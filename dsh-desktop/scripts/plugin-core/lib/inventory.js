'use strict';

// ---------------------------------------------------------------------------
// plugin-core 插件清单收集（inventory）：全仓唯一的插件分组语义。
//
// 分组（修复历史缺陷：第三方 bundle 曾被归入 core 而不可管理）：
//   core        bundles ∩ CORE_BUNDLE_NAMES —— 不可开关、不可卸载
//   companion   COMPANION_PLUGINS —— 可开关、可卸载（可恢复）
//   community   除 core/companion 外的 bundle 登记（第三方）—— 可开关、可卸载（不可恢复）
//   other       仅 patch insert/用户层条目（非 bundle）—— 可开关、可卸载（不可恢复）
//   removed     带 removed 标记 / state.uninstalled —— 可恢复（仅 companion）
// 每行携带 quarantined 标记（自动隔离状态，用户可一键解除）。
// 行结构与历史 pluginManagerCollect 完全兼容（新增字段只增不减）。
// ---------------------------------------------------------------------------

const { parsePatchRows } = require('./patch-surgery');
const { CORE_BUNDLE_NAMES } = require('../../../profile-manifest');

const GROUP_ORDER = { companion: 0, community: 1, other: 2, core: 3, removed: 4 };

/**
 * @param {Object} opts
 * @param {string} opts.profileDir              profiles/<name> 目录
 * @param {Array<{id:string,name:string}>} opts.companionPlugins COMPANION_PLUGINS
 * @param {string[]} [opts.coreNames]           核心 bundle 名（默认 CORE_BUNDLE_NAMES）
 * @param {{ isUninstalled:(id:string)=>boolean, isQuarantined:(id:string)=>boolean }} [opts.state]
 * @param {string} [opts.patchText]             cordis.patch.yml 原文（读取失败传 ''）
 * @param {string[]} [opts.bundles]             manifest 的 dsh.profile.bundles（读取失败传 []）
 * @param {(name:string)=>string} [opts.describe] 包名 → description（注入 app assets 兜底）
 * @returns {Array<{id:string,name:string,description:string,enabled:boolean,toggleable:boolean,
 *                  group:string,removed:boolean,hasConfig:boolean,quarantined:boolean}>}
 */
function collectInventory(opts) {
  const {
    profileDir,
    companionPlugins = [],
    coreNames = CORE_BUNDLE_NAMES,
    state = { isUninstalled: () => false, isQuarantined: () => false },
    patchText = '',
    bundles = [],
    describe = () => '',
  } = opts;
  void profileDir;
  const { top, inserts } = parsePatchRows(patchText);

  const companionById = new Map(companionPlugins.map((p) => [p.id, p.name]));
  const insertById = new Map();
  for (const it of inserts) if (it && it.id) insertById.set(it.id, it.name || '');
  const userById = new Map();
  for (const row of top) {
    userById.set(row.id, {
      name: row.name || '',
      disabled: row.disabled === true,
      hasConfig: row.hasConfig === true,
      removed: row.removed === true,
    });
  }
  const companionNames = new Set(companionPlugins.map((p) => p.name));
  const coreNamesSet = new Set(coreNames);

  const seen = new Set();
  const rows = [];
  const addRow = (id, name, group) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const user = userById.get(id);
    const userDisabled = !!(user && user.disabled);
    const hasConfig = !!(user && user.hasConfig);
    const removed = !!(user && user.removed === true) || state.isUninstalled(id);
    const toggleable = group !== 'core' && !removed && !(hasConfig && !userDisabled);
    rows.push({
      id,
      name: name || id,
      description: describe(name || id),
      enabled: !userDisabled,
      toggleable,
      group,
      removed,
      hasConfig,
      quarantined: state.isQuarantined(id),
      // 恢复资格与分组解耦：卸载后的配套行 group 为 'removed'，仍可恢复。
      restorable: companionById.has(id),
    });
  };

  // companion：配套插件（带卸载标记归入 removed 分组）。
  // 分组判定同时看 patch removed 行与 state 卸载决策：patch 被自愈重置后，
  // 仅剩 state 决策的卸载项也必须归入 removed（与 §6 表一致）。
  for (const p of companionPlugins) {
    const u = userById.get(p.id);
    addRow(p.id, p.name, (u && u.removed === true) || state.isUninstalled(p.id) ? 'removed' : 'companion');
  }
  // insert 块出现但不在配套表 → other。
  for (const [id, name] of insertById) if (!companionById.has(id)) addRow(id, name, 'other');
  // 用户层条目（llm-deepseek / web / 手动条目）。
  for (const [id, u] of userById) {
    if (!companionById.has(id)) addRow(id, u.name, u.removed === true || state.isUninstalled(id) ? 'removed' : 'other');
  }
  // bundles：核心 / 配套名之外的第三方 bundle → community。
  for (const name of bundles) {
    if (companionNames.has(name)) continue;
    if (coreNamesSet.has(name)) {
      const id = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
      addRow(id, name, 'core');
      continue;
    }
    const id = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!seen.has(id)) addRow(id, name, 'community');
  }
  // 卸载标记兜底（不在配套表也不在用户表的 removed 条目）。
  for (const row of top) {
    if (row.removed === true && !seen.has(row.id)) addRow(row.id, row.name || row.id, 'removed');
  }

  return rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.id.localeCompare(b.id));
}

/** 按 id 定位行（返回 undefined 表示未知）。 */
function findRow(rows, id) {
  return rows.find((r) => r.id === id);
}

module.exports = { collectInventory, findRow, GROUP_ORDER };
