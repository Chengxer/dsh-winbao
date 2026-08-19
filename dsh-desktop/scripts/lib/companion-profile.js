'use strict';

// ---------------------------------------------------------------------------
// 配套插件同步的共享实现（唯一实现）。
//
// 补丁层文本变换（注册 / 去重 / 禁用块 / 卸载标记 / 旧市场清理）已收口到
// scripts/plugin-core/lib/patch-surgery.js（统一 id 字符集、EOL 保持、三种
// 引号 name 改名修复），本模块从那里 re-export；文件同步 / 过期清理 / 目录
// 同步保留在此（fs 操作，非文本）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { COMPANION_PLUGINS, companionDirName } = require('./companion-plugins');
const { dropBlocksByIds } = require('../../profile-patch-heal');
const { writeFileAtomic } = require('./patch-io');
const { bundlePatchRel, verifyBundleDir } = require('../../profile-bundle-heal');
const { compareVersions } = require('./versions');
const {
  PATCH_HEADER,
  ACP_DISABLE_BLOCK,
  PET_DISABLE_BLOCK,
  removedPluginIdsFromPatch,
  removeLegacyMarketplacePatchLines,
  ensureDisabledPatchEntry,
  registerCompanionPatchEntries,
} = require('../plugin-core/lib/patch-surgery');

// 同步进 profile 的固定文件清单（根目录平铺布局的第三方插件也在内）。
const PLUGIN_FILES = [
  'package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.zh.md',
  'lib/index.js', 'lib/index.mjs', 'lib/client.js', 'lib/vlm.js', 'lib/typert.host.js', 'lib/typert.host.d.ts',
  'dsh.plugin.json',
  'index.js', 'client.js', 'app.js', 'styles.css', 'deepseek-mark.svg',
];

// 配套插件引用的私有依赖（dsh 核心闭包之外）。
const VENDOR_DEPS = ['schemastery', 'cosmokit', '@standard-schema/spec'];

// ---------------------------------------------------------------------------
// 目录/文件清理
// ---------------------------------------------------------------------------

/**
 * 过期配套插件清理白名单：当前与历史内置目录名（含 scope 内与顶层两种落点）。
 * 只有命中白名单且（private + description 含 "DSH Desktop"）的目录才会被清理
 * —— 修复历史「仅凭描述即可误删用户自装包」的判定过宽。
 */
const KNOWN_COMPANION_DIR_NAMES = new Set([
  ...COMPANION_PLUGINS.map(companionDirName),
  // 历史退役/改名目录：
  'zat-dsh-engine',
  'dsh-plugin-marketplace',
  'dsh-terminal',
  'dsh-prompt',
]);

/**
 * 清理历史版本遗留的旧包目录（白名单 + 私有 + 描述三重判定，避免误删）。
 * 修复：白名单里包含**当前配套目录名**，若不做「当前名单」排除，命中
 * private+描述判定的当前插件会在每次同步时被「删除 → 重新复制」——
 * 破坏零写入幂等，并让「保留更新版本」分支读不到已装版本。
 * @param {string} scanDir 扫描目录（node_modules 或 node_modules/@scope）
 * @param {Object} hooks { log, fail, plan, dryRun, expectedDirs }
 *   expectedDirs —— 当前配套目录名集合（bare 名），命中即跳过（绝不清当前插件）
 * @returns {number} 清理数量
 */
function removeStaleCompanionPlugins(scanDir, hooks = {}) {
  const { log, fail, plan, dryRun = false, expectedDirs } = hooks;
  let cleaned = 0;
  let entries;
  try { entries = fs.readdirSync(scanDir, { withFileTypes: true }); } catch { return cleaned; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !KNOWN_COMPANION_DIR_NAMES.has(entry.name)) continue;
    if (expectedDirs && expectedDirs.has(entry.name)) continue; // 当前插件目录，绝不清理
    const pkgPath = path.join(scanDir, entry.name, 'package.json');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { continue; }
    if (pkg && pkg.private === true && typeof pkg.description === 'string' && /DSH Desktop/.test(pkg.description)) {
      if (dryRun) {
        if (plan) plan('dry-run: 将清理过期配套插件 ' + entry.name);
        continue;
      }
      try {
        fs.rmSync(path.join(scanDir, entry.name), { recursive: true, force: true });
        cleaned += 1;
        if (log) log('已清理过期配套插件: ' + entry.name);
      } catch (err) {
        if (fail) fail('清理过期配套插件失败 ' + entry.name + ': ' + err.message);
      }
    }
  }
  return cleaned;
}

