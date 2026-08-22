'use strict';

// ta15-boot-chain-concurrent.test.js — TA15 竞态测试 #2：boot 链（applyAll /
// applyPatchToFiles）并发应用同一 appDir。
//
// 现状定性（读代码，scripts/lib/patch-engine.js + scripts/lib/patch-io.js +
// scripts/plugin-core/lib/fs-atomic.js）：
//   · 引擎无 Mutex / 无跨进程锁（fs-atomic 的 WriteGate 存在但 patch 链
//     未走它）——applyAll 全同步 fs，单进程内事件循环不可重入，单实例内
//     无交错；
//   · 写入经 writeFileAtomic（tmp+rename），读者永见完整文件（无撕裂）；
//   · transform 幂等（已含 marker → 'already'），**同补丁**并发收敛；
//   · **不同补丁打同一文件**的读-改-写窗口无防护：两进程同读原文 → 各自
//     rename 覆盖 → 后写者胜、先写者的补丁静默丢失（lost update，记 P1
//     缺陷，本测试锁现状不修）。
//
// 用例：
//   A. 确定性 lost-update 复现（write 钩子注入交错：P1 读完未写期间 P2 完成
//      全链）→ 断言现状 = A 丢失（回归锁；修复后此断言会翻转提醒升级）。
//   B. 幂等竞态（两方同补丁交错）→ 收敛单次补丁，无双重应用。
//   C. 真双进程（spawn 两个 node，同补丁、同文件、起跑线旗语同时开跑）
//      → 文件终态 = 单次补丁结果；无撕裂（marker 计数恰 1）。
//   D. 真双进程不同补丁 → 终态 ∈ {只A, 只B}，文件内容完整不撕裂（原子写
//      兜底语义），两进程各自报告成功（缺陷形态锁）。
// 运行：node --test scripts/test/ta15-boot-chain-concurrent.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { applyPatchToFiles } = require('../lib/patch-engine');
const { writeFileAtomic } = require('../lib/patch-io');

const BASE = 'const x = 1;\n// END\n';

function mkTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ta15-' + tag + '-'));
  return dir;
}

/** 补丁 A/B：往 // END 前插各自 marker；已含 marker → already；锚缺失 → anchor-missing。 */
function makeTransform(marker) {
  return (src) => {
    if (src.includes(marker)) return { status: 'already' };
    if (!src.includes('// END')) return { status: 'anchor-missing', detail: '锚 // END 缺失' };
    return { status: 'ok', src: src.replace('// END', marker + '\n// END'), note: marker };
  };
}

function apply(file, marker, write) {
  return applyPatchToFiles({
    prefix: 'test-' + marker,
    files: [file],
    log: () => {},
    transform: makeTransform(marker),
    write,
  });
}

test('A. lost-update 确定性复现：P1 读后未写期间 P2 写入 → P1 覆盖丢 P2（现状=缺陷锁）', () => {
  const dir = mkTmp('lost');
  const file = path.join(dir, 'client.js');
  fs.writeFileSync(file, BASE);

  let writeCount = 0;
  // P1 的写被挂钩延迟：写盘前先让 P2 完整跑完（读 BASE → 写 BASE+B）。
  const n1 = apply(file, '// PATCH-A', (f, content) => {
    writeCount += 1;
    assert.strictEqual(content, BASE.replace('// END', '// PATCH-A\n// END'), 'P1 计算基于原始内容');
    apply(file, '// PATCH-B'); // P2 全链插入 P1 的读-写窗口
    writeFileAtomic(f, content); // P1 后写 → 覆盖丢 B
  });
  // P2 复核（只探测不改写）：文件被 P1 覆盖回只含 A → P2 视角自己从未应用。
  const probeB = makeTransform('// PATCH-B')(fs.readFileSync(file, 'utf8'));

  const final = fs.readFileSync(file, 'utf8');
  assert.strictEqual(writeCount, 1);
  assert.strictEqual(n1, 1, 'P1 报告写入成功');
  // 现状：P2 的写入被 P1 的后写覆盖（lost update，P1 缺陷记录，勿修）。
  assert.ok(final.includes('// PATCH-A'), 'A 存活（后写者）');
  assert.ok(!final.includes('// PATCH-B'), 'B 丢失（先写者被覆盖）——现状缺陷锁');
  assert.strictEqual(probeB.status, 'ok', '复核时 B 已不在文件中（P2 会再写一遍而非 already——引擎无法察觉丢失）');
  assert.ok(final.startsWith('const x = 1;') && final.endsWith('// END\n'), '文件整体完整（原子写：无撕裂）');
});

