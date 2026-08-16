'use strict';

// Copies the system Node executable into vendor/node/node.exe.
//
// Why: the packaged app boots the dsh CLI with a real node.exe so prebuilt
// native modules (sharp, node-pty, koffi, ...) keep the exact Node ABI they
// were compiled for. Electron's embedded Node has a different ABI and would
// refuse to load them; rebuilding against Electron would break them for
// plain node. Bundling the same node.exe used at install time is the
// zero-config way to guarantee a match.
//
// Usage (must run under system Node, not Electron):
//   npm run fetch-node                          # copy the local node.exe
//   node scripts/fetch-node.js --arch=arm64     # download the SAME node
//                                               # version for win32-arm64 from
//                                               # nodejs.org (used by the
//                                               # cross-built ARM64 package)
//
// ARM64 mode: a Windows x64 build machine cannot produce an arm64 node.exe by
// copying, so instead we fetch the official win-arm64 build of the exact same
// node version (process.version) from nodejs.org. All runtime native modules
// (koffi / sharp / node-pty / node-addon-require-builtin) are N-API addons,
// so any modern Node version matches their ABI.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const dest = path.resolve(__dirname, '..', 'vendor', 'node', 'node.exe');

const MAX_REDIRECTS = 5;

function httpDownload(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'dsh-desktop-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          return reject(new Error(`重定向超过 ${MAX_REDIRECTS} 次: ${url}`));
        }
        return httpDownload(res.headers.location, destPath, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('下载超时: ' + url)));
    req.on('error', reject);
  });
}

function extractNodeExe(zipPath, tmpDir) {
  // Prefer bsdtar (ships with Windows 10 1803+ and every GH runner);
  // fall back to PowerShell Expand-Archive if tar is unavailable.
  let ok = false;
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', tmpDir], { stdio: 'pipe' });
    ok = true;
  } catch (err) {
    console.warn('tar 解压失败，改用 PowerShell Expand-Archive: ' + err.message);
  }
  if (!ok) {
    const script = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'pipe' });
    } catch (err) {
      console.error('解压 node zip 失败: ' + err.message);
      process.exit(1);
    }
  }
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^node(\.exe)?$/i.test(e.name)) found.push(full);
    }
  };
  walk(tmpDir);
  if (!found.length) {
    console.error('zip 内未找到 node.exe: ' + zipPath);
    process.exit(1);
  }
  return found[0];
}

async function fetchArm64() {
  const version = process.version; // e.g. v24.3.0
  const url = `https://nodejs.org/dist/${version}/node-${version}-win-arm64.zip`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-node-arm64-'));
  const zip = path.join(tmpDir, 'node-win-arm64.zip');
  console.log(`下载 ${url}`);
  await httpDownload(url, zip);
  const size = fs.statSync(zip).size;
  if (!size) {
    console.error('下载产物为空（0 bytes）: ' + zip);
    process.exit(1);
  }
  console.log(`    -> ${zip} (${size} bytes)`);
  const exe = extractNodeExe(zip, tmpDir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(exe, dest);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`已写入 ${dest}`);
  console.log(`Node ${version} / win32-arm64 / ${fs.statSync(dest).size} bytes`);
}

(async () => {
  const archFlag = process.argv.find((a) => a.startsWith('--arch='));
  const arch = archFlag ? archFlag.slice('--arch='.length) : process.arch;
  if (arch === 'arm64') {
    await fetchArm64();
    return;
  }
  if (arch !== process.arch) {
    console.error(`fetch-node 仅支持 --arch=${process.arch}（本地复制）或 --arch=arm64（下载）。`);
    process.exit(1);
  }

  // Native path: copy the running node.exe (original behavior).
  const src = process.execPath;
  if (!/node(\.exe)?$/i.test(path.basename(src))) {
    console.error('fetch-node 必须在系统 Node 下运行（npm run fetch-node），不能在 Electron 内运行。');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`已复制 ${src}`);
  console.log(`    -> ${dest}`);
  console.log(`Node ${process.version} / ${process.platform}-${process.arch} / ${fs.statSync(dest).size} bytes`);
})().catch((err) => {
  console.error('fetch-node 失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
