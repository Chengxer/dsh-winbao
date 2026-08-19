'use strict';

// inventory / lifecycle / manifest-store / quarantine 单测：
// 第三方 bundle 可管理分组、卸载彻底性（deps 移除 + 不复活 + 第三方恢复拒绝）、
// 隔离闭环（apply → disabled 行 → clear 恢复）。全部临时目录注入。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectInventory } = require('../plugin-core/lib/inventory');
const { ManifestStore } = require('../plugin-core/lib/manifest-store');
const { createLifecycle, packageDirOf, cleanupStaleTrash } = require('../plugin-core/lib/lifecycle');
const { createQuarantine } = require('../plugin-core/lib/quarantine');
const { PluginStateStore } = require('../plugin-core/lib/state-store');
const { WriteGate } = require('../plugin-core/lib/fs-atomic');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-life-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function makeProfile(t) {
  const home = tmp(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '');
  return { home, profileDir };
}

function makeCenter(t, { bundles = [], deps = {} } = {}) {
  const { home, profileDir } = makeProfile(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles];
  manifest.dependencies = deps;
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // 第三方 bundle 落盘（含补丁层与入口，可装配形态）。
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
  const state = new PluginStateStore({ file: path.join(home, 'desktop-plugin-state.json') });
  const manifestStore = new ManifestStore({ profileDir });
  const patchGate = new WriteGate({ lockDir: path.join(profileDir, '.locks') });
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const companionPlugins = [
    { id: 'companion-bundle', name: 'companion-bundle-pkg' },
    { id: 'companion-row', name: 'companion-row-pkg' },
  ];
  const inventoryRows = () => collectInventory({
    profileDir,
    companionPlugins,
    patchText: (() => { try { return fs.readFileSync(patchFile, 'utf8'); } catch { return ''; } })(),
    bundles: manifestStore.bundles(),
    state: { isUninstalled: (id) => state.isUninstalled(id), isQuarantined: (id) => state.isQuarantined(id) },
  });
  const lifecycle = createLifecycle({ profileDir, state, manifestStore, patchGate, inventoryRows });
  const quarantine = createQuarantine({ profileDir, state, gate: patchGate, inventoryRows });
  return { home, profileDir, state, manifestStore, lifecycle, quarantine, inventoryRows, patchFile };
}

test('inventory: 第三方 bundle 归入 community 组（可开关、可卸载）', (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'], deps: { 'third-party-bundle': '1.0.0' } });
  const rows = c.inventoryRows();
  const row = rows.find((r) => r.id === 'third-party-bundle');
  assert.ok(row, '第三方 bundle 应出现在清单');
  assert.equal(row.group, 'community');
  assert.equal(row.toggleable, true);
  const core = rows.find((r) => r.group === 'core');
  assert.ok(core);
  assert.equal(core.toggleable, false);
});

test('lifecycle.uninstall: 第三方 bundle 彻底卸载（bundles+dependencies+目录+store 全清）', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'], deps: { 'third-party-bundle': '1.0.0' } });
  // 模拟 pnpm store 副本
  const storeDir = path.join(c.profileDir, 'node_modules', '.pnpm', 'third-party-bundle@1.0.0');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'package.json'), JSON.stringify({ name: 'third-party-bundle', version: '1.0.0' }));
  const res = await c.lifecycle.uninstall('third-party-bundle');
  assert.ok(res.ok);
  const manifest = JSON.parse(fs.readFileSync(path.join(c.profileDir, 'package.json'), 'utf8'));
  assert.ok(!manifest.dsh.profile.bundles.includes('third-party-bundle'), 'bundles 登记移除');
  assert.ok(!manifest.dependencies || !manifest.dependencies['third-party-bundle'], 'dependencies 键移除（防 pnpm 复活）');
  assert.ok(!fs.existsSync(path.join(c.profileDir, 'node_modules', 'third-party-bundle')), '包目录移除');
  assert.ok(!fs.existsSync(storeDir), 'store 副本清理');
  // patch 行：disabled + removed 顶层条目
  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.match(patch, /removed: true/);
  assert.match(patch, /disabled: true/);
  // 状态存储持久化
  const reloaded = new PluginStateStore({ file: path.join(c.home, 'desktop-plugin-state.json') });
  assert.ok(reloaded.isUninstalled('third-party-bundle'));
});

