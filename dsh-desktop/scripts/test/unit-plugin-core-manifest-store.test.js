'use strict';

// manifest-store 深测：唯一读写方契约（零写入、EOL 保持、备份轮转、损坏/缺失、
// removeBundles / removeDependencies / setBundles 边界、兼容包装）。全部临时目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ManifestStore, removeBundlesFromProfile } = require('../plugin-core/lib/manifest-store');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function writeManifest(profileDir, obj, { crlf = false } = {}) {
  let text = JSON.stringify(obj, null, 2) + '\n';
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), text);
  return text;
}

function readManifest(profileDir) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

const baseManifest = () => ({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [] } },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── modify：零写入 / null 中止 / EOL / 备份轮转 / 损坏与缺失 ──────────────

test('modify: 内容未变 → changed:false 且不产生备份', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a', 'b'];
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const result = await store.modify((manifest) => manifest);
  assert.equal(result.changed, false);
  assert.equal(result.backup, null);
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['a', 'b']);
  const backups = fs.readdirSync(profileDir).filter((n) => n.includes('.bak-'));
  assert.equal(backups.length, 0, '零写入不产生备份');
});

test('modify: fn 返回 null → 不写入', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a'];
  const before = writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const result = await store.modify(() => null);
  assert.equal(result.changed, false);
  assert.equal(result.backup, null);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before);
});

test('modify: CRLF manifest 改写后仍保持 CRLF（无孤立 LF）', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a'];
  writeManifest(profileDir, m, { crlf: true });
  const store = new ManifestStore({ profileDir });
  const result = await store.modify((manifest) => {
    manifest.dsh.profile.bundles = ['a', 'b'];
    return manifest;
  });
  assert.equal(result.changed, true);
  const raw = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  assert.ok(raw.includes('\r\n'), 'CRLF 保留');
  assert.ok(!/(^|[^\r])\n/.test(raw), '无孤立 LF');
});

test('modify: LF manifest 改写后保持 LF', (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a'];
  writeManifest(profileDir, m, { crlf: false });
  const store = new ManifestStore({ profileDir });
  store.modify((manifest) => {
    manifest.dsh.profile.bundles = ['a', 'b'];
    return manifest;
  });
  const raw = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  assert.ok(raw.includes('\n'));
  assert.ok(!raw.includes('\r\n'), 'LF 保持');
});

test('modify: 备份轮转 ≤5 份（8 次修改）', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['@deepseek-ai/dsh-base'];
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir, backupKeep: 5 });
  for (let i = 1; i <= 8; i += 1) {
    // 错开时间戳，确保备份文件名不碰撞（同毫秒同名会覆盖）。
    await sleep(20);
    store.setBundles(['@deepseek-ai/dsh-base', 'extra-' + i]);
  }
  const backups = fs.readdirSync(profileDir).filter((n) => n.includes('package.json.bak-'));
  assert.ok(backups.length <= 5, '备份不超过 5 份');
  assert.ok(backups.length === 5, '8 次修改应恰好保留最近 5 份');
});

test('modify/removeBundles: 损坏 manifest → read null、removed []、零写入', async (t) => {
  const profileDir = tmp(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{ not valid json');
  const store = new ManifestStore({ profileDir });
  assert.equal(store.read(), null, '损坏读取返回 null');
  const removed = await store.removeBundles(['a']);
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), '{ not valid json', '文件未被改写');
});

test('removeBundles: 缺失 manifest → no-op，不创建文件', async (t) => {
  const profileDir = tmp(t);
  const store = new ManifestStore({ profileDir });
  assert.equal(store.read(), null);
  const removed = await store.removeBundles(['a']);
  assert.deepEqual(removed, []);
  assert.ok(!fs.existsSync(path.join(profileDir, 'package.json')), '不隐式创建文件');
});

// ── removeBundles ─────────────────────────────────────────────────────────

test('removeBundles: 输入去重、@deepseek-ai/* 跳过、非字符串项保留、返回实际移除名单', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a', '@deepseek-ai/dsh-base', 42, { pinned: true }];
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  // 'a' 传两次（去重）；@deepseek-ai/dsh-base 跳过（保留）；非字符串项不丢。
  const removed = await store.removeBundles(['a', 'a', '@deepseek-ai/dsh-base']);
  assert.deepEqual(removed, ['a']);
  const after = readManifest(profileDir).dsh.profile.bundles;
  assert.deepEqual(after, ['@deepseek-ai/dsh-base', 42, { pinned: true }], '非字符串项与核心 bundle 保留');
});

test('removeBundles: 目标缺失时返回空名单且零写入', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['keep'];
  const before = writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const removed = await store.removeBundles(['nope']);
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before);
});

// ── removeDependencies ────────────────────────────────────────────────────

test('removeDependencies: 只移除匹配键，删空后删除 dependencies 键，支持 scope 名', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dependencies = { 'pkg-a': '1.0.0', '@scope/pkg-b': '2.0.0', 'keep': '3.0.0' };
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const removed = await store.removeDependencies(['pkg-a', '@scope/pkg-b']);
  assert.deepEqual(removed, ['pkg-a', '@scope/pkg-b']);
  const after = readManifest(profileDir);
  assert.deepEqual(after.dependencies, { keep: '3.0.0' });
});

test('removeDependencies: 删空后 dependencies 键被删除', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dependencies = { 'only': '1.0.0' };
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  await store.removeDependencies(['only']);
  const after = readManifest(profileDir);
  assert.ok(!Object.prototype.hasOwnProperty.call(after, 'dependencies'), '空 dependencies 键删除');
});

test('removeDependencies: 非对象 dependencies → no-op', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dependencies = 'not-an-object';
  const before = writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const removed = await store.removeDependencies(['x']);
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before);
});

// ── setBundles / 形状 / 兼容包装 ──────────────────────────────────────────

test('setBundles: 非数组或含非字符串项抛 TypeError', (t) => {
  const profileDir = tmp(t);
  writeManifest(profileDir, baseManifest());
  const store = new ManifestStore({ profileDir });
  assert.throws(() => store.setBundles('not-array'), TypeError);
  assert.throws(() => store.setBundles(['a', 42]), TypeError);
  assert.throws(() => store.setBundles(['a', null]), TypeError);
});

test('setBundles: 整体替换并保持顺序', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['old'];
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const order = ['c', 'a', 'b'];
  await store.setBundles(order);
  assert.deepEqual(store.bundles(), order);
});

test('bundles()/dependencyNames(): 形状（拷贝、非数组容错）', (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['a', 'b'];
  m.dependencies = { a: '1', b: '2' };
  writeManifest(profileDir, m);
  const store = new ManifestStore({ profileDir });
  const b = store.bundles();
  b.push('mutated');
  assert.deepEqual(store.bundles(), ['a', 'b'], 'bundles() 返回拷贝');
  assert.deepEqual(store.dependencyNames(), ['a', 'b']);
  // 无 bundles 时返回 []（不写入）。
  const m2 = baseManifest();
  writeManifest(profileDir, m2);
  assert.deepEqual(store.bundles(), []);
});

test('removeBundlesFromProfile: 兼容包装返回 Promise 并生效', async (t) => {
  const profileDir = tmp(t);
  const m = baseManifest();
  m.dsh.profile.bundles = ['dsh-x'];
  writeManifest(profileDir, m);
  const p = removeBundlesFromProfile(profileDir, ['dsh-x']);
  assert.ok(p instanceof Promise, '返回 Promise');
  const removed = await p;
  assert.deepEqual(removed, ['dsh-x']);
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, []);
});
