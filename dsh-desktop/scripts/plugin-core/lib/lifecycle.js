'use strict';

// ---------------------------------------------------------------------------
// plugin-core 生命周期服务（lifecycle）：开关 / 卸载 / 恢复的唯一实现。
//
// 写入顺序固定（Invariant I1）：State → Patch → Manifest → Modules。
// 前一步失败即中止，绝不留半状态。所有写经 WriteGate（进程内串行 + 跨进程
// 锁文件）；运行中的插件目录操作一律 rename 语义（先移走再删），不直接
// rm 被引用的目录（Windows 文件锁下也能成功移走）。
//
// 卸载彻底性（修复审计 #19/#20/#21）：
//   · 第三方 bundle 同样从 dsh.profile.bundles 移除登记（不再残留告警）；
//   · dependencies 键一并移除 —— 消灭「后续 pnpm install 静默复活」根源；
//   · .pnpm store 同名副本在无其它引用时精确清理；
//   · 卸载决策落 PluginStateStore（patch 被自愈重置也不会复活）；
//   · 第三方插件恢复返回 PLUGIN_RESTORE_NO_SOURCE（不再假成功）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');
const { assertLoaderId, isPackageName } = require('./ids');
const { setPluginRemoved, togglePluginInPatch } = require('./patch-surgery');
const { writeFileAtomic } = require('./fs-atomic');
const { collectInventory, findRow } = require('./inventory');

// ---------------------------------------------------------------------------
// node_modules 目录操作（rename 语义 + .pnpm store 精确清理）
// ---------------------------------------------------------------------------

/** 包名 → profile node_modules 下绝对路径（白名单校验）。 */
function packageDirOf(profileDir, name) {
  if (!isPackageName(name)) return null;
  const base = path.join(profileDir, 'node_modules');
  const dir = path.join(base, ...name.split('/'));
  if (!dir.startsWith(base + path.sep)) return null;
  return dir;
}

/**
 * 安全移除包目录：先 rename 到 .trash-<ts>-<pid> 再删除（运行中文件锁下
 * rename 可成功；删除失败则残留 .trash 由下次启动清理）。返回 true=已移除。
 */
function removePackageDir(profileDir, name, { log = () => {} } = {}) {
  const dir = packageDirOf(profileDir, name);
  if (!dir || !fs.existsSync(dir)) return true;
  const trash = dir + '.trash-' + Date.now() + '-' + process.pid;
  try {
    fs.renameSync(dir, trash);
  } catch (err) {
    // rename 失败（罕见：同目录树被独占）→ 直接递归删除兜底。
    log('卸载目录 rename 失败（' + (err && err.message) + '），改用直接删除: ' + dir);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return true; } catch (err2) {
      throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY, '删除插件目录失败（文件被占用，请退出应用后重试）: ' + dir, String((err2 && err2.message) || err2));
    }
  }
  try {
    fs.rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // 服务运行中部分文件被锁：残留 .trash 留存，下次启动清理（不视为失败）。
    log('插件目录已移出（.trash 残留待下次启动清理）: ' + trash);
  }
  return true;
}

/** 清理 24h 前的 .trash-* 残留（启动时调用，尽力而为）。 */
function cleanupStaleTrash(profileDir, { now = Date.now(), maxAgeMs = 24 * 3600 * 1000, log = () => {} } = {}) {
  const modulesDir = path.join(profileDir, 'node_modules');
  let entries;
  try { entries = fs.readdirSync(modulesDir); } catch { return; }
  for (const name of entries) {
    const m = /^(.+)\.trash-(\d+)-\d+$/.exec(name);
    if (!m || now - Number(m[2]) < maxAgeMs) continue;
    try { fs.rmSync(path.join(modulesDir, name), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 占用则跳过 */ }
  }
}

/**
 * 清理 .pnpm store 中该包的副本（仅当无任何顶层链接仍指向它时）。
 * store 目录名：裸包 `<name>@<ver>`，scope 包 `@scope+name@<ver>`。
 */
function prunePackageStore(profileDir, name, { log = () => {} } = {}) {
  if (!isPackageName(name)) return;
  const storeRoot = path.join(profileDir, 'node_modules', '.pnpm');
  if (!fs.existsSync(storeRoot)) return;
  const base = name.replace('/', '+'); // @scope/name → @scope+name
  const prefix = base + '@';
  let entries;
  try { entries = fs.readdirSync(storeRoot); } catch { return; }
  for (const entryName of entries) {
    if (!entryName.startsWith(prefix)) continue;
    const entryDir = path.join(storeRoot, entryName);
    if (!referencedByLinks(profileDir, entryDir)) {
      try { fs.rmSync(entryDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 占用则跳过 */ }
    } else {
      log('store 副本仍被其它包引用，保留: ' + entryName);
    }
  }
}

/** 探测 profile node_modules 顶层（含 @scope 子层）是否有链接指向目标目录。 */
function referencedByLinks(profileDir, targetDir) {
  const modulesDir = path.join(profileDir, 'node_modules');
  const norm = (p) => path.resolve(p).replace(/\//g, '\\').toLowerCase();
  const target = norm(targetDir);
  const checkDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name === '.pnpm') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink() || e.isDirectory()) {
        try {
          const real = fs.realpathSync(p);
          if (norm(real) === target || norm(real).startsWith(target + '\\')) return true;
        } catch { /* 悬空链接跳过 */ }
        if (e.isDirectory()) {
          try {
            if (!fs.lstatSync(p).isSymbolicLink() && checkDir(p)) return true;
          } catch { /* 忽略 */ }
        }
      }
    }
    return false;
  };
  return checkDir(modulesDir);
}

