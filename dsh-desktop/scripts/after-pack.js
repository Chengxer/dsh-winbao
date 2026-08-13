'use strict';

// electron-builder afterPack hook.
//
// electron-builder's file copier strips nested node_modules directories from
// extraResources, but the bundled npm CLI needs its own bundled deps
// (graceful-fs, semver, ...). Copy vendor/npm verbatim into the packed app
// after packaging; both the portable and NSIS targets then archive this copy.

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== 'win32') return;
  const src = path.resolve(__dirname, '..', 'vendor', 'npm');
  const dest = path.join(appOutDir, 'resources', 'npm');
  if (!fs.existsSync(src)) {
    console.warn('afterPack: vendor/npm missing — npm CLI will not be bundled');
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const deps = fs.readdirSync(path.join(dest, 'node_modules')).length;
  console.log(`afterPack: bundled npm copied (deps: ${deps})`);
};
