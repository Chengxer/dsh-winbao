'use strict';

// ---------------------------------------------------------------------------
// 配套 dsh 插件的唯一数据源。
//
// main.js 的 syncCompanionPlugins 与 scripts/sync-companion-plugins.js 曾
// 各自维护一份 COMPANION_PLUGINS 清单，历史上已发生过一次漂移（同步脚本
// 缺 better-sidebar / harness-pet）。新增或改名配套插件只改这里，两个同步
// 入口（桌面壳运行时 / WSL·Linux CLI）自动保持一致。
//
// 条目字段约定：
//   id    cordis.patch.yml 注册条目与插件管理页使用的 loader id；
//   name  profile node_modules 下的包名（含 scope）。
// ---------------------------------------------------------------------------

const COMPANION_PLUGINS = [
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal-tab' },
  { id: 'plugin-market', name: 'zat-dsh-engine' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar' },
  { id: 'harness-pet', name: 'harness-pet' },
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  // 对话节点导航条（vlln/dsh-navbar，MIT）：对话区右缘节点串快速跳转
  // user 消息（悬停预览/点击跳转/滚轮切换），取代 conversation-tweaks
  // 内置的会话滑轨。
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar' },
  // 对话删除与归档管理（本仓库内置）：会话行菜单删除按钮 + 设置内归档管理
  // 面板（恢复/删除）。依赖 patch-session-manage.js 的官方包运行时补丁。
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  { id: 'super-injector', name: '@dsh-external/dsh-super-injector' },
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  { id: 'workspace-anchor', name: '@deepseek-ai/dsh-workspace-anchor' },
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  { id: 'wsl-settings', name: '@deepseek-ai/dsh-wsl-settings' },
  { id: 'dsh-vision', name: '@dsh-external/dsh-vision' },
  { id: 'side-session', name: '@dsh-external/dsh-side-session' },
  { id: 'compaction-acp', name: 'billion-context-dsh' },
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  // 知识图谱记忆（adoresever/graph-memory，MIT）：跨会话图记忆 + PageRank /
  // 社区检测 + 向量去重；作者为 DSH 提供原生适配器（graph-memory/dsh 入口），
  // 内置后随壳分发，dsh-hub 中枢页直接显示装配状态与图谱统计。
  { id: 'graph-memory', name: 'graph-memory' },
  // 可视化插件市场（dsh-market/dsh-market，MIT）：浏览/搜索/一键安装社区插件，
  // 内置后与 zat-dsh-engine 并存，设置页各自入口。
  { id: 'dsh-market', name: 'dshmarket' },
  // 插件中枢（ARFCON/dsh-hub-DSH，MIT）：插件更新引擎（版本对比/一键更新/
  // 启停/卸载/启动自检修复）+ 全局记忆 + graph-memory / dsh-market 挂载 +
  // 自身更新检查；原生适配 Gitee 版客户端版本双源对比。
  { id: 'dsh-hub', name: 'dsh-hub' },
];

/** 包名 → assets/plugins 下的目录名（去 scope 前缀）。 */
function companionDirName(p) {
  const slash = p.name.indexOf('/');
  return slash >= 0 ? p.name.slice(slash + 1) : p.name;
}

module.exports = { COMPANION_PLUGINS, companionDirName };
