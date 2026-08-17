'use strict';

// 为 win32-arm64 交叉构建安装原生预编译包（在 x64 Windows 构建机上运行）。
//
// 为什么不用 `npm install --os=win32 --cpu=arm64`：npm 会重解析整棵依赖树
// （reify），既慢又可能把其它平台相关包（如 electron 的 extract-zip）一起
// 换掉。这里改用 npm pack 精确拉取 3 个 arm64 预编译 tgz，解包后直接落盘
// node_modules，其余依赖一概不动 —— 确定性、快、无副作用。
//
// koffi / sharp / node-addon-require-builtin 在运行时按
// process.platform + process.arch 动态 require 平台包，因此只要 arm64 包
// 出现在 node_modules 里，arm64 机器上就会加载正确二进制。
// node-pty 的 win32-arm64 预编译随主包分发（prebuilds/），无需安装。
//
// 用法（arm64 构建前，npm ci 之后执行）：
//   node scripts/install-arm64-prebuilds.js
//
// 脚本自带 PE 校验：所有 *.node 的 Machine 字段必须为 0xAA64（arm64），
// 装错架构会直接失败退出，防止把 x64 二进制打进 arm64 安装包。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ARM64_MACHINE = 0xaa64; // IMAGE_FILE_MACHINE_ARM64

// 通过随 Node 分发的 npm-cli.js 调 npm（Windows 下 .cmd 无法直接 spawn）。
// 布局因平台而异：Windows 安装把 npm 放在 <bin>/node_modules/npm，而
// macOS/Linux（含 GitHub Actions setup-node 的 toolcache）放在
// <bin>/../lib/node_modules/npm。
function npmCliJs() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('未找到随 Node 分发的 npm-cli.js（尝试: ' + candidates.join(', ') + '）');
}

// [npm 包名, node_modules 目标相对路径]
const PACKAGES = [
  ['@koromix/koffi-win32-arm64@3.1.5', 'node_modules/@koromix/koffi-win32-arm64'],
  ['@img/sharp-win32-arm64@0.35.3', 'node_modules/@img/sharp-win32-arm64'],
  ['node-addon-require-builtin-win32-arm64-msvc@0.1.4', 'node_modules/node-addon-require-builtin-win32-arm64-msvc'],
];

// 同名的 x64 变体（npm ci 装进来的），arm64 包不需要，删掉避免体积浪费。
const X64_VARIANTS = [
  'node_modules/@koromix/koffi-win32-x64',
  'node_modules/@img/sharp-win32-x64',
  'node_modules/node-addon-require-builtin-win32-x64-msvc',
];

function peMachine(file) {
  const buf = fs.readFileSync(file);
  const peOff = buf.readUInt32LE(0x3c);
  return buf.readUInt16LE(peOff + 4);
}

function findNodeFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findNodeFiles(full, out);
    else if (e.name.endsWith('.node')) out.push(full);
  }
  return out;
}

function packAndExtract(spec, targetRel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arm64-prebuild-'));
  try {
    const out = execFileSync(process.execPath, [npmCliJs(), 'pack', spec, '--json', '--pack-destination', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // --json 输出是整段 JSON 数组（可能 pretty-printed 多行），从首个 [ 截取后整体解析，
    // 避免依赖 npm 人类可读输出的行格式（不同 npm 版本可能输出 basename / 相对路径）。
    const arr = JSON.parse(out.slice(out.indexOf('[')));
    const filename = Array.isArray(arr) && arr[0] && arr[0].filename ? arr[0].filename : null;
    if (!filename) throw new Error('npm pack --json 未产出 filename: ' + spec);
    const tgz = path.join(tmp, filename);
    if (!fs.existsSync(tgz)) throw new Error('npm pack 未产出 tarball: ' + spec);
    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir);
    // Windows 10 1803+ 自带 bsdtar，可解 .tgz
    try {
      execFileSync('tar', ['-xzf', tgz, '-C', extractDir], { stdio: 'pipe' });
    } catch (err) {
      throw new Error('tar 解压失败（需 Windows 10 1803+ 的 bsdtar）: ' + err.message);
    }
    const pkgDir = path.join(extractDir, 'package');
    if (!fs.existsSync(pkgDir)) throw new Error('tarball 缺少 package/ 根目录: ' + spec);
    const target = path.join(root, targetRel);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(pkgDir, target, { recursive: true });
    console.log(`已安装 ${spec} -> ${targetRel}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  for (const [spec, target] of PACKAGES) packAndExtract(spec, target);

  for (const rel of X64_VARIANTS) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`已删除 x64 变体 ${rel}`);
    }
  }

  // PE 校验：目标包 + node-pty 内置 arm64 预编译
  const verifyDirs = [
    'node_modules/@koromix/koffi-win32-arm64',
    'node_modules/@img/sharp-win32-arm64',
    'node_modules/node-addon-require-builtin-win32-arm64-msvc',
    'node_modules/node-pty/prebuilds/win32-arm64',
  ];
  let checked = 0;
  for (const rel of verifyDirs) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) throw new Error('缺少目录: ' + rel);
    for (const f of findNodeFiles(dir)) {
      const m = peMachine(f);
      if (m !== ARM64_MACHINE) {
        throw new Error(`架构不符: ${path.relative(root, f)} machine=0x${m.toString(16)}（期望 0xaa64 arm64）`);
      }
      checked++;
    }
  }
  if (checked === 0) throw new Error('未找到任何 .node 文件可校验');
  console.log(`OK: ${checked} 个原生二进制均为 arm64（0xaa64）`);
}

main();
