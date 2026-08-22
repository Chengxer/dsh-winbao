'use strict';

// ta2-synapse.test.js — dsh-synapse 滚动门控属性测试 + 渲染洪水压力（TA2 测试加固）。
//
// 被测对象：assets/plugins/dsh-synapse/app.js（浏览器整页脚本）。vm 装载
//（DOM/storage/fetch/timer 全 stub），顶层 function 声明挂到 sandbox 全局，
// 直接取用纯函数与渲染链入口：
//   · shouldDeferDetailRender / nextDetailScrollTop / computeRestoreScroll：
//     随机事件序列回放 oracle（门控 / 滚动记忆决策）；
//   · messagesFromEvents：毒化事件流提取不炸、顺序保持；
//   · scheduleLiveRender（120ms 节流的详情视图渲染）+ scheduleLiveCardUpdate
//     （rAF 合并的画布卡内补丁）：10⁴ 事件洪水，断言 render 调用上界、
//     定时器零泄漏、滚动 pin 位置不丢。
// 运行：node --test scripts/test/ta2-synapse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-synapse', 'app.js'), 'utf8');

// ---------------------------------------------------------------------------
// 可控假定时器 + DOM stub
// ---------------------------------------------------------------------------
function fakeClock() {
  let now = 0;
  const timers = new Map();
  const rafQueue = [];
  let seq = 0;
  return {
    now: () => now,
    advance(dt) {
      const target = now + dt;
      while (true) {
        let nextKey = null, nextAt = Infinity;
        for (const [id, t] of timers) if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextKey = id; }
        if (nextKey === null) break;
        const t = timers.get(nextKey);
        timers.delete(nextKey);
        now = Math.max(now, t.at);
        t.fn();
      }
      now = target;
    },
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, delay) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { rafQueue.push(fn); return ++seq; },
    fireRaf() { const q = rafQueue.splice(0); for (const fn of q) fn(); },
    get pendingTimers() { return timers.size; },
    get pendingRaf() { return rafQueue.length; },
  };
}

