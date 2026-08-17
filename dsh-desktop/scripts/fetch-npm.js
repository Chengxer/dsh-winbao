'use strict';

// Copies the npm CLI bundled with the system Node into vendor/npm.
// The packaged app uses it (via the vendored node.exe) to check for and
// install official @deepseek-ai/dsh updates — npm resolves the dependency
// tree exactly as the registry publish intends, handles platform-specific
// optional deps, and respects the user's .npmrc (registry mirrors, proxies).
//
// Usage (must run under system Node):
//   npm run fetch-npm

const fs = require('node:fs');
const path = require('node:path');

// 随 Node 分发的 npm 目录。布局因平台而异：Windows 安装放在
// <bin>/node_modules/npm，macOS/Linux（含 GitHub Actions setup-node 的
// toolcache）放在 <bin>/../lib/node_modules/npm。
function bundledNpmDir() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'bin', 'npm-cli.js'))) return c;
  }
  throw new Error('找不到随 Node 分发的 npm（尝试: ' + candidates.join(', ') + '）');
}

const src = bundledNpmDir();
const dest = path.resolve(__dirname, '..', 'vendor', 'npm');

if (!fs.existsSync(path.join(src, 'bin', 'npm-cli.js'))) {
  console.error('找不到随 Node 分发的 npm：' + src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const version = require(path.join(dest, 'package.json')).version;
console.log(`已复制 npm@${version}`);
console.log(`    ${src}`);
console.log(` -> ${dest}`);
