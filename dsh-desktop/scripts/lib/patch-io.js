'use strict';

// ---------------------------------------------------------------------------
// 统一补丁 I/O 原语。
//
// 原子写已收口到 scripts/plugin-core/lib/fs-atomic.js（全仓唯一实现，
// 含 EPERM 重试与 rename 覆盖兜底）；本模块保留历史导入路径与进程级读缓存
// readFileCached（main.js 运行时补丁 / CLI 补丁脚本共用）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const { writeFileAtomic, isTransientFsError } = require('../plugin-core/lib/fs-atomic');

// realpath -> { size, mtimeMs, text }
const fileReadMemo = new Map();
// 路径本身是固定常量：realpath 解析结果缓存一次即可。
const fileRealKeyMemo = new Map();

function fileRealKey(file) {
  let key = fileRealKeyMemo.get(file);
  if (key === undefined) {
    try { key = fs.realpathSync(file); } catch { key = file; }
    fileRealKeyMemo.set(file, key);
  }
  return key;
}

/**
 * 进程级读缓存：文件缺失/不可读返回 null（调用方按读取失败处理）。
 * 缓存命中条件 = realpath 相同 + size 与 mtimeMs 精确一致；写入必改 mtime，
 * 因此不存在陈旧内容。
 * @param {string} file
 * @returns {string|null}
 */
function readFileCached(file) {
  try {
    const st = statRetry(file);
    const key = fileRealKey(file);
    const hit = fileReadMemo.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = readFileRetry(file, 'utf8');
    // TOCTOU 防护：读取期间文件被改写（size/mtime 变化）则不缓存。
    const st2 = statRetry(file);
    if (st2.size === st.size && st2.mtimeMs === st.mtimeMs) {
      fileReadMemo.set(key, { size: st2.size, mtimeMs: st2.mtimeMs, text });
    }
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Windows 瞬时 EBUSY/EPERM/EACCES 有限重试（#154 第二根因）：杀软/索引器
// 扫描锁住文件时，fs.readFileSync / fs.statSync 会抛 EBUSY/EPERM/EACCES。
// 历史行为是一次失败即按「读取失败」跳过（patch-engine 跳过该文件）或
// 让调用方把瞬时锁当成真故障（boot 链 readFileCached 直接判 null）。有限
// 重试（3 次 × 递增退避 120/240ms，总 < 0.5s，远低于任何 60s 超时）把
// 「AV 锁瞬时报错」从失败面上拿掉；重试耗尽才抛（错误带可读包装，指出
// 文件与已重试次数）。
// ---------------------------------------------------------------------------

/** 是否为可重试的 Windows 瞬时锁错误码。
 *  复用 plugin-core/lib/fs-atomic.js 的唯一实现（V17 LOW：消除两份同名复制）。 */
// isTransientFsError 由 fs-atomic.js 导入并在 module.exports 一并 re-export。

/** 重试耗尽后的可读错误包装（#154：失败时给可读错误而非裸 EBUSY）。 */
function readableFsError(err, file, op, attempts) {
  const e = new Error(`${op} 失败（${file}）：${(err && err.message) || err}。文件可能被杀毒软件/索引服务暂时锁定，已重试 ${attempts} 次仍失败。可稍后重试或关闭实时防护后重试。`);
  e.code = (err && err.code) || 'EIO';
  e.cause = err;
  return e;
}

/**
 * readFileSync 的瞬时锁重试版本：EBUSY/EPERM/EACCES 重试 3 次
 * （120/240ms 递增退避），耗尽后抛可读错误。其余错误码（ENOENT 等）
 * 不重试直接抛（保持调用方语义）。
 * @param {string} file
 * @param {string} [encoding]
 * @param {{attempts?:number, baseDelayMs?:number}} [opts]
 * @returns {string|Buffer}
 */
function readFileRetry(file, encoding, opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts >= 1 ? opts.attempts : 3;
  const base = Number.isFinite(opts.baseDelayMs) && opts.baseDelayMs >= 0 ? opts.baseDelayMs : 120;
  for (let i = 0; ; i += 1) {
    try {
      return fs.readFileSync(file, encoding);
    } catch (err) {
      if (!isTransientFsError(err) || i >= attempts - 1) {
        if (isTransientFsError(err) && i >= attempts - 1) {
          throw readableFsError(err, file, '读取文件', attempts);
        }
        throw err;
      }
      sleepSync(base * (i + 1));
    }
  }
}

/**
 * statSync 的瞬时锁重试版本（readFileCached 与调用方共用）。
 * @param {string} file
 * @param {object} [opts]
 * @returns {fs.Stats}
 */
function statRetry(file, opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts >= 1 ? opts.attempts : 3;
  const base = Number.isFinite(opts.baseDelayMs) && opts.baseDelayMs >= 0 ? opts.baseDelayMs : 120;
  for (let i = 0; ; i += 1) {
    try {
      return fs.statSync(file);
    } catch (err) {
      if (!isTransientFsError(err) || i >= attempts - 1) {
        if (isTransientFsError(err) && i >= attempts - 1) {
          throw readableFsError(err, file, '读取文件状态', attempts);
        }
        throw err;
      }
      sleepSync(base * (i + 1));
    }
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步退避 */ }
}

module.exports = { writeFileAtomic, readFileCached, readFileRetry, statRetry, isTransientFsError, readableFsError };
