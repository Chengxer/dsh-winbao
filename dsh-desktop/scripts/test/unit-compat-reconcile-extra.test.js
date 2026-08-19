'use strict';

// unit-compat-reconcile-extra.test.js — scripts/lib/profile-reconcile.js 的兼容修复回归：
//   · 包名形状校验（PACKAGE_NAME_RE）：非法形状（../、空格、前导点等）判 INVALID_NAME；
//   · reset 语义：manifest 缺失不得判为「损坏重建」（reset=false）；
//   · 隔离记录去重统一入口（quarantineEntry）：步骤 2 的同类失败不重写 removedAt；
//   · removedByPolicy 只上报「确实在清单里被移除」的名字（actualRemovedFrom）；
//   · manifest 写失败 try/catch：writeFileAtomic 失败不冒泡（磁盘保持原样）。
// 运行：node --test scripts/test/unit-compat-reconcile-extra.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BUNDLE_CHECK_CODES,
} = require('../../profile-bundle-heal');
const { CORE_BUNDLE_NAMES } = require('../../profile-manifest');
const {
  BROKEN_BUNDLES_RECORD_FILENAME,
  readBrokenBundlesRecord,
  validateBundleEntry,
  reconcileProfileBundles,
} = require('../lib/profile-reconcile');

const CORES = [...CORE_BUNDLE_NAMES];

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeHealthyBundle(base, name) {
  const dir = path.join(base, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export {};\n');
  return dir;
}

function recordFile(profileDir) {
  return path.join(profileDir, BROKEN_BUNDLES_RECORD_FILENAME);
}

// ---------------------------------------------------------------------------
// 包名形状校验（PACKAGE_NAME_RE）
// ---------------------------------------------------------------------------

test('validateBundleEntry: 非法包名形状判 INVALID_NAME（防 ../ 越出探测）', (t) => {
  const base = tmpdir(t);
  const bad = ['../evil', '..', '.hidden', 'a b', 'a:b', 'a/b', '@scope', '@scope/../evil'];
  for (const name of bad) {
    const r = validateBundleEntry(name, { installAnchorDir: base, profileDir: base });
    assert.equal(r.code, BUNDLE_CHECK_CODES.INVALID_NAME, '非法包名应判 INVALID_NAME: ' + name);
    assert.match(r.reason, /包名非法/, 'reason 应标注包名非法: ' + name);
  }
  // 合法形状不判 INVALID_NAME（继续走解析 → 未安装判 UNRESOLVABLE）
  const ok1 = validateBundleEntry('@scope/pkg', { installAnchorDir: base, profileDir: base });
  assert.notEqual(ok1.code, BUNDLE_CHECK_CODES.INVALID_NAME, '@scope/pkg 是合法形状');
  assert.equal(ok1.code, BUNDLE_CHECK_CODES.UNRESOLVABLE);
  const ok2 = validateBundleEntry('plain-pkg', { installAnchorDir: base, profileDir: base });
  assert.notEqual(ok2.code, BUNDLE_CHECK_CODES.INVALID_NAME, 'plain-pkg 是合法形状');
});

// ---------------------------------------------------------------------------
// reset 语义：缺失 ≠ 损坏重建
// ---------------------------------------------------------------------------

test('reconcile: manifest 缺失不得判为损坏重建（reset=false），仍按初始化预写核心', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 不创建 package.json（全新安装）
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(r.reset, false, '文件缺失（全新安装）不得被当作「损坏重建」');
  assert.equal(r.changed, true, '核心可解析时仍应预写核心 bundles');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, CORES);
});

// ---------------------------------------------------------------------------
// 隔离记录去重（步骤 2 逐条校验移除路径）
// ---------------------------------------------------------------------------

test('reconcile: 步骤 2 同类失败不重写隔离记录（保留首次 removedAt）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 普通库（无 dsh.bundle.patch）落盘 → validateBundleEntry 判 NO_BUNDLE_DECL
  const plainDir = path.join(profileDir, 'node_modules', 'plain-pkg');
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'package.json'), JSON.stringify({ name: 'plain-pkg', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'plain-pkg'] } },
  }, null, 2) + '\n');
  // 预置同 code+reason 的历史隔离记录（首次 removedAt 固定）
  const reason = 'package.json 未声明 dsh.bundle.patch';
  fs.writeFileSync(recordFile(profileDir), JSON.stringify({
    v: 1,
    entries: { 'plain-pkg': { code: BUNDLE_CHECK_CODES.NO_BUNDLE_DECL, reason, removedAt: '2026-01-01T00:00:00.000Z' } },
  }, null, 2) + '\n');
  const beforeRecord = fs.readFileSync(recordFile(profileDir), 'utf8');

  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(r.changed, true, '无效登记应从 manifest 移除');
  assert.ok(r.removed.some((x) => x.name === 'plain-pkg' && x.code === BUNDLE_CHECK_CODES.NO_BUNDLE_DECL));
  assert.deepEqual(r.quarantined, [], '同类失败不得重新记入隔离记录（去重）');
  // 记录未重写：removedAt 保留首次值，且文件字节不变
  assert.equal(fs.readFileSync(recordFile(profileDir), 'utf8'), beforeRecord, '隔离记录不得重写');
  assert.equal(readBrokenBundlesRecord(recordFile(profileDir)).entries['plain-pkg'].removedAt, '2026-01-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// removedByPolicy：只上报确实在清单里被移除的名字
// ---------------------------------------------------------------------------

test('reconcile: removedByPolicy 只上报清单里实际存在的名字（缺失/卸载名单里的幽灵名不上报）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'companion-a'] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    missingNames: new Set(['companion-a', 'companion-ghost']),
    removedBundles: new Set(['companion-ghost2']),
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.removedByPolicy, ['companion-a'], '只有清单里实际存在的名字才上报');
  assert.ok(!logs.some((m) => m.includes('companion-ghost')), '幽灵缺失名不得出现在日志');
  assert.ok(!logs.some((m) => m.includes('companion-ghost2')), '幽灵卸载名不得出现在日志');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, CORES);
});

// ---------------------------------------------------------------------------
// manifest 写失败 try/catch（不冒泡）
// ---------------------------------------------------------------------------

test('reconcile: manifest 写入失败被捕获（不冒泡），磁盘保持原样', { skip: process.platform !== 'win32' }, (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const manifestFile = path.join(profileDir, 'package.json');
  const before = {
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'ghost-bundle'] } },
  };
  fs.writeFileSync(manifestFile, JSON.stringify(before, null, 2) + '\n');
  const beforeBytes = fs.readFileSync(manifestFile, 'utf8');
  fs.chmodSync(manifestFile, 0o444); // Windows 只读 → tmp+rename 失败
  const logs = [];
  try {
    assert.doesNotThrow(() => reconcileProfileBundles(profileDir, {
      installAnchorDir: installDir,
      coreNames: CORES,
      parsePatch: null,
      log: (m) => logs.push(m),
    }), 'manifest 写失败不得冒泡（CLI/主进程不得因一次 rename 失败中断）');
    assert.ok(logs.some((m) => m.includes('profile manifest 写入失败')), '应记录写入失败诊断日志');
  } finally {
    fs.chmodSync(manifestFile, 0o666);
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), beforeBytes, '磁盘 manifest 保持原样');
  }
});