test('B. 同补丁幂等竞态：交错后收敛单次应用，无双重 marker', () => {
  const dir = mkTmp('idem');
  const file = path.join(dir, 'client.js');
  fs.writeFileSync(file, BASE);

  let first = true;
  const n1 = apply(file, '// PATCH-A', (f, content) => {
    if (first) { first = false; apply(file, '// PATCH-A'); } // 并发同补丁先完成
    writeFileAtomic(f, content);
  });
  const final = fs.readFileSync(file, 'utf8');
  assert.strictEqual((final.match(/\/\/ PATCH-A/g) || []).length, 1, 'marker 恰一次');
  assert.strictEqual(n1, 1, '两方各报告 1 次（终态幂等收敛）');
});

/** 真双进程：child 等待起跑旗语文件 → 读/transform/原子写 → 报告写数（stdout 末行）。 */
const CHILD_SRC = `
const fs = require('node:fs');
const { applyPatchToFiles } = require(process.env.TA15_ROOT + '/scripts/lib/patch-engine');
const file = process.env.TA15_FILE, flag = process.env.TA15_FLAG, marker = process.env.TA15_MARKER;
// 起跑线：自旋等旗语（短等待，占用可忽略）。
const t0 = Date.now();
while (!fs.existsSync(flag)) { if (Date.now() - t0 > 10000) { console.error('flag timeout'); process.exit(2); } }
const n = applyPatchToFiles({
  prefix: 'child', files: [file], log: () => {},
  transform: (src) => src.includes(marker) ? { status: 'already' }
    : !src.includes('// END') ? { status: 'anchor-missing', detail: 'x' }
    : { status: 'ok', src: src.replace('// END', marker + '\\n// END'), note: marker },
});
process.stdout.write(String(n));
`;

function runChild(repoRoot, file, flag, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SRC], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TA15_ROOT: repoRoot, TA15_FILE: file, TA15_FLAG: flag, TA15_MARKER: marker },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('child exit ' + code + ': ' + err))));
  });
}

test('C. 真双进程同补丁：终态=单次应用，无撕裂', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const dir = mkTmp('twoproc-same2');
  const file = path.join(dir, 'client.js');
  const flag = path.join(dir, 'go');
  fs.writeFileSync(file, BASE);
  const kids = [runChild(root, file, flag, '// PATCH-A'), runChild(root, file, flag, '// PATCH-A')];
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(flag, ''); // 起跑线：两 child 几乎同时开跑
  const counts = await Promise.all(kids);
  const final = fs.readFileSync(file, 'utf8');
  const markers = (final.match(/\/\/ PATCH-A/g) || []).length;
  assert.strictEqual(markers, 1, 'marker 恰一次（幂等收敛）');
  const writes = counts.reduce((a, b) => a + Number(b || 0), 0);
  assert.ok(writes >= 1 && writes <= 2, `真实写入 1-2 次（同读原文时双方都报写，终态仍收敛；writes=${writes}）`);
  assert.ok(final.startsWith('const x = 1;') && final.endsWith('// END\n'), '结构完整（原子写防撕裂）');
});

test('D. 真双进程不同补丁同文件：终态 ∈ {只A, 只B}，内容完整（缺陷形态锁）', async () => {
  const root = path.resolve(__dirname, '..', '..');
  const dir = mkTmp('twoproc-diff');
  const file = path.join(dir, 'client.js');
  const flag = path.join(dir, 'go');
  fs.writeFileSync(file, BASE);
  const kids = [runChild(root, file, flag, '// PATCH-A'), runChild(root, file, flag, '// PATCH-B')];
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(flag, '');
  const counts = await Promise.all(kids);
  const final = fs.readFileSync(file, 'utf8');
  const hasA = final.includes('// PATCH-A');
  const hasB = final.includes('// PATCH-B');
  // 真进程起跑有毫秒级偏差，两种合法终态：
  //   · 交错（双方同读原文）→ 后写覆盖，只含一方 marker（lost-update 形态，
  //     确定性复现在用例 A）；
  //   · 天然串行（一方先完成）→ 链式叠加，两 marker 各恰一次。
  // 原子写保证任何交错下：marker 各 ≤1 次、结构完整不撕裂。
  assert.strictEqual((final.match(/\/\/ PATCH-A/g) || []).length, hasA ? 1 : 0, 'A marker 至多一次');
  assert.strictEqual((final.match(/\/\/ PATCH-B/g) || []).length, hasB ? 1 : 0, 'B marker 至多一次');
  assert.ok(hasA || hasB, '至少一方存活');
  assert.ok(final.startsWith('const x = 1;') && final.endsWith('// END\n'), '文件完整无撕裂');
});
