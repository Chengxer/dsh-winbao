'use strict';

// ---------------------------------------------------------------------------
// plugin-core 插件更新链（updates）：下载→校验→预检→解压→扫描→原子替换→回滚
// 的唯一实现（修复审计发现的高危更新链缺陷）。
//
// 安全不变量（Invariant I4 / I6，fail-closed）：
//   · 完整性锚点必须存在：npm = dist.integrity（sha512），GitHub = Release
//     API digest（sha256）；缺失一律拒绝（UPDATE_NO_INTEGRITY），绝不降级安装；
//   · 下载仅 https（初始 URL 与全部重定向都必须是 https，禁止协议降级）；
//   · 归档条目预检：tar -tf 列名（拒绝 ../、绝对路径、盘符）+ tar -tvf 列类型
//     （拒绝 symlink/hardlink/设备/fifo），解压后再全树 lstat 复检无链接；
//   · 包名必须与更新目标一致、version 合法（UPDATE_PACKAGE_MISMATCH）；
//   · 解压产物静态扫描（scan.js），命中高危需 confirm 确认，拒绝即中止；
//   · 替换原子（rename 语义）：pkgDir → .bak-<ts>，临时根 → pkgDir，失败
//     rename 回滚；成功清理 .bak（服务占用失败则留存，下次启动清理）。
//
// 网络层（request / spawnSync / tarBin）全部注入，纯 Node 可测（单测注入桩，
// 零真实网络）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');
const {
  verifyIntegrity, findPackageRoot, npmLatestUrl, githubReleaseApiUrl, githubAssetDownloadUrl, ghProxyUrl,
} = require('../../plugin-manager-update');
const { compareVersions } = require('../../lib/versions');
const { selectReleaseAsset } = require('../../lib/github-release-assets');
const { scanDir } = require('./scan');

const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const REDIRECT_MAX = 5;
const JSON_MAX_BYTES = 4 * 1024 * 1024;

/** 默认 https 传输（可注入替换）。返回 { statusCode, headers, body(Buffer) }。 */
function defaultRequest(url, { timeoutMs = 60000, headers = {}, maxBytes = DOWNLOAD_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('非 https 协议: ' + u.protocol));
    const https = require('node:https');
    const req = https.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let total = 0;
      let limitHit = false;
      res.on('data', (c) => {
        if (limitHit) return;
        total += c.length;
        if (total > maxBytes) {
          limitHit = true;
          req.destroy(new Error('下载超过 ' + maxBytes + ' 字节上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (!limitHit) resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 带重定向（仅 https、上限 5 跳）的下载。 */
async function downloadHttps(url, { request = defaultRequest, timeoutMs = 60000, redirects = 0 } = {}) {
  if (redirects > REDIRECT_MAX) throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED, '重定向次数过多');
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_BAD_URL, '下载地址非法（仅允许 https）: ' + url);
  const res = await request(url, { timeoutMs });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    const next = new URL(res.headers.location, url).toString();
    if (new URL(next).protocol !== 'https:') {
      throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_BAD_URL, '重定向降级到非 https 协议，已拒绝: ' + next);
    }
    return downloadHttps(next, { request, timeoutMs, redirects: redirects + 1 });
  }
  if (res.statusCode !== 200) throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED, 'HTTP ' + res.statusCode);
  return res.body;
}

/** 下载 JSON（带大小上限，上限在传输层生效——超大响应不会先整块进内存）。 */
async function downloadJson(url, { request = defaultRequest, timeoutMs = 15000, headers = {} } = {}) {
  const res = await rawGet(url, { request, timeoutMs, headers, maxBytes: JSON_MAX_BYTES });
  const text = res.body.toString('utf8');
  if (text.length > JSON_MAX_BYTES) throw new Error('响应超过大小上限');
  try { return JSON.parse(text); } catch (err) { throw new Error('响应不是合法 JSON'); }
}

async function rawGet(url, { request = defaultRequest, timeoutMs = 15000, headers = {}, maxBytes = undefined, redirects = 0 } = {}) {
  if (redirects > REDIRECT_MAX) throw new Error('重定向次数过多');
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('非 https 协议');
  const res = await request(url, { timeoutMs, headers, maxBytes });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    const next = new URL(res.headers.location, url).toString();
    if (new URL(next).protocol !== 'https:') throw new Error('重定向降级到非 https，已拒绝');
    return rawGet(next, { request, timeoutMs, headers, maxBytes, redirects: redirects + 1 });
  }
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
  return res;
}

