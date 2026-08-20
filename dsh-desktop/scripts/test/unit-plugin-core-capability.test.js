'use strict';

// capability.js 单测：IPC 能力表不变量 + 统一鉴权（frame origin 精确匹配）。
// 覆盖：能力表完整性（键唯一 / confirm 双向一致 / mutating 破坏性集合 / originCheck）、
// origin 校验矩阵（端口/主机/协议/特殊 scheme/空值/主窗不匹配）、未登记动作、
// '*' 通用口径。零 Electron：mainWindow.webContents 用普通对象桩。

const test = require('node:test');
const assert = require('node:assert/strict');

// 注：capability.js 曾导出 confirmKeyFor(action)，但本会话期间该函数被并发重构移除，
// 现模块仅导出 PLUGIN_IPC_ACTIONS / CONFIRM_MESSAGES / authorize（confirm 文案经
// createPluginCenter 的 confirmMessages 透出）。矩阵中的 confirmKeyFor 条目已无法
// 对当前代码测试，故此处不包含。
const { PLUGIN_IPC_ACTIONS, CONFIRM_MESSAGES, authorize } = require('../plugin-core/lib/capability');
const { PluginError, PLUGIN_ERROR_CODES } = require('../plugin-core/lib/errors');

// 破坏性动作（mutating:true）——与架构文档 §7 的破坏性确认集合一致，
// 另含 set-enabled（无 confirm 但会改写 cordis.patch.yml）。
const DESTRUCTIVE_ACTIONS = new Set([
  'dsh:plugin-set-enabled',
  'dsh:plugin-uninstall',
  'dsh:plugin-restore',
  'dsh:plugin-update',
  'dsh:diag-order-apply',
  'dsh:diag-remove-bundle',
  'dsh:backup-restore',
]);

/** 构造一个合法（origin 匹配）的鉴权上下文；可按需覆盖字段。 */
function context(overrides = {}) {
  const webContents = {};
  const mainWindow = { webContents };
  const event = {
    sender: webContents,
    senderFrame: { url: 'http://127.0.0.1:8321/x' },
  };
  const deps = {
    mainWindow,
    getWebUrl: () => 'http://127.0.0.1:8321',
  };
  const merged = {
    event,
    deps,
    ...overrides,
  };
  return merged;
}

// ── 能力表不变量 ────────────────────────────────────────────────────────────

test('capability: 能力表 action 键唯一', () => {
  const keys = Object.keys(PLUGIN_IPC_ACTIONS);
  assert.equal(new Set(keys).size, keys.length, 'action 键不得重复');
  assert.ok(keys.length > 0, '能力表非空');
});

test('capability: 每个 confirm!=null 的动作都在 CONFIRM_MESSAGES 有文案', () => {
  for (const [action, spec] of Object.entries(PLUGIN_IPC_ACTIONS)) {
    if (spec.confirm !== null) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CONFIRM_MESSAGES, spec.confirm),
        `动作 ${action} 的 confirm 键 ${spec.confirm} 缺失文案`
      );
      assert.ok(CONFIRM_MESSAGES[spec.confirm].length > 0, `动作 ${action} 的文案为空`);
    }
  }
});

test('capability: 每个 CONFIRM_MESSAGES 键都被至少一个动作引用', () => {
  for (const key of Object.keys(CONFIRM_MESSAGES)) {
    const referenced = Object.values(PLUGIN_IPC_ACTIONS).some((spec) => spec.confirm === key);
    assert.ok(referenced, `文案键 ${key} 未被任何动作引用`);
  }
});

test('capability: mutating:true 动作恰好等于文档破坏性集合', () => {
  const mutating = Object.keys(PLUGIN_IPC_ACTIONS).filter((a) => PLUGIN_IPC_ACTIONS[a].mutating === true);
  assert.deepEqual(new Set(mutating), DESTRUCTIVE_ACTIONS, 'mutating:true 集合与破坏性集合必须完全一致');
});

test('capability: 每个动作都声明 originCheck:true', () => {
  for (const [action, spec] of Object.entries(PLUGIN_IPC_ACTIONS)) {
    assert.equal(spec.originCheck, true, `动作 ${action} 必须 originCheck:true`);
  }
});

// ── authorize: origin 匹配 ──────────────────────────────────────────────────

test('capability: authorize 匹配 origin 通过', () => {
  const { event, deps } = context();
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, true);
  assert.equal(r.spec.originCheck, true);
  assert.equal(r.spec.confirm, null);
  assert.equal(r.spec.mutating, false);
});

