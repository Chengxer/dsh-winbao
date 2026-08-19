'use strict';

// patch-target-resolver 单元测试（node --test）。
// 验证五函数收敛为 resolvePatchTargets / resolveNmRoots 后，各布局与旧实现的
// 路径构造逐项一致（localCopyFiles / guardCopyFiles / patchTargets /
// localNodeModulesRoots / slotCompat*），且 WSL 布局选择正确。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolvePatchTargets,
  resolveNmRoots,
  slotCompatCopyFiles,
  slotCompatPatchTargets,
  SLOT_KEY_COMPAT_PKG_REL,
  SLOT_UNKEYED_COMPAT_PKG_REL,
  SLOT_COMPAT_PKG_RELS,
} = require('../lib/patch-target-resolver');

const CTX = {
  home: 'C:\\Users\\t\\.dsh',
  appDir: 'C:\\app\\resources\\app',
  userDataDir: 'C:\\Users\\t\\AppData\\Roaming\\DSH Desktop',
  wslMode: false,
};

test('runtime-local 布局 = 硬编码三副本（golden，非同义反复）', () => {
  const rel = path.join('dsh-client-runtime', 'lib', 'client.js');
  const got = resolvePatchTargets(CTX, { layout: 'runtime-local', pkgRel: rel });
  // 硬编码 golden 期望，证明 resolver 输出正确（而非与自身薄封装 f(x)===f(x)）。
  assert.deepEqual(got, [
    path.join(CTX.home, 'profiles', 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.appDir, 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.userDataDir, 'agent', 'node_modules', '@deepseek-ai', rel),
  ]);
  assert.equal(got.length, 3);
});

test('guard 布局 = 硬编码四副本（golden，含嵌套 dsh）', () => {
  const rel = path.join('dsh-app-boot', 'lib', 'index.js');
  const got = resolvePatchTargets(CTX, { layout: 'guard', pkgRel: rel });
  assert.deepEqual(got, [
    path.join(CTX.appDir, 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.userDataDir, 'agent', 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.userDataDir, 'agent', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.home, 'profiles', 'node_modules', '@deepseek-ai', rel),
  ]);
  assert.equal(got.length, 4);
  // 第三项必须是 overlay 嵌套 dsh 依赖副本。
  assert.ok(got[2].includes(path.join('dsh', 'node_modules', '@deepseek-ai')));
});

test('wsl 布局 = 硬编码 profile fallback + agent（golden）', () => {
  const rel = path.join('dsh-host-apiproxy', 'lib', 'index.js');
  const got = resolvePatchTargets(CTX, { layout: 'wsl', pkgRel: rel });
  assert.deepEqual(got, [
    path.join(CTX.home, 'profiles', 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.home, 'agent', 'node_modules', '@deepseek-ai', rel),
  ]);
  assert.equal(got.length, 2);
});

test('wslLayout 存在且 ctx.wslMode 时优先 wsl 布局', () => {
  const rel = path.join('dsh-client-runtime', 'lib', 'client.js');
  const wslCtx = { ...CTX, wslMode: true };
  const got = resolvePatchTargets(wslCtx, { layout: 'runtime-local', wslLayout: 'wsl', pkgRel: rel });
  assert.deepEqual(got, [
    path.join(CTX.home, 'profiles', 'node_modules', '@deepseek-ai', rel),
    path.join(CTX.home, 'agent', 'node_modules', '@deepseek-ai', rel),
  ]);
  // 非 WSL 仍走本地三副本。
  assert.deepEqual(
    resolvePatchTargets(CTX, { layout: 'runtime-local', wslLayout: 'wsl', pkgRel: rel }),
    [
      path.join(CTX.home, 'profiles', 'node_modules', '@deepseek-ai', rel),
      path.join(CTX.appDir, 'node_modules', '@deepseek-ai', rel),
      path.join(CTX.userDataDir, 'agent', 'node_modules', '@deepseek-ai', rel),
    ],
  );
});

test('nm-roots 布局：硬编码本地三根、WSL 追加 agent 直连根（golden）', () => {
  const local = resolveNmRoots(CTX, { layout: 'nm-roots' });
  assert.deepEqual(local, [
    path.join(CTX.home, 'profiles', 'node_modules'),
    path.join(CTX.appDir, 'node_modules'),
    path.join(CTX.userDataDir, 'agent', 'node_modules'),
  ]);
  const wsl = resolveNmRoots({ ...CTX, wslMode: true }, { layout: 'nm-roots' });
  assert.deepEqual(wsl, [
    path.join(CTX.home, 'profiles', 'node_modules'),
    path.join(CTX.appDir, 'node_modules'),
    path.join(CTX.userDataDir, 'agent', 'node_modules'),
    path.join(CTX.home, 'agent', 'node_modules'),
  ]);
  assert.equal(wsl.length, 4);
});

test('slot-compat 布局（本地）逐文件 = 单 pkgRel 子集（去重）', () => {
  const rel = SLOT_KEY_COMPAT_PKG_REL;
  const got = resolvePatchTargets(CTX, { layout: 'slot-compat', pkgRel: rel });
  // 单文件布局只应包含该 pkgRel 的副本（不得再返回完整 pkgRels 并集，避免双重处理）。
  assert.ok(got.length > 0, '应返回该 pkgRel 的副本');
  assert.ok(got.every((f) => f.includes(rel)), '单文件布局只应包含目标 pkgRel');
  assert.equal(got.length, new Set(got).size, '应去重');
  // 全量 compat 函数仍是 SLOT_COMPAT_PKG_RELS 的并集。
  const full = slotCompatCopyFiles(CTX.home, CTX.appDir, CTX.userDataDir);
  assert.ok(full.some((f) => f.includes(SLOT_KEY_COMPAT_PKG_REL)));
  assert.ok(full.some((f) => f.includes(SLOT_UNKEYED_COMPAT_PKG_REL)));
  assert.equal(full.length, new Set(full).size, 'compat 全量应去重');
});

test('slot-compat-wsl 布局（本地）逐文件 = 单 pkgRel 子集（去重）', () => {
  const rel = SLOT_KEY_COMPAT_PKG_REL;
  const got = resolvePatchTargets(CTX, { layout: 'slot-compat-wsl', pkgRel: rel });
  assert.ok(got.length > 0, '应返回该 pkgRel 的副本');
  assert.ok(got.every((f) => f.includes(rel)), '单文件布局只应包含目标 pkgRel');
  assert.equal(got.length, new Set(got).size, '应去重');
  const full = slotCompatPatchTargets(CTX.home);
  assert.ok(full.some((f) => f.includes(SLOT_KEY_COMPAT_PKG_REL)));
  assert.ok(full.some((f) => f.includes(SLOT_UNKEYED_COMPAT_PKG_REL)));
  assert.equal(full.length, new Set(full).size, 'compat 全量应去重');
});

test('未知布局返回空数组（不抛异常）', () => {
  assert.deepEqual(resolvePatchTargets(CTX, { layout: 'nope', pkgRel: 'x' }), []);
});

test('profile-boot-dirs 布局返回三个候选目录', () => {
  const dirs = resolvePatchTargets(CTX, { layout: 'profile-boot-dirs' });
  assert.equal(dirs.length, 3);
  for (const d of dirs) assert.ok(d.endsWith(path.join('@deepseek-ai', 'dsh', 'lib')));
});
