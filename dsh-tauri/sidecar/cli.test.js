'use strict';

/**
 * DSH Desktop（Tauri 版）sidecar CLI 功能测试
 * ============================================
 * 运行：`node --test sidecar/cli.test.js`（仓库 dsh-tauri/ 目录下）。
 *
 * 覆盖：boot 链（沙箱 home 全新建档）/ plugin-list / set-enabled 可逆往返 /
 * diag-run / backup 导出→预览→恢复 roundtrip / 用法错误路径。
 *
 * 依赖：仓库检出内 dsh-desktop 已 npm install（vendor node + node_modules）。
 * 隔离：DSH_HOME 与 DSH_TAURI_USERDATA 全部指向临时目录，绝不触碰真实 ~/.dsh。
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEAR = path.join(__dirname, 'cli.js');
const APP_DIR = path.resolve(__dirname, '..', '..', 'dsh-desktop');
const NODE = path.join(APP_DIR, 'vendor', 'node', 'node.exe');
const HAVE_DEPS = fs.existsSync(NODE) && fs.existsSync(path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh'));

/** 沙箱环境（每个测试独立 home/userData）。 */
function sandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidecar-test-'));
  return { dir, env: { ...process.env, DSH_HOME: dir, DSH_TAURI_USERDATA: path.join(dir, 'ud') } };
}

/** 跑 CLI 子命令，返回 { code, json, stderr }（json = stdout 末行解析）。 */
function cli(args, opts = {}) {
  const r = spawnSync(NODE, [SIDEAR, ...args, '--app-dir', APP_DIR], {
    encoding: 'utf8',
    env: opts.env || process.env,
    timeout: opts.timeout || 120_000,
  });
  const lastLine = (r.stdout || '').trimEnd().split('\n').pop() || '';
  let json = null;
  try { json = JSON.parse(lastLine); } catch { /* 保持 null */ }
  return { code: r.status, json, stderr: r.stderr || '', stdout: r.stdout || '' };
}

test('环境自检：依赖齐备（否则全组跳过）', () => {
  if (!HAVE_DEPS) {
    console.warn('[skip] dsh-desktop 依赖不齐（先 npm install）');
  }
  assert.ok(true);
});

test('boot：沙箱 home 四步全过并建档', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  const r = cli(['boot'], { env: sb.env, timeout: 180_000 });
  assert.strictEqual(r.code, 0, `stderr: ${r.stderr.slice(-500)}`);
  assert.strictEqual(r.json.ok, true, JSON.stringify(r.json));
  // 固定顺序契约（data-flow.md §3）。
  assert.deepStrictEqual(r.json.steps.map((s) => s.name), ['repair', 'sync', 'patches', 'preflight']);
  // 沙箱建档：web profile + patch 清单落盘。
  assert.ok(fs.existsSync(path.join(sb.dir, 'profiles', 'web', 'cordis.patch.yml')), 'profile patch 应建档');
  assert.ok(fs.existsSync(path.join(sb.dir, 'profiles', 'web', 'package.json')), 'profile package 应建档');
});

test('plugin-list：boot 后可列出 companion 插件', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  assert.strictEqual(cli(['boot'], { env: sb.env, timeout: 180_000 }).code, 0);
  const r = cli(['plugin-list'], { env: sb.env });
  assert.strictEqual(r.code, 0);
  assert.ok(Array.isArray(r.json), '应输出插件数组');
  assert.ok(r.json.length >= 20, `沙箱应装配 20+ 伴随插件，得到 ${r.json.length}`);
  const groups = new Set(r.json.map((x) => x.group));
  assert.ok(groups.has('companion'), '应含 companion 组');
  for (const row of r.json) {
    // 行形态契约（contracts/plugin-contract.md C 层）。
    for (const key of ['id', 'name', 'enabled', 'toggleable', 'group', 'removed']) {
      assert.ok(key in row, `插件行缺字段 ${key}: ${JSON.stringify(row)}`);
    }
  }
});

test('plugin-set-enabled：可逆往返（关闭→列表确认→启用→还原）', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  assert.strictEqual(cli(['boot'], { env: sb.env, timeout: 180_000 }).code, 0);
  const list = () => cli(['plugin-list'], { env: sb.env }).json;
  const before = list().find((x) => x.id === 'balance');
  assert.ok(before, '应存在 balance 插件');
  assert.strictEqual(before.enabled, true, '初始应为启用');

  const off = cli(['plugin-set-enabled', 'balance', '0'], { env: sb.env });
  assert.strictEqual(off.json.ok, true, JSON.stringify(off.json));
  assert.strictEqual(list().find((x) => x.id === 'balance').enabled, false, '应已禁用');

  const on = cli(['plugin-set-enabled', 'balance', '1'], { env: sb.env });
  assert.strictEqual(on.json.ok, true);
  assert.strictEqual(list().find((x) => x.id === 'balance').enabled, true, '应还原启用');

  // 未知插件 → ok:false + 中文错误。
  const bad = cli(['plugin-set-enabled', 'no-such-plugin', '0'], { env: sb.env });
  assert.strictEqual(bad.json.ok, false);
  assert.ok(String(bad.json.error).length > 0);
});

test('diag-run：沙箱只读诊断返回结构化报告', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  assert.strictEqual(cli(['boot'], { env: sb.env, timeout: 180_000 }).code, 0);
  const r = cli(['diag-run'], { env: sb.env, timeout: 120_000 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.ok, true, JSON.stringify(r.json).slice(0, 200));
  for (const key of ['errors', 'warnings', 'infos', 'generatedAt', 'sections']) {
    assert.ok(key in r.json.report, `诊断报告缺 ${key}`);
  }
});

