'use strict';

// ---------------------------------------------------------------------------
// plugin-core 标记解析（markers）：从 dsh web 子进程 stderr 流中提取机器可读
// 标记。纯文本扫描、零依赖、幂等；壳层据此驱动 quarantine / 通知 / 重启。
//
// 标记契约（与 web-crash-shield.js / loader-isolation.js 注入代码逐字对应）：
//   [loader-isolation] entry <id> (<name>): <reason...>
//   [crash-shield] attribute: <source> count: <n>
// ---------------------------------------------------------------------------

const LOADER_ISOLATION_RE = /\[loader-isolation\]\s+entry\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\(([^)\n]*)\)/g;
const ATTRIBUTE_RE = /\[crash-shield\]\s+attribute:\s+(\S+)\s+count:\s*(\d+)/g;

/**
 * 解析一段 stderr 文本，返回结构化标记。
 * @param {string} text 文本片段（可跨 chunk 累积后整体解析）
 * @returns {{ isolations: Array<{id:string, name:string}>, attributes: Array<{source:string, count:number}> }}
 */
function parseMarkers(text) {
  const isolations = [];
  const attributes = [];
  let m;
  LOADER_ISOLATION_RE.lastIndex = 0;
  while ((m = LOADER_ISOLATION_RE.exec(String(text || ''))) !== null) {
    isolations.push({ id: m[1], name: m[2].trim() });
  }
  ATTRIBUTE_RE.lastIndex = 0;
  while ((m = ATTRIBUTE_RE.exec(String(text || ''))) !== null) {
    attributes.push({ source: m[1], count: Number(m[2]) || 0 });
  }
  return { isolations, attributes };
}

/**
 * 累积式解析器：stderr 是分块到达的流，标记可能跨 chunk 断裂。
 * 每块只保留尾部最长可能前缀（取两种标记中较长者 ≈ 96 字符）拼接下一块。
 */
function createMarkerAccumulator() {
  let tail = '';
  const KEEP = 128;
  return (chunk) => {
    const text = tail + String(chunk);
    tail = text.slice(-KEEP);
    return parseMarkers(text);
  };
}

module.exports = { parseMarkers, createMarkerAccumulator };
