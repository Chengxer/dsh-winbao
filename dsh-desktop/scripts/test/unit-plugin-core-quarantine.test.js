'use strict';

// quarantine.js 深测：自动隔离落盘（apply/applyBySource/clear）用真实
// PluginStateStore + 真实 WriteGate + 临时 profile 组装。
// 覆盖：community 行 disabled 覆盖 + state 决策、二次 apply 幂等、core/removed
// 拒绝、未知/非法 id、state.save 失败仍走 patch 运行期防线、applyBySource
// 三级映射与 thenable 契约、clear 幂等/未知、CRLF 保持、setEnabled 联动解除。
// 全部临时目录注入，绝不读写真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQuarantine } = require('../plugin-core/lib/quarantine');
const { createLifecycle } = require('../plugin-core/lib/lifecycle');
const { PluginStateStore } = require('../plugin-core/lib/state-store');
const { WriteGate } = require('../plugin-core/lib/fs-atomic');
const { collectInventory } = require('../plugin-core/lib/inventory');
const { ManifestStore } = require('../plugin-core/lib/manifest-store');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-quar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function readFileOr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * 组装真实 profile + 真实 state store + 真实 patch gate。
 * @param {string[]} bundles  额外 bundle（核心 @deepseek-ai/dsh-base 恒在）
 * @param {string} [patchText] cordis.patch.yml 初始内容
 * @param {boolean} [stateReadOnly] 让 state store 处于只读（save 恒 false）
 */
function makeCenter(t, { bundles = [], patchText = '', stateReadOnly = false } = {}) {
  const home = tmp(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...bundles] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText || '');
  for (const name of bundles) {
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name, version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export default {};\n');
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ' + name.replace('/', '-') + '\n      name: \'' + name + '\'\n');
  }
  const stateFile = path.join(home, 'desktop-plugin-state.json');
  const state = new PluginStateStore({ file: stateFile, readOnly: stateReadOnly });
  const manifestStore = new ManifestStore({ profileDir });
  const patchGate = new WriteGate({ lockDir: path.join(profileDir, '.locks') });
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const inventoryRows = () => collectInventory({
    profileDir,
    companionPlugins: [],
    patchText: readFileOr(patchFile),
    bundles: manifestStore.bundles(),
    state: { isUninstalled: (id) => state.isUninstalled(id), isQuarantined: (id) => state.isQuarantined(id) },
  });
  const quarantine = createQuarantine({ profileDir, state, gate: patchGate, inventoryRows });
  const lifecycle = createLifecycle({ profileDir, state, manifestStore, patchGate, inventoryRows });
  return { home, profileDir, state, manifestStore, patchGate, quarantine, lifecycle, inventoryRows, patchFile, stateFile };
}

// ── 1. apply 落盘：community 行 disabled 覆盖 + state 决策 + 二次幂等 ────────

test('quarantine.apply: community 行写 disabled 覆盖 + state 决策；二次 apply applied:false', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const r1 = await c.quarantine.apply('third-party-bundle', { source: 'runtime', reason: '持续异常' });
  assert.deepEqual(r1, { ok: true, applied: true });

  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.match(patch, /- id: third-party-bundle/);
  assert.match(patch, /disabled: true/, '顶层 disabled 覆盖行（运行期防线先落盘）');

  const q = c.state.getQuarantined();
  assert.ok(q['third-party-bundle'], 'state.quarantine 记录该 id');
  assert.equal(q['third-party-bundle'].source, 'runtime');
  assert.equal(q['third-party-bundle'].reason, '持续异常');
  assert.ok(c.state.isQuarantined('third-party-bundle'));

  // 二次 apply：patch 已 disabled → applied:false（文本不变），但 state 重新落决策。
  const before = fs.readFileSync(c.patchFile, 'utf8');
  const r2 = await c.quarantine.apply('third-party-bundle', { source: 'boot', reason: '再次' });
  assert.deepEqual(r2, { ok: true, applied: false });
  assert.equal(fs.readFileSync(c.patchFile, 'utf8'), before, 'patch 无重复改写');
  assert.ok(c.state.isQuarantined('third-party-bundle'), 'state 仍为隔离态');
});

