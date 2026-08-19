'use strict';

// 侧栏「打开项目目录」（issue #85）运行时补丁（幂等、锚点不匹配时跳过且绝不
// 损坏文件）。
//
// 背景：dsh 的侧栏项目行 / 会话行 ⋯ 菜单没有「打开项目目录」入口，也无法用
// 右键直接呼出行菜单。本补丁在官方包 dsh-client-ui-workspace 上做外科手术式
// 扩展：
//
//   1. 项目行菜单（workspaceMenuItems）末尾追加 open-folder 项（文件夹图标），
//      点击调 window.__dshDesktopOpenDir?.(row.cwd)；
//   2. 会话行菜单（sessionMenuItems）末尾按需追加 open-folder 项 —— 仅在能
//      解析到 cwd 时显示（分组视图取 group.cwd，扁平视图从 list.byId 反查
//      list.byId[node.id]?.cwd），未分组 / 孤儿会话自动隐藏；
//   3. 项目行 / 会话行 div 增加 onContextMenu：preventDefault + stopPropagation
//      后在同一个菜单以光标坐标弹出（getAnchorRect 提供完整四边矩形
//      left/top/right/bottom，right=x+1、bottom=y+1 —— 修复只给左/上两边的
//      初版实现：align=start + side=bottom 时 y 变 NaN，portal 落到静态位置）；
//   4. 菜单锚点矩形统一走 getAnchorRect：⋯ 按钮点击时返回按钮矩形，右键时
//      返回光标矩形。
//
// 桥 openPath 为 preload 已暴露的宿主能力 window.dshDesktop.openPath（显式
// 直接引用，不再经 dsh-session-manager 插件的 window.__dshDesktopOpenDir 别名
// 中转）；桥缺失时（纯浏览器）`?.` 可选链静默降级为无操作。
//
// 用法：
//   node scripts/patch-open-project-dir.js [<node_modules 根目录>]
// 同时导出 patchOpenProjectDir(nmRoot, log) 供 main.js 启动补丁与 after-pack.js
// 打包补丁复用（覆盖内置副本 / profile fallback / agent overlay / dev）。

const fs = require('node:fs');
const path = require('node:path');
// 原子写与 main.js / 其它补丁脚本共用同一实现（scripts/lib/patch-io.js）。
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (open project dir)';

// ---------------------------------------------------------------------------
// 1. dsh-client-ui-workspace：项目行 / 会话行菜单 + 右键菜单
// ---------------------------------------------------------------------------

// 1a. 项目行菜单项数组：delete 项后追加 open-folder 项。
const UI_PROJECT_ITEMS_ANCHOR = '}, {\n\t\t\t\tid: "delete",\n\t\t\t\tlabel: t("delete.workspace"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),\n\t\t\t\tdanger: true\n\t\t\t}];';
const UI_PROJECT_ITEMS_INSERT = '}, {\n\t\t\t\tid: "delete",\n\t\t\t\tlabel: t("delete.workspace"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),\n\t\t\t\tdanger: true\n\t\t\t}, {\n\t\t\t\t// dsh-desktop patch (open project dir): 打开项目目录。\n\t\t\t\tid: "open-folder",\n\t\t\t\tlabel: t("menu.openProjectDir"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {})\n\t\t\t}];';

// 1b. 项目行菜单 onSelect：放行 open-folder 并调用桥。
const UI_PROJECT_SELECT_ANCHOR = 'if (id !== "rename" && id !== "delete") return;\n\t\t\t\t\t\t\t\tif (id === "rename") actions.rename();\n\t\t\t\t\t\t\t\telse actions.delete();';
const UI_PROJECT_SELECT_INSERT = 'if (id !== "rename" && id !== "delete" && id !== "open-folder") return;\n\t\t\t\t\t\t\t\tif (id === "rename") actions.rename();\n\t\t\t\t\t\t\t\telse if (id === "delete") actions.delete();\n\t\t\t\t\t\t\t\telse if (id === "open-folder") window.dshDesktop?.openPath?.(row.cwd);';

