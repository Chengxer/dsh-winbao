'use strict';

// inventory 深测：§6 分组矩阵、enabled/toggleable 判定、quarantined 标记、
// 排序、去重、describe 注入、scope id 提取、空输入。纯函数，零文件系统。

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectInventory, findRow, GROUP_ORDER } = require('../plugin-core/lib/inventory');

const DEFAULTS = { profileDir: '/unused', companionPlugins: [], patchText: '', bundles: [] };
const collect = (o) => collectInventory({ ...DEFAULTS, ...o });
const row = (o, id) => collect(o).find((r) => r.id === id);

// ── §6 分组矩阵 ───────────────────────────────────────────────────────────

test('core：bundle 命中 CORE_BUNDLE_NAMES → core、不可开关、不可恢复', () => {
  const r = row({ bundles: ['@deepseek-ai/dsh-base'] }, 'dsh-base');
  assert.ok(r);
  assert.equal(r.group, 'core');
  assert.equal(r.toggleable, false);
  assert.equal(r.restorable, false);
  assert.equal(r.name, '@deepseek-ai/dsh-base');
});

test('companion：配套插件在 bundles → companion、可开关、可恢复', () => {
  const r = row(
    { companionPlugins: [{ id: 'file-drop', name: 'dsh-file-drop' }], bundles: ['dsh-file-drop'] },
    'file-drop'
  );
  assert.ok(r);
  assert.equal(r.group, 'companion');
  assert.equal(r.toggleable, true);
  assert.equal(r.restorable, true);
});

test('community：第三方 bundle → community、可开关、不可恢复', () => {
  const r = row({ bundles: ['third-party-bundle'] }, 'third-party-bundle');
  assert.ok(r);
  assert.equal(r.group, 'community');
  assert.equal(r.toggleable, true);
  assert.equal(r.restorable, false);
});

test('other：仅 patch insert 的非配套条目 → other', () => {
  const r = row({ patchText: '- insert:\n    - id: my-id\n      name: \'pkg\'\n' }, 'my-id');
  assert.ok(r);
  assert.equal(r.group, 'other');
  assert.equal(r.toggleable, true);
});

test('other：顶层用户条目 → other', () => {
  const r = row({ patchText: '- id: web\n  name: \'x\'\n' }, 'web');
  assert.ok(r);
  assert.equal(r.group, 'other');
});

test('removed：patch 顶层 removed:true 条目 → removed', () => {
  const r = row({ patchText: '- id: some-id\n  name: \'pkg\'\n  disabled: true\n  removed: true\n' }, 'some-id');
  assert.ok(r);
  assert.equal(r.group, 'removed');
  assert.equal(r.removed, true);
});

test('removed：仅 state 卸载（patch 为普通条目）→ removed（修复锚定）', () => {
  const state = { isUninstalled: (id) => id === 'file-drop', isQuarantined: () => false };
  const r = row(
    {
      companionPlugins: [{ id: 'file-drop', name: 'dsh-file-drop' }],
      patchText: '- id: file-drop\n  name: \'dsh-file-drop\'\n',
      state,
    },
    'file-drop'
  );
  assert.ok(r);
  assert.equal(r.group, 'removed');
  assert.equal(r.removed, true);
});

test('removed：配套插件仅 state 卸载 → removed 且 restorable、removed 均为 true', () => {
  const state = { isUninstalled: (id) => id === 'file-drop', isQuarantined: () => false };
  const r = row(
    {
      companionPlugins: [{ id: 'file-drop', name: 'dsh-file-drop' }],
      patchText: '- id: file-drop\n  name: \'dsh-file-drop\'\n',
      state,
    },
    'file-drop'
  );
  assert.equal(r.restorable, true, '卸载后的配套仍可恢复');
  assert.equal(r.removed, true);
});

// ── enabled / toggleable 判定 ─────────────────────────────────────────────

