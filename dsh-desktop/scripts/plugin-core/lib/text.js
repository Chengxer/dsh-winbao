'use strict';

// ---------------------------------------------------------------------------
// plugin-core 文本工具（text）：正则转义、EOL 检测与保持、行级工具。
// 全仓所有「id 拼进正则」「行拆分-重组」场景共用本实现，消除三处复制漂移。
// ---------------------------------------------------------------------------

/** 正则字面量转义（id/包名拼进正则前必须转义）。 */
function escRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 检测文本主导换行符：含 CRLF 判 '\r\n'，否则 '\n'（兼容纯 LF / 混合少量 LF）。 */
function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

/** 按行拆分（兼容 CRLF/LF），返回去行尾符的行数组。 */
function splitLines(text) {
  return String(text).split(/\r?\n/);
}

/** 用指定 EOL 连接行数组。 */
function joinLines(lines, eol) {
  return lines.join(eol === '\r\n' ? '\r\n' : '\n');
}

/**
 * EOL 保持：以 original 的 EOL 为基准重写 changed。
 * 输入原文为 CRLF 时，把 changed 中混入的孤立 LF 统一为 CRLF（全文无双重 CRLF）；
 * 输入为 LF 时保持 LF。保证「改动文件不改换行风格」，避免全文 diff 噪声。
 */
function preserveEol(original, changed) {
  if (String(original).includes('\r\n')) {
    return String(changed).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }
  return String(changed).replace(/\r\n/g, '\n');
}

/** YAML 单引号串转义（单引号加倍）。 */
function yamlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

module.exports = {
  escRegExp,
  detectEol,
  splitLines,
  joinLines,
  preserveEol,
  yamlQuote,
};