// 1c. 项目行 div：右键弹出同一菜单（光标锚点；无 actions 的未分组桶不弹）。
const UI_PROJECT_DIV_ANCHOR = 'role: "treeitem",\n\t\t\t\t"aria-expanded": row.expanded,\n\t\t\t\tonClick: onToggle,';
const UI_PROJECT_DIV_INSERT = 'role: "treeitem",\n\t\t\t\t"aria-expanded": row.expanded,\n\t\t\t\tonClick: onToggle,\n\t\t\t\tonContextMenu: (e) => {\n\t\t\t\t\te.preventDefault();\n\t\t\t\t\te.stopPropagation();\n\t\t\t\t\tif (actions === void 0) return;\n\t\t\t\t\tsetMenuRect({ left: e.clientX, top: e.clientY, right: e.clientX + 1, bottom: e.clientY + 1 });\n\t\t\t\t\tsetMenuOpen(true);\n\t\t\t\t},';

// 1d. 项目行：右键锚点矩形 state。
const UI_PROJECT_STATE_ANCHOR = 'const active = group.expanded && group.containsCurrent;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);';
const UI_PROJECT_STATE_INSERT = 'const active = group.expanded && group.containsCurrent;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst [menuRect, setMenuRect] = (0, react.useState)(null);';

// 1e. 项目行 Menu：锚点矩形统一走 getAnchorRect（portal 定位用）。
const UI_PROJECT_ANCHOR_ANCHOR = 'items: workspaceMenuItems,\n\t\t\t\t\t\t\tonSelect: (id) => {';
const UI_PROJECT_ANCHOR_INSERT = 'items: workspaceMenuItems,\n\t\t\t\t\t\t\tgetAnchorRect: () => menuRect,\n\t\t\t\t\t\t\tonSelect: (id) => {';

// 1f. 项目行 ⋯ 按钮：点击时用按钮矩形做锚点。
const UI_PROJECT_BUTTON_ANCHOR = '"aria-label": t("actions.workspace.aria", { name: label }),\n\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t},';
const UI_PROJECT_BUTTON_INSERT = '"aria-label": t("actions.workspace.aria", { name: label }),\n\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\tsetMenuRect(e.currentTarget.getBoundingClientRect());\n\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t},';

// 2a. 会话行组件签名：新增 cwd prop（分组视图 group.cwd / 扁平视图反查 list.byId）。
const UI_SESSION_SIG_ANCHOR = 'function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {';
const UI_SESSION_SIG_INSERT = 'function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t, cwd }) {';

// 2b. 会话行：右键锚点矩形 state。
const UI_SESSION_STATE_ANCHOR = 'const showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);';
const UI_SESSION_STATE_INSERT = 'const showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst [menuRect, setMenuRect] = (0, react.useState)(null);';

// 2c. 会话行菜单项数组：delete 项后按需追加 open-folder（无 cwd 不显示）。
const UI_SESSION_ITEMS_ANCHOR = '// dsh-desktop patch (session manage): 归档下方增加删除。\n\t\t\t\t// 桥 window.__dshSessionManager 由 dsh-session-manager 插件提供；桥缺失\n\t\t\t\t// 时隐藏「删除对话」项（显式降级，而非可选链静默无反应）。\n\t\t\t\t...(window.__dshSessionManager && typeof window.__dshSessionManager.deleteSession === "function" ? [{\n\t\t\t\t\tid: "delete",\n\t\t\t\t\tlabel: t("menu.deleteSession")\n\t\t\t\t}] : [])\n\t\t\t];';
const UI_SESSION_ITEMS_INSERT = '// dsh-desktop patch (session manage): 归档下方增加删除。\n\t\t\t\t// 桥 window.__dshSessionManager 由 dsh-session-manager 插件提供；桥缺失\n\t\t\t\t// 时隐藏「删除对话」项（显式降级，而非可选链静默无反应）。\n\t\t\t\t...(window.__dshSessionManager && typeof window.__dshSessionManager.deleteSession === "function" ? [{\n\t\t\t\t\tid: "delete",\n\t\t\t\t\tlabel: t("menu.deleteSession")\n\t\t\t\t}] : []),\n\t\t\t\t// dsh-desktop patch (open project dir): 打开会话所在项目目录（无 cwd 的孤儿/未分组会话不显示）。\n\t\t\t\t...(cwd ? [{\n\t\t\t\t\tid: "open-folder",\n\t\t\t\t\tlabel: t("menu.openProjectDir"),\n\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {})\n\t\t\t\t}] : [])\n\t\t\t];';