// ---------------------------------------------------------------------------
// 生命周期服务
// ---------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {string} opts.profileDir             profiles/<name> 目录
 * @param {import('./state-store').PluginStateStore} opts.state
 * @param {import('./manifest-store').ManifestStore} opts.manifestStore
 * @param {import('./fs-atomic').WriteGate} opts.patchGate 补丁写锁
 * @param {() => Array<Object>} opts.inventoryRows  清单（注入，读改写一致）
 * @param {(msg: string) => void} [opts.log]
 */
function createLifecycle(opts) {
  const { profileDir, state, manifestStore, patchGate, inventoryRows, log = () => {} } = opts;

  const patchFile = () => path.join(profileDir, 'cordis.patch.yml');
  const readPatch = () => {
    try { return fs.readFileSync(patchFile(), 'utf8'); } catch { return ''; }
  };

  /** 在补丁写锁内读-改-写 cordis.patch.yml（返回 Promise，调用方必须 await）。 */
  function withPatchWrite(fn) {
    return patchGate.run('profile-patch', () => {
      const text = readPatch();
      const next = fn(text);
      if (next !== text) writeFileAtomic(patchFile(), next);
      return true;
    });
  }

  /** 开关插件（官方 disabled 覆盖语义；core 拒绝）。 */
  async function setEnabled(id, enabled) {
    assertLoaderId(id);
    const row = findRow(inventoryRows(), id);
    if (!row) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未知插件: ' + id);
    if (!row.toggleable) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_TOGGLEABLE, '该插件不可开关: ' + id);
    // I1：补丁写失败即抛错（不返回虚假成功）；写锁内完成落盘后才返回。
    await withPatchWrite((text) => togglePluginInPatch(text, id, !!enabled, row.name));
    // 用户重新启用 = 解除自动隔离决策。
    if (enabled && state.isQuarantined(id)) await state.clearQuarantined(id);
    return { ok: true, restartRequired: true };
  }

  /**
   * 卸载（内置配套 / 第三方统一走本流）。顺序：State → Patch → Manifest → Modules。
   * @returns {Promise<{ ok: true, restartRequired: true }>}
   */
  async function uninstall(id) {
    assertLoaderId(id);
    const row = findRow(inventoryRows(), id);
    if (!row) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未知插件: ' + id);
    if (row.group === 'core') throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_CORE_PROTECTED, '核心组件不可卸载: ' + id);
    if (row.hasConfig && !row.removed) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_HAS_CONFIG, '该插件带自定义配置，禁止卸载: ' + id);
    if (!isPackageName(row.name)) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BAD_PACKAGE, '包名非法: ' + row.name);

    // 1) State：决策先落盘（抗 patch 重置复活）；持久化失败即中止卸载。
    const saved = await state.markUninstalled(id, row.name);
    if (!saved) {
      throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY, '卸载决策持久化失败，已中止卸载（磁盘保持原样）: ' + id);
    }
    // 2) Patch：disabled + removed 顶层条目（loader 语义 + 同步器跳过复制）。
    //    await：写失败即抛错（I1 前一步失败即中止），不得留下「目录已删但
    //    patch 仍启用」的半状态。
    await withPatchWrite((text) => setPluginRemoved(text, id, true, row.name));
    // 3) Manifest：bundle 登记移除（第三方一并覆盖）+ dependencies 键移除
    //    （消灭「后续 pnpm install 静默复活」根源）。
    await manifestStore.removeBundles([row.name]);
    await manifestStore.removeDependencies([row.name]);
    // 4) Modules：rename→删除包目录 + .pnpm store 无引用清理。
    removePackageDir(profileDir, row.name, { log });
    prunePackageStore(profileDir, row.name, { log });
    return { ok: true, restartRequired: true };
  }

  /**
   * 恢复卸载。仅内置配套有装配源（sync 重新复制）；第三方返回
   * PLUGIN_RESTORE_NO_SOURCE（修复历史「假成功」）。
   * @returns {Promise<{ ok: true, restartRequired: true }>}
   */
  async function restore(id) {
    assertLoaderId(id);
    const row = findRow(inventoryRows(), id);
    if (!row) throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未知插件: ' + id);
    // restorable 判定与分组解耦：卸载后的配套行 group 会变成 'removed'，
    // 恢复资格必须以「配套名单命中」为准（修复「卸载后无法恢复」回归）。
    if (!row.restorable) {
      throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_RESTORE_NO_SOURCE, '第三方插件无安装源，无法恢复，请从插件市场重新安装: ' + id);
    }
    await state.clearUninstalled(id);
    await state.clearQuarantined(id);
    await withPatchWrite((text) => setPluginRemoved(text, id, false, row.name));
    return { ok: true, restartRequired: true };
  }

  return { setEnabled, uninstall, restore, removePackageDir, prunePackageStore, cleanupStaleTrash };
}

module.exports = { createLifecycle, packageDirOf, removePackageDir, cleanupStaleTrash, prunePackageStore };