test('capability: authorize 不同端口拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = 'http://127.0.0.1:8322/x';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize 不同主机拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = 'http://example.com:8321/x';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize https vs http 拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = 'https://127.0.0.1:8321/x';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize file:// 拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = 'file:///C:/plugin/index.html';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize about:blank 拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = 'about:blank';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize senderFrame 为 null 拒绝', () => {
  const { event, deps } = context();
  event.senderFrame = null;
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize senderFrame.url 为空串拒绝', () => {
  const { event, deps } = context();
  event.senderFrame.url = '';
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize webUrl 为空串拒绝', () => {
  const { event, deps } = context({ deps: { mainWindow: { webContents: {} }, getWebUrl: () => '' } });
  // 注意：deps.mainWindow.webContents 必须与 event.sender 相同对象才能走到 origin 校验。
  deps.mainWindow.webContents = event.sender;
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize webUrl 为 null 拒绝', () => {
  const { event, deps } = context({ deps: { mainWindow: { webContents: {} }, getWebUrl: () => null } });
  deps.mainWindow.webContents = event.sender;
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize event.sender !== mainWindow.webContents 拒绝', () => {
  const { event, deps } = context();
  event.sender = {}; // 不同于 mainWindow.webContents
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize deps.mainWindow 为 null 拒绝', () => {
  const { event, deps } = context({ deps: { mainWindow: null, getWebUrl: () => 'http://127.0.0.1:8321' } });
  const r = authorize(event, deps, 'dsh:plugin-list');
  assert.equal(r.ok, false);
});

test('capability: authorize 未登记动作返回 UNAUTHORIZED', () => {
  const { event, deps } = context();
  const r = authorize(event, deps, 'dsh:not-a-real-action');
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof PluginError);
  assert.equal(r.error.code, PLUGIN_ERROR_CODES.UNAUTHORIZED);
});

test('capability: authorize action "*" 在合法 origin 通过且 spec.originCheck 为 true', () => {
  const { event, deps } = context();
  const r = authorize(event, deps, '*');
  assert.equal(r.ok, true);
  assert.equal(r.spec.originCheck, true);
  assert.equal(r.spec.confirm, null);
});

test('capability: 所有拒绝路径的 error 都携带 code=UNAUTHORIZED 且为 PluginError', () => {
  const base = context();
  const scenarios = [
    { label: '不同端口', event: { ...base.event, senderFrame: { url: 'http://127.0.0.1:8322/x' } }, deps: base.deps },
    { label: '不同主机', event: { ...base.event, senderFrame: { url: 'http://example.com:8321/x' } }, deps: base.deps },
    { label: 'https vs http', event: { ...base.event, senderFrame: { url: 'https://127.0.0.1:8321/x' } }, deps: base.deps },
    { label: 'file://', event: { ...base.event, senderFrame: { url: 'file:///C:/x' } }, deps: base.deps },
    { label: 'about:blank', event: { ...base.event, senderFrame: { url: 'about:blank' } }, deps: base.deps },
    { label: 'senderFrame null', event: { ...base.event, senderFrame: null }, deps: base.deps },
    { label: 'senderFrame.url 空串', event: { ...base.event, senderFrame: { url: '' } }, deps: base.deps },
  ];
  for (const s of scenarios) {
    // 每个场景的 sender 需与 mainWindow.webContents 一致（senderFrame 变更不影响 sender）。
    s.event.sender = base.deps.mainWindow.webContents;
    const r = authorize(s.event, s.deps, 'dsh:plugin-list');
    assert.equal(r.ok, false, `${s.label} 应拒绝`);
    assert.ok(r.error instanceof PluginError, `${s.label}: error 应为 PluginError`);
    assert.equal(r.error.code, PLUGIN_ERROR_CODES.UNAUTHORIZED, `${s.label}: code 应为 UNAUTHORIZED`);
  }
  // 未登记动作 / 主窗不匹配 同样 UNAUTHORIZED。
  const unregistered = authorize(base.event, base.deps, 'dsh:unknown');
  assert.equal(unregistered.error.code, PLUGIN_ERROR_CODES.UNAUTHORIZED);
  assert.ok(unregistered.error instanceof PluginError);
  const wrongSender = authorize({ ...base.event, sender: {} }, base.deps, 'dsh:plugin-list');
  assert.equal(wrongSender.error.code, PLUGIN_ERROR_CODES.UNAUTHORIZED);
  assert.ok(wrongSender.error instanceof PluginError);
});

// confirmKeyFor 已从当前 capability.js 移除（见文件头注释），不再有对应测试。