function makeClass(base) {
  return class StubElement extends base {
    constructor(tag) {
      super();
      this.tagName = (tag || 'div').toUpperCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.scrollTop = 0;
      this.scrollHeight = 10000;
      this.clientHeight = 500;
      this.value = '';
      this.listeners = {};
      this._html = '';
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
      const arr = this.listeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    }
    dispatch(type, extra) { for (const fn of this.listeners[type] || []) fn({ target: this, ...extra }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    matches() { return false; }
    closest() { return null; }
    focus() {}
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; }
    get firstChild() { return this.children[0] || null; }
  };
}

/**
 * 装载 app.js。返回 { sandbox, clock, app, counters, detailScroll, ... }。
 * counters.renders = app.innerHTML 赋值次数（render() 全量重建的观测出口）。
 */
function loadApp() {
  const clock = fakeClock();
  const HTMLElement = makeClass(class {});
  const HTMLTextAreaElement = class extends HTMLElement {};
  const HTMLFormElement = class extends HTMLElement {};
  const appEl = new HTMLElement('div');
  const counters = { renders: 0 };
  Object.defineProperty(appEl, 'innerHTML', {
    get() { return appEl._html; },
    set(v) { appEl._html = v; counters.renders++; },
    configurable: true,
  });
  const detailScrollEl = new HTMLElement('div');
  const storage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      _map: m,
    };
  };
  const localStorage = storage();
  const sessionStorage = storage();
  const doc = {
    querySelector: (sel) => (sel === '.detail-scroll' ? detailScrollEl : (sel === '#app' ? appEl : null)),
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    documentElement: new HTMLElement('html'),
    body: new HTMLElement('body'),
    hidden: false,
    activeElement: null,
    createElement: (t) => new HTMLElement(t),
  };
  const messageListeners = [];
  const windowObj = {
    location: { origin: 'http://ta2.local' },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: () => {},
    confirm: () => true,
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
    removeEventListener: () => {},
  };
  windowObj.parent = windowObj; // post() 直发（parent === window 分支）
  const sandbox = {
    window: windowObj,
    document: doc,
    HTMLElement, HTMLTextAreaElement, HTMLFormElement,
    localStorage, sessionStorage,
    history: {},
    // 永不 resolve 的 fetch：冻结装载期的异步拉取链（避免微任务在测试结束后继续跑）
    fetch: () => new Promise(() => {}),
    crypto: { randomUUID: () => 'ta2-' + Math.random().toString(36).slice(2) },
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame,
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: 'dsh-synapse/app.js' });
  return { sandbox, clock, app: appEl, counters, detailScroll: detailScrollEl, messageListeners, sessionStorage };
}

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5ADADE);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------------------------------------------------------------------------
// 1) shouldDeferDetailRender：随机状态 × 时间序列回放 oracle
// ---------------------------------------------------------------------------
test('属性：shouldDeferDetailRender 门控 oracle（×500）', () => {
  const { sandbox } = loadApp();
  const fn = sandbox.shouldDeferDetailRender;
  assert.equal(typeof fn, 'function', '顶层 function 声明应挂到 sandbox 全局');
  for (let i = 0; i < 500; i++) {
    const mode = pick(['thread', 'canvas', 'other', null, undefined]);
    const refreshAfter = pick([0, 100, 700, Infinity, -1, NaN, 1e12, 'x', null, undefined]);
    const now = pick([0, 50, 699, 700, 701, 1e12, NaN, -5]);
    const urgent = pick([true, false]);
    const state = { mode, detailRefreshAfter: refreshAfter };
    let got;
    assert.doesNotThrow(() => { got = fn(state, now, urgent); }, '毒化状态不抛');
    // oracle：urgent 恒不延迟；thread 模式且 now < 有限 refreshAfter 时延迟；
    // NaN 比较（now 或 refreshAfter 为 NaN）恒 false → 不延迟。
    const defer = !urgent && mode === 'thread'
      && Number.isFinite(refreshAfter) && Number.isFinite(now) && now < refreshAfter;
    assert.equal(got, defer, `mode=${mode} after=${refreshAfter} now=${now} urgent=${urgent}`);
  }
  // urgent 短路：即使处于滚动窗口也不丢
  assert.equal(fn({ mode: 'thread', detailRefreshAfter: Infinity }, 0, true), false);
});

// ---------------------------------------------------------------------------
// 2) nextDetailScrollTop：程序性回显不覆盖记忆，用户滚动覆盖
// ---------------------------------------------------------------------------
test('属性：nextDetailScrollTop 回显规则 oracle（×500）', () => {
  const { sandbox } = loadApp();
  const fn = sandbox.nextDetailScrollTop;
  for (let i = 0; i < 500; i++) {
    const remembered = pick([0, 123, 4321, NaN, -1, null, undefined]);
    const prog = pick([null, undefined, 0, 123, 500, NaN, -1]);
    const scrollTop = pick([0, 123, 500, 4321, NaN, -1, 1e9]);
    const el = { scrollTop };
    let got;
    assert.doesNotThrow(() => { got = fn(remembered, el, prog); });
    const echo = typeof prog === 'number' && scrollTop === prog;
    assert.equal(got, echo ? remembered : scrollTop,
      `remembered=${remembered} prog=${prog} scrollTop=${scrollTop}`);
  }
  // 典型序列回放：程序置顶 → 回显不覆盖；用户滚走 → 记忆更新
  const el = { scrollTop: 0 };
  assert.equal(fn(400, el, 0), 400, '程序性 scrollTop=0 是回显，保记忆 400');
  el.scrollTop = 800;
  assert.equal(fn(400, el, 0), 800, '用户滚到 800 是真滚动，记忆更新');
});

