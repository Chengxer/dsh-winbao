#!/usr/bin/env node
// build-client-compat.mjs —— rc.7 客户端包兼容注册器（页面端）
// ==========================================================================
// 背景（issue 实测 + 源码深挖定论）：页面插件的
// require("@deepseek-ai/dsh-client-web-react" / "-schema-form" /
// "-ui-attachment") 由页面端 client-modules 加载器解析，三个合法来源：
// seed 表（前端 vite 构建注入）/ 已物化模块 / 已注册 package factory。
// 页面**永远不读 node_modules**。rc.8 前端构建把这三个包从 seed 表删了
// （rc.7 seed 10 项 → rc.8 7 项），而大量伴随插件 client bundle 仍 require
// 它们 → "missed the module table" → 插件全灭、侧边栏消失。
// （Electron 0.4.1 正常是因为整棵栈 rc.7：其前端 dist 静态打包了它们。）
//
// 修复：走第三条合法通道——把 rc.7 包（来自 0.4.1 构建产物，字节级同源）
// 以 esbuild 打成单文件 CJS（--packages=external：相对文件内联、包依赖
// 外部化），再包成 factory 经 window.__ModuleLoader__.load() 注册进队列
// facade（rc.8 host 注入在 <head> 紧后，classic head script 必在其后执行；
// 队列/活体两模式 load() 都收敛，注册顺序无关）。
//
// 产物：payload 的 dsh-web-frontend/dist/assets/client-compat.js
//   + dist/index.html <head> 注入 <script src="/assets/client-compat.js">
// 用法：node dsh-tauri/scripts/build-client-compat.mjs（stage-payload.sh 内建调用）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RC7 = path.join(REPO, 'dsh-desktop', 'dist', 'win-unpacked', 'resources', 'app', 'node_modules');
const FE_DIST = path.join(
  REPO, 'dsh-tauri', 'package-payload', 'dsh-desktop',
  'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist',
);

// rc.8 seed 表全集（external require 命中 seed 的部分；closure 包走各自的
// load() 注册，两条路在页面端都合法）。
const RC8_SEED = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]);

// 根：rc.8 前端 seed 缺失且被插件 require 的包。**必须同时不在 rc.8 boot
// graph 行里**——arrive() 见 factories.has(id) 会跳过该行 bundle 拉取
// （client.js arrive()：loadCache/factories 命中即 resolve），预注册的
// rc.7 纯对象形态会顶死 rc.8 客户端插件条目 → 「invalid plugin, expect
// function or object with an "apply" method, received object」启动横幅
// （实测：ui-attachment 在 71 图行中，曾入 ROOTS 即触发该横幅；web-react/
// schema-form 无图行，安全）。graph 行原生供给的包一律不得入此清单。
const ROOTS = [
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-schema-form',
];

// node 内建/危险模块黑名单（页面端不可用，出现即构建失败——防把内核侧
// 库意外拉进闭包）。


function pkgDir(id) { return path.join(RC7, ...id.split('/')); }
function readPkg(id) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir(id), 'package.json'), 'utf8'));
}

// 闭包 BFS 仅供诊断输出与存在性校验；实际打包按根独立进行——闭包依赖
// **内联**进各根 bundle（--external 仅限 rc8 seed 7 项）。曾试
// --packages=external + 全闭包逐包注册：子路径 require
// （use-sync-external-store/shim/with-selector.js）会暴露给页面表且
// 匹配不到注册 id（Node harness 实测抓出）。内联后页面只见 3 个根 id。
const closureDiag = new Set();
{
  const q = [...ROOTS];
  while (q.length > 0) {
    const id = q.shift();
    if (closureDiag.has(id) || RC8_SEED.has(id)) continue;
    if (!fs.existsSync(path.join(RC7, ...id.split('/'), 'package.json'))) {
      throw new Error(`client-compat: 闭包包缺失 ${id}（0.4.1 构建产物不完整？重跑 dsh-desktop 打包）`);
    }
    closureDiag.add(id);
    for (const dep of Object.keys(readPkg(id).dependencies || {})) q.push(dep);
  }
}
console.log(`[compat] 依赖闭包（将内联）：${[...closureDiag].join(', ')}`);

// ---- 每根独立 esbuild：单文件 CJS，external 仅 rc8 seed ----
function bundleRoot(id) {
  const pkg = readPkg(id);
  const entry = path.join(pkgDir(id), pkg.main || 'index.js');
  const extArgs = [...RC8_SEED].map((s) => `--external:${s}`).join(' ');
  const out = execSync(
    `npx --yes esbuild@0.25.0 ${JSON.stringify(entry)} --bundle --format=cjs --platform=node ${extArgs} --log-level=error`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const requires = [...out.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  const bad = requires.filter((s) => !RC8_SEED.has(s));
  if (bad.length > 0) {
    throw new Error(`client-compat: ${id} 残留非 seed external ${bad.join(',')}（内联不彻底）`);
  }
  return out;
}

const parts = [];
parts.push(
  '/* DSH Desktop client-compat：rc.7 客户端包兼容注册（自动生成，勿手改）。',
  ' * 机制见 dsh-tauri/scripts/build-client-compat.mjs 头注。 */',
  '(function(){',
  "'use strict';",
  'var L = window.__ModuleLoader__;',
  "if (L == null || typeof L.load !== 'function') { console.warn('[dsh-compat] __ModuleLoader__ 缺失，跳过'); return; }",
  'function wrap(cjsSource) {',
  '  return function (require) {',
  '    var module = { exports: {} };',
  '    new Function("require", "module", "exports", cjsSource)(require, module, module.exports);',
  '    return module.exports;',
  '  };',
  '}',
);
for (const id of ROOTS) {
  const src = bundleRoot(id);
  parts.push(`L.load({ id: ${JSON.stringify(id)}, factory: wrap(${JSON.stringify(src)}) });`);
  console.log(`[compat] + ${id}（${(src.length / 1024).toFixed(0)}KB，依赖已内联）`);
}
parts.push('})();');

const outFile = path.join(FE_DIST, 'assets', 'client-compat.js');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, parts.join('\n'), 'utf8');

// ---- index.html 注入（<title> 后；host 的 facade 注在 <head> 紧后必先于本脚本）----
const idxFile = path.join(FE_DIST, 'index.html');
let html = fs.readFileSync(idxFile, 'utf8');
if (html.includes('client-compat.js')) {
  console.log('[compat] index.html 已注入，跳过');
} else {
  const TAG = '<script src="/assets/client-compat.js" defer></script>';
  if (html.includes('<title>')) {
    html = html.replace(/(<title>[^<]*<\/title>)/, `$1\n  ${TAG}`);
  } else {
    html = html.replace(/(<head[^>]*>)/, `$1\n  ${TAG}`);
  }
  fs.writeFileSync(idxFile, html, 'utf8');
  console.log('[compat] index.html 注入完成');
}
console.log(`[compat] 完成：${outFile}`);
