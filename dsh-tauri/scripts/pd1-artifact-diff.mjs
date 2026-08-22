#!/usr/bin/env node
// pd1-artifact-diff.mjs —— PD1 安装包体积对账（两安装树 diff + 差额瀑布表）
// ==========================================================================
// 用途：本地构建 vs 官方 Release 安装包的体积对账。回答三个问题：
//   1. 差多少（压缩口径 / 安装后原始字节口径）；
//   2. 差在哪（按安装树顶层组件 + node_modules 逐包的瀑布分解）；
//   3. 差得对不对（健康审计：client-compat.js / rc7 vendor 包 / vendor node
//      二进制 / D3DCOMPILER_47.dll 等关键件在不在）。
//
// 输入（各取其一，可混搭）：
//   · NSIS 安装包 .exe     —— 用 7-Zip 静态列举（不执行安装器，零副作用；
//     Windows 上 NSIS 的 prior-install 检测会动真实安装，故绝不运行安装器）
//   · 便携版 zip / 任意压缩包 —— 同上走 7z
//   · 已解压目录           —— 直接遍历文件系统
//
// 用法：
//   node dsh-tauri/scripts/pd1-artifact-diff.mjs <A.exe|A.zip|A目录> <B.exe|B.zip|B目录> \
//        [--7z C:/path/to/7z.exe] [--top 30] [--json out.json]
//   A 为基准（官方），B 为对账方（本地新构建）——差额 = B - A。
//
// 依赖：7z.exe（--7z 指定路径；PATH 里有 7z 可省略）。仅目录对比时零依赖。
// 退出码：0 正常产出（体积差本身不是失败）；1 输入/工具错误。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SEVEN_ZIP = opt('7z', process.platform === 'win32' ? '7z.exe' : '7z');
const TOP_N = Number(opt('top', 30));
const JSON_OUT = opt('json');

if (args.length < 2) {
  const self = path.basename(fileURLToPath(import.meta.url));
  console.error(`用法: node ${self} <基准(官方).exe|.zip|目录> <对账(本地).exe|.zip|目录> [--7z <7z路径>] [--top N] [--json out.json]`);
  console.error('示例: node dsh-tauri/scripts/pd1-artifact-diff.mjs \\\n  "%TEMP%/pd1/DSH-Desktop-Setup-0.5.2-win-x64.exe" \\\n  DSH-Desktop-Setup-0.5.2-dev-win-x64.exe --7z "%TEMP%/pd1-7zip/7z.exe"');
  process.exit(1);
}

const MB = 1024 * 1024;
const mb = (n) => (n / MB).toFixed(2);

// ---------------------------------------------------------------------------
// 采集：安装包 → 7z l -slt 解析；目录 → 递归遍历
// ---------------------------------------------------------------------------
function listArchive(file) {
  let out;
  try {
    out = execFileSync(SEVEN_ZIP, ['l', '-slt', file], { encoding: 'utf8', maxBuffer: 256 * MB });
  } catch (e) {
    throw new Error(`7z 列举失败: ${file}\n${e.message}\n（--7z 指定完整版 7z.exe；7za 无 NSIS 处理器）`);
  }
  // -slt 块：Path = xxx / Size = n。注：Solid 压缩（NSIS LZMA solid）下
  // 「Packed Size」逐条为空——压缩贡献只能看安装包文件总尺寸（collect 里
  // 用 statSync 记录），逐桶瀑布用安装后原始字节（精确、可复算）。
  const files = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(Path|Size|Attributes) = (.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    // NSIS/zip 条目路径为反斜杠——统一正斜杠，与目录扫描口径一致
    if (k === 'Path') { if (cur) files.push(cur); cur = { path: v.replace(/\\/g, '/'), size: 0, dir: false }; }
    else if (!cur) continue;
    else if (k === 'Size') cur.size = Number(v) || 0;
    else if (k === 'Attributes' && v.startsWith('D')) cur.dir = true;
  }
  if (cur) files.push(cur);
  return files.filter((f) => !f.dir);
}

function walkDir(root) {
  const files = [];
  const rec = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) rec(p);
      else if (ent.isFile()) {
        const size = fs.statSync(p).size;
        files.push({ path: path.relative(root, p).split(path.sep).join('/'), size });
      }
    }
  };
  rec(root);
  return files;
}

function collect(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) return { kind: 'dir', files: walkDir(target), packSize: null };
  return {
    kind: path.extname(target).toLowerCase(),
    files: listArchive(target),
    // 压缩口径 = 安装包文件自身尺寸（solid 归档无逐文件压缩值）
    packSize: st.size,
  };
}

// NSIS/zip 树里的辅助目录（$PLUGINSDIR/$TEMP 等）不是安装产物本体，剔除对齐
const isNoise = (p) => p.startsWith('$PLUGINSDIR/') || p.startsWith('$TEMP/') || p === '[nsis].nsi';

