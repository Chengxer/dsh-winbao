'use strict';
// ---------------------------------------------------------------------------
// DSH Desktop 备份与恢复（设置页「插件」页内嵌「诊断与备份」区块）：
// 纯函数部分集中于本模块（收集 / 校验 / 原子恢复 + 回滚），便于
// node --test 单测；main.js 负责路径解析（effectiveDshHome 等）、
// 对话框选文件与 IPC 编排。
//
// 备份范围（用户确认：profile 配置 + 全局设置）：
//   - profileDir  （~/.dsh/profiles/web）：除 node_modules 外全部配置文件
//   - homeDir     （~/.dsh）：顶层全局设置（settings.yaml / .credentials.yaml
//                 等），不含 sessions/ 等大目录
// 敏感文件（.credentials.yaml 等）照常备份（可恢复性优先），但在备份元数据
// 中标记 secretFiles，UI 据此弹警告；恢复前同样提示。
//
// 数据格式（JSON，UTF-8，可读可手改）：
//   { format: 'dsh-desktop-backup', version: 1,
//     createdAt, label, homeDir, profileDir,
//     secretFiles: [relPath...],
//     files: [{ path, json } | { path, lines }] }   // path 相对备份根
//
// 安全模型（对齐 dsh-market backup.ts）：
//   - 收集/恢复均按相对路径 + 白名单目录，拒绝绝对路径、.. 段、符号链接
//   - 恢复前严格校验（validatedBackup），写盘用 tmp+rename 原子替换
//   - 恢复失败自动回滚到恢复前的原始字节
//   - 大小上限（2MB）与文件数上限（256），防止恶意备份撑爆磁盘
// ---------------------------------------------------------------------------

const BACKUP_FORMAT = 'dsh-desktop-backup';
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 256;

/** 备份时跳过的大目录 / 生成物。 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'sessions',
  'storages',
  'skills',
  'skills-disabled',
  'skill-toggle',
  'super-injector', // super-injector 运行时缓存
  'profiles', // profile 内容由 profile/ 前缀单独收集，避免 home 递归重复打包
]);

/** 顶层直接跳过的不安全/冗余文件（多个）。 */
const SKIP_FILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json']);

/** 仅收集白名单扩展名的配置文本文件（避免把二进制/大文件包进备份）。 */
const ALLOWED_EXT = new Set([
  '.yml', '.yaml', '.json', '.toml', '.txt', '.md', '.ini', '.cfg',
  '.env', '.conf', '.properties', '.log', '.tsv', '.csv',
]);

/** 备份后用户需知情的敏感文件（含密钥）。 */
const SECRET_FILE_RE = /(^|\/)(\.credentials\.yaml|credentials\.yaml|settings\.yaml|\.env(\.\w+)?|\.npmrc|config\.toml)$/i;

/** Windows 保留设备名：作为路径段会触发 EINVAL（CON/NUL/PRN/AUX/COM1-9/LPT1-9）。 */
const WIN_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 兼容校验：path 安全性（绝对 / .. / 空段 / illegal）检查。 */
function assertSafeRelPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') throw new Error('备份路径不是合法字符串');
  if (require('node:path').isAbsolute(rawPath)) throw new Error('备份路径不允许绝对路径');
  const parts = rawPath.split(/[\\/]/);
  for (const part of parts) {
    if (part === '..' || part === '' || part === '.') throw new Error(`备份路径含非法段: ${rawPath}`);
    if (part.includes(':') || part.includes('*') || part.includes('?') || part.includes('"') || part.includes('<') || part.includes('>') || part.includes('|')) {
      throw new Error(`备份路径含非法字符: ${rawPath}`);
    }
    if (WIN_RESERVED_NAME_RE.test(part)) throw new Error(`备份路径含 Windows 保留设备名: ${rawPath}`);
  }
  return parts.join('/');
}

/** 收集根目录下的配置文本文件（相对路径列表，/ 分隔，已排序去重）。 */
function collectFiles(root, fs = require('node:fs'), path = require('node:path')) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relPath = rel === '' ? e.name : rel + '/' + e.name;
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(abs, relPath);
        continue;
      }
      if (!e.isFile()) continue; // symlink 等一律跳过
      const ext = path.extname(e.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext) && !isSecretName(e.name)) continue;
      if (SKIP_FILE_NAMES.has(e.name) || /\.(bak|tmp|broken|old|orig|swp)($|\.)/.test(e.name)) continue;
      out.push(relPath.replace(/\\/g, '/'));
    }
  };
  walk(root, '');
  return [...new Set(out)].sort();
}

