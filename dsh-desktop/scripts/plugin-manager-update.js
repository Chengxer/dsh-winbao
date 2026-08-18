'use strict';
// ---------------------------------------------------------------------------
// 插件更新（npm 官方/镜像 双源 + GitHub Releases 官方/镜像）：
// 纯函数部分（版本比较、源 URL 构建、校验、解压包根定位）集中在这里，
// 便于 node --test 单测；网络下载与文件落地编排在 main.js（pluginManager*）。
// 版本比较全仓唯一实现在 scripts/lib/versions.js（updater.js 与本模块共用），
// 此处仅作兼容性再导出（main.js / companion-profile / 既有单测沿用本路径）。
// ---------------------------------------------------------------------------

const { compareVersions } = require('./lib/versions');

/** npm registry 的「最新版本」端点（官方 / npmmirror 镜像）。 */
function npmLatestUrl(pkg, mirror) {
  const enc = encodeURIComponent(String(pkg));
  const host = mirror ? 'registry.npmmirror.com' : 'registry.npmjs.org';
  return 'https://' + host + '/' + enc + '/latest';
}

/** GitHub Releases 的 latest API 端点。 */
function githubReleaseApiUrl(repo) {
  return 'https://api.github.com/repos/' + String(repo).replace(/^\/|\/$/g, '') + '/releases/latest';
}

/** GitHub Release 资产直链（官方）。 */
function githubAssetDownloadUrl(repo, tag, assetName) {
  return 'https://github.com/' + String(repo).replace(/^\/|\/$/g, '') + '/releases/download/' + String(tag) + '/' + encodeURIComponent(String(assetName));
}

/** GitHub 加速镜像前缀列表（国内网络友好；逐个尝试，全部失败再报错）。 */
const GH_PROXY_PREFIXES = [
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
];

/** 给任意 https://github.com/... 直链套镜像前缀。 */
function ghProxyUrl(url) {
  for (const prefix of GH_PROXY_PREFIXES) {
    if (url.startsWith(prefix)) return url;
  }
  return GH_PROXY_PREFIXES[0] + url;
}

// ---------------------------------------------------------------------------
// GitHub Release 多资产选择（issue #90 遗留边界，issue #97 根治）：
// 原实现 isWinAsset 用子串匹配（darwin 含 "win" 误判为 Windows）、无架构
// 优先级、无归档时可能选中 .sha256 校验和文本。这里改为纯函数 + 词边界
// 平台判定 + 架构优先级 + 任何阶段排除非二进制文件。
// ---------------------------------------------------------------------------

/** 任何阶段都不得选中的「非二进制」文件（校验和/签名/说明等，下载了无法安装）。 */
const NON_BINARY_RE = /\.(?:sha256|sha512|sha1|sig|asc|txt|md|json|yaml|yml|toml|ini|nfo|log)$|(?:^|[.\-_])sha(?:256|512|1)?sums?$/i;

/** process.platform 值 → 资产命名中的平台关键词（词边界匹配）。 */
const PLATFORM_HINTS = {
  win32: ['win', 'windows'],
  darwin: ['darwin', 'macos', 'osx'],
  linux: ['linux'],
};

/** 架构优先级（越小越优先）：x64/amd64 > arm64/aarch64 > ia32/x86 > arm。 */
const ARCH_ORDER = ['x64', 'amd64', 'arm64', 'aarch64', 'ia32', 'x86', 'arm'];

/**
 * 从 GitHub Release 资产中挑选「当前平台可用的安装包」：
 *   1) 剔除 .sha256/.sig/.asc/说明文档等非二进制文件（任何阶段不选中）；
 *   2) 平台词边界匹配（win/windows | darwin/macos/osx | linux）优先；
 *   3) 平台池内归档（.tgz/.tar.gz/.zip）优先，无归档时回退平台池任意文件；
 *   4) 架构优先级排序（x64 优先，ia32/arm64 次之）。
 * 纯函数，便于单测。返回资产对象；无可下载资产返回 null。
 * @param {Array} assets GitHub API 资产数组（含 name 字段的对象）
 * @param {string} platform process.platform 值（win32/darwin/linux）
 */