/** 查 npm 最新版：官方失败自动切 npmmirror；integrity 缺失由调用方 fail-closed。 */
async function fetchNpmLatest(pkg, { request = defaultRequest, log = () => {} } = {}) {
  for (const mirror of [false, true]) {
    try {
      const data = await downloadJson(npmLatestUrl(pkg, mirror), { request });
      if (data && typeof data.version === 'string' && data.dist && data.dist.tarball) {
        return {
          version: String(data.version),
          tarball: String(data.dist.tarball),
          integrity: typeof data.dist.integrity === 'string' ? data.dist.integrity : '',
          source: mirror ? 'npmmirror' : 'npm',
        };
      }
    } catch (err) {
      log('查询 ' + pkg + (mirror ? ' 镜像' : ' 官方') + '失败: ' + err.message);
    }
  }
  return null;
}

/** 查 GitHub Releases 最新版（digest 缺失由调用方 fail-closed）。 */
async function fetchGithubLatest(repo, { request = defaultRequest, log = () => {} } = {}) {
  try {
    const data = await downloadJson(githubReleaseApiUrl(repo), {
      request,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (data && data.tag_name && Array.isArray(data.assets) && data.assets.length > 0) {
      const a = selectReleaseAsset(data.assets);
      if (!a) return null;
      const dm = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(String(a.digest || ''));
      return {
        version: String(data.tag_name).replace(/^v/, ''),
        tag: String(data.tag_name),
        assetName: String(a.name),
        tarball: githubAssetDownloadUrl(repo, data.tag_name, a.name),
        digest: dm ? dm[1].toLowerCase() : '',
        source: 'github',
      };
    }
  } catch (err) {
    log('查询 ' + repo + ' Releases 失败: ' + err.message);
  }
  return null;
}

/**
 * 检查全部可更新插件（与历史 pluginManagerCheckUpdates 语义一致）。
 * @param {Array} rows                 inventory 行
 * @param {Object} sources             { [id]: { kind:'npm', pkg } | { kind:'github', repo } }
 * @param {(name:string)=>string} installedVersion 包名 → 当前版本（空串按 0.0.0）
 * @param {Object} [opts]              { request, log }
 * @returns {Promise<Array>}           有更新源且未卸载的行的检查结果
 */
async function checkUpdatesAvailable(rows, sources, installedVersion, opts = {}) {
  const { request = defaultRequest, log = () => {} } = opts;
  const candidates = (rows || []).filter((r) => sources[r.id] && !r.removed);
  const settled = await Promise.all(candidates.map(async (row) => {
    const src = sources[row.id];
    const current = installedVersion(row.name) || '0.0.0';
    const info = src.kind === 'npm'
      ? await fetchNpmLatest(src.pkg, { request, log })
      : await fetchGithubLatest(src.repo, { request, log });
    if (!info) {
      return { id: row.id, name: row.name, current, latest: '', hasUpdate: false, source: src.kind, error: '查询失败' };
    }
    // 完整性锚点缺失（fail-closed 更新链）：不把「更新后必然被拒」的版本
    // 展示成可更新（UI 一致性：hasUpdate 即「可更新」，不是「有新版」）。
    const anchorMissing = src.kind === 'npm'
      ? !/^sha512-[A-Za-z0-9+/=]+$/.test(info.integrity || '')
      : !info.digest;
    if (anchorMissing) {
      return { id: row.id, name: row.name, current, latest: info.version, hasUpdate: false, source: src.kind, error: 'UPDATE_NO_INTEGRITY' };
    }
    return {
      id: row.id,
      name: row.name,
      current,
      latest: info.version,
      hasUpdate: compareVersions(info.version, current) > 0,
      source: src.kind,
      download: info,
    };
  }));
  return settled;
}

// ---------------------------------------------------------------------------
// 归档预检 / 解压
// ---------------------------------------------------------------------------

/** Windows 保留设备名（大小写不敏感，含 ADS 冒号与尾随点/空格归一化后的形态）。 */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * 归档条目名安全性：拒绝 ../、绝对路径、盘符、NUL；并做 Windows 归一化防御——
 * 段尾点/空格会在创建文件时被剥除（`.. ` 归一化为 `..`）、`:` 是 ADS 流分隔符、
 * CON/AUX/NUL 等保留名不可创建。与 bsdtar 自身清洗叠加，构成纵深防线。
 */
function validateArchiveEntryName(name) {
  const n = String(name || '');
  if (n.includes('\0')) return false;
  if (n.startsWith('/') || n.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(n)) return false;
  for (const rawSeg of n.split(/[\\/]/)) {
    if (rawSeg === '' || rawSeg === '.') continue;
    if (rawSeg === '..') return false;
    // Windows 归一化：剥尾随点/空格后再判定（`.. ` 归一化为 `..`、`...` 归一化为空）。
    const seg = rawSeg.replace(/[. ]+$/, '');
    if (seg === '..' || seg === '') return false;
    if (seg.includes(':')) return false; // 盘符残留 / ADS 流
    // 保留设备名判定在「stem」（首个点之前的部分）上进行：Windows 会剥掉
    // stem 尾部空格——`CON .txt` 归一化为 `CON.txt`，同样命中保留名。
    const dotIdx = seg.indexOf('.');
    const stem = (dotIdx >= 0 ? seg.slice(0, dotIdx) : seg).replace(/[. ]+$/, '');
    if (stem === '') continue; // 纯点/空格 stem（如 `..txt` 的父层）按普通名处理
    if (WINDOWS_RESERVED_RE.test(stem)) return false;
  }
  return true;
}

/**
 * 列出归档条目（tar -tf）+ 类型（tar -tvf）。
 * @param {string} tarBin tar 可执行文件（Windows 自带 bsdtar）
 * @param {string} file  归档文件
 * @param {(cmd:string, args:string[], opts:Object)=>Object} [spawnSync]
 * @returns {{ names: string[], types: string[] }} types 为 -tvf 每行首字符
 */
function listArchive(tarBin, file, { spawnSync = require('node:child_process').spawnSync } = {}) {
  const namesRun = spawnSync(tarBin, ['-tf', file], { encoding: 'utf8', windowsHide: true });
  if (namesRun.status !== 0) throw new Error('列出归档失败: ' + ((namesRun.stderr && namesRun.stderr.trim()) || 'tar 退出码 ' + namesRun.status));
  const names = String(namesRun.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const typesRun = spawnSync(tarBin, ['-tvf', file], { encoding: 'utf8', windowsHide: true });
  if (typesRun.status !== 0) throw new Error('读取归档类型失败: ' + ((typesRun.stderr && typesRun.stderr.trim()) || 'tar 退出码 ' + typesRun.status));
  const types = String(typesRun.stdout || '').split(/\r?\n/).map((l) => (l[0] || '')).filter((c) => c !== '');
  return { names, types };
}

/** 归档安全预检：条目名 + 条目类型（链接/设备/fifo 一律拒绝）。 */
function assertArchiveSafe(names, types) {
  for (const name of names) {
    if (!validateArchiveEntryName(name)) {
      throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE, '归档包含越界条目: ' + name);
    }
  }
  for (const t of types) {
    if (/[lhcbp]/.test(t)) {
      throw new PluginError(PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE, '归档包含链接/设备条目（类型 ' + t + '），已拒绝');
    }
  }
  return true;
}

/** 解压归档到目录（tgz / zip 由扩展名决定参数）。 */
function extractArchive(tarBin, file, extractDir, { spawnSync = require('node:child_process').spawnSync } = {}) {
  fs.mkdirSync(extractDir, { recursive: true });
  const isZip = /\.zip$/i.test(file);
  const run = spawnSync(tarBin, isZip ? ['-xf', file, '-C', extractDir] : ['-xzf', file, '-C', extractDir], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error('解压失败: ' + ((run.stderr && run.stderr.trim()) || 'tar 退出码 ' + run.status));
}

/** 全树 lstat 复检：存在符号链接/junction 即拒绝（解压后的纵深防线）。 */
function treeHasLinks(dir) {
  const walk = (d, depth) => {
    if (depth > 12) return true; // 异常深嵌套按不安全处理
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let lst;
      try { lst = fs.lstatSync(p); } catch { continue; }
      if (lst.isSymbolicLink()) return true;
      if (e.isDirectory()) {
        if (walk(p, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

// ---------------------------------------------------------------------------
// 更新编排
// ---------------------------------------------------------------------------

/**
 * 更新单个插件（加固链）。
 * @param {Object} opts
 * @param {string} opts.id           loader id（锁与日志用）
 * @param {string} opts.name         包名（更新目标）
 * @param {string} opts.profileDir   profiles/<name> 目录（pkgDir 与临时目录落点）
 * @param {Object} opts.source       { kind: 'npm', pkg } | { kind: 'github', repo }
 * @param {() => boolean} [opts.isBusy] 外部忙判定（保留位，主进程注入）
 * @param {(findings: Array) => Promise<boolean>|boolean} [opts.confirm] 扫描命中确认（默认拒绝）
 * @param {(msg: string) => void} [opts.log]
 * @param {Function} [opts.request]       https 传输（注入）
 * @param {Function} [opts.spawnSync]     tar 子进程（注入）
 * @param {string} [opts.tarBin]          tar 可执行文件（默认 tar.exe）
 * @param {Function} [opts.now]          时间源（注入）
 * @returns {Promise<{ok:true, version:string}|{ok:false, error:PluginError}>}
 */
async function updatePlugin(opts) {
  const {
    id, name, profileDir, source, log = () => {},
    request = defaultRequest, spawnSync = require('node:child_process').spawnSync,
    tarBin = 'tar.exe', confirm = () => false, now = Date.now,
    installedVersion = '', gate = null,
  } = opts;
  const pkgDir = path.join(profileDir, 'node_modules', ...name.split('/'));
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
    return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未找到插件安装目录: ' + name) };
  }

  // 1) 元数据 + 完整性锚点（fail-closed）
  const info = source.kind === 'npm'
    ? await fetchNpmLatest(source.pkg, { request, log })
    : await fetchGithubLatest(source.repo, { request, log });
  if (!info || !info.tarball) return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED, '查询最新版本失败（网络或源不可用）') };
  if (source.kind === 'npm') {
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(info.integrity || '')) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_NO_INTEGRITY, 'npm 元数据缺少 sha512 integrity，为安全起见拒绝更新: ' + source.pkg) };
    }
  } else if (!info.digest) {
    return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_NO_INTEGRITY, '该 Release 未提供校验和，为安全起见拒绝更新: ' + source.repo) };
  }

  const isZip = /\.zip$/i.test(info.tarball);
  const tmpFile = path.join(profileDir, 'plugin-update-' + id + '-' + now() + (isZip ? '.zip' : '.tgz'));
  const extractDir = path.join(profileDir, 'plugin-update-x-' + id + '-' + now());
  const backupDir = pkgDir + '.bak-' + now();
  let rollbackFailed = false;
  try {
    // 2) 下载（https-only；GitHub 官方直链失败 → 镜像重试，镜像内容同样过校验）
    let buf;
    try {
      buf = await downloadHttps(info.tarball, { request });
    } catch (err) {
      if (source.kind === 'github') {
        log('官方直链下载失败(' + err.message + ')，改用镜像重试');
        buf = await downloadHttps(ghProxyUrl(info.tarball), { request });
      } else {
        throw err;
      }
    }
    // 3) 完整性校验（锚点来自官方元数据，镜像替换内容即失败）
    if (source.kind === 'npm') {
      if (!verifyIntegrity(buf, info.integrity)) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_INTEGRITY_MISMATCH, '下载校验失败（sha512 不匹配），已中止') };
      }
    } else {
      const crypto = require('node:crypto');
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== info.digest) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_INTEGRITY_MISMATCH, '下载校验失败（sha256 不匹配），已中止') };
      }
    }
    fs.writeFileSync(tmpFile, buf);

    // 4) 归档预检（条目名 + 类型，拒绝 ../、绝对路径、链接/设备）
    try {
      const { names, types } = listArchive(tarBin, tmpFile, { spawnSync });
      assertArchiveSafe(names, types);
    } catch (err) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE, (err && err.message) || String(err)) };
    }

    // 5) 解压 → 包根定位（越界围栏）→ 链接复检
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      extractArchive(tarBin, tmpFile, extractDir, { spawnSync });
    } catch (err) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED, (err && err.message) || String(err)) };
    }
    const root = findPackageRoot(extractDir);
    if (!root) return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH, '解压内容里找不到 package.json') };
    // 围栏：root 必须在解压根内（root === 解压根本身 = package.json 位于归档
    // 顶层的合法形态，findPackageRoot 对这类归档返回解压根，一并放行）。
    const resolvedRoot = path.resolve(root);
    const resolvedExtract = path.resolve(extractDir);
    if (resolvedRoot !== resolvedExtract && !resolvedRoot.startsWith(resolvedExtract + path.sep)) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE, '解压内容路径越界，已中止') };
    }
    if (treeHasLinks(extractDir)) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE, '解压产物包含符号链接，已中止') };
    }

    // 6) 包名/版本契约（fail-closed）：包名缺失或与目标不一致一律拒绝；
    //    版本必须合法且严格高于当前安装版本（拒绝降级/原地重装伪装成更新）。
    let newPkg;
    try { newPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (err) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH, '新版本 package.json 无法解析: ' + err.message) };
    }
    if (!newPkg || !newPkg.version) return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH, '新版本 package.json 缺少 version') };
    if (!newPkg.name || newPkg.name !== name) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH, '下载内容包名不匹配（' + String(newPkg.name || '(缺失)') + ' ≠ ' + name + '），已中止') };
    }
    if (typeof installedVersion === 'string' && installedVersion !== ''
      && compareVersions(String(newPkg.version), installedVersion) <= 0) {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH, '新版本 ' + String(newPkg.version) + ' 未高于当前安装版本 ' + installedVersion + '，拒绝更新') };
    }

    // 7) 静态扫描门禁（命中高危 → confirm；默认拒绝）
    const findings = scanDir({ root, maxDepth: 3 });
    if (findings.length > 0) {
      let allowed = false;
      try { allowed = await confirm(findings); } catch (err) {
        log('扫描确认回调失败: ' + err.message);
      }
      if (!allowed) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_SCAN_BLOCKED, '静态扫描发现高危内容且未获确认，已中止', findings.slice(0, 5)) };
      }
    }

    // 8) 原子替换（rename 语义 + 回滚）。与 lifecycle 的模块目录操作共用
    //    'profile-modules' 锁，杜绝「卸载删目录与更新换目录」交错（同进程
    //    与跨进程都经 WriteGate 串行）。
    const swap = () => {
      try {
        fs.renameSync(pkgDir, backupDir);
      } catch (err) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_ROLLBACK_FAILED, '移出旧版本失败（文件被占用，请退出应用后重试）: ' + err.message) };
      }
      try {
        fs.renameSync(root, pkgDir);
      } catch (err) {
        // 回滚
        try {
          fs.rmSync(pkgDir, { recursive: true, force: true, maxRetries: 2 });
          fs.renameSync(backupDir, pkgDir);
        } catch (rollbackErr) {
          rollbackFailed = true;
          log('更新回滚失败，旧版本备份保留在 ' + backupDir + ': ' + rollbackErr.message);
          return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_ROLLBACK_FAILED, '更新失败且回滚失败，备份保留在 ' + backupDir) };
        }
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY, '替换新版本失败: ' + err.message) };
      }
      return null;
    };
    const swapResult = gate ? await gate.run('profile-modules', swap) : swap();
    if (swapResult) return swapResult;
    return { ok: true, restartRequired: true, version: String(newPkg.version) };
  } catch (err) {
    if (err instanceof PluginError) return { ok: false, error: err };
    return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED, (err && err.message) || String(err)) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* 清理失败无害 */ }
    try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* 清理失败无害 */ }
    if (!rollbackFailed) {
      try { if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 服务占用则留存 */ }
    }
  }
}

/** 启动时清理 24h 前的 .bak-<ts> 更新备份（服务运行中被锁的残留；含 @scope 子层）。 */
function cleanupStaleUpdateBackups(profileDir, { now = Date.now(), maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const modulesDir = path.join(profileDir, 'node_modules');
  const scanDirs = [modulesDir];
  let entries;
  try { entries = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('@')) scanDirs.push(path.join(modulesDir, e.name));
  }
  for (const dir of scanDirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = /^(.+)\.bak-(\d+)$/.exec(name);
      if (!m || now - Number(m[2]) < maxAgeMs) continue;
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 2 }); } catch { /* 占用则跳过 */ }
    }
  }
}

module.exports = {
  DOWNLOAD_MAX_BYTES,
  JSON_MAX_BYTES,
  defaultRequest,
  downloadHttps,
  downloadJson,
  fetchNpmLatest,
  fetchGithubLatest,
  checkUpdatesAvailable,
  listArchive,
  validateArchiveEntryName,
  assertArchiveSafe,
  extractArchive,
  treeHasLinks,
  updatePlugin,
  cleanupStaleUpdateBackups,
  compareVersions,
};