// 2d. 会话行菜单 onSelect：open-folder 调用桥。
const UI_SESSION_SELECT_ANCHOR = 'if (id === "delete") window.__dshSessionManager?.deleteSession(node.id);';
const UI_SESSION_SELECT_INSERT = 'if (id === "delete") window.__dshSessionManager?.deleteSession(node.id);\n\t\t\t\t\t\t\t\t\tif (id === "open-folder") window.dshDesktop?.openPath?.(cwd);';

// 2e. 会话行 div：右键弹出同一菜单（光标锚点；blank 占位行无菜单不弹）。
const UI_SESSION_DIV_ANCHOR = '"aria-selected": selected,\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tonOpen(node.id);\n\t\t\t\t\t},';
const UI_SESSION_DIV_INSERT = '"aria-selected": selected,\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tonOpen(node.id);\n\t\t\t\t\t},\n\t\t\t\t\tonContextMenu: (e) => {\n\t\t\t\t\t\te.preventDefault();\n\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\tif (row.blank) return;\n\t\t\t\t\t\tsetMenuRect({ left: e.clientX, top: e.clientY, right: e.clientX + 1, bottom: e.clientY + 1 });\n\t\t\t\t\t\tsetMenuOpen(true);\n\t\t\t\t\t},';

// 2f. 会话行 Menu：锚点矩形统一走 getAnchorRect。
const UI_SESSION_ANCHOR_ANCHOR = 'items: sessionMenuItems,\n\t\t\t\t\t\t\t\tonSelect: (id) => {';
const UI_SESSION_ANCHOR_INSERT = 'items: sessionMenuItems,\n\t\t\t\t\t\t\t\tgetAnchorRect: () => menuRect,\n\t\t\t\t\t\t\t\tonSelect: (id) => {';

// 2g. 会话行 ⋯ 按钮：点击时用按钮矩形做锚点。
const UI_SESSION_BUTTON_ANCHOR = '"aria-label": t("actions.session.aria", { name: title }),\n\t\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t\t},';
const UI_SESSION_BUTTON_INSERT = '"aria-label": t("actions.session.aria", { name: title }),\n\t\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tsetMenuRect(e.currentTarget.getBoundingClientRect());\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t\t},';

// 3a. 分组视图会话行调用点：传 group.cwd。
const UI_GROUPED_CALL_ANCHOR = 'node,\n\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,\n\t\t\t\t\t\t\t\t\t\t\tnow,';
const UI_GROUPED_CALL_INSERT = 'node,\n\t\t\t\t\t\t\t\t\t\t\tcwd: group.cwd,\n\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,\n\t\t\t\t\t\t\t\t\t\t\tnow,';

// 3b. 扁平视图会话行调用点：从 list.byId 反查 cwd（孤儿会话为 undefined，项自动隐藏）。
const UI_FLAT_CALL_ANCHOR = 'node,\n\t\t\t\t\t\t\tcurrentId: list.current,\n\t\t\t\t\t\t\tnow,';
const UI_FLAT_CALL_INSERT = 'node,\n\t\t\t\t\t\t\tcwd: list.byId[node.id]?.cwd,\n\t\t\t\t\t\t\tcurrentId: list.current,\n\t\t\t\t\t\t\tnow,';

// 4. 翻译：zh / en（与 menu.archiveSession 等同一字典）。
const UI_ZH_ANCHOR = '"menu.archiveSession": "归档会话",\n\t\t\t"menu.deleteSession": "删除对话",';
const UI_ZH_INSERT = '"menu.archiveSession": "归档会话",\n\t\t\t"menu.deleteSession": "删除对话",\n\t\t\t"menu.openProjectDir": "打开项目目录",';
const UI_EN_ANCHOR = '"menu.archiveSession": "Archive session",\n\t\t\t"menu.deleteSession": "Delete conversation",';
const UI_EN_INSERT = '"menu.archiveSession": "Archive session",\n\t\t\t"menu.deleteSession": "Delete conversation",\n\t\t\t"menu.openProjectDir": "Open project directory",';

