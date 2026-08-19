'use strict';

// ---------------------------------------------------------------------------
// plugin-core 全局唯一标识符税（ids）。
//
// 全仓所有「loader id」与「npm 包名」的合法性判定必须经由本模块，禁止再出现
// 多份互不一致的正则（历史漂移：profile-patch-heal 不含点号、plugin-manager-patch
// 允许任意起点、patch-row-heal 允许 \w，导致点号 id 插件「能写不能愈」）。
// ---------------------------------------------------------------------------

/**
 * loader id（cordis.patch.yml 条目 id）：
 *   必须以字母/数字开头，其后仅允许字母/数字/下划线/点/连字符。
 * 与历史 plugin-manager-patch 的 ID_RE 兼容（全部存量 id 均满足），
 * 并补齐 profile-patch-heal / patch-row-heal 缺失的点号支持。
 */
const LOADER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * npm 包名：与历史 pluginManagerPackageDir 白名单逐字同构
 * （@scope/name 或裸名；scope 仅小写字母数字连字符，name 含点/下划线/连字符），
 * 兼容性优先，不收紧存量行为。
 */
const PACKAGE_NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/i;

/** 包名 → assets/plugins 下的目录名（去 scope 前缀；与 companionDirName 同构）。 */
function packageDirName(name) {
  const slash = String(name || '').indexOf('/');
  return slash >= 0 ? String(name).slice(slash + 1) : String(name);
}

function isLoaderId(id) {
  return typeof id === 'string' && id !== '' && LOADER_ID_RE.test(id);
}

/** 校验并返回 id；非法抛 PluginError(PLUGIN_BAD_ID)。 */
function assertLoaderId(id) {
  if (isLoaderId(id)) return id;
  const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');
  throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BAD_ID, '插件 id 含非法字符（仅允许字母/数字/下划线/点/连字符，且以字母或数字开头）: ' + String(id));
}

function isPackageName(name) {
  return typeof name === 'string' && name !== '' && PACKAGE_NAME_RE.test(name);
}

/** 校验并返回包名；非法抛 PluginError(PLUGIN_BAD_PACKAGE)。 */
function assertPackageName(name) {
  if (isPackageName(name)) return name;
  const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');
  throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BAD_PACKAGE, '包名含非法字符: ' + String(name));
}

module.exports = {
  LOADER_ID_RE,
  PACKAGE_NAME_RE,
  packageDirName,
  isLoaderId,
  assertLoaderId,
  isPackageName,
  assertPackageName,
};
