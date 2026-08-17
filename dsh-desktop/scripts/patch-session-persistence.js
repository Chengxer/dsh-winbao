'use strict';

// Make the JSONL persistence reader tolerate the recoverable crash state where
// the final zstd frame is structurally complete but its plaintext ends halfway
// through one JSONL record.  The actual transform lives in runtime-patches.js
// so the desktop boot path, WSL sync, postinstall, and afterPack share it.

const fs = require('node:fs');
const path = require('node:path');
const { applyPatchToFiles } = require('./lib/patch-engine');
const {
  PERSISTENCE_PKG_REL,
  transformPersistenceTornTail,
} = require('./lib/runtime-patches');

function patchSessionPersistence(nmRoot, log = () => {}) {
  const file = path.join(nmRoot, '@deepseek-ai', PERSISTENCE_PKG_REL);
  if (!fs.existsSync(file)) return 0;
  return applyPatchToFiles({
    prefix: '会话历史尾部恢复补丁',
    files: [file],
    log,
    transform: transformPersistenceTornTail,
    alreadyLog: (target) => '已应用，跳过 ' + target,
    doneLog: (target) => '已恢复 zstd 尾部容错 ' + target,
    anchorLog: log,
    failLog: (target, error) => '会话历史尾部恢复补丁失败(' + target + '): ' + error.message,
  });
}

module.exports = { patchSessionPersistence };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'node_modules'));
  const changed = patchSessionPersistence(root, (message) => console.log(message));
  console.log(`会话历史尾部恢复补丁: ${changed > 0 ? '已应用' : '无变化'}`);
}
