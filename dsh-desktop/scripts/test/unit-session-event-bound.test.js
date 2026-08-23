'use strict';

// unit-session-event-bound.test.js — v0.5.4 多子代理渲染进程 OOM 根治补丁单测。
//
// 补丁（patch-adapters.transformSessionEventBound）对内核 dsh-client-runtime
// lib/client.js 做两件事：
//   1) Session.appendLive 追加后调用 trimSessionWindow()：events 超
//      SESSION_EVENT_BOUND（2000）时按 turn/start 对齐裁掉最旧切片并 flip
//      hasMore（host 会话日志是持久真相，loadOlder 可按需回翻）；
//   2) Session.dispose() 实装 + SessionManager.drop() 调用：会话被 prune/drop
//      时清空 events/views/conversation 派生态，解决「切会话/删会话后仍常驻」。
//
// 本单测通过 vm 装载补丁前（pristine）与补丁后（patched）两份内核 client.js，
// 直接实例化内部 Session（测试期注入 __Session 导出），验证：
//   1) 有界保留后 events 长度有上界（且视图数组同步、turn 对齐、hasMore flip）；
//   2) dispose 释放（events/views/liveBuffer/pending 清空、幂等）；
//   3) SessionManager.drop 触发 dispose；
//   4) trim 复用 replaceWindow（open/resync 同款），重建后继续 append 不抛、
//      结构性事件（turn 边界 / 消息 / compaction 摘要）在尾部窗口内保持连续；
//   5) 多 Session 高频 appendLive 压测：每个 Session events 长度有上界，
//      补丁前后内存斜率对比（pristine 线性增长 vs patched 封顶）。
//
// 运行：node --test scripts/test/unit-session-event-bound.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const { transformSessionEventBound } = require('../lib/patch-adapters');

const BOUND = 2000;
const KEEP = 1200;

/** 定位内核 client.js 源：优先 pristine rc2 stage，回退真实 node_modules（当前未打补丁树）。 */
function resolveClientSource() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '.tmp-rc2-stage', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const CLIENT_PATH = resolveClientSource();
const DESKTOP_REQ = createRequire(path.join(__dirname, '..', '..', 'package.json'));

/**
 * vm 装载 client.js（window.__ModuleLoader__.load 形态），返回模块 exports。
 * 测试期注入 __Session / __SessionManager 导出（仅观测用，非生产面）。
 */
function loadClientModule(src) {
  const injected = src.replace(
    'exports.WorkspaceRuntime = WorkspaceRuntime;',
    'exports.WorkspaceRuntime = WorkspaceRuntime;\n\t\texports.__Session = Session;\n\t\texports.__SessionManager = SessionManager;',
  );
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    console,
    queueMicrotask: (f) => f(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(injected, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'window.__ModuleLoader__.load 应登记模块');
  const factory = captured.factory;
  const requireShim = (spec) => {
    // dsh-client-ui-slots 在本测试环境不装配：返回空对象即可（仅 slots 子系统懒用）。
    if (spec === '@deepseek-ai/dsh-client-ui-slots') return {};
    return DESKTOP_REQ(spec);
  };
  return factory(requireShim);
}

/** 造一个可 appendLive 的最小 Session（openState 无需真实 open）。 */
function makeSession(mod, sessionId = 's1') {
  const api = { sessions: { history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }) } };
  return new mod.__Session(sessionId, api, {}, {});
}

/** 事件工厂：seq 从 1 递增；每 turnSize 条一个 turn/start，末尾一个 compaction/summary。 */
function eventAt(seq, turnSize) {
  if (seq % turnSize === 0) return { seq, type: 'turn/start', data: { turn: Math.floor(seq / turnSize) } };
  if (seq % turnSize === 5) return { seq, type: 'compaction/summary', data: { summary: [{ type: 'text', text: 's' + seq }] } };
  if (seq % turnSize === 8) return { seq, type: 'user/message', data: { id: 'm' + seq } };
  return { seq, type: 'assistant/message', data: { turn: Math.floor(seq / turnSize) } };
}

const hasSource = CLIENT_PATH !== null;

test('补丁 transform 注入有界保留 + dispose + drop（内容契约）', () => {
  assert.ok(hasSource, '缺内核 client.js 源（.tmp-rc2-stage 或 node_modules）');
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const r = transformSessionEventBound(pristine, 'client.js');
  assert.equal(r.status, 'changed', '未打补丁源应 changed');
  const src = r.src;
  assert.ok(src.includes('dsh-desktop compat: bounded session event retention'), '应含 marker');
  assert.ok(src.includes('const SESSION_EVENT_BOUND = 2000;'), '应含 SESSION_EVENT_BOUND');
  assert.ok(src.includes('const SESSION_EVENT_KEEP = 1200;'), '应含 SESSION_EVENT_KEEP');
  assert.ok(src.includes('trimSessionWindow() {'), '应注入 trimSessionWindow 方法');
  assert.ok(src.includes('this.trimSessionWindow();'), 'appendLive 应调用 trimSessionWindow');
  assert.ok(src.includes('this.conversation.replaceWindow([], false);'), 'dispose 应重建空窗口');
  assert.ok(src.includes('if (session !== void 0) session.dispose();'), 'drop 应调用 dispose');
  assert.ok(src.includes('if (this.disposed === true) return;'), 'dispose 应幂等');
  // 幂等：二次 transform already。
  assert.equal(transformSessionEventBound(src, 'client.js').status, 'already');
});

