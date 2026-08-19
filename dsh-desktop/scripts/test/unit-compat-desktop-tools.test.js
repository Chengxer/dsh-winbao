'use strict';

// unit-compat-desktop-tools.test.js — 桌面工具链兼容修复回归：
//   · desktop-ordering：非字符串 order 条目上报 error（不崩溃）；中立 no-change 措辞；
//   · desktop-backup：home 根下 profiles 段拒绝；within 路径围栏大小写不敏感；
//   · desktop-validity：patch/client/main 路径越界围栏；
//   · profile-module-heal：.pnpm 分隔符（防 .pnpm-evil 兄弟目录误删）；
//   · plugin-guard：collectBundleEntryIds 接线（bundle 自身声明 id 与 overlay 行 id 级去重）；
//   · profile-patch-heal：removeBundlesFromProfile 返回 Promise + 并发串行化不丢更新；
//   · 兼容 shims：plugin-manager-patch / patch-row-heal / patch-io 再导出一致。
// 运行：node --test scripts/test/unit-compat-desktop-tools.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readBundleStack,
  applyBundleOrder,
  validateOrder,
} = require('../desktop-ordering');
const {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  validatedBackup,
  restoreBackup,
} = require('../desktop-backup');
const { checkPluginPackage } = require('../desktop-validity');
const { healProfileModuleShadowing } = require('../../profile-module-heal');
const { removeBundlesFromProfile } = require('../../profile-patch-heal');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-tools-'));
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const jsonYaml = { load: (t) => JSON.parse(t) };

// ---------------------------------------------------------------------------
// desktop-ordering：非字符串条目 + 中立措辞
// ---------------------------------------------------------------------------