// ---------------------------------------------------------------------------
// 分桶：安装树顶层组件 + node_modules 包粒度
// ---------------------------------------------------------------------------
// 包粒度相对路径：dsh-desktop/node_modules/<pkg> 与 .../@scope/<pkg> 归一
function bucketOf(rel) {
  const parts = rel.split('/');
  // 顶层组件（NSIS 树根 = $INSTDIR 布局）；payload 下再分一层（node_modules/
  // vendor/{node,npm}/assets/scripts）让瀑布粒度对准 staging 口径。
  // 兼容便携版 "DSH Desktop/resources/dsh-desktop/..." 布局：先剥前缀。
  let p = parts;
  if (p[0] === 'DSH Desktop' && p[1] === 'resources') p = p.slice(2);
  if (p[0] === 'dsh-desktop') {
    const second = p[1];
    if (second === 'vendor' && p[2]) {
      return { top: `dsh-desktop/vendor/${p[2]}`, pkg: `__top__/dsh-desktop/vendor/${p[2]}`, file: p.slice(3).join('/') };
    }
    if (second === 'node_modules') {
      // 主 payload node_modules：top 固定，包粒度键与深层 node_modules 统一
      const rest = p.slice(2);
      let pkg = rest[0] || '(root)';
      if (pkg.startsWith('@') && rest[1]) pkg = `${pkg}/${rest[1]}`;
      return { top: 'dsh-desktop/node_modules', pkg: `node_modules/${pkg}`, file: rest.join('/') };
    }
    if (['assets', 'scripts'].includes(second)) {
      return { top: `dsh-desktop/${second}`, pkg: `__top__/dsh-desktop/${second}`, file: p.slice(2).join('/') };
    }
    return { top: 'dsh-desktop(根)', pkg: '__top__/dsh-desktop-root', file: p.slice(1).join('/') };
  }
  // 其余 node_modules（assets/plugins/node_modules、vendor/npm/node_modules 等）
  const nmi = p.indexOf('node_modules');
  if (nmi >= 0) {
    const rest = p.slice(nmi + 1);
    let pkg = rest[0] || '(root)';
    if (pkg.startsWith('@') && rest[1]) pkg = `${pkg}/${rest[1]}`;
    return { top: p.slice(0, nmi + 1).join('/'), pkg: `node_modules/${pkg}`, file: rest.join('/') };
  }
  return { top: p[0], pkg: `__top__/${p[0]}`, file: p.slice(1).join('/') };
}

function summarize(files) {
  const byTop = new Map(); // top -> raw 字节
  const byPkg = new Map(); // pkgKey -> raw 字节
  let raw = 0, count = 0;
  for (const f of files) {
    if (isNoise(f.path)) continue;
    const { top, pkg } = bucketOf(f.path);
    raw += f.size; count += 1;
    byTop.set(top, (byTop.get(top) || 0) + f.size);
    if (pkg.startsWith('node_modules/')) {
      byPkg.set(pkg, (byPkg.get(pkg) || 0) + f.size);
    }
  }
  return { raw, count, byTop, byPkg };
}

const A = collect(path.resolve(args[0]));
const B = collect(path.resolve(args[1]));
const SA = summarize(A.files);
const SB = summarize(B.files);

// ---------------------------------------------------------------------------
// 输出 1：总额与顶层瀑布
// ---------------------------------------------------------------------------
const line = '='.repeat(86);
const ps = (x) => (x == null ? '  n/a' : mb(x).padStart(7));
console.log(line);
console.log(`PD1 体积对账：基准 A = ${args[0]} (${A.kind})  vs  对账 B = ${args[1]} (${B.kind})`);
console.log(`            A: ${SA.count} 文件  安装后 ${mb(SA.raw)}MB  包体 ${ps(A.packSize)}`);
console.log(`            B: ${SB.count} 文件  安装后 ${mb(SB.raw)}MB  包体 ${ps(B.packSize)}`);
console.log(`  差额(B-A): 安装后 ${mb(SB.raw - SA.raw)}MB` + (A.packSize != null && B.packSize != null ? `   包体 ${mb(B.packSize - A.packSize)}MB` : ''));
console.log(line);

const tops = new Set([...SA.byTop.keys(), ...SB.byTop.keys()]);
const rows = [...tops].map((t) => ({
  top: t,
  aRaw: SA.byTop.get(t) || 0,
  bRaw: SB.byTop.get(t) || 0,
})).filter((r) => r.aRaw !== 0 || r.bRaw !== 0)
  .sort((x, y) => Math.abs(y.bRaw - y.aRaw) - Math.abs(x.bRaw - x.aRaw));