// ── 2. core / removed / 未知 / 非法 id ──────────────────────────────────────

test('quarantine.apply: 核心插件不隔离（ok/applied false，无 patch/state 变更）', async (t) => {
  const c = makeCenter(t);
  const r = await c.quarantine.apply('dsh-base', { source: 'runtime' });
  assert.deepEqual(r, { ok: true, applied: false });
  assert.equal(fs.readFileSync(c.patchFile, 'utf8'), '', 'patch 不变');
  assert.ok(!c.state.isQuarantined('dsh-base'));
});

test('quarantine.apply: 已卸载（removed）行 no-op', async (t) => {
  const c = makeCenter(t, {
    patchText: "- id: gone\n  name: 'gone-pkg'\n  disabled: true\n  removed: true\n",
  });
  const before = fs.readFileSync(c.patchFile, 'utf8');
  const r = await c.quarantine.apply('gone', { source: 'runtime' });
  assert.deepEqual(r, { ok: true, applied: false });
  assert.equal(fs.readFileSync(c.patchFile, 'utf8'), before, 'patch 不变');
  assert.ok(!c.state.isQuarantined('gone'));
});

test('quarantine.apply: 未知 id → PLUGIN_NOT_FOUND', async (t) => {
  const c = makeCenter(t);
  const r = await c.quarantine.apply('nope', { source: 'runtime' });
  assert.deepEqual(r.ok, false);
  assert.equal(r.applied, false);
  assert.equal(r.error.code, 'PLUGIN_NOT_FOUND');
});

test('quarantine.apply: 非法 id 抛 PluginError(PLUGIN_BAD_ID)', async (t) => {
  const c = makeCenter(t);
  await assert.rejects(c.quarantine.apply('../x', { source: 'runtime' }), (e) => e.code === 'PLUGIN_BAD_ID');
});

// ── 3. state.save 失败：patch 覆盖行仍是运行期防线 ──────────────────────────

test('quarantine.apply: state.save 失败仍 {ok:true, applied:true}（patch 行是运行期防线）', async (t) => {
  // 只读 state store 使 save() 恒返回 false（与「状态文件只读磁盘不可写」同一代码
  // 路径），确定性跨平台复现「决策持久化失败」；patch 覆盖行仍先落盘。
  const c = makeCenter(t, { bundles: ['third-party-bundle'], stateReadOnly: true });
  const r = await c.quarantine.apply('third-party-bundle', { source: 'runtime', reason: '异常' });
  assert.deepEqual(r, { ok: true, applied: true });
  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.match(patch, /disabled: true/, 'patch 覆盖行已写入（运行期防线）');
  assert.ok(!c.state.isQuarantined('third-party-bundle'), 'state 落盘失败已回滚（隔离态仅存在于 patch）');
});

// ── 4. applyBySource 三级映射 + thenable 契约 ──────────────────────────────

test('quarantine.applyBySource: 精确名 / 去 scope 名 / id 三级映射', async (t) => {
  const c = makeCenter(t, { bundles: ['@evil/alpha-pkg', 'beta-pkg', '@evil/gamma-pkg'] });
  // 精确包名（row.name === token）
  const r1 = await c.quarantine.applyBySource('@evil/alpha-pkg', { source: 'runtime' });
  assert.ok(r1.ok && r1.applied);
  await c.quarantine.clear('alpha-pkg');
  // scoped token → bare-name 匹配（row.name 是裸名 beta-pkg）
  const r2 = await c.quarantine.applyBySource('@scope/beta-pkg', { source: 'runtime' });
  assert.ok(r2.ok && r2.applied);
  await c.quarantine.clear('beta-pkg');
  // id 匹配（第三兜底：row.name '@evil/gamma-pkg'，token 'gamma-pkg' 命中 row.id）
  const r3 = await c.quarantine.applyBySource('gamma-pkg', { source: 'runtime' });
  assert.ok(r3.ok && r3.applied);
  await c.quarantine.clear('gamma-pkg');
});