function isSecretName(name) {
  return SECRET_FILE_RE.test(name);
}

/**
 * 提取一个文件的「可打包内容」：文本行数组、JSON 对象，或非 UTF-8 文本的 base64 原始字节。
 * 返回 { path, json } / { path, lines } / { path, encoding:'base64', base64 }；
 * 二进制（含 NUL）抛错跳过；非 UTF-8 文本不再静默乱码（GBK/GB2312/ANSI 中文 Windows 常见）。
 */
function readBackupFile(root, relPath, fs = require('node:fs'), path = require('node:path')) {
  const abs = path.join(root, relPath);
  const buf = fs.readFileSync(abs);
  if (buf.length > MAX_BACKUP_BYTES) throw new Error(`文件过大（跳过）: ${relPath}`);
  // 拒绝二进制：前 8KB 内含 NUL 即非文本
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) throw new Error(`文件不是文本（跳过）: ${relPath}`);
  // 非 UTF-8 文本（GBK 等）：原字节 base64 存储，恢复时原样写回，避免乱码损坏
  let text = null;
  try { text = buf.toString('utf8'); } catch { /* 下取 base64 */ }
  if (text !== null) {
    // UTF-16 带 BOM 时 Node 的 utf8 解码可能通过（BOM 被解码成 U+FEFF），
    // 但内容会乱——显式探测 BOM 与无效字节
    const hasBom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
    if (hasBom || !isLikelyUtf8(buf)) {
      return { path: relPath, encoding: 'base64', base64: buf.toString('base64') };
    }
  } else {
    return { path: relPath, encoding: 'base64', base64: buf.toString('base64') };
  }
  if (path.basename(relPath).toLowerCase() === 'package.json') {
    let json = null;
    try { json = JSON.parse(text); } catch { /* 退回 lines */ }
    if (json !== null && typeof json === 'object') return { path: relPath, json };
  }
  return { path: relPath, lines: text.split(/\r?\n/) };
}

/** UTF-8 合法性启发式：解码后无 U+FFFD 替换符 + 重编码一致。 */
function isLikelyUtf8(buf) {
  try {
    const decoded = buf.toString('utf8');
    if (decoded.includes('\uFFFD')) return false;
    return Buffer.from(decoded, 'utf8').equals(buf);
  } catch { return false; }
}

/**
 * 创建备份对象（纯函数；不写文件）。
 * @param {object} opts { profileDir, homeDir, label?, fs?, path? }
 * @returns {object} 备份 JSON
 */
function createBackup(opts, fs = require('node:fs'), pathMod = require('node:path')) {
  if (!opts || !opts.profileDir || !opts.homeDir) throw new Error('备份需要 profileDir 与 homeDir');
  const { profileDir, homeDir } = opts;
  const files = [];
  const secretFiles = [];
  const roots = [
    { dir: profileDir, prefix: 'profile/' },
    { dir: homeDir, prefix: 'home/' },
  ];
  for (const { dir, prefix } of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const rel of collectFiles(dir, fs, pathMod)) {
      const entryPath = prefix + rel;
      try {
        const content = readBackupFile(dir, rel, fs, pathMod);
        files.push({ ...content, path: entryPath });
        if (isSecretName(rel)) secretFiles.push(entryPath);
      } catch {
        // 单个文件异常不阻断整体备份
      }
    }
  }
  if (files.length === 0) throw new Error('没有可备份的配置内容');
  if (files.length > MAX_FILES) throw new Error(`配置文件超过 ${MAX_FILES} 个，放弃备份`);
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    label: String(opts.label || 'DSH Desktop 配置备份'),
    // 不写入 profileDir/homeDir 绝对路径：备份文件可能被分享，目录布局不应泄露
    secretFiles,
    files,
  };
  const bytes = Buffer.byteLength(JSON.stringify(backup));
  if (bytes > MAX_BACKUP_BYTES) throw new Error(`备份体积 ${bytes} 字节超过上限 ${MAX_BACKUP_BYTES}`);
  return backup;
}

/**
 * 严格校验备份内容（恢复前强制调用）。
 * 抛错 = 备份非法；返回规范化后的备份对象。
 */