// ---------------------------------------------------------------------------
// 3) computeRestoreScroll：clamp 到容器可视范围
// ---------------------------------------------------------------------------
test('属性：computeRestoreScroll 夹取 oracle（×300）', () => {
  const { sandbox } = loadApp();
  const fn = sandbox.computeRestoreScroll;
  for (let i = 0; i < 300; i++) {
    const top = pick([0, 100, 99999, -1, NaN, null, undefined, 'x']);
    const scrollHeight = pick([0, 500, 1000, 10000, NaN]);
    const clientHeight = pick([0, 500, 1000, NaN, scrollHeight]);
    const container = { scrollHeight, clientHeight };
    let got;
    assert.doesNotThrow(() => { got = fn({ top }, container); });
    if (typeof top !== 'number' || !Number.isFinite(top) || top < 0) {
      assert.equal(got, null, '非法记忆 → null');
    } else {
      const sh = Number.isFinite(scrollHeight) ? scrollHeight : 0;
      const ch = Number.isFinite(clientHeight) ? clientHeight : 0;
      assert.equal(got, Math.min(top, Math.max(0, sh - ch)), '夹取到 [0, scrollHeight-clientHeight]');
    }
  }
});

// ---------------------------------------------------------------------------
// 4) messagesFromEvents：毒化事件流
// ---------------------------------------------------------------------------
test('属性：messagesFromEvents 毒化事件流不炸且顺序保持（×300）', () => {
  const { sandbox } = loadApp();
  const fn = sandbox.messagesFromEvents;
  const junk = () => pick([null, undefined, 0, '', {}, [], { type: 'user/message' },
    { type: 'user/message', data: null, seq: 1, time: 1 },
    { type: 'assistant/message', data: { content: null } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'q' }, { type: 'img' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] } } },
    { type: 'tool/call', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
  ]);
  for (let i = 0; i < 300; i++) {
    const events = [];
    const n = Math.floor(rand() * 20);
    for (let k = 0; k < n; k++) events.push(junk());
    let out;
    assert.doesNotThrow(() => { out = fn(events); }, '毒化事件流不抛');
    assert.ok(Array.isArray(out));
    for (const m of out) assert.ok(m.kind === 'user' || m.kind === 'assistant');
  }
  // 非数组输入
  for (const bad of [null, undefined, 0, {}, 'x']) assert.doesNotThrow(() => fn(bad));
  // 顺序保持 + runtime-context 快照过滤
  const out = fn([
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'a' }] } }, seq: 1 },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'b' }] }, seq: 2 },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. zz' }] } }, seq: 3 },
  ]);
  assert.deepEqual(out.map((m) => m.text), ['a', 'b']);
  assert.deepEqual(out.map((m) => m.sourceSeq), [1, 2]);
});

// ---------------------------------------------------------------------------
// 5) 洪水：10⁴ live-reply 事件（画布模式 rAF 合并 + 详情模式 120ms 节流）
// ---------------------------------------------------------------------------
test('洪水：10⁴ scheduleLiveRender 调用（120ms 节流）render 上界 + 零定时器泄漏', () => {
  const { sandbox, clock, counters } = loadApp();
  const schedule = sandbox.scheduleLiveRender;
  assert.equal(typeof schedule, 'function');
  const rendersBefore = counters.renders;
  const N = 10_000;
  // 每 10ms 一波事件、每波 20 次 scheduleLiveRender（模拟流式分片洪水），
  // 总时长 5s：节流下至多 ceil(5000/120)+1 次渲染。
  let peakTimers = 0;
  for (let wave = 0; wave < N / 20; wave++) {
    for (let k = 0; k < 20; k++) schedule();
    peakTimers = Math.max(peakTimers, clock.pendingTimers);
    clock.advance(10);
  }
  clock.advance(10_000); // 排空
  const renders = counters.renders - rendersBefore;
  assert.ok(renders <= Math.ceil((N / 20 * 10) / 120) + 2,
    '10⁴ 次事件下 render 次数上界（≈每 120ms 至多 1 次），实际 ' + renders);
  assert.ok(peakTimers <= 1, '任意时刻至多 1 个 pending 渲染定时器，峰值 ' + peakTimers);
  assert.equal(clock.pendingTimers, 0, '排空后零 pending 定时器');
});