/**
 * 移除旧版 @deepseek-ai/dsh-plugin-marketplace 的同步副本。
 */
function removeLegacyMarketplaceDir(profileWebModules, hooks = {}) {
  const { log, fail, plan, dryRun = false } = hooks;
  const oldPkg = path.join(profileWebModules, '@deepseek-ai', 'dsh-plugin-marketplace');
  if (!fs.existsSync(oldPkg)) return;
  if (dryRun) {
    if (plan) plan('dry-run: 将移除旧插件市场包 @deepseek-ai/dsh-plugin-marketplace');
    return;
  }
  try {
    fs.rmSync(oldPkg, { recursive: true, force: true });
    if (log) log('已移除旧插件市场包: @deepseek-ai/dsh-plugin-marketplace');
  } catch (err) {
    if (fail) fail('移除旧插件市场包失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 目录级同步（递归比对 size+mtime 精确值，一致时跳过）
// ---------------------------------------------------------------------------

function dirNeedsSync(src, dest) {
  if (!fs.existsSync(dest)) return true;
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return true; }
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (dirNeedsSync(s, d)) return true;
    } else {
      try {
        const ss = fs.statSync(s);
        const ds = fs.statSync(d);
        // 毫秒取整比较：cpSync 的时间戳保留精度受文件系统限制（NTFS 往返后
        // 亚毫秒部分不稳定），精确比较会破坏「二次同步零写入」幂等契约。
        if (ds.size !== ss.size || Math.round(ds.mtimeMs) !== Math.round(ss.mtimeMs)) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/** 目录级同步：内容一致时跳过；源不存在时 no-op。失败仅告警不抛出。 */
function syncDir(src, dest, log) {
  if (!fs.existsSync(src)) return;
  try {
    if (fs.existsSync(dest) && !dirNeedsSync(src, dest)) return;
    fs.cpSync(src, dest, { recursive: true, force: true, preserveTimestamps: true });
  } catch (err) {
    if (log) log('同步目录失败 ' + src + ': ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 插件文件同步（复制 + bundle 校验）
// ---------------------------------------------------------------------------

/**
 * 把配套插件从 assets/plugins 同步进 profile web node_modules，并校验 bundle
 * 完整性。语义与历史实现逐字一致（详见历史 companion-profile.js 注释），
 * 差异仅在：过期清理覆盖 scope 内 + 顶层（非 scope 包）两种落点，且清理
 * 判定加白名单；单文件 mtime 精确比较。
 * @param {Object} opts
 * @returns {{ bundleNames: Set<string>, missingNames: Set<string> }}
 */
function syncCompanionFiles(opts) {
  const {
    plugins = COMPANION_PLUGINS,
    assetsRoot,
    profileDir,
    vendorRoot,
    removedIds,
    log,
    fail,
    onMissingSource,
    onCopyFail,
    onVerifyFail,
    onInstalled,
    onVendorSynced,
    plan,
    dryRun = false,
  } = opts;
  const profileModules = path.join(profileDir, 'node_modules', '@deepseek-ai');
  if (!dryRun) fs.mkdirSync(profileModules, { recursive: true });
  // 当前配套目录名（bare）集合：过期清理必须以它为排除集（修复「每次同步
  // 误删当前插件 → 删除重拷抖动 + 保留更新版本分支失效」回归）。
  const currentDirs = new Set((plugins || []).map((p) => companionDirName(p)));
  removeStaleCompanionPlugins(profileModules, { log, fail, plan, dryRun, expectedDirs: currentDirs });
  // 非 scope 落点（dsh-better-sidebar / harness-pet / graph-memory / dshmarket /
  // dsh-hub / billion-context-dsh 等）同样过清理（修复历史「非 scope 旧目录
  // 永不清理」）。
  removeStaleCompanionPlugins(path.join(profileDir, 'node_modules'), { log, fail, plan, dryRun, expectedDirs: currentDirs });
  removeLegacyMarketplaceDir(path.join(profileDir, 'node_modules'), { log, fail, plan, dryRun });

  const bundleNames = new Set();
  for (const name of VENDOR_DEPS) {
    const sdir = path.join(vendorRoot, name);
    if (!fs.existsSync(sdir)) continue;
    const ddir = path.join(profileDir, 'node_modules', name);
    if (dryRun) {
      if (plan) plan(`dry-run: 将同步私有依赖 ${name} → ${ddir}`);
      continue;
    }
    syncDir(sdir, ddir, log);
    if (onVendorSynced) onVendorSynced(name);
  }
  // 源缺失的配套插件：不复制、不注册、manifest 移除登记（避免注册了但包不存在）。
  const missingNames = new Set();
  for (const p of plugins) {
    const sdir = path.join(assetsRoot, companionDirName(p));
    if (!fs.existsSync(path.join(sdir, 'package.json'))) {
      missingNames.add(p.name);
      if (onMissingSource) onMissingSource(p.name, sdir);
    }
  }
  for (const p of plugins) {
    if (removedIds && removedIds.has(p.id)) continue;
    const rel = companionDirName(p);
    const src = path.join(assetsRoot, rel);
    if (!fs.existsSync(path.join(src, 'package.json'))) continue;
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')); } catch {}
    const isBundle = bundlePatchRel(pkg) !== '';
    const dest = path.join(profileModules, '..', p.name);
    if (!dryRun) {
      try {
        const aPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
        const dPkgFile = path.join(dest, 'package.json');
        if (aPkg && aPkg.version && fs.existsSync(dPkgFile)) {
          const dPkg = JSON.parse(fs.readFileSync(dPkgFile, 'utf8'));
          if (dPkg && dPkg.version && compareVersions(dPkg.version, aPkg.version) > 0) {
            if (log) log('插件 ' + p.id + ' 版本 ' + dPkg.version + ' 高于安装包 ' + aPkg.version + '，保留更新版本');
            if (isBundle) bundleNames.add(p.name);
            continue;
          }
        }
      } catch { /* 版本读取失败按正常复制处理 */ }
    }
    if (dryRun) {
      if (plan) plan(`dry-run: 将安装 ${p.name} → ${dest}${isBundle ? '（bundle 插件）' : ''}`);
      continue;
    }
    fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
    for (const f of PLUGIN_FILES) {
      const sf = path.join(src, f);
      if (!fs.existsSync(sf)) continue;
      const df = path.join(dest, f);
      try {
        const sst = fs.statSync(sf);
        const dst = fs.statSync(df);
        // 毫秒取整比较（同上：cpSync 亚毫秒精度不稳定，精确比较破坏零写入幂等）。
        if (dst.size === sst.size && Math.round(dst.mtimeMs) === Math.round(sst.mtimeMs)) continue;
      } catch { /* 目标缺失或不可读 → 照常复制 */ }
      try {
        fs.cpSync(sf, df, { force: true, preserveTimestamps: true });
      } catch (err) {
        if (onCopyFail) onCopyFail(sf, err);
      }
    }
    for (const sub of ['lib', 'client', 'data', 'assets', 'src', 'dist', 'public', 'gui', 'node_modules']) {
      syncDir(path.join(src, sub), path.join(dest, sub), log);
    }
    if (isBundle) {
      const check = verifyBundleDir(dest);
      if (!check.ok) {
        missingNames.add(p.name);
        if (onVerifyFail) onVerifyFail(p.name, check.reason);
      } else {
        bundleNames.add(p.name);
      }
    }
    if (onInstalled) onInstalled(p.name, isBundle);
  }
  return { bundleNames, missingNames };
}

module.exports = {
  PATCH_HEADER,
  ACP_DISABLE_BLOCK,
  PET_DISABLE_BLOCK,
  KNOWN_COMPANION_DIR_NAMES,
  removeStaleCompanionPlugins,
  removeLegacyMarketplaceDir,
  removeLegacyMarketplacePatchLines,
  removedPluginIdsFromPatch,
  ensureDisabledPatchEntry,
  registerCompanionPatchEntries,
  syncCompanionFiles,
  dirNeedsSync,
  syncDir,
};
