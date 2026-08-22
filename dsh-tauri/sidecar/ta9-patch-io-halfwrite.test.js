'use strict';

/**
 * TA9 混沌测试 —— patch-io：写入中途 kill（半写文件）× readFileCached 缓存失效。
 *
 * 运行：`node --test sidecar/ta9-patch-io-halfwrite.test.js`（仓库 dsh-tauri/ 下）。
 *
 * 故障注入（全部沙箱内，绝不触碰真实数据）：
 *   1. 半写文件：直接以 fs.writeFileSync 落「截断形态」内容（模拟
 *      writeFileAtomic 的 tmp 写一半被 kill 后目标文件被外部改短的形态），
 *      下一次 readFileCached 必须因 size/mtime 变化而缓存失效，读到新内容；
 *   2. 同 size 改写：mtime 变化也必须失效（双条件精确一致才命中）；
 *   3. 文件缺失 / 目标被换成目录 → readFileCached 返回 null（不抛）；
 *   4. writeFileAtomic 写向不可写目标（目标位置被目录占用）→ 显式抛错
 *      （fail-fast，不静默丢数据），且不残留 .tmp。
 *
 * 依赖：仓库根 dsh-desktop/scripts（纯 Node，无 npm 依赖面）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..', 'dsh-desktop');
const { writeFileAtomic, readFileCached } = require(path.join(APP_DIR, 'scripts', 'lib', 'patch-io.js'));

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ta9-patch-io-'));
}

test('半写（size 缩短）后 readFileCached 必须失效并读到新内容', () => {
  const dir = sandbox();
  const file = path.join(dir, 'cordis.patch.yml');
  const full = '- id: a\n  disabled: true\n- id: b\n  disabled: true\n';
  fs.writeFileSync(file, full);
  const first = readFileCached(file);
  assert.strictEqual(first, full, '首读命中并缓存');
  assert.strictEqual(readFileCached(file), full, '二次读命中缓存（同对象）');

  // 模拟写入中途被 kill：目标文件变成半截（size 变小）。
  const half = full.slice(0, 12);
  fs.writeFileSync(file, half);
  const after = readFileCached(file);
  assert.strictEqual(after, half, 'size 变化必须令缓存失效，读到半写内容');
  assert.notStrictEqual(after, full);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('同 size 改写（mtime 变化）也必须令缓存失效', () => {
  const dir = sandbox();
  const file = path.join(dir, 'same-size.txt');
  fs.writeFileSync(file, 'AAAA');
  assert.strictEqual(readFileCached(file), 'AAAA');
  // 同长度不同内容：只有 mtime 变（写入必改 mtime——模块头契约）。
  const t0 = Date.now();
  let wrote = false;
  while (!wrote) {
    fs.writeFileSync(file, 'BBBB');
    const st = fs.statSync(file);
    // 等待 mtime 真正前进（同一毫秒内重写 mtimeMs 可能不变）。
    wrote = st.mtimeMs !== fs.statSync(file).mtimeMs || Date.now() - t0 > 50;
    if (!wrote) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  // 直接绕过等待捷径：再等至少 2ms 保证 mtimeMs 变化后重写一次。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  fs.writeFileSync(file, 'BBBB');
  const got = readFileCached(file);
  assert.strictEqual(got, 'BBBB', 'mtime 变化必须令缓存失效（size 相同也不得命中旧缓存）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件缺失 / 被换成目录 → readFileCached 返回 null 不抛', () => {
  const dir = sandbox();
  const missing = path.join(dir, 'nope.yml');
  assert.strictEqual(readFileCached(missing), null, '缺失 → null');
  const asDir = path.join(dir, 'now-a-dir.yml');
  fs.mkdirSync(asDir);
  assert.strictEqual(readFileCached(asDir), null, '目录形态 → null（readFileSync ENOTDIR 被吞）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic 写向被目录占用的目标 → 显式抛错且不残留 tmp', () => {
  const dir = sandbox();
  const target = path.join(dir, 'blocked.yml');
  fs.mkdirSync(target); // 目标位置被目录占用：rename/write 均 EPERM/ENOTEMPTY 形态
  assert.throws(() => writeFileAtomic(target, 'data'), (err) => {
    assert.ok(err instanceof Error);
    return true;
  }, '不可写目标必须显式抛错（fail-fast，不静默）');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('tmp') || n.includes('.new') || n.includes('part'));
  assert.deepStrictEqual(leftovers, [], '失败后不得残留临时文件: ' + leftovers.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic 正常路径原子可见（对照实验）', () => {
  const dir = sandbox();
  const file = path.join(dir, 'ok.yml');
  writeFileAtomic(file, 'line1\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'line1\n');
  writeFileAtomic(file, 'line2\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'line2\n');
  assert.strictEqual(readFileCached(file), 'line2\n', '原子写后读缓存一致');
  fs.rmSync(dir, { recursive: true, force: true });
});
