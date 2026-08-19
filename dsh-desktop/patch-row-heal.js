'use strict';
// ---------------------------------------------------------------------------
// 兼容再导出：patch 行级自愈的唯一实现在
// scripts/plugin-core/lib/patch-surgery.js（历史本文件为独立实现，曾与
// profile-patch-heal / plugin-manager-patch 三处漂移——id 字符集不一致导致
// 点号 id 插件「能写不能愈」）。本文件保留历史导入路径，全部函数委托唯一实现。
// ---------------------------------------------------------------------------

const {
  configLinesFor,
  normalizeRowConfigIndent,
  healSoulMdPatchRow,
  healRowConfig,
  removeBundledRowDuplicates,
  bundlePatchEntryIds,
  collectBundleEntryIds,
} = require('./plugin-core/lib/patch-surgery');

module.exports = {
  configLinesFor,
  normalizeRowConfigIndent,
  healSoulMdPatchRow,
  healRowConfig,
  removeBundledRowDuplicates,
  bundlePatchEntryIds,
  collectBundleEntryIds,
};