const UI_REPLACEMENTS = [
  { anchor: UI_PROJECT_ITEMS_ANCHOR, insert: UI_PROJECT_ITEMS_INSERT },
  { anchor: UI_PROJECT_SELECT_ANCHOR, insert: UI_PROJECT_SELECT_INSERT },
  { anchor: UI_PROJECT_DIV_ANCHOR, insert: UI_PROJECT_DIV_INSERT },
  { anchor: UI_PROJECT_STATE_ANCHOR, insert: UI_PROJECT_STATE_INSERT },
  { anchor: UI_PROJECT_ANCHOR_ANCHOR, insert: UI_PROJECT_ANCHOR_INSERT },
  { anchor: UI_PROJECT_BUTTON_ANCHOR, insert: UI_PROJECT_BUTTON_INSERT },
  { anchor: UI_SESSION_SIG_ANCHOR, insert: UI_SESSION_SIG_INSERT },
  { anchor: UI_SESSION_STATE_ANCHOR, insert: UI_SESSION_STATE_INSERT },
  { anchor: UI_SESSION_ITEMS_ANCHOR, insert: UI_SESSION_ITEMS_INSERT },
  { anchor: UI_SESSION_SELECT_ANCHOR, insert: UI_SESSION_SELECT_INSERT },
  { anchor: UI_SESSION_DIV_ANCHOR, insert: UI_SESSION_DIV_INSERT },
  { anchor: UI_SESSION_ANCHOR_ANCHOR, insert: UI_SESSION_ANCHOR_INSERT },
  { anchor: UI_SESSION_BUTTON_ANCHOR, insert: UI_SESSION_BUTTON_INSERT },
  { anchor: UI_GROUPED_CALL_ANCHOR, insert: UI_GROUPED_CALL_INSERT },
  { anchor: UI_FLAT_CALL_ANCHOR, insert: UI_FLAT_CALL_INSERT },
  { anchor: UI_ZH_ANCHOR, insert: UI_ZH_INSERT },
  { anchor: UI_EN_ANCHOR, insert: UI_EN_INSERT },
];

// ---------------------------------------------------------------------------
// 工具：在文件中做「锚点必须存在 + 标记幂等」的替换
// ---------------------------------------------------------------------------
function applyReplacements(file, replacements, log, stats, options) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('open-project-dir 补丁: 读取失败 ' + file + ': ' + err.message);
    return false;
  }
  if (src.includes(MARKER)) {
    log('open-project-dir 补丁: 已应用，跳过 ' + file);
    return false;
  }
  for (const { anchor, insert } of replacements) {
    if (!src.includes(anchor)) {
      log('open-project-dir 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file + ' :: ' + anchor.slice(0, 60));
      if (stats) stats.anchorMissing += 1;
      return false;
    }
    src = src.replace(anchor, insert);
  }
  src = '// ' + MARKER + ': 侧栏「打开项目目录」+ 右键菜单（issue #85）\n' + src;
  try {
    if (options && options.dryRun) {
      log('open-project-dir 补丁: dry-run: 将应用 ' + file);
      return false; // dryRun 不落盘，不计为已写
    }
    writeFileAtomic(file, src);
    log('open-project-dir 补丁: 已应用 ' + file);
    return true;
  } catch (err) {
    log('open-project-dir 补丁: 写入失败 ' + file + ': ' + err.message);
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用「打开项目目录」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchOpenProjectDir(nmRoot, log = () => {}, stats, options) {
  const targets = [
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
      replacements: UI_REPLACEMENTS,
    },
  ];
  let changed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    if (applyReplacements(t.file, t.replacements, log, stats, options)) changed += 1;
  }
  return changed;
}

/** 测试用：构造一份包含全部 UI 锚点的最小夹具（unit-open-project-dir.test.js 使用）。 */
function buildUiFixture() {
  return UI_REPLACEMENTS.map((r) => r.anchor).join('\n// ---- 夹具分隔 ----\n') + '\n';
}

module.exports = { patchOpenProjectDir, MARKER, buildUiFixture };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchOpenProjectDir(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