function validatedBackup(value) {
  if (value === null || typeof value !== 'object') throw new Error('备份内容不是对象');
  const b = value;
  if (b.format !== BACKUP_FORMAT) throw new Error(`备份格式不匹配（期望 ${BACKUP_FORMAT}，实际 ${String(b.format)}）`);
  if (b.version !== BACKUP_VERSION) throw new Error(`备份版本不支持（期望 v${BACKUP_VERSION}，实际 v${String(b.version)}）`);
  if (!Array.isArray(b.files) || b.files.length === 0) throw new Error('备份缺少文件列表');
  if (b.files.length > MAX_FILES) throw new Error('备份文件数超过上限');
  // secretFiles 形状校验：必须是无重复的字符串数组（恶意备份不能塞任意形状）
  const secretList = Array.isArray(b.secretFiles) ? b.secretFiles : [];
  if (secretList.some((s) => typeof s !== 'string')) throw new Error('备份密钥文件清单格式非法');
  const out = { ...b, secretFiles: [], files: [] };
  const detectedSecrets = new Set();
  const seen = new Set();
  for (const file of b.files) {
    if (file === null || typeof file !== 'object') throw new Error('文件条目不是对象');
    const p = assertSafeRelPath(file.path);
    // 备份可能跨平台恢复；Windows 路径大小写不敏感，因此一律拒绝仅大小写
    // 不同的重复目标，避免同一文件被覆盖两次而破坏回滚快照。
    const key = p.toLowerCase();
    if (seen.has(key)) throw new Error(`备份路径重复: ${key}`);
    seen.add(key);
    if (!p.startsWith('profile/') && !p.startsWith('home/')) throw new Error(`备份路径不在允许根目录内: ${p}`);
    if (p === 'profile/' || p === 'home/') throw new Error('空路径');
    // node_modules 段是 junction/symlink 装配点（profile 下、home 下都可能有）——
    // 恢复写入可经链接直通真实插件目录（合法备份绝不包含它：collectFiles 跳过），
    // 来路不明的备份含此段时直接拒绝，封死「经链接写穿」攻击面。
    if (p.split('/').includes('node_modules')) throw new Error(`备份路径含 node_modules 段（符号链接装配点），拒绝: ${p}`);
    // home 根下不得出现 profiles 段：profile 内容由 profile/ 前缀单独收集，
    // home/profiles/web/... 形态可双写 profile 配置（破坏 profile/home 隔离边界）。
    if (p.startsWith('home/') && p.split('/').includes('profiles')) {
      throw new Error(`home 路径含 profiles 段（profile 由 profile/ 前缀单独管理），拒绝: ${p}`);
    }
    // 深度恢复防逃逸：逐段校验
    const parts = p.split('/');
    for (const part of parts) assertSafeRelPath(part);
    if (isSecretName(p)) detectedSecrets.add(p);
    if ('json' in file) {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) throw new Error(`package.json 格式非法: ${p}`);
      out.files.push({ path: p, json: file.json });
    } else if (file.encoding === 'base64') {
      if (typeof file.base64 !== 'string' || file.base64.length === 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(file.base64)) {
        throw new Error(`base64 内容格式非法: ${p}`);
      }
      out.files.push({ path: p, encoding: 'base64', base64: file.base64.replace(/\s+/g, '') });
    } else if (Array.isArray(file.lines) && file.lines.every((l) => typeof l === 'string')) {
      out.files.push({ path: p, lines: file.lines });
    } else {
      throw new Error(`文件内容格式非法: ${p}`);
    }
  }
  // 不信任备份自报的 secretFiles：攻击者可删掉该字段来绕过恢复确认警告。
  // 警告清单始终根据实际待恢复路径重新生成。
  out.secretFiles = [...detectedSecrets].sort();
  const bytes = Buffer.byteLength(JSON.stringify(out));
  if (bytes > MAX_BACKUP_BYTES) throw new Error('备份体积超过上限');
  return out;
}

/**
 * 恢复备份到指定根目录（原子写 + 失败回滚）。
 * @param {object} backup validatedBackup 后的备份对象
 * @param {object} roots { profileDir, homeDir } 目标目录
 * @returns {object} { files, rollback }
 */