test('backup 全链：导出→预览（token）→恢复（roundtrip）', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  assert.strictEqual(cli(['boot'], { env: sb.env, timeout: 180_000 }).code, 0);

  const outFile = path.join(sb.dir, 'backup.json');
  const ex = cli(['backup-export', 'test-label', outFile], { env: sb.env });
  assert.strictEqual(ex.json.ok, true, JSON.stringify(ex.json));
  assert.ok(fs.existsSync(outFile), '备份文件应写出');
  assert.ok(ex.json.files >= 1, '至少备份一个文件');

  const prev = cli(['backup-restore-preview', outFile], { env: sb.env });
  assert.strictEqual(prev.json.ok, true, JSON.stringify(prev.json));
  assert.match(prev.json.token, /^[0-9a-f]{64}$/, 'token = sha256');

  // 篡改文件后 token 失配 → 拒绝（TOCTOU 防御）。
  const tampered = path.join(sb.dir, 'tampered.json');
  fs.copyFileSync(outFile, tampered);
  const prev2 = cli(['backup-restore-preview', tampered], { env: sb.env });
  fs.appendFileSync(tampered, ' ');
  const bad = cli(['backup-restore-apply', tampered, prev2.json.token], { env: sb.env });
  assert.strictEqual(bad.json.ok, false, '篡改后必须拒绝恢复');

  // 正件恢复成功。
  const ap = cli(['backup-restore-apply', outFile, prev.json.token], { env: sb.env });
  assert.strictEqual(ap.json.ok ?? true, true, JSON.stringify(ap.json).slice(0, 300));
});

test('用法错误：未知子命令退出码 2、空参数退出码 2', { skip: !HAVE_DEPS }, () => {
  const r1 = cli(['definitely-not-a-command']);
  assert.strictEqual(r1.code, 2, `未知子命令应 exit 2，得到 ${r1.code}`);
  const r2 = spawnSync(NODE, [SIDEAR], { encoding: 'utf8', timeout: 15_000 });
  assert.strictEqual(r2.status, 2, `空参数应 exit 2，得到 ${r2.status}`);
});

test('未知插件卸载：ok:false 而非崩溃', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  assert.strictEqual(cli(['boot'], { env: sb.env, timeout: 180_000 }).code, 0);
  const r = cli(['plugin-uninstall', 'no-such-id'], { env: sb.env });
  assert.strictEqual(r.json.ok, false);
  assert.match(String(r.json.error), /未知插件/);
});

// ===========================================================================
// 升级适配子命令（koffi 预检 / picker 降级 overlay / safe-boot overlay）
// ===========================================================================

test('koffi-preflight：返回布尔探测结果（本机应通过）', { skip: !HAVE_DEPS }, () => {
  const r = cli(['koffi-preflight']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(typeof r.json.ok, 'boolean', JSON.stringify(r.json));
});

test('picker-overlay：内容与 Electron 版逐行一致', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  const r = cli(['picker-overlay'], { env: sb.env });
  assert.strictEqual(r.json.ok, true, JSON.stringify(r.json));
  const text = fs.readFileSync(r.json.path, 'utf8');
  // Electron main.js enablePickerBrowseOverlay 的关键行逐条断言。
  assert.ok(text.includes('# DSH-DESKTOP-AUTO: picker browse fallback'), '标记行');
  assert.ok(text.includes('- id: directory-picker\n  disabled: true'), '禁用 native 选择器');
  assert.ok(text.includes("@deepseek-ai/dsh-host-directory-picker-browse"), 'browse 后端包名');
  assert.ok(text.includes('@deepseek-ai/dsh-client-ui-directory-picker-browse'), 'browse client 包名');
});

test('safe-overlay：解析失败日志 → 禁用 overlay（幂等合并）', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  // 模拟 dsh-web.log 尾部（Electron parseFailedLoaderIds 的三种形态样本）。
  const logs = path.join(sb.dir, 'ud', 'logs'); // sandbox 的 DSH_TAURI_USERDATA = sb.dir/ud
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'dsh-web.log'), [
    'boot: ok',
    'duplicate loader entry id: bad-plugin-x',
    'failed to apply loader entry broken_y (some stack)',
    'profile bundle "ghost-bundle" declares no dsh.bundle',
    'dsh web: http://127.0.0.1:1',
  ].join('\n'));
  const r = cli(['safe-overlay'], { env: sb.env });
  assert.strictEqual(r.json.ok, true, JSON.stringify(r.json));
  assert.ok(r.json.ids.includes('bad-plugin-x'), `ids: ${JSON.stringify(r.json.ids)}`);
  assert.ok(r.json.ids.includes('ghost-bundle'), 'bundle 形态也应命中');
  const text = fs.readFileSync(r.json.path, 'utf8');
  assert.ok(text.includes('- id: bad-plugin-x\n  disabled: true'), 'overlay 禁用条目');
  // 幂等：再跑一次不重复。
  const r2 = cli(['safe-overlay'], { env: sb.env });
  const dup = (fs.readFileSync(r2.json.path, 'utf8').match(/bad-plugin-x/g) || []).length;
  assert.strictEqual(dup, 1, '重复执行不得重复登记');
});

test('safe-overlay：无失败日志 → 不生成禁用条目', { skip: !HAVE_DEPS }, (t) => {
  const sb = sandbox(t.name);
  t.after(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  const r = cli(['safe-overlay'], { env: sb.env });
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(r.json.ids, [], '干净日志应返回空名单');
  assert.strictEqual(fs.existsSync(path.join(sb.dir, 'safe-boot.overlay.yml')), false, '不应生成文件');
});