test('lifecycle.restore: 第三方恢复返回 PLUGIN_RESTORE_NO_SOURCE（修复假成功）', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  await c.lifecycle.uninstall('third-party-bundle');
  await assert.rejects(c.lifecycle.restore('third-party-bundle'), (err) => err.code === 'PLUGIN_RESTORE_NO_SOURCE');
});

test('lifecycle.uninstall: 核心组件拒绝卸载（PLUGIN_CORE_PROTECTED）', async (t) => {
  const c = makeCenter(t);
  await assert.rejects(c.lifecycle.uninstall('dsh-base'), (err) => err.code === 'PLUGIN_CORE_PROTECTED');
});

test('lifecycle.uninstall: 带 config 的用户条目拒绝卸载（PLUGIN_HAS_CONFIG）', async (t) => {
  const c = makeCenter(t);
  fs.writeFileSync(c.patchFile, '- id: web\n  name: \'x\'\n  config:\n    a: 1\n');
  await assert.rejects(c.lifecycle.uninstall('web'), (err) => err.code === 'PLUGIN_HAS_CONFIG');
});

test('quarantine: apply 写 disabled 覆盖 + state；clear 恢复（闭环）', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const r = await c.quarantine.apply('third-party-bundle', { source: 'runtime', reason: '异常' });
  assert.ok(r.ok && r.applied);
  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.match(patch, /- id: third-party-bundle/);
  assert.match(patch, /disabled: true/);
  assert.ok(c.state.isQuarantined('third-party-bundle'));
  const rc = await c.quarantine.clear('third-party-bundle');
  assert.ok(rc.ok);
  assert.ok(!c.state.isQuarantined('third-party-bundle'));
  const patch2 = fs.readFileSync(c.patchFile, 'utf8');
  assert.ok(!patch2.includes('third-party-bundle'), '清除后 disabled 条目移除');
});

test('quarantine: 核心插件不参与自动隔离（交由启动自愈）', async (t) => {
  const c = makeCenter(t);
  const r = await c.quarantine.apply('dsh-base', { source: 'runtime' });
  assert.ok(r.ok && !r.applied);
  assert.ok(!c.state.isQuarantined('dsh-base'));
});

test('manifest-store: 非字符串 bundle 项在 removeBundles 中原样保留（不丢数据）', async (t) => {
  const { home, profileDir } = makeProfile(t);
  void home;
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  manifest.dsh.profile.bundles = ['dsh-ok', 42];
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2));
  const store = new ManifestStore({ profileDir });
  const removed = await store.removeBundles(['dsh-ok']);
  assert.deepEqual(removed, ['dsh-ok']);
  const after = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(after.dsh.profile.bundles, [42], '非字符串项原样保留');
});

test('manifest-store: 备份保留最近 5 份', (t) => {
  const { home, profileDir } = makeProfile(t);
  void home;
  const store = new ManifestStore({ profileDir, backupKeep: 5 });
  for (let i = 1; i <= 8; i += 1) {
    store.setBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'extra-' + i]);
  }
  const backups = fs.readdirSync(profileDir).filter((n) => n.includes('package.json.bak-'));
  assert.ok(backups.length <= 5, '备份不超过 5 份');
});

test('lifecycle: 运行中卸载走 rename 语义（.trash 残留不阻塞）', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const dir = packageDirOf(c.profileDir, 'third-party-bundle');
  assert.ok(dir);
  // 模拟运行中文件被锁：让 trash 删除失败（用只读目录内容占位）。
  fs.writeFileSync(path.join(dir, 'locked.bin'), 'x');
  const res = await c.lifecycle.uninstall('third-party-bundle');
  assert.ok(res.ok, '卸载不因删除失败而失败（rename 已移出）');
  assert.ok(!fs.existsSync(dir), '原目录已移出');
});

