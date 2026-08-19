'use strict';
// 依赖层小补丁（幂等）：目录选择器 worker 无消息退出时，把真实退出码/信号带进
// 错误文案。由 postinstall / pack / dist 在打包前应用；匹配失败只告警不中断。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js');

const PATCH_MARKER = 'worker.on("exit", (code, signal) => {';
const OLD_RE = /worker\.on\("exit", \(\) => \{\s*settle\(\(\) => \{\s*reject\(\/\* @__PURE__ \*\/ new Error\("win32 folder dialog worker exited before reporting a result"\)\);\s*\}\);\s*\}\);/;
const NEW_BLOCK = [
  'worker.on("exit", (code, signal) => {',
  '\t\tsettle(() => {',
  '\t\t\tconst suffix = signal ? ` (signal ${signal})` : typeof code === "number" ? ` (exit code ${code})` : "";',
  '\t\t\treject(/* @__PURE__ */ new Error(`win32 folder dialog worker exited before reporting a result${suffix}`));',
  '\t\t});',
  '\t});',
].join('\n');

function main() {
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-host-directory-picker-native 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(PATCH_MARKER)) {
    console.log('[patch-deps] picker worker 退出码补丁已应用，跳过');
    return;
  }
  if (!OLD_RE.test(src)) {
    console.log('[patch-deps] picker-native 未匹配到目标代码（版本可能已更新），跳过');
    return;
  }
  src = src.replace(OLD_RE, NEW_BLOCK);
  writeFileAtomic(target, src);
  console.log('[patch-deps] 已补丁 picker-native：worker 退出上报 exit code / signal');
}

main();

// 顺带应用 dsh-llm-pi-ai 余额判定补丁：opencode 等第三方 provider 余额不足时返回
// 401 + CreditsError，dsh 原本一律判 AUTH 并显示 "API key is invalid"，误导用户。
// 见 patch-pi-ai-credits.js（幂等，失败只告警不中断）。
require('./patch-pi-ai-credits.js');

// 顺带应用 Menu portal 视口补丁（issue #36）：预设很多时弹层顶部条目被裁掉。
// 开发模式（npm start）直接打 dev node_modules；打包由 after-pack 与启动时
// 运行时补丁覆盖（幂等，锚点不匹配只告警不中断）。
try {
  const { patchMenuViewport } = require('./patch-menu-viewport');
  // 补丁函数期望 node_modules 根目录（path.join(nmRoot, '@deepseek-ai', ...)）。
  const n = patchMenuViewport(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] menu-viewport 补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] menu-viewport 补丁跳过: ' + (err && err.message ? err.message : err));
}

// 顺带应用对话删除/归档管理补丁（dsh-session-manager 前置依赖）：开发模式
// （npm start）直接打 dev node_modules；打包由 after-pack 与启动时运行时
// 补丁覆盖（幂等，锚点不匹配只告警不中断）。
try {
  const { patchSessionManage } = require('./patch-session-manage');
  // 补丁函数期望 node_modules 根目录（path.join(nmRoot, '@deepseek-ai', ...)）。
  const n = patchSessionManage(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] session-manage 补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] session-manage 补丁跳过: ' + (err && err.message ? err.message : err));
}

// 顺带应用「打开项目目录」补丁（issue #85）：侧栏项目/会话行 ⋯ 菜单增加
// 「打开项目目录」+ 右键菜单（dsh-client-ui-workspace）。依赖
// dsh-session-manager 插件提供的 window.__dshDesktopOpenDir 桥；开发模式
// （npm start）直接打 dev node_modules；打包由 after-pack 与启动时运行时
// 补丁覆盖（幂等，锚点不匹配只告警不中断）。
try {
  const { patchOpenProjectDir } = require('./patch-open-project-dir');
  // 注意：补丁函数期望 node_modules 根目录（与 slot-compat 一致）；其它
  // 旧补丁块直接传 root 是历史遗留，这里保持正确传法。
  const n = patchOpenProjectDir(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] open-project-dir 补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] open-project-dir 补丁跳过: ' + (err && err.message ? err.message : err));
}

// 会话进程在 frame 收尾后、JSONL 行写完前中断时，官方读取器会把可恢复的
// 最终半条记录误判为永久损坏。让它复用已有 torn-tail repair 流程。
try {
  const { patchSessionPersistence } = require('./patch-session-persistence');
  // 补丁函数期望 node_modules 根目录（path.join(nmRoot, '@deepseek-ai', ...)）。
  const n = patchSessionPersistence(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] session-persistence 尾部恢复补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] session-persistence 尾部恢复补丁跳过: ' + (err && err.message ? err.message : err));
}
// 空 tool-call 持久化会把 tool/result 的 callId 写成空串，restore 严格校验
// 直接击穿（整个会话打不开）。读端 dsh-session 容错 + 写端 dsh-agent-loop 防护。
try {
  const { patchToolSourceCompat } = require('./lib/tool-source-patch');
  const n = patchToolSourceCompat(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] tool source 容错补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] tool source 容错补丁跳过: ' + (err && err.message ? err.message : err));
}
// rc.6 第三方客户端插件用 `id` 注册 keyed slot；rc.7 改为强制 `key`，而
// dsh-advisor / dsh-llm-fallbacks key/id 都不传，单个插件就能拖垮整个 loader。
// 只在 keyed slot 缺 key 时兜底；显式 key 与其它 slot 行为保持原样。
try {
  const { patchSlotCompat } = require('./patch-slot-compat');
  const n = patchSlotCompat(path.join(root, 'node_modules'), (m) => console.log(m));
  if (n > 0) console.log('[patch-deps] keyed slot 兼容补丁已应用（dev node_modules）');
} catch (err) {
  console.log('[patch-deps] keyed slot 兼容补丁跳过: ' + (err && err.message ? err.message : err));
}
