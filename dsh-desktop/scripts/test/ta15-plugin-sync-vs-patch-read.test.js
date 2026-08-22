'use strict';

// ta15-plugin-sync-vs-patch-read.test.js — TA15 竞态 #3：plugin-sync 复制中途
// vs boot 补丁读同一文件。
//
// 场景定性（读代码）：
//   · plugin-sync 的 manifest/patch 落盘走 writeFileAtomic（tmp+rename）——
//     读者永见完整旧版或完整新版，不存在「半复制文件」；
//   · 但 heal 兜底路径（plugin-sync.js:154/193 恢复坏 cordis.patch.yml）用
//     裸 fs.writeFileSync——非原子，读者可能读到半行（记 P2 缺陷形态，本
//     测试锁「读侧防线」：半文件被 transform 拒收且缓存不陈化）；
//   · readFileCached 以 realpath+size+mtimeMs 精确命中——外部改写（含半写）
//     必然 size/mtime 变化 → 缓存失效，不会把改写前的完整内容当命中返回。
//
// 用例：
//   A. size 变化 → 缓存失效：改写后 readFileCached 返回**当前盘上内容**
//      （半文件就返回半内容），绝不返回陈旧全文。
//   B. mtime 变化（size 巧合相同）→ 仍失效（mtime 精确比对）。
//   C. 半复制文件进 transform → anchor-missing → 引擎跳过不写（fail-safe，
//      不把坏内容「修复」落盘、不产生半写放大）。
//   D. 真并发：写进程锤 writeFileAtomic（交替两种合法全量），独立读进程
//      （子进程循环 readFileSync）→ 每次读取都恰为某一版全文，无混合体。
// 运行：node --test scripts/test/ta15-plugin-sync-vs-patch-read.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeFileAtomic, readFileCached } = require('../lib/patch-io');
const { applyPatchToFiles } = require('../lib/patch-engine');

function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ta15-sync-' + tag + '-'));
}

const FULL = 'plugin(function (ctx) {\n  ctx.register("x");\n  // ANCHOR-TAIL\n});\n';
const HALF = FULL.slice(0, Math.floor(FULL.length / 2)); // 复制中断形态

test('A. size 变化（完整→半文件）→ readFileCached 失效，返回盘上半内容而非陈旧全文', () => {
  const dir = mkTmp('size');
  const file = path.join(dir, 'plugin.js');
  fs.writeFileSync(file, FULL);
  assert.strictEqual(readFileCached(file), FULL, '首次读=全文');

  fs.writeFileSync(file, HALF); // 模拟外部复制中途（非原子半写）
  const again = readFileCached(file);
  assert.strictEqual(again, HALF, '缓存失效且返回当前半内容（绝不返回陈旧全文）');

  fs.writeFileSync(file, FULL); // 复制完成（同 size 回全文）
  assert.strictEqual(readFileCached(file), FULL, 'size 恢复后再次正确命中新读');
});

test('B. size 巧合相同、mtime 变 → 仍失效（mtime 精确比对兜底）', () => {
  const dir = mkTmp('mtime');
  const file = path.join(dir, 'plugin.js');
  const same = 'A'.repeat(64);
  const same2 = 'B'.repeat(64);
  fs.writeFileSync(file, same);
  assert.strictEqual(readFileCached(file), same);
  fs.writeFileSync(file, same2); // 同 size 不同内容
  // 同步连写 mtime 分辨率风险：ntfs 100ns 粒度下 ms 级几乎必变；即便 mtime
  // 恰同（文件系统粒度粗），size 也相同 → 可能返回陈旧——此处等 2ms 拉开。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  fs.writeFileSync(file, same2);
  assert.strictEqual(readFileCached(file), same2, 'mtime 变化使缓存失效');
});

test('C. 半文件进 transform → anchor-missing → 引擎跳过不写（fail-safe）', () => {
  const dir = mkTmp('halfwrite');
  const file = path.join(dir, 'plugin.js');
  fs.writeFileSync(file, HALF);
  const anchorMissing = [];
  let writeCalled = 0;
  const n = applyPatchToFiles({
    prefix: 'ta15',
    files: [file],
    log: () => {},
    anchorLog: (m) => anchorMissing.push(m),
    transform: (src) => (src.includes('ANCHOR-TAIL')
      ? { status: 'ok', src: src + '// patched\n', note: '' }
      : { status: 'anchor-missing', detail: '锚 ANCHOR-TAIL 缺失（半文件）' }),
    write: () => { writeCalled += 1; },
  });
  assert.strictEqual(n, 0, '零写入');
  assert.strictEqual(writeCalled, 0, '写钩子绝不被调');
  assert.strictEqual(anchorMissing.length, 1, '失配告警恰一条');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), HALF, '盘上半文件原样未被放大破坏');
});

test('D. 真并发：原子写锤击 × 独立读者进程 → 每读必是某版全文，无混合体', async () => {
  const dir = mkTmp('hammer');
  const file = path.join(dir, 'state.json');
  const payloadA = JSON.stringify({ v: 'A', pad: 'a'.repeat(4096) }) + '\n';
  const payloadB = JSON.stringify({ v: 'B', pad: 'b'.repeat(4096) }) + '\n';
  fs.writeFileSync(file, payloadA);

  // 读进程：循环 1.2s，每次读取必须完整解析且 v ∈ {A,B}，异常形态计数。
  const readerSrc = `
const fs = require('node:fs');
let bad = 0, reads = 0;
const t0 = Date.now();
while (Date.now() - t0 < 1200) {
  reads += 1;
  try {
    const v = JSON.parse(fs.readFileSync(process.env.TA15_FILE, 'utf8'));
    if (v.v !== 'A' && v.v !== 'B') bad += 1;
  } catch (e) { bad += 1; }
}
process.stdout.write(JSON.stringify({ reads, bad }));
`;
  const kid = spawn(process.execPath, ['-e', readerSrc], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, TA15_FILE: file },
  });
  let out = '';
  kid.stdout.on('data', (d) => { out += d; });
  // 写侧锤击固定墙钟 1.5s：交替两版全量原子写。Windows 下 rename 偶发
  // EPERM（读端瞬时占用/杀软），writeFileAtomic 内建 3 次重试后仍可抛——
  // 测试侧再兜底容忍（失败时盘上是完整旧版，不影响读者不变量）。
  // 锤击后必须 await（让出事件循环，子进程 exit 事件才可达）。
  const t0 = Date.now();
  let i = 0;
  let eperm = 0;
  while (Date.now() - t0 < 1500) {
    try {
      writeFileAtomic(file, i % 2 === 0 ? payloadB : payloadA);
      i += 1;
    } catch (err) {
      assert.strictEqual(err.code, 'EPERM', '唯一可容忍的锤击失败形态');
      eperm += 1;
    }
  }
  const code = await new Promise((r) => kid.on('close', (c) => r(c)));
  assert.strictEqual(code, 0);
  const { reads, bad } = JSON.parse(out.trim() || '{"reads":0,"bad":-1}');
  assert.ok(reads > 100, `读者样本足够（reads=${reads}）`);
  assert.strictEqual(bad, 0, `原子写下无撕裂读取（writes=${i} eperm容忍=${eperm}）`);
});