test('洪水：10⁴ scheduleLiveCardUpdate 调用（rAF 合并）rAF 上界', () => {
  const { sandbox, clock } = loadApp();
  const schedule = sandbox.scheduleLiveCardUpdate;
  assert.equal(typeof schedule, 'function');
  let peakRaf = 0;
  for (let i = 0; i < 10_000; i++) {
    schedule('sess-1');
    peakRaf = Math.max(peakRaf, clock.pendingRaf);
    if (i % 100 === 99) clock.fireRaf(); // 浏览器每帧消费
  }
  assert.ok(peakRaf <= 1, '任意时刻至多 1 个 pending rAF（合并到帧），峰值 ' + peakRaf);
  clock.fireRaf();
  assert.equal(clock.pendingRaf, 0);
});

test('洪水：10⁴ bridge message 事件（毒化载荷）不炸、渲染有界', () => {
  const { messageListeners, clock, counters } = loadApp();
  assert.ok(messageListeners.length >= 1, 'message 监听已登记');
  const rendersBefore = counters.renders;
  const poisons = () => pick([
    null, undefined, {}, { source: 'other' },
    { source: 'dsh-synapse', type: 'synapse:live-reply' },
    { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 42, running: 'x', text: null },
    { source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'no-such', running: true, text: 'x'.repeat(5000) },
    { source: 'dsh-synapse', type: 'synapse:theme', dark: 1 },
    { source: 'dsh-synapse', type: 'synapse:workspaces', workspaces: 'bad' },
    { source: 'dsh-synapse', type: 'synapse:current-session', session: null },
    { source: 'dsh-synapse', type: 'synapse:bridge-error', requestId: 'r-' + Math.floor(rand() * 10), message: '\u0000毒' },
  ]);
  for (let i = 0; i < 10_000; i++) {
    const data = poisons();
    assert.doesNotThrow(() => {
      for (const fn of messageListeners) fn({ origin: 'http://ta2.local', data });
    }, '毒化 bridge 消息 #' + i);
    if (i % 500 === 499) clock.advance(50);
  }
  clock.advance(10_000);
  const renders = counters.renders - rendersBefore;
  assert.ok(renders < 10_000, '毒化洪水下渲染远小于事件数（节流生效），实际 ' + renders);
});

// ---------------------------------------------------------------------------
// 6) 滚动 pin 不丢位置：记忆写入 session storage → 洪水 → 排空后可恢复
// ---------------------------------------------------------------------------
test('洪水后滚动 pin 位置可恢复（sessionStorage 记忆不丢）', () => {
  const { sandbox, clock, detailScroll, sessionStorage } = loadApp();
  // 用户滚动：detail-scroll 元素收到 scroll 事件（pinDetailScroll 注册的监听在
  // render 进入 thread 模式时挂载；此处直接模拟 pin 链路的后半段 —— 经
  // nextDetailScrollTop + writeDetailScroll 验证记忆持久化，然后洪水排空）。
  const remember = sandbox.nextDetailScrollTop;
  const write = sandbox.writeDetailScroll;
  const read = sandbox.readDetailScroll;
  const el = { scrollTop: 777 };
  const top = remember(0, el, null);
  assert.equal(top, 777, '用户滚动到 777 → 记忆 777');
  write(sessionStorage, 'thread-1', top);
  const back = read(sessionStorage, 'thread-1');
  assert.ok(back && back.top === 777, '记忆写入并可读回');
  // 洪水 + 排空（detailRefreshAfter 窗口内的延迟渲染不丢 catch-up）
  const schedule = sandbox.scheduleLiveRender;
  for (let i = 0; i < 5_000; i++) { schedule(); clock.advance(1); }
  clock.advance(10_000);
  const back2 = read(sessionStorage, 'thread-1');
  assert.ok(back2 && back2.top === 777, '洪水后记忆仍在');
  // 恢复：computeRestoreScroll 夹取（容器充足时原样恢复）
  const restore = sandbox.computeRestoreScroll({ top: 777 }, detailScroll);
  assert.equal(restore, 777, '容器可容纳 → 原位置恢复');
});
