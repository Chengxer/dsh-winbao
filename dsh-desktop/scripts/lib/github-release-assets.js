'use strict';

// ---------------------------------------------------------------------------
// GitHub Release 资产选择（全仓唯一实现，单一数据源）。
//
// 历史：main.js 的 pluginManagerFetchGithubLatest 内联维护资产选择逻辑
// （issue #90 引入，issue #97 暴露缺陷）：
//   · isWinAsset = /(?:win|windows)/i 会把 darwin 误判为 Windows（含子串
//     win），多平台 Release 下载到错误的 mac 包；
//   · 无架构优先级，win-x64 与 win-arm64 并存时随机取数组首个（GitHub
//     API 对同名资产按字母序，arm64 往往排前面）；
//   · 无归档时兜底选中 .sha256 校验和文件，下载 1KB 文本当安装包。
// 本模块收口为一份可选测实现：平台判定用词边界并显式排除 darwin/macos/
// linux；架构偏好 x64 > arm64 > ia32/x86；先剔除校验和/签名等非二进制
// 资产再按「平台匹配归档 → 任意归档 → 平台匹配任意文件 → 首个二进制」
// 依次兜底。
// ---------------------------------------------------------------------------

// 非二进制资产（校验和 / 签名 / 元数据），任何情况下都不该被选中下载。
// 覆盖两类：带扩展名（.sha256/.asc/.json…）与无扩展名清单（SHA256SUMS/checksums）。
const NON_BINARY_RE = /(?:\.(?:sha256|sha512|sha224|sha384|sha1|md5|sig|asc|blockmap|pem|crt|txt|json|ya?ml)$)|(?:^|[.-_])(?:sha(?:256|512|1)?sums?|checksums?|md5sums?)(?:[.-_]|$)/i;

const ARCHIVE_RE = /\.(?:tgz|tar\.gz|zip)$/i;

/** 判断资产是否为可下载的二进制（排除校验和/签名/元数据文件）。 */
function isBinaryAsset(x) {
  return Boolean(x && x.name && !NON_BINARY_RE.test(x.name));
}

/** 判断文件名是否为归档（.tgz / .tar.gz / .zip）。 */
function isArchive(name) {
  return ARCHIVE_RE.test(String(name || ''));
}

/**
 * 判断文件名是否为 Windows 资产：
 * 显式排除 darwin/macos/linux（darwin 含子串 win，直接误判）；Windows
 * 匹配用词边界（非 a-z 字符或串首/串尾），winrar/window 等不误中。
 */
function isWinAsset(name) {
  const s = String(name || '').toLowerCase();
  if (/(?:darwin|macos|linux)/.test(s)) return false;
  return /(?:^|[^a-z])(?:win|windows)(?:[^a-z]|$)/.test(s);
}

/** 架构优先级：x64 > arm64 > ia32/x86 > 未知（排序用，越小越优）。 */
function archRank(name) {
  const s = String(name || '').toLowerCase();
  if (/(?:x64|x86_64|amd64)/.test(s)) return 0;
  if (/(?:arm64|aarch64)/.test(s)) return 1;
  if (/(?:ia32|x86|win32|i386)/.test(s)) return 2;
  return 3;
}

/** 在同优先级组内按架构偏好取一个（稳定排序，同 rank 保留原顺序）。 */
function pick(list) {
  return (list || []).slice().sort((a, b) => archRank(a.name) - archRank(b.name))[0] || null;
}

/**
 * 从 GitHub Release 资产列表中选出最优下载目标，返回资产对象（含 name/
 * digest 等原字段）；无可用二进制时返回 null（调用方应视作查询失败，
 * 而非拿校验和文件当安装包）。
 */
function selectReleaseAsset(assets) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const binaries = assets.filter(isBinaryAsset);
  if (binaries.length === 0) return null;
  const archives = binaries.filter((x) => isArchive(x.name));
  const win = binaries.filter((x) => isWinAsset(x.name));
  return (
    pick(archives.filter((x) => isWinAsset(x.name))) ||
    pick(archives) ||
    pick(win) ||
    binaries[0] ||
    null
  );
}

module.exports = { selectReleaseAsset, isBinaryAsset, isArchive, isWinAsset, archRank };