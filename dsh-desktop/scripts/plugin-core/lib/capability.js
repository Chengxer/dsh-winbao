'use strict';

// ---------------------------------------------------------------------------
// plugin-core IPC 能力策略（capability）：插件管理 IPC 的统一鉴权与破坏性
// 确认。修复审计发现：「list/set-enabled 只查 sender 不查 frame origin」与
// 「破坏性动作无二次确认」的不一致。
//
// 能力表集中声明；每个动作：{ originCheck, confirm, mutating }。
//   originCheck —— sender 必须是主窗 webContents，且 senderFrame.url.origin
//                  与当前 webUrl.origin 精确相等（历史 startsWith 前缀匹配
//                  可被 http://127.0.0.1:<port>.evil.com 绕过，已弃用）。
//   confirm     —— 主进程弹确认框（dialogs.confirm 注入，测试可桩）。
// 新增 IPC 必须在此登记，禁止散落判断。
// ---------------------------------------------------------------------------

const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');

const PLUGIN_IPC_ACTIONS = {
  'dsh:plugin-list': { originCheck: true, confirm: null, mutating: false },
  'dsh:plugin-set-enabled': { originCheck: true, confirm: null, mutating: true },
  'dsh:plugin-uninstall': { originCheck: true, confirm: 'uninstall', mutating: true },
  'dsh:plugin-restore': { originCheck: true, confirm: 'restore', mutating: true },
  'dsh:plugin-check-updates': { originCheck: true, confirm: null, mutating: false },
  'dsh:plugin-update': { originCheck: true, confirm: 'update', mutating: true },
  'dsh:diag-run': { originCheck: true, confirm: null, mutating: false },
  'dsh:diag-export': { originCheck: true, confirm: null, mutating: false },
  'dsh:diag-validate': { originCheck: true, confirm: null, mutating: false },
  'dsh:diag-order': { originCheck: true, confirm: null, mutating: false },
  'dsh:diag-order-apply': { originCheck: true, confirm: 'order-apply', mutating: true },
  'dsh:diag-remove-bundle': { originCheck: true, confirm: 'remove-bundle', mutating: true },
  'dsh:backup-export': { originCheck: true, confirm: null, mutating: false },
  'dsh:backup-restore': { originCheck: true, confirm: 'backup-restore', mutating: true },
  'guard:action': { originCheck: true, confirm: null, mutating: false }, // restore 分支单独确认
};

/** 破坏性动作的确认文案（中文稳定文案，UI 测试可断言）。 */
const CONFIRM_MESSAGES = {
  uninstall: '确定要卸载该插件吗？卸载后需重启生效。',
  update: '确定要更新该插件吗？更新后需重启生效。',
  restore: '确定要恢复该插件吗？恢复后需重启生效（被自动隔离的插件恢复后若仍出错会再次被隔离）。',
  'order-apply': '确定要应用新的 bundle 顺序吗？重启后生效。',
  'remove-bundle': '确定要从启动清单移除这些条目吗？',
  'backup-restore': '确定要用该备份覆盖当前配置吗？此操作不可撤销。',
};

/**
 * 统一鉴权。
 * @param {Object} event         Electron IPC event（含 sender / senderFrame）
 * @param {Object} deps
 * @param {Object|null} deps.mainWindow  主窗 BrowserWindow（未就绪为 null）
 * @param {() => string} deps.getWebUrl  当前 webUrl（空串=未就绪）
 * @param {string} action       PLUGIN_IPC_ACTIONS 键；'*' = 只做 sender+origin 通用校验
 * @returns {{ ok: boolean, error?: PluginError }}
 */
function authorize(event, deps, action) {
  const spec = action === '*' ? { originCheck: true, confirm: null } : PLUGIN_IPC_ACTIONS[action];
  if (!spec) {
    return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UNAUTHORIZED, '未登记的动作: ' + action) };
  }
  if (!deps.mainWindow || event.sender !== deps.mainWindow.webContents) {
    return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UNAUTHORIZED, '调用来源不是主窗口') };
  }
  if (spec.originCheck) {
    const webUrl = deps.getWebUrl();
    try {
      const url = event.senderFrame && typeof event.senderFrame.url === 'string' ? event.senderFrame.url : '';
      if (url === '' || !webUrl) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UNAUTHORIZED, '无法校验调用方 origin') };
      }
      if (new URL(url).origin !== new URL(webUrl).origin) {
        return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UNAUTHORIZED, '调用方 origin 不匹配') };
      }
    } catch {
      return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.UNAUTHORIZED, '调用方 origin 非法') };
    }
  }
  return { ok: true, spec };
}

module.exports = { PLUGIN_IPC_ACTIONS, CONFIRM_MESSAGES, authorize };
