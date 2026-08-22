'use strict';

// ta12-composition-integrity-cli.test.js —— composition-integrity.js 的子进程级 CLI
// 测试（node --test）。与 unit-composition-integrity.test.js 的区别：那边用
// cliMain() 直调 + 注入 checkServicePresence；本文件真实 spawn `node
// composition-integrity.js`，覆盖既有测没锁的契约：
//   · 退出码矩阵经 process.exit 真实传导（0 / 1 / 2），stdout JSON 可解析；
//   · --app-dir 与 --payload-dir 两个名字在真实 CLI 下同义；
//   · 生产关键服务清单（16 项，不注入精简表）下的健康 / 缺包两种形态；
//   · --app-dir 缺参数值 / 未知参数不致崩（仍按缺 appDir → 2 处理）。
// 运行：node --test scripts/test/ta12-composition-integrity-cli.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'integration', 'composition-integrity.js');

/** 全部 16 项生产关键服务都在位的最小 payload（组合 yml + 包目录）。 */
function buildPayload(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-comp-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nm = path.join(root, 'node_modules');

  const { criticalServices } = require('../integration/composition-integrity');
  const list = criticalServices();

  // yml：所有服务行（base 容器装 base-bundle 域行，web 容器装其余）。
  const baseRows = [], webRows = [];
  for (const s of list) {
    if (s.rowId === 'base-bundle') continue; // bundle 容器，源在位即视为在位
    (s.rowId === 'web-runtime' || /webserver|api-gateway|modules|connection|plugin-inventory/.test(s.rowId)
      ? webRows : baseRows).push(`    - id: ${s.rowId}\n      name: '${s.moduleName}'`);
  }
  const mkSrc = (pkg, rows) => {
    const dir = path.join(nm, ...pkg.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0' }));
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), rows.join('\n') + '\n');
  };
  mkSrc('@deepseek-ai/dsh-base', baseRows);
  mkSrc('@deepseek-ai/dsh-web-app', webRows);
  for (const s of list) {
    const dir = path.join(nm, ...s.moduleName.split('/'));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: s.moduleName, version: '0.0.0' }));
    }
  }
  return { root, nm, list };
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('CLI 子进程：健康 payload → exit 0，stdout 为可解析 JSON 且 ok=true', (t) => {
  const { root } = buildPayload(t);
  const r = runCli(['--app-dir', root]);
  assert.equal(r.code, 0, r.out + r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, true, '不应有关键缺席: ' + JSON.stringify(report.criticalMissing));
  assert.deepEqual(report.criticalMissing, []);
  assert.equal(report.appDir, root);
});

test('CLI 子进程：挖掉关键服务包 → exit 1，JSON 标出缺席与后果文案', (t) => {
  const { root } = buildPayload(t);
  fs.rmSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-credentials-local'), { recursive: true, force: true });
  const r = runCli(['--app-dir', root]);
  assert.equal(r.code, 1, r.out + r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, false);
  const cred = report.criticalMissing.find((s) => s.rowId === 'credentials');
  assert.ok(cred, 'credentials 应在 criticalMissing');
  assert.equal(cred.status, 'package-missing');
  assert.ok(cred.consequence.includes('credentials service is absent'));
});

test('CLI 子进程：--payload-dir 别名与 --app-dir 同义（同夹具同退出码）', (t) => {
  const { root } = buildPayload(t);
  const a = runCli(['--app-dir', root]);
  const b = runCli(['--payload-dir', root]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(b.code, a.code, '--payload-dir 必须与 --app-dir 同义: ' + b.out + b.err);
  assert.equal(JSON.parse(b.out).ok, true);
});

test('CLI 子进程退出码矩阵：无参数 → 2 + 用法行；缺参数值 → 2；不存在的目录 → 1', (t) => {
  const { root } = buildPayload(t); // 控制变量：矩阵不依赖夹具内容（除最后一条）

  assert.equal(runCli([]).code, 2, '无参数 → 用法错误 2');
  const noVal = runCli(['--app-dir']);
  assert.equal(noVal.code, 2, '--app-dir 缺值 → 2（appDir=undefined 视同未给）');
  assert.ok(noVal.err.includes('用法') || noVal.out.includes('用法'), '应输出用法行');

  // 不存在的目录：组合源缺失 → 关键服务 row-missing → 1（且 JSON 输出而非崩溃）
  const ghost = runCli(['--app-dir', path.join(root, 'no-such-dir')]);
  assert.equal(ghost.code, 1, ghost.out + ghost.err);
  const report = JSON.parse(ghost.out);
  assert.equal(report.ok, false);
  assert.ok(report.criticalMissing.some((s) => s.rowId === 'base-bundle'));
});

test('CLI 子进程：--app-dir 与 --payload-dir 同给时后者生效（逐个消费）', (t) => {
  const { root } = buildPayload(t);
  const ghost = path.join(root, 'ghost');
  // 两个标志都出现：CLI 循环取最后一个赋值 → ghost → 1；反序则 root → 0
  assert.equal(runCli(['--app-dir', root, '--payload-dir', ghost]).code, 1);
  assert.equal(runCli(['--payload-dir', ghost, '--app-dir', root]).code, 0);
});