function restoreBackup(backup, roots, fs = require('node:fs'), pathMod = require('node:path')) {
  backup = validatedBackup(backup); // 恢复前强制严格校验（路径安全/格式/体积）
  const targetOf = (p) => {
    if (p.startsWith('profile/')) return pathMod.join(roots.profileDir, p.slice('profile/'.length));
    if (p.startsWith('home/')) return pathMod.join(roots.homeDir, p.slice('home/'.length));
    throw new Error(`未知根目录: ${p}`);
  };
  // 预检目标父目录存在性：全部可写
  const previous = new Map();
  const writePlan = [];
  // 符号链接/接合点写穿防护：目标根目录先解析真实路径，写入前对每个目标的
  // 「最深已存在祖先」做 realpath——若落在真实根之外（经 junction/symlink
  // 指到别处），拒绝。字符串前缀比较不是安全边界。
  const realRoot = (dir) => {
    try { return fs.realpathSync(dir); } catch { throw new Error(`目标根目录不可解析: ${dir}`); }
  };
  const realProfile = realRoot(roots.profileDir);
  const realHome = realRoot(roots.homeDir);
  const deepestReal = (dir) => {
    let cur = dir;
    for (let depth = 0; depth < 64; depth += 1) {
      try { return fs.realpathSync(cur); } catch { /* 不存在则上溯一层 */ }
      const parent = pathMod.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
    return null;
  };
  // Windows 路径大小写不敏感：realpath 返回的规范大小写与调用方路径大小写
  // 可能不一致，比较统一归一化（修复审计发现：大小写敏感 startsWith 会误拒绝）。
  const IS_WIN = process.platform === 'win32';
  const normCase = (s) => (IS_WIN ? String(s).toLowerCase() : String(s));
  const within = (realDir, root) => {
    const n = normCase(realDir);
    const r = normCase(root);
    return n === r || n.startsWith(r + pathMod.sep);
  };
  for (const file of backup.files) {
    const target = targetOf(file.path);
    const dir = pathMod.dirname(target);
    if (!fs.existsSync(dir)) throw new Error(`目标目录缺失，拒绝恢复: ${dir}`);
    if (!target.startsWith(roots.profileDir + pathMod.sep) && !target.startsWith(roots.homeDir + pathMod.sep)) {
      throw new Error(`恢复路径逃逸目标根目录: ${file.path}`);
    }
    const realAncestor = deepestReal(dir);
    if (!realAncestor || (!within(realAncestor, realProfile) && !within(realAncestor, realHome))) {
      throw new Error(`恢复路径经符号链接/接合点逃逸目标根目录: ${file.path}`);
    }
    writePlan.push({ target, file });
  }
  // 预读原内容（回滚快照）+ 目录存在性校验
  for (const { target } of writePlan) {
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error(`目标已存在且不是文件，拒绝覆盖: ${target}`);
      previous.set(target, fs.readFileSync(target));
    } else {
      previous.set(target, null);
    }
  }
  const rollback = () => {
    // 返回回滚失败清单；文案承诺「已尝试回滚」而非绝对「已回滚」
    const failed = [];
    for (const [target, content] of previous) {
      try {
        if (content === null) { try { fs.rmSync(target, { force: true }); } catch (err) { failed.push(target + ': ' + ((err && err.message) || err)); } }
        else fs.writeFileSync(target, content);
      } catch (err) {
        failed.push(target + ': ' + ((err && err.message) || err));
      }
    }
    return failed;
  };
  // tmp+rename 原子写
  const written = new Set();
  const tmpPaths = new Set();
  try {
    for (const { target, file } of writePlan) {
      const tmp = target + '.dsh-restore-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
      tmpPaths.add(tmp);
      let body;
      if ('json' in file) body = JSON.stringify(file.json, null, 2) + '\n';
      else if (file.encoding === 'base64') body = Buffer.from(file.base64, 'base64');
      else body = file.lines.join('\n');
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
      written.add(target);
    }
  } catch (err) {
    const failed = rollback();
    for (const t of tmpPaths) { try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch { /* ignore */ } }
    const suffix = failed.length > 0 ? `；回滚失败 ${failed.length} 项: ${failed.join('; ')}` : '';
    throw new Error('恢复失败，已尝试回滚' + suffix + ': ' + String((err && err.message) || err));
  }
  return { files: writePlan.length, rollback };
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_FILES,
  SKIP_DIR_NAMES,
  ALLOWED_EXT,
  SECRET_FILE_RE,
  assertSafeRelPath,
  collectFiles,
  readBackupFile,
  createBackup,
  validatedBackup,
  restoreBackup,
};
