'use strict';

// ---------------------------------------------------------------------------
// 统一补丁 I/O 原语。
//
// 原子写已收口到 scripts/plugin-core/lib/fs-atomic.js（全仓唯一实现，
// 含 EPERM 重试与 rename 覆盖兜底）；本模块保留历史导入路径与进程级读缓存
// readFileCached（main.js 运行时补丁 / CLI 补丁脚本共用）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const { writeFileAtomic } = require('../plugin-core/lib/fs-atomic');

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
    const st = fs.statSync(file);
    const key = fileRealKey(file);
    const hit = fileReadMemo.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(file, 'utf8');
    // TOCTOU 防护：读取期间文件被改写（size/mtime 变化）则不缓存。
    const st2 = fs.statSync(file);
    if (st2.size === st.size && st2.mtimeMs === st.mtimeMs) {
      fileReadMemo.set(key, { size: st2.size, mtimeMs: st2.mtimeMs, text });
    }
    return text;
  } catch {
    return null;
  }
}

module.exports = { writeFileAtomic, readFileCached };
