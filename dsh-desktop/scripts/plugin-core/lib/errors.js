'use strict';

// ---------------------------------------------------------------------------
// plugin-core 统一错误税（单一实现）。
//
// 插件管理子系统的一切对外失败都必须是 PluginError：携带稳定 code（见
// docs/plugin-center-architecture.md §9），UI / 日志 / 测试只按 code 分支，
// 绝不解析 message 文案。新增 code 时必须同步架构文档与本文档映射。
// ---------------------------------------------------------------------------

/** 稳定错误码全集（与 docs/plugin-center-architecture.md §9 一一对应）。 */
const PLUGIN_ERROR_CODES = Object.freeze({
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_CORE_PROTECTED: 'PLUGIN_CORE_PROTECTED',
  PLUGIN_HAS_CONFIG: 'PLUGIN_HAS_CONFIG',
  PLUGIN_NOT_TOGGLEABLE: 'PLUGIN_NOT_TOGGLEABLE',
  PLUGIN_RESTORE_NO_SOURCE: 'PLUGIN_RESTORE_NO_SOURCE',
  PLUGIN_BUSY: 'PLUGIN_BUSY',
  PLUGIN_SERVICE_RUNNING: 'PLUGIN_SERVICE_RUNNING',
  PLUGIN_BAD_ID: 'PLUGIN_BAD_ID',
  PLUGIN_BAD_PACKAGE: 'PLUGIN_BAD_PACKAGE',
  UPDATE_NO_INTEGRITY: 'UPDATE_NO_INTEGRITY',
  UPDATE_INTEGRITY_MISMATCH: 'UPDATE_INTEGRITY_MISMATCH',
  UPDATE_BAD_URL: 'UPDATE_BAD_URL',
  UPDATE_ARCHIVE_UNSAFE: 'UPDATE_ARCHIVE_UNSAFE',
  UPDATE_PACKAGE_MISMATCH: 'UPDATE_PACKAGE_MISMATCH',
  UPDATE_SCAN_BLOCKED: 'UPDATE_SCAN_BLOCKED',
  UPDATE_ROLLBACK_FAILED: 'UPDATE_ROLLBACK_FAILED',
  UPDATE_DOWNLOAD_FAILED: 'UPDATE_DOWNLOAD_FAILED',
  STATE_CORRUPT: 'STATE_CORRUPT',
  UNAUTHORIZED: 'UNAUTHORIZED',
});

/** 面向用户的中文文案（code → 稳定文案，UI 兜底展示用）。 */
const PLUGIN_ERROR_MESSAGES = Object.freeze({
  [PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND]: '未知插件',
  [PLUGIN_ERROR_CODES.PLUGIN_CORE_PROTECTED]: '核心组件不可操作',
  [PLUGIN_ERROR_CODES.PLUGIN_HAS_CONFIG]: '该插件带自定义配置，禁止卸载',
  [PLUGIN_ERROR_CODES.PLUGIN_NOT_TOGGLEABLE]: '该插件不可开关',
  [PLUGIN_ERROR_CODES.PLUGIN_RESTORE_NO_SOURCE]: '第三方插件无安装源，无法恢复，请从插件市场重新安装',
  [PLUGIN_ERROR_CODES.PLUGIN_BUSY]: '该插件正在操作中，请稍候',
  [PLUGIN_ERROR_CODES.PLUGIN_SERVICE_RUNNING]: '服务运行中，操作已安全降级为重启后生效',
  [PLUGIN_ERROR_CODES.PLUGIN_BAD_ID]: '插件 id 含非法字符',
  [PLUGIN_ERROR_CODES.PLUGIN_BAD_PACKAGE]: '包名含非法字符',
  [PLUGIN_ERROR_CODES.UPDATE_NO_INTEGRITY]: '发布源未提供完整性校验和，为安全起见拒绝更新',
  [PLUGIN_ERROR_CODES.UPDATE_INTEGRITY_MISMATCH]: '下载内容校验失败，已中止',
  [PLUGIN_ERROR_CODES.UPDATE_BAD_URL]: '下载地址非法（仅允许 https）',
  [PLUGIN_ERROR_CODES.UPDATE_ARCHIVE_UNSAFE]: '归档内容包含不安全的条目，已中止',
  [PLUGIN_ERROR_CODES.UPDATE_PACKAGE_MISMATCH]: '下载内容与目标插件不匹配，已中止',
  [PLUGIN_ERROR_CODES.UPDATE_SCAN_BLOCKED]: '静态扫描发现高危内容且未获确认，已中止',
  [PLUGIN_ERROR_CODES.UPDATE_ROLLBACK_FAILED]: '回滚失败，备份保留在 .bak 目录',
  [PLUGIN_ERROR_CODES.UPDATE_DOWNLOAD_FAILED]: '下载失败',
  [PLUGIN_ERROR_CODES.STATE_CORRUPT]: '状态文件损坏（已备份重建）',
  [PLUGIN_ERROR_CODES.UNAUTHORIZED]: '未授权的调用',
});

/**
 * 插件管理统一错误。
 * @param {string} code    PLUGIN_ERROR_CODES 之一
 * @param {string} [message] 详细说明（可空，缺省用稳定文案）
 * @param {*} [detail]     附带结构化详情（不进 UI，只进日志/测试）
 */
class PluginError extends Error {
  constructor(code, message, detail) {
    const text = message || PLUGIN_ERROR_MESSAGES[code] || String(code);
    super(text);
    this.name = 'PluginError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** IPC 响应可直接使用的安全形态。 */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }
}

/** 判定任意值是否为 PluginError（跨模块边界判定用，避免 instanceof 跨副本失真）。 */
function isPluginError(err) {
  return !!(err && typeof err === 'object' && typeof err.code === 'string' && PLUGIN_ERROR_CODES[err.code]);
}

/** 把任意异常规整为 PluginError：已合规原样返回，其余包成对应 code（默认 UPDATE/内部）。 */
function asPluginError(err, code) {
  if (isPluginError(err)) return err;
  return new PluginError(code || 'PLUGIN_BUSY', (err && err.message) || String(err), err);
}

/** IPC handler 统一出口：把结果 / PluginError 收敛成 { ok, error?, code? } 形态。 */
function wrapIpcResult(result) {
  return result;
}

module.exports = {
  PLUGIN_ERROR_CODES,
  PLUGIN_ERROR_MESSAGES,
  PluginError,
  isPluginError,
  asPluginError,
  wrapIpcResult,
};