test('有界保留：events 长度有上界、views 同步、turn 对齐、hasMore flip', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  const TOTAL = 5000;
  for (let i = 1; i <= TOTAL; i += 1) s.appendLive(eventAt(i, 50), undefined);

  assert.ok(s.events.length <= BOUND, `events 应有上界 ${BOUND}，实际 ${s.events.length}`);
  // trim 在 events 超 BOUND 时回落到 ~KEEP，随后继续追加直至再次触顶，故最终
  // 长度在 (KEEP, BOUND] 区间内；硬上界恒为 BOUND。
  assert.ok(s.events.length > KEEP, `压测后长度应高于 KEEP(${KEEP})（末次 trim 后继续追加），实际 ${s.events.length}`);
  assert.equal(s.views.length, s.events.length, 'views 与 events 同步裁剪');
  assert.equal(s.baseSeq, s.events[0].seq, 'baseSeq 应对齐裁剪后首事件 seq');
  assert.equal(s.hasMore, true, '裁剪后 hasMore 应 flip true（旧切片在 host 可回翻）');
  assert.equal(s.events[0].type, 'turn/start', '裁剪首事件应对齐 turn/start 边界');
  // conversation.inputs 与 events 同步有界（内存双副本一致封顶）。
  assert.ok(s.conversation.inputs.size <= BOUND, `conversation.inputs 应有上界，实际 ${s.conversation.inputs.size}`);
});

test('补丁前（pristine）无界：同一压测 events 线性增长到 5000（对照斜率）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const mod = loadClientModule(pristine);
  const s = makeSession(mod);

  for (let i = 1; i <= 5000; i += 1) s.appendLive(eventAt(i, 50), undefined);

  assert.equal(s.events.length, 5000, 'pristine 无 trim，events 线性堆积（OOM 根因）');
});

test('dispose 释放：events/views/liveBuffer/pending 清空且幂等', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  for (let i = 1; i <= 100; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length > 0, 'dispose 前应有事件');

  s.dispose();
  assert.equal(s.events.length, 0, 'dispose 后 events 应清空');
  assert.equal(s.views.length, 0, 'dispose 后 views 应清空');
  assert.equal(s.liveBuffer.length, 0, 'dispose 后 liveBuffer 应清空');
  assert.equal(s.pending.size, 0, 'dispose 后 pending 应清空');
  assert.equal(s.disposed, true, 'dispose 应标记 disposed');

  // 幂等：二次 dispose 不抛、状态不变。
  s.dispose();
  assert.equal(s.events.length, 0, '二次 dispose 应保持清空');
});

test('SessionManager.drop 触发 session.dispose（切/删会话后释放常驻）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

  const api = { sessions: {} };
  const mgr = new mod.__SessionManager(api, {}, undefined, undefined, undefined);
  const s = makeSession(mod, 'dropped');
  s.appendLive({ seq: 1, type: 'user/message', data: { id: 'm1' } }, undefined);
  assert.ok(s.events.length > 0);

  mgr.sessions.set('dropped', s);
  mgr.drop('dropped');
  assert.equal(mgr.sessions.has('dropped'), false, 'drop 后 sessions 摘除');
  assert.equal(s.disposed, true, 'drop 应触发 dispose');
  assert.equal(s.events.length, 0, 'drop 后事件应释放');
});

test('replay 连续性：trim 后 installWindow 重建 + 继续 appendLive 不抛、窗口仍连续', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  // 压到触发 trim。
  for (let i = 1; i <= 3000; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length <= BOUND);

  // 模拟 open/resync/gap-repair 的 replay：installWindow 用新历史窗重建。
  const replayEntries = [
    { event: { seq: 9000, type: 'turn/start', data: { turn: 1 } }, view: undefined },
    { event: { seq: 9001, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
  ];
  assert.doesNotThrow(() => s.installWindow(replayEntries, false, undefined));
  assert.equal(s.events.length, 2, 'replay 重建后 events 即新窗口');
  assert.equal(s.baseSeq, 9000, 'replay 后 baseSeq 即新窗口首 seq');

  // 继续 appendLive：不抛、seq 连续性仍由 windowTailSeq 守卫。
  assert.doesNotThrow(() => s.appendLive({ seq: 9002, type: 'assistant/message', data: { turn: 1 } }, undefined));
  assert.equal(s.events[s.events.length - 1].seq, 9002, '重建后追加仍按 seq 续接');
});

test('多 Session 高频压测：每个 Session events 有上界（内存斜率趋平）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

  const SESSIONS = 8;
  const EVENTS = 4000;
  const sessions = [];
  for (let n = 0; n < SESSIONS; n += 1) {
    const s = makeSession(mod, 'subagent-' + n);
    for (let i = 1; i <= EVENTS; i += 1) s.appendLive(eventAt(i, 50), undefined);
    sessions.push(s);
  }

  // 每个 Session 独立有界（多子代理 = 多 Session 场景下渲染进程内存不再随
  // 事件数无上限增长）。
  for (const s of sessions) {
    assert.ok(s.events.length <= BOUND, `每 Session events 应有上界，实际 ${s.events.length}`);
    assert.ok(s.conversation.inputs.size <= BOUND, `每 Session conversation.inputs 应有上界`);
  }
  // 结构性事件在尾部窗口内保持（rewind/compaction 依赖的 turn/start 与
  // compaction/summary 不被裁掉到只剩碎片）。
  const tail = sessions[0].events;
  assert.ok(tail.some((e) => e.type === 'turn/start'), '尾部窗口应保留 turn/start 边界');
  assert.ok(tail.some((e) => e.type === 'compaction/summary'), '尾部窗口应保留 compaction/summary 摘要');
});