console.log('\n── 顶层组件瀑布（安装后原始字节，差额=B-A，按 |Δ| 降序）──');
console.log('组件'.padEnd(40), 'A(MB)'.padStart(9), 'B(MB)'.padStart(9), 'Δ(MB)'.padStart(10));
for (const r of rows) {
  const d = r.bRaw - r.aRaw;
  console.log(r.top.slice(0, 39).padEnd(40), mb(r.aRaw).padStart(9), mb(r.bRaw).padStart(9),
    (d >= 0 ? '+' : '') + mb(d).padStart(9));
}

// ---------------------------------------------------------------------------
// 输出 2：node_modules 逐包差额 Top-N（含只在单侧存在的包）
// ---------------------------------------------------------------------------
console.log(`\n── node_modules 逐包差额 Top-${TOP_N}（Δ=B-A 原始字节； ONLY-A/B = 单侧独有）──`);
const pkgs = new Set([...SA.byPkg.keys(), ...SB.byPkg.keys()]);
const prow = [...pkgs].map((p) => ({
  pkg: p,
  a: SA.byPkg.get(p) || 0,
  b: SB.byPkg.get(p) || 0,
})).map((r) => ({ ...r, d: r.b - r.a }))
  .filter((r) => r.a !== 0 || r.b !== 0);
prow.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
console.log('包'.padEnd(52), 'A(KB)'.padStart(9), 'B(KB)'.padStart(9), 'Δ(KB)'.padStart(10), '备注'.padStart(8));
const fmt = (n) => String(Math.round(n / 1024));
for (const r of prow.slice(0, TOP_N)) {
  const note = r.a === 0 ? 'ONLY-B' : r.b === 0 ? 'ONLY-A' : '';
  console.log(r.pkg.slice(0, 51).padEnd(52), fmt(r.a).padStart(9), fmt(r.b).padStart(9),
    (r.d >= 0 ? '+' : '') + fmt(r.d).padStart(9), note.padStart(8));
}
const onlyA = prow.filter((r) => r.a > 0 && r.b === 0).length;
const onlyB = prow.filter((r) => r.a === 0 && r.b > 0).length;
console.log(`  包级汇总：A 独有 ${onlyA} 个 / B 独有 ${onlyB} 个 / 共同 ${prow.length - onlyA - onlyB} 个`);

// ---------------------------------------------------------------------------
// 输出 3：健康审计（关键件存在性矩阵）
// ---------------------------------------------------------------------------
// 在两侧树里按候选相对路径探测：整段等值 / 目录前缀（候选可为目录）/
// 尾段对齐。不做裸子串匹配——避免 vendor/node/node.exe 误命中
// vendor/node/node 之类前缀陷阱。
function detect(files, cands) {
  const set = new Set(files.map((f) => f.path));
  for (const c of cands) {
    if (set.has(c)) return c;
    const hit = [...set].find((p) => p.startsWith(c + '/') || p.endsWith('/' + c));
    if (hit) return hit;
  }
  return null;
}
const AUDIT = [
  ['client-compat.js（compat 层）', ['dsh-desktop/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/client-compat.js']],
  ['rc7 vendor: dsh-client-web-react', ['dsh-desktop/node_modules/@deepseek-ai/dsh-client-web-react/package.json']],
  ['rc7 vendor: use-sync-external-store', ['dsh-desktop/node_modules/use-sync-external-store/package.json']],
  ['rc7 vendor: @deepseek-ai/schemastery', ['dsh-desktop/node_modules/@deepseek-ai/schemastery/package.json']],
  ['vendor node 二进制（unix node 混入=死重）', ['dsh-desktop/vendor/node/node']],
  ['vendor node.exe（win 必需）', ['dsh-desktop/vendor/node/node.exe']],
  ['D3DCOMPILER_47.dll（B1 边车）', ['D3DCOMPILER_47.dll']],
  ['darwin 二进制混入（win 包=死重）', ['dsh-desktop/node_modules/@img/sharp-libvips-darwin-arm64']],
  ['wasm32 二进制混入（CI 排除面）', ['dsh-desktop/node_modules/@img/sharp-wasm32']],
  ['@electron 混入（CI 排除面）', ['dsh-desktop/node_modules/@electron']],
];
console.log('\n── 健康审计（√=在 / ×=缺）──');
for (const [label, cands] of AUDIT) {
  const ha = detect(A.files, cands) ? '√' : '×';
  const hb = detect(B.files, cands) ? '√' : '×';
  console.log(`${label.padEnd(44)} A(基准):${ha}   B(对账):${hb}`);
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    a: args[0], b: args[1],
    totals: {
      a: { ...SA, packSize: A.packSize },
      b: { ...SB, packSize: B.packSize },
    },
    top: rows, packages: prow, audit: AUDIT.map(([label, cands]) => ({
      label, a: !!detect(A.files, cands), b: !!detect(B.files, cands),
    })),
  }, null, 2));
  console.log(`\nJSON 明细已写入: ${JSON_OUT}`);
}