test('quarantine.applyBySource: 无法映射 → {ok:true, applied:false} 且返回 Promise', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const p = c.quarantine.applyBySource('unknown-pkg', { source: 'runtime' });
  assert.ok(p instanceof Promise, '返回值是 Promise');
  assert.equal(typeof p.then, 'function', '返回值是 thenable（.then 可用，修复历史非 Promise 回归）');
  const r = await p;
  assert.deepEqual(r, { ok: true, applied: false });
  assert.ok(!c.state.isQuarantined('third-party-bundle'), '不误伤其它插件');
});

test('quarantine.applyBySource: 空来源 → {ok:false, applied:false}（Promise）', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const p = c.quarantine.applyBySource('', { source: 'runtime' });
  assert.ok(p instanceof Promise);
  assert.deepEqual(await p, { ok: false, applied: false });
  assert.ok(!c.state.isQuarantined('third-party-bundle'));
});

// ── 5. clear：移除 disabled 行 + 清决策；幂等；未知；CRLF 保持 ─────────────

test('quarantine.clear: 移除 disabled 行 + 清决策；幂等', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  await c.quarantine.apply('third-party-bundle', { source: 'runtime' });
  const r1 = await c.quarantine.clear('third-party-bundle');
  assert.ok(r1.ok);
  assert.ok(!c.state.isQuarantined('third-party-bundle'));
  assert.ok(!fs.readFileSync(c.patchFile, 'utf8').includes('third-party-bundle'), 'disabled 行移除');
  // 幂等：再次 clear 不抛错
  const r2 = await c.quarantine.clear('third-party-bundle');
  assert.ok(r2.ok);
});

test('quarantine.clear: 未知 id → PLUGIN_NOT_FOUND', async (t) => {
  const c = makeCenter(t);
  const r = await c.quarantine.clear('nope');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PLUGIN_NOT_FOUND');
});

test('quarantine: CRLF patch 经 apply+clear 后仍保持 CRLF', async (t) => {
  const crlf = "# 头部注释\r\n- id: web\r\n  name: 'web'\r\n  disabled: true\r\n";
  const c = makeCenter(t, { bundles: ['third-party-bundle'], patchText: crlf });
  const assertCrlf = (label) => {
    const text = fs.readFileSync(c.patchFile, 'utf8');
    assert.ok(text.includes('\r\n'), label + ': 仍含 CRLF');
    assert.ok(!text.replace(/\r\n/g, '').includes('\n'), label + ': 不得出现孤立 LF');
  };
  await c.quarantine.apply('third-party-bundle', { source: 'runtime' });
  assertCrlf('apply 后');
  assert.match(fs.readFileSync(c.patchFile, 'utf8'), /- id: third-party-bundle/);
  await c.quarantine.clear('third-party-bundle');
  assertCrlf('clear 后');
  assert.ok(!fs.readFileSync(c.patchFile, 'utf8').includes('third-party-bundle'));
});

// ── 6. Interplay：apply 后 setEnabled(true) 联动解除隔离 ─────────────────────

test('quarantine → lifecycle.setEnabled(true)：patch 启用 + state 清隔离', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  await c.quarantine.apply('third-party-bundle', { source: 'runtime' });
  assert.ok(c.state.isQuarantined('third-party-bundle'));

  const res = await c.lifecycle.setEnabled('third-party-bundle', true);
  assert.ok(res.ok);
  assert.ok(!c.state.isQuarantined('third-party-bundle'), '启用即解除隔离决策');
  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.ok(!patch.includes('third-party-bundle'), 'disabled 覆盖行移除');

  const row = c.inventoryRows().find((r) => r.id === 'third-party-bundle');
  assert.ok(row);
  assert.equal(row.enabled, true);
  assert.equal(row.quarantined, false);
});
