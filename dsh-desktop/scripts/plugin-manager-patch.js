'use strict';
// ---------------------------------------------------------------------------
// 兼容再导出：补丁层文本手术的唯一实现在 scripts/plugin-core/lib/patch-surgery.js。
// 本文件保留历史导入路径（main.js / 单测 / 外部脚本），行为与契约完全一致，
// 并修复了历史缺陷：loader id 统一字符集（含点号）、EOL 保持、卸载/开关幂等。
// ---------------------------------------------------------------------------

const { togglePluginInPatch, setPluginRemoved } = require('./plugin-core/lib/patch-surgery');

module.exports = { togglePluginInPatch, setPluginRemoved };
