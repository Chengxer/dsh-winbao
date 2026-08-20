'use strict';

// unit-compat-sync-dual-source.test.js — 双源卸载决策（patch ∪ state.uninstalled）回归：
//   · 仅状态存储卸载（patch 行被重置、无 removed 行）的插件不得被重新同步；
//   · 隔离（quarantine，非 uninstalled）的插件必须照常同步；
//   · sync-companion-plugins.js --dry-run 不写 desktop-plugin-state.json（readOnly 修复）。
// 运行：node --test scripts/test/unit-compat-sync-dual-source.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createPluginSync } = require('../integration/plugin-sync');
const { createEntryListYamlParser } = require('../lib/profile-reconcile');

const repoRoot = path.resolve(__dirname, '..', '..');
const cli = path.join(repoRoot, 'scripts', 'sync-companion-plugins.js');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-dual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 构造隔离的 createPluginSync ctx；appDir 指向真实 dsh-desktop（assets/plugins 只读使用）。 */
function makeSyncCtx(t) {
  const home = tmpdir(t);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-dual-ud-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const parse = createEntryListYamlParser();
  const ctx = {
    getHome: () => home,
    appDir: repoRoot,
    getUserDataDir: () => userDataDir,
    log: () => {},
    loadYaml: () => (parse ? { load: (c) => parse(c) } : null),
    loadSettings: () => ({}),
    saveSettings: () => {},
    getInstallAnchorDir: () => path.join(os.tmpdir(), 'dsh-compat-dual-no-anchor'),
  };
  return { ctx, home };
}

const balanceDest = (home) => path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-balance', 'package.json');

test('双源卸载：仅 state.uninstalled（patch 行已重置）的插件不得被重新同步', { skip: process.platform !== 'win32' }, (t) => {
  const { ctx, home } = makeSyncCtx(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  // patch 已重置（无 removed 行）：模拟 patch 行被其它写入方改写
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  // 家级状态存储：balance 已卸载（决策面）
  fs.writeFileSync(path.join(home, 'desktop-plugin-state.json'), JSON.stringify({
    v: 2,
    uninstalled: { balance: { name: '@deepseek-ai/dsh-balance', at: '2026-01-01T00:00:00.000Z', source: 'ui' } },
    quarantine: {},
  }, null, 2) + '\n');

  createPluginSync(ctx).sync();

  assert.ok(!fs.existsSync(balanceDest(home)), '仅状态存储卸载的插件（patch 行已重置）绝不能被重新同步');
});

test('双源卸载：隔离（quarantine，非 uninstalled）的插件必须照常同步', { skip: process.platform !== 'win32' }, (t) => {
  const { ctx, home } = makeSyncCtx(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  // 隔离（quarantine）不等于卸载（uninstalled）：不得进入 removedIds
  fs.writeFileSync(path.join(home, 'desktop-plugin-state.json'), JSON.stringify({
    v: 2,
    uninstalled: {},
    quarantine: { balance: { name: '@deepseek-ai/dsh-balance', at: '2026-01-01T00:00:00.000Z', source: 'runtime', reason: 'crash' } },
  }, null, 2) + '\n');

  createPluginSync(ctx).sync();

  assert.ok(fs.existsSync(balanceDest(home)), '隔离（非卸载）的插件必须照常同步');
});

// ---------------------------------------------------------------------------
// sync-companion-plugins.js --dry-run 不写 desktop-plugin-state.json（readOnly）
// ---------------------------------------------------------------------------

function runCliDryRun(home) {
  const res = spawnSync(process.execPath, [cli, home, '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_HOME: '',
      PATH: process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '',
    },
  });
  assert.strictEqual(res.status, 0, `CLI --dry-run 应正常退出（signal=${res.signal}）`);
}

test('sync CLI --dry-run：损坏状态文件不产生 .broken- 备份（readOnly 不写盘）', (t) => {
  const home = tmpdir(t);
  const stateFile = path.join(home, 'desktop-plugin-state.json');
  fs.writeFileSync(stateFile, '{broken json');
  const before = fs.readFileSync(stateFile, 'utf8');

  runCliDryRun(home);

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'dry-run 不得改写状态文件');
  assert.equal(fs.readdirSync(home).filter((n) => n.includes('.broken-')).length, 0, 'dry-run 不得产生 .broken- 备份');
});

test('sync CLI --dry-run：v1 状态文件不迁移为 v2（readOnly 不写盘）', (t) => {
  const home = tmpdir(t);
  const stateFile = path.join(home, 'desktop-plugin-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, uninstalled: { old: { name: 'old-pkg', at: '', source: 'ui' } } }));

  runCliDryRun(home);

  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).v, 1, 'dry-run 不得把 v1 迁移为 v2');
});