function selectGithubAsset(assets, platform) {
  const list = (assets || []).filter((x) => x && typeof x.name === 'string');
  const candidates = list.filter((x) => !NON_BINARY_RE.test(x.name));
  if (!candidates.length) return null;

  const hints = PLATFORM_HINTS[platform] || [];
  // 词边界平台匹配：win/windows（win 后可带数字：win32/win64/win-arm64），
  // 前后必须是分隔符/行首行尾——darwin 含 "win" 子串但前无边界，不误配。
  const platRe = hints.length
    ? new RegExp('(?:^|[.\\-_])(' + hints.map((h) => (h === 'win' ? 'win\\d*' : h)).join('|') + ')(?:[.\\-_]|$)', 'i')
    : null;
  const platPool = platRe ? candidates.filter((x) => platRe.test(x.name)) : [];
  const pool = platPool.length ? platPool : candidates;

  const archives = pool.filter((x) => /\.(?:tgz|tar\.gz|zip)$/i.test(x.name));
  const finalPool = archives.length ? archives : pool;

  const archPatterns = ARCH_ORDER.map((a) => new RegExp('(?:^|[.\\-_])' + a + '(?:[.\\-_]|$)', 'i'));
  const archScore = (name) => {
    for (let i = 0; i < archPatterns.length; i += 1) {
      if (archPatterns[i].test(name)) return i;
    }
    return archPatterns.length; // 无架构信息 → 排最后但可用
  };
  // 排序：平台命中优先（darwin-x64 与 win32-x64 同架构时仍必须选 win32），
  // 再按架构优先级。稳定排序保证同分保持资产原始顺序。
  const platHit = (name) => (platRe ? (platRe.test(name) ? 0 : 1) : 0);
  return finalPool.slice().sort((a, b) => {
    const pa = platHit(a.name);
    const pb = platHit(b.name);
    if (pa !== pb) return pa - pb;
    return archScore(a.name) - archScore(b.name);
  })[0] || null;
}

/** 校验 sha512 base64 integrity（npm dist.integrity 格式: sha512-<base64>）。 */
function verifyIntegrity(buffer, integrity) {
  if (!integrity || typeof integrity !== 'string') return false;
  const m = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/);
  if (!m) return false;
  const crypto = require('node:crypto');
  const actual = crypto.createHash('sha512').update(buffer).digest('base64');
  return actual === m[1];
}

/**
 * 在解压目录中定位「含 package.json 的包根目录」：
 *   npm tarball → 顶层 package/；GitHub zip → 顶层 <repo>-<ref>/ 或直接是根。
 * 返回目录绝对路径；找不到返回 null。
 * @param {string} dir 解压目标目录（tar.exe 解压后的临时目录）
 */
function findPackageRoot(dir, depth = 0) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (depth > 8) return null; // 递归深度防护（防目录环/异常嵌套）
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  // 1) 顶层直接就是包根
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  // 2) 只有一个子目录且内含 package.json → 那就是包根；
  //    唯一子目录不含 package.json 时递归深入（GitHub zip 可能多套一层）
  if (dirs.length === 1) {
    const sub = path.join(dir, dirs[0]);
    if (fs.existsSync(path.join(sub, 'package.json'))) return sub;
    return findPackageRoot(sub, depth + 1);
  }
  // 3) package/ 惯例（npm tarball）
  const pkg = path.join(dir, 'package');
  if (fs.existsSync(path.join(pkg, 'package.json'))) return pkg;
  // 4) 多个子目录：找其中唯一含 package.json 的那个
  for (const name of dirs) {
    if (fs.existsSync(path.join(dir, name, 'package.json'))) return path.join(dir, name);
  }
  return null;
}

module.exports = {
  compareVersions,
  npmLatestUrl,
  githubReleaseApiUrl,
  githubAssetDownloadUrl,
  ghProxyUrl,
  GH_PROXY_PREFIXES,
  verifyIntegrity,
  findPackageRoot,
  selectGithubAsset,
  NON_BINARY_RE,
};