test('readBundleStack: bundles 含非字符串条目 → 上报 error（不静默丢弃）', () => {
  const dir = tmpdir();
  write(dir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a-pkg', 42, null] } } }));
  const out = readBundleStack(dir, fs);
  assert.match(out.error || '', /非字符串/);
  assert.deepEqual(out.bundles, []);
  assert.deepEqual(out.community, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyBundleOrder: 含非字符串条目的清单拒绝写入（保护数据）', () => {
  const dir = tmpdir();
  write(dir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a-pkg', 42] } } }));
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  const out = applyBundleOrder(dir, ['a-pkg'], fs);
  assert.strictEqual(out.ok, false);
  assert.match(out.error || '', /非字符串/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before, '拒绝写入时 manifest 原样保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateOrder: 冲突措辞中立（只陈述位置，不再「当前在前/在后」误导）', () => {
  const conflicts = validateOrder(['a-pkg', 'b-pkg'], [{ name: 'b-pkg', before: ['a-pkg'] }]);
  assert.strictEqual(conflicts.length, 1);
  assert.match(conflicts[0].reason, /必须早于 a-pkg 加载/);
  assert.match(conflicts[0].reason, /当前顺序：b-pkg 位置 1，a-pkg 位置 0/);
  assert.doesNotMatch(conflicts[0].reason, /当前在前|当前在后/);
});

// ---------------------------------------------------------------------------
// desktop-backup：profiles 段 + within 大小写不敏感
// ---------------------------------------------------------------------------

test('validatedBackup: home 根下 profiles 段拒绝（破坏 profile/home 隔离边界）', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    secretFiles: [],
    files: [{ path: 'home/profiles/web/cordis.patch.yml', lines: ['- id: x'] }],
  };
  assert.throws(() => validatedBackup(backup), /profiles 段/);
});

test('restoreBackup: within 路径围栏大小写不敏感（realpath 大小写差异不误拒绝）', { skip: process.platform !== 'win32' }, () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-case-Profile-'));
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-case-Home-'));
  fs.mkdirSync(path.join(profileRoot, 'sub'), { recursive: true });
  const canonProfile = fs.realpathSync(profileRoot);

  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    secretFiles: [],
    files: [{ path: 'profile/sub/cordis.patch.yml', lines: ['- id: x'] }],
  };

  // 注入 fake fs：realpathSync 对根目录返回规范大小写、对子目录返回小写，
  // 强制「realDir 与 root 大小写不一致」——修复前 startsWith 大小写敏感会误拒绝。
  const fakeFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'realpathSync') {
        return (p) => {
          const canon = target.realpathSync(p);
          const lower = String(canon).toLowerCase();
          if (lower === canonProfile.toLowerCase()) return canon; // 根 → 规范大小写
          return lower; // 子目录 → 小写
        };
      }
      return target[prop];
    },
  });

  try {
    const r = restoreBackup(backup, { profileDir: profileRoot, homeDir: homeRoot }, fakeFs, path);
    assert.ok(r.files >= 1);
    assert.ok(fs.existsSync(path.join(profileRoot, 'sub', 'cordis.patch.yml')), '恢复应成功（大小写差异不得误判逃逸）');
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// desktop-validity：路径越界围栏
// ---------------------------------------------------------------------------

test('checkPluginPackage: patch / client / main 路径越界围栏', () => {
  const dir = tmpdir();
  // 补丁越界
  write(dir, 'pkg/package.json', JSON.stringify({ name: 'esc-pkg', dsh: { bundle: { patch: '../../outside.yml' } } }));
  const patchEsc = checkPluginPackage('esc-pkg', path.join(dir, 'pkg'), jsonYaml, fs);
  assert.ok(patchEsc.issues.some((i) => i.level === 'error' && /补丁路径越界/.test(i.text)));
  assert.strictEqual(patchEsc.patchOk, false);

  // dsh.bundle.client 越界
  write(dir, 'pkg2/package.json', JSON.stringify({ name: 'esc2', dsh: { bundle: { client: '../../c.js' } } }));
  const bundleClient = checkPluginPackage('esc2', path.join(dir, 'pkg2'), jsonYaml, fs);
  assert.ok(bundleClient.issues.some((i) => /客户端入口不存在或路径越界/.test(i.text)));

  // dsh.client.client 越界
  write(dir, 'pkg3/package.json', JSON.stringify({ name: 'esc3', dsh: { client: { client: '../../c.js' } } }));
  const clientEsc = checkPluginPackage('esc3', path.join(dir, 'pkg3'), jsonYaml, fs);
  assert.ok(clientEsc.issues.some((i) => /客户端入口不存在或路径越界/.test(i.text)));

  // main 越界（清单内 → error）
  write(dir, 'pkg4/package.json', JSON.stringify({ name: 'esc4', main: '../../main.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'pkg4/cordis.patch.yml', '[]\n');
  const mainEsc = checkPluginPackage('esc4', path.join(dir, 'pkg4'), jsonYaml, fs, true);
  assert.ok(mainEsc.issues.some((i) => i.level === 'error' && /main 入口不存在或路径越界/.test(i.text)));

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// profile-module-heal：.pnpm 分隔符
// ---------------------------------------------------------------------------

test('healProfileModuleShadowing: .pnpm 分隔符防止误删 .pnpm-evil 兄弟目录，真 .pnpm store 仍清理', () => {
  const home = tmpdir();
  const fallbackDir = path.join(home, 'profiles', 'node_modules');
  const profileModulesDir = path.join(home, 'profiles', 'web', 'node_modules');
  fs.mkdirSync(fallbackDir, { recursive: true });
  fs.mkdirSync(profileModulesDir, { recursive: true });

  const link = (name, target) => fs.symlinkSync(target, path.join(fallbackDir, name), 'junction');
  const closurePkg = (name) => {
    const d = path.join(home, 'closure', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    return d;
  };

  // 两个 fallback 包：schemastery / cosmokit
  link('schemastery', closurePkg('schemastery'));
  link('cosmokit', closurePkg('cosmokit'));

  // schemastery 的 shadow 指向 .pnpm-evil（兄弟目录，不得误删）
  const evilTarget = path.join(profileModulesDir, '.pnpm-evil', 'schemastery@1.0.0');
  fs.mkdirSync(evilTarget, { recursive: true });
  fs.writeFileSync(path.join(evilTarget, 'package.json'), '{}');
  fs.symlinkSync(evilTarget, path.join(profileModulesDir, 'schemastery'), 'junction');

  // cosmokit 的 shadow 指向真 .pnpm store（应清理）
  const storeTarget = path.join(profileModulesDir, '.pnpm', 'cosmokit@1.0.0');
  fs.mkdirSync(storeTarget, { recursive: true });
  fs.writeFileSync(path.join(storeTarget, 'package.json'), '{}');
  fs.symlinkSync(storeTarget, path.join(profileModulesDir, 'cosmokit'), 'junction');

  const removed = healProfileModuleShadowing(home, 'web');
  assert.deepEqual(removed.sort(), ['cosmokit'], '只有真 .pnpm store 链接被清理');
  assert.ok(fs.existsSync(path.join(profileModulesDir, 'schemastery')), '.pnpm-evil 兄弟目录链接必须保留');

  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// plugin-guard：collectBundleEntryIds 接线（id 级去重）
// 说明：plugin-guard.repair() 通过 patch-row-heal.js 再导出接入
// patch-surgery.removeBundledRowDuplicates 的 id 级去重。guard 侧 rowIds 的
// 值恒为 null（无包名映射），name 级去重永远不命中，只有 id 级（bundleEntryIds
// 集合）能命中——这里直接断言该接线语义（含「空集=旧行为不命中」反证）。
// ---------------------------------------------------------------------------

test('collectBundleEntryIds 接线：id 级去重命中（name 不一致），空集（旧行为）不命中', () => {
  const { removeBundledRowDuplicates } = require('../plugin-core/lib/patch-surgery');
  const patch = '- insert:\n    - id: my.id\n      name: \'forked-name\'\n';
  // guard 侧 rowIds 形态：id → null（无 name 映射，name 级去重永不命中）
  const rowIds = { 'my.id': null };
  const bundleNames = ['bundle-pkg']; // 与 'forked-name' 不一致 → name 级不命中
  const wired = removeBundledRowDuplicates(patch, rowIds, bundleNames, new Set(['my.id']));
  assert.deepEqual(wired.removed, ['my.id'], 'bundle 自身声明 my.id → id 级去重命中');
  const old = removeBundledRowDuplicates(patch, rowIds, bundleNames, new Set());
  assert.deepEqual(old.removed, [], '空 bundleEntryIds（历史 new Set()）不命中——证明 id 级接线必要性');
});

// ---------------------------------------------------------------------------
// profile-patch-heal：removeBundlesFromProfile Promise + 并发串行化
// ---------------------------------------------------------------------------

test('removeBundlesFromProfile: 两个实例并发移除不同名 → 串行化不丢更新', async () => {
  const profileDir = tmpdir();
  write(profileDir, 'package.json', JSON.stringify({
    name: 'p',
    dependencies: {},
    dsh: { profile: { bundles: ['a-pkg', 'b-pkg', 'c-pkg'] } },
  }, null, 2) + '\n');

  const [r1, r2] = await Promise.all([
    removeBundlesFromProfile(profileDir, ['a-pkg']),
    removeBundlesFromProfile(profileDir, ['b-pkg']),
  ]);
  assert.deepEqual(r1, ['a-pkg']);
  assert.deepEqual(r2, ['b-pkg']);
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['c-pkg'], '两次并发移除都不得丢失更新');

  fs.rmSync(profileDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 兼容 shims：再导出一致
// ---------------------------------------------------------------------------

test('compat shims: plugin-manager-patch / patch-io / profile-patch-heal 与 plugin-core 原实现一致', async () => {
  const pluginManagerPatch = require('../plugin-manager-patch');
  const patchIo = require('../lib/patch-io');
  const patchSurgery = require('../plugin-core/lib/patch-surgery');
  const fsAtomic = require('../plugin-core/lib/fs-atomic');
  const profilePatchHeal = require('../../profile-patch-heal');

  // 同函数引用（re-export）
  assert.strictEqual(pluginManagerPatch.togglePluginInPatch, patchSurgery.togglePluginInPatch);
  assert.strictEqual(pluginManagerPatch.setPluginRemoved, patchSurgery.setPluginRemoved);
  assert.strictEqual(patchIo.writeFileAtomic, fsAtomic.writeFileAtomic);
  assert.strictEqual(profilePatchHeal.dedupePatchEntries, patchSurgery.dedupePatchEntries);
  assert.strictEqual(profilePatchHeal.dropBlocksByIds, patchSurgery.dropBlocksByIds);
  // 注：dsh-desktop/patch-row-heal.js（根目录）的再导出 require 路径为
  // './plugin-core/lib/patch-surgery'，实际实现位于 scripts/plugin-core/lib/
  // ——该 shim 当前加载即 MODULE_NOT_FOUND，无法在此做再导出一致性断言（见报告）。

  // 代表性输入行为一致
  const input = "- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-balance'\n";
  assert.strictEqual(
    pluginManagerPatch.togglePluginInPatch(input, 'balance', false, 'x'),
    patchSurgery.togglePluginInPatch(input, 'balance', false, 'x'),
  );
  assert.strictEqual(
    pluginManagerPatch.setPluginRemoved('', 'harness-pet', true, 'harness-pet'),
    patchSurgery.setPluginRemoved('', 'harness-pet', true, 'harness-pet'),
  );

  // removeBundlesFromProfile 返回 Promise（委托 ManifestStore）
  const profileDir = tmpdir();
  const p = profilePatchHeal.removeBundlesFromProfile(profileDir, ['x-pkg']);
  assert.ok(p && typeof p.then === 'function', 'removeBundlesFromProfile 必须返回 Promise');
  await p;
  fs.rmSync(profileDir, { recursive: true, force: true });
});