test('cleanupStaleTrash: 24h 前的 .trash 清理，新残留保留', (t) => {
  const { profileDir } = makeProfile(t);
  const modules = path.join(profileDir, 'node_modules');
  const now = Date.now();
  const oldName = 'pkg.trash-' + (now - 25 * 3600 * 1000) + '-1';
  const freshName = 'pkg.trash-' + now + '-2';
  fs.mkdirSync(path.join(modules, oldName), { recursive: true });
  fs.mkdirSync(path.join(modules, freshName), { recursive: true });
  cleanupStaleTrash(profileDir, { now });
  assert.ok(!fs.existsSync(path.join(modules, oldName)), '旧残留清理');
  assert.ok(fs.existsSync(path.join(modules, freshName)), '新残留保留');
});

// ── 对抗性审查修复回归：配套插件卸载→恢复闭环 / setEnabled / applyBySource ──

test('lifecycle: 配套插件卸载后可以恢复（修复「恢复失效」回归）', async (t) => {
  const c = makeCenter(t);
  // 配套 bundle 落盘（可装配形态）。
  const dir = path.join(c.profileDir, 'node_modules', 'companion-bundle-pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'companion-bundle-pkg', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export default {};\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: companion-bundle\n      name: \'companion-bundle-pkg\'\n');
  const res1 = await c.lifecycle.uninstall('companion-bundle');
  assert.ok(res1.ok);
  // 卸载后 group 为 'removed'，但恢复资格（restorable）仍成立。
  const rowAfter = c.inventoryRows().find((r) => r.id === 'companion-bundle');
  assert.equal(rowAfter.group, 'removed');
  assert.equal(rowAfter.restorable, true);
  const res2 = await c.lifecycle.restore('companion-bundle');
  assert.ok(res2.ok, '配套插件应可恢复');
  assert.ok(!c.state.isUninstalled('companion-bundle'));
  const patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.ok(!patch.includes('removed: true'), '恢复后 removed 标记清除');
});

test('lifecycle.setEnabled: 开关写入 patch 且幂等', async (t) => {
  const c = makeCenter(t, { bundles: ['third-party-bundle'] });
  const res = await c.lifecycle.setEnabled('third-party-bundle', false);
  assert.ok(res.ok);
  let patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.match(patch, /- id: third-party-bundle/);
  assert.match(patch, /disabled: true/);
  // 再次关闭：幂等（不重复追加条目）。
  await c.lifecycle.setEnabled('third-party-bundle', false);
  patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.equal((patch.match(/^\s*- id: third-party-bundle\s*$/gm) || []).length, 1);
  // 启用：disabled 行移除。
  await c.lifecycle.setEnabled('third-party-bundle', true);
  patch = fs.readFileSync(c.patchFile, 'utf8');
  assert.ok(!patch.includes('third-party-bundle'), '启用后条目移除');
});

test('lifecycle.setEnabled: 核心插件拒绝（PLUGIN_NOT_TOGGLEABLE）', async (t) => {
  const c = makeCenter(t);
  await assert.rejects(c.lifecycle.setEnabled('dsh-base', false), (err) => err.code === 'PLUGIN_NOT_TOGGLEABLE');
});

test('lifecycle.setEnabled: 未知插件拒绝（PLUGIN_NOT_FOUND）', async (t) => {
  const c = makeCenter(t);
  await assert.rejects(c.lifecycle.setEnabled('nope', false), (err) => err.code === 'PLUGIN_NOT_FOUND');
});

test('quarantine.applyBySource: 包名/去 scope 名/id 三级映射', async (t) => {
  const c = makeCenter(t, { bundles: ['@evil/bad-bundle'] });
  // 精确包名
  const r1 = await c.quarantine.applyBySource('@evil/bad-bundle', { source: 'runtime' });
  assert.ok(r1.ok && r1.applied);
  await c.quarantine.clear('bad-bundle');
  // 去 scope 名（inventory 行的 id 是 bad-bundle）
  const r2 = await c.quarantine.applyBySource('bad-bundle', { source: 'runtime' });
  assert.ok(r2.ok && r2.applied);
  await c.quarantine.clear('bad-bundle');
  // 无法映射的来源：不误伤
  const r3 = await c.quarantine.applyBySource('unknown-pkg', { source: 'runtime' });
  assert.ok(r3.ok && !r3.applied);
});
