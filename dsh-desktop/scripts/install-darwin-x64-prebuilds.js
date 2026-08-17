'use strict';

// 为 darwin-x64 交叉构建安装原生预编译包（在 Apple Silicon (arm64) macOS
// 构建机上运行，为 x64 安装包补装 Intel 变体）。
//
// 背景：GitHub Actions 的 Intel macOS runner（macos-13 / macos-15-intel）已
// 退役或行将退役，x64 macOS 包只能在 arm64 runner 上交叉构建。npm ci 在
// arm64 机器上只装 darwin-arm64 变体，因此这里用 npm pack 精确拉取 4 个
// darwin-x64 预编译 tgz（koffi / sharp / sharp-libvips / narb），解包后直接
// 落盘 node_modules，并删除 arm64 变体 —— 与 scripts/install-arm64-prebuilds.js
// 同一模式：确定性、快、无副作用（不重解析依赖树）。
//
// koffi / sharp / node-addon-require-builtin 在运行时按 process.platform +
// process.arch 动态 require 平台包，因此只要 x64 包出现在 node_modules 里，
// x64 机器上就会加载正确二进制。node-pty 的 darwin-x64 预编译随主包分发
// （prebuilds/），无需安装。
//
// 用法（x64 macOS 构建前，npm ci 之后执行）：
//   node scripts/install-darwin-x64-prebuilds.js
//
// 脚本自带 Mach-O 校验：所有 *.node / *.dylib / spawn-helper 必须包含
// x86_64 架构（lipo -archs），装错架构会直接失败退出。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// 通过随 Node 分发的 npm-cli.js 调 npm（避免依赖 shell 的 npm 可执行文件）。
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
// sharp-darwin-x64 依赖 @img/sharp-libvips-darwin-x64（libvips dylib），
// 必须一并补装，否则 x64 包里会残留 arm64 的 libvips。
const PACKAGES = [
  ['@koromix/koffi-darwin-x64@3.1.5', 'node_modules/@koromix/koffi-darwin-x64'],
  ['@img/sharp-darwin-x64@0.35.3', 'node_modules/@img/sharp-darwin-x64'],
  ['@img/sharp-libvips-darwin-x64@1.3.2', 'node_modules/@img/sharp-libvips-darwin-x64'],
  ['node-addon-require-builtin-darwin-x64@0.1.4', 'node_modules/node-addon-require-builtin-darwin-x64'],
];

// 同名的 arm64 变体（npm ci 装进来的），x64 包不需要，删掉避免体积浪费。
const ARM64_VARIANTS = [
  'node_modules/@koromix/koffi-darwin-arm64',
  'node_modules/@img/sharp-darwin-arm64',
  'node_modules/@img/sharp-libvips-darwin-arm64',
  'node_modules/node-addon-require-builtin-darwin-arm64',
];

// 用 lipo 列出 Mach-O 架构（macOS 自带；对 fat binary 输出全部架构）。
function machOArchs(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error('lipo 校验失败: ' + file + ' — ' + err.message);
  }
}

function findBinaries(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findBinaries(full, out);
    else if (e.name.endsWith('.node') || e.name.endsWith('.dylib') || e.name === 'spawn-helper') {
      out.push(full);
    }
  }
  return out;
}

function packAndExtract(spec, targetRel) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-x64-prebuild-'));
  try {
    const out = execFileSync(process.execPath, [npmCliJs(), 'pack', spec, '--json', '--pack-destination', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // --json 输出是整段 JSON 数组（可能 pretty-printed 多行），从首个 [ 截取后整体解析
    const arr = JSON.parse(out.slice(out.indexOf('[')));
    const filename = Array.isArray(arr) && arr[0] && arr[0].filename ? arr[0].filename : null;
    if (!filename) throw new Error('npm pack --json 未产出 filename: ' + spec);
    const tgz = path.join(tmp, filename);
    if (!fs.existsSync(tgz)) throw new Error('npm pack 未产出 tarball: ' + spec);
    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir);
    try {
      execFileSync('tar', ['-xzf', tgz, '-C', extractDir], { stdio: 'pipe' });
    } catch (err) {
      throw new Error('tar 解压失败: ' + err.message);
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

  for (const rel of ARM64_VARIANTS) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`已删除 arm64 变体 ${rel}`);
    }
  }

  // Mach-O 校验：目标包 + node-pty 内置 darwin-x64 预编译（含 spawn-helper）
  const verifyDirs = [
    'node_modules/@koromix/koffi-darwin-x64',
    'node_modules/@img/sharp-darwin-x64',
    'node_modules/@img/sharp-libvips-darwin-x64',
    'node_modules/node-addon-require-builtin-darwin-x64',
    'node_modules/node-pty/prebuilds/darwin-x64',
  ];
  let checked = 0;
  for (const rel of verifyDirs) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) throw new Error('缺少目录: ' + rel);
    for (const f of findBinaries(dir)) {
      const archs = machOArchs(f);
      if (!archs.split(/\s+/).includes('x86_64')) {
        throw new Error(`架构不符: ${path.relative(root, f)} archs=[${archs}]（期望含 x86_64）`);
      }
      checked++;
    }
  }
  if (checked === 0) throw new Error('未找到任何 Mach-O 二进制可校验');
  console.log(`OK: ${checked} 个 Mach-O 二进制均含 x86_64`);
}

main();
