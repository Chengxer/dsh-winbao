'use strict';

// Keyed-slot 兼容补丁（脚本入口）：rc.6 旧插件把 keyed slot 的注册身份放在
// `id`，rc.7 改为强制 `key`；dsh-advisor / dsh-llm-fallbacks 则 key/id 都不
// 传，会令单个第三方插件拖垮整个 loader。ui-slots 侧把旧 `id` 提升为 `key`，
// runner 侧为既无 key 又无 id 的注册派生包级兜底 key。postinstall / pack /
// dist 通过 patch-deps 打 dev node_modules，after-pack 打打包副本，boot /
// sync CLI 打运行副本，全部幂等。

const path = require('node:path');
const { applyPatchToFiles } = require('./lib/patch-engine');
const {
  SLOT_KEY_COMPAT_PKG_REL,
  SLOT_UNKEYED_COMPAT_PKG_REL,
  transformLegacySlotKey,
  transformSlotUnkeyedCompat,
} = require('./lib/runtime-patches');

function patchSlotCompat(nmRoot, log = () => {}) {
  const uiFile = path.join(nmRoot, '@deepseek-ai', SLOT_KEY_COMPAT_PKG_REL);
  const runnerFile = path.join(nmRoot, '@deepseek-ai', SLOT_UNKEYED_COMPAT_PKG_REL);
  let written = 0;
  written += applyPatchToFiles({
    prefix: 'keyed slot 旧插件兼容补丁',
    files: [uiFile],
    log,
    transform: transformLegacySlotKey,
    alreadyLog: (target) => '已应用，跳过 ' + target,
    doneLog: (target) => '已兼容旧插件的 keyed slot id ' + target,
    anchorLog: log,
    failLog: (target, error) => 'keyed slot 旧插件兼容补丁失败(' + target + '): ' + error.message,
  });
  written += applyPatchToFiles({
    prefix: 'keyed slot 无 key 兼容补丁',
    files: [runnerFile],
    log,
    transform: transformSlotUnkeyedCompat,
    alreadyLog: (target) => '已应用，跳过 ' + target,
    doneLog: (target) => '已兼容 keyed slot 无 key 注册 ' + target,
    anchorLog: log,
    failLog: (target, error) => 'keyed slot 无 key 兼容补丁失败(' + target + '): ' + error.message,
  });
  return written;
}

module.exports = { patchSlotCompat };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'node_modules'));
  const changed = patchSlotCompat(root, (message) => console.log(message));
  console.log(`keyed slot 兼容补丁: ${changed > 0 ? '已应用' : '无变化'}`);
}
