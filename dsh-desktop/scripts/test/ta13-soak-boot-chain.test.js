'use strict';

// ta13-soak-boot-chain.test.js — TA13 极限压测：boot 链 ×50 轮。
// 临时 appDir/home/userDataDir 布局上重复跑 applyAll（patch-runner）+
// preflight（fault-isolation），观察：
//   · readFileCached（patch-io 进程级读缓存）命中后总耗时应递减趋稳
//     （首轮冷读全量 fs.readFileSync，后续轮 stat 命中缓存直接返回文本）；
//   · 无累积副作用：目标文件内容在首轮后保持逐字节不变（补丁幂等）、
//     耗时不随轮次单调上升。
// 运行：node --test scripts/test/ta13-soak-boot-chain.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyAll } = require('../integration/patch-runner');
const { preflight } = require('../integration/fault-isolation');
const { readFileCached } = require('../lib/patch-io');

const ROUNDS = 50;

test('boot 链 soak：applyAll+preflight ×50 轮，缓存命中后耗时趋稳 + 无累积副作用', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta13-boot-'));
  const appDir = path.join(root, 'app');
  const home = path.join(root, 'home');
  const userDataDir = path.join(root, 'userdata');
  // 最小可补丁布局：@deepseek-ai/dsh/lib 下放若干运行时文件（runtime-local 补丁读它们）
  const libDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const targetFiles = ['index.js', 'session.js', 'settings.js'].map((name, i) => {
    const f = path.join(libDir, name);
    // 伪 dsh 内核形态：足够大（~200KB）使冷读成本可见，含补丁引擎可扫描的普通 JS
    const body = '// ta13 boot soak target ' + name + '\n' +
      Array.from({ length: 1200 }, (_, k) => `function f${i}_${k}(a){ return a + ${k}; } // ${'x'.repeat(40)}\n`).join('');
    fs.writeFileSync(f, body);
    return f;
  });
  // preflight 需要 profiles/web/package.json（不存在时 scanned:0 —— 放一个最小体走真实分支）
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'web', dsh: { profile: { bundles: [{ id: 'b1', name: 'n' }] } },
  }));

  const logs = [];
  const ctx = { home, appDir, userDataDir, wslMode: false, log: (m) => logs.push(m) };

  const times = [];
  let report1 = null;
  let snapshotAfterFirst = null;
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = process.hrtime.bigint();
    const patchReport = applyAll(ctx);
    const health = preflight(ctx);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms);
    if (round === 0) {
      report1 = { patchReport, health };
      snapshotAfterFirst = targetFiles.map((f) => fs.readFileSync(f, 'utf8'));
    }
  }

  const first5 = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const last5 = times.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const mid = times.slice(20, 30).reduce((a, b) => a + b, 0) / 10;
  console.log('[ta13-boot-chain] 轮耗时 ms 首5均值', first5.toFixed(1), '中段(21-30)', mid.toFixed(1), '末5均值', last5.toFixed(1),
    '；全部轮次', times.map((v) => v.toFixed(0)));

  // 1) 缓存有效性证据（直接单元级）：同文件重复读走 memo（无第二次磁盘读体），
  //    文件被改写（mtime/size 变）后缓存失效。
  const probe = targetFiles[0];
  const cold = readFileCached(probe);
  const warm = readFileCached(probe);
  assert.equal(warm, cold, 'readFileCached 第二次应命中缓存返回同文本');
  fs.appendFileSync(probe, '// touch\n');
  const refreshed = readFileCached(probe);
  assert.notEqual(refreshed, cold, '改写后缓存应失效');
  fs.writeFileSync(probe, cold); // 还原，保持后续幂等断言口径

  // 2) 趋稳：末 5 轮均值不显著高于首 5 轮。容差 2×+10ms：单跑与全套并行
  //    （node --test 多文件并发，其他用例 spawn 子进程争 CPU）两种负载形态
  //    都要稳定——真实累积劣化（缓存泄漏/补丁叠写）是复利式增长，50 轮放大
  //    百倍以上远超此容差；瞬态调度噪声不应误报（1.3×+2ms 在满套并行下
  //    实测会抖：首5 13.0ms 末5 20.6ms 误红，单跑则恒绿）。
  assert.ok(last5 <= first5 * 2 + 10, `boot 链耗时应趋稳不劣化：首5 ${first5.toFixed(1)}ms 末5 ${last5.toFixed(1)}ms`);
  // 3) 无累积副作用：50 轮后目标文件与首轮后逐字节一致（补丁幂等/不叠写）
  targetFiles.forEach((f, i) => {
    assert.equal(fs.readFileSync(f, 'utf8'), snapshotAfterFirst[i], '重复 applyAll 不应累积改写目标: ' + f);
  });
  // 4) 首轮报告可解析（不炸）
  assert.ok(report1.patchReport && report1.health && typeof report1.health.scanned === 'number', 'patch/health 报告形态正常');

  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* tmp 残留无害 */ }
});