test('enabled：disabled:true → enabled false；disabled:false → enabled true', () => {
  const off = row({ patchText: '- id: x\n  name: \'p\'\n  disabled: true\n' }, 'x');
  assert.equal(off.enabled, false);
  const on = row({ patchText: '- id: x\n  name: \'p\'\n  disabled: false\n' }, 'x');
  assert.equal(on.enabled, true);
});

test('toggleable：hasConfig 且 enabled → false；hasConfig 且 disabled → true', () => {
  const enabled = row({ patchText: '- id: x\n  name: \'p\'\n  config:\n    a: 1\n' }, 'x');
  assert.equal(enabled.hasConfig, true);
  assert.equal(enabled.toggleable, false, '带配置且启用的插件不可开关（卸载禁止）');
  const disabled = row({ patchText: '- id: x\n  name: \'p\'\n  disabled: true\n  config:\n    a: 1\n' }, 'x');
  assert.equal(disabled.hasConfig, true);
  assert.equal(disabled.toggleable, true, '带配置但已禁用时可重新启用');
});

test('quarantined 标记来自 state.isQuarantined', () => {
  const state = { isUninstalled: () => false, isQuarantined: (id) => id === 'x' };
  const rows = collect({
    companionPlugins: [{ id: 'x', name: 'pkg-x' }, { id: 'y', name: 'pkg-y' }],
    state,
  });
  const rx = rows.find((r) => r.id === 'x');
  const ry = rows.find((r) => r.id === 'y');
  assert.equal(rx.quarantined, true);
  assert.equal(ry.quarantined, false);
});

// ── 排序 / 去重 / describe / scope id / 空输入 ────────────────────────────

test('排序：companion < community < other < core < removed，再按 id', () => {
  const rows = collect({
    companionPlugins: [{ id: 'zcomp', name: 'comp-pkg' }],
    patchText: '- id: r\n  removed: true\n- insert:\n    - id: o\n      name: \'opkg\'\n',
    bundles: ['@deepseek-ai/dsh-base', 'comm-pkg'],
  });
  assert.deepEqual(rows.map((r) => r.group), ['companion', 'community', 'other', 'core', 'removed']);
  // 同组按 id 排序
  const two = collect({
    companionPlugins: [{ id: 'b', name: 'pb' }, { id: 'a', name: 'pa' }],
  });
  assert.deepEqual(two.map((r) => r.id), ['a', 'b']);
});

test('去重：同 id 同时出现在配套表与 insert → 单行（companion 优先）', () => {
  const rows = collect({
    companionPlugins: [{ id: 'x', name: 'pkg-x' }],
    patchText: '- insert:\n    - id: x\n      name: \'pkg-x\'\n',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, 'companion');
});

test('describe 回调以 name 调用并写入 description；scoped bundle 提取 id', () => {
  const calls = [];
  const rows = collect({
    bundles: ['@scope/name-pkg', 'plain-pkg'],
    describe: (name) => { calls.push(name); return 'DESC:' + name; },
  });
  const scoped = rows.find((r) => r.id === 'name-pkg');
  assert.ok(scoped, 'scope 包 id 提取为去 scope 名');
  assert.equal(scoped.name, '@scope/name-pkg');
  assert.equal(scoped.description, 'DESC:@scope/name-pkg');
  assert.ok(calls.includes('@scope/name-pkg'), 'describe 以完整包名调用');
  const plain = rows.find((r) => r.id === 'plain-pkg');
  assert.equal(plain.description, 'DESC:plain-pkg');
});

test('空输入：无 patch、无 manifest → 仅配套清单行', () => {
  const rows = collect({ companionPlugins: [{ id: 'a', name: 'pkg-a' }] });
  assert.deepEqual(rows.map((r) => r.id), ['a']);
  assert.deepEqual(collect({}), [], '全空 → 空清单');
});

test('findRow：按 id 定位，未知返回 undefined', () => {
  const rows = collect({ companionPlugins: [{ id: 'a', name: 'pkg-a' }] });
  assert.equal(findRow(rows, 'a').id, 'a');
  assert.equal(findRow(rows, 'nope'), undefined);
});
