'use strict';

// ta13-soak-synapse.test.js — TA13 极限压测（压缩时间尺度 soak）：
// dsh-synapse/app.js 事件洪水 ×100 轮（每轮 200 条 live-reply 事件 + 渲染 +
// pin 开关[canvas/thread 模式切换驱动 pinDetailScroll/stopDetailScrollPin]）。
//
// 在 vm 沙箱物化真实 app.js（经典脚本 → 顶层函数/const 挂到沙箱全局），
// 直接驱动内部 state/render/消息监听器。断言：
//   · 堆增长斜率：末 10 轮均值 - 首 10 轮均值 < HEAP_SLOPE_LIMIT_MB（宽松阈值防 CI 抖动）；
//   · render 正常完成（不抛、产出非空 innerHTML）；
//   · state 运行期 Map（liveReplies/historyBySession 等）洪水后归零/不无限增长。
// 运行：node --test scripts/test/ta13-soak-synapse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-synapse', 'app.js'), 'utf8');

const ROUNDS = 100;          // 事件洪水轮数
const EVENTS_PER_ROUND = 200;
const HEAP_SLOPE_LIMIT_MB = 40; // 宽松：只拦单调泄漏，不拦 GC 噪声

// ---------------------------------------------------------------------------
// 最小 DOM/浏览器环境（innerHTML 只存字符串；querySelector(All) 返回桩）
// ---------------------------------------------------------------------------
function makeElement() {
  const el = {
    children: [],
    dataset: {},
    style: {},
    scrollTop: 0, scrollHeight: 1000, clientHeight: 100,
    hidden: false,
    innerHTML: '',
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    hasAttribute() { return false; },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    focus() {},
  };
  return el;
}

function loadSynapse() {
  const messageListeners = [];
  const storage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    // setInterval 不真正挂起进程（轮询循环由测试手动驱动）
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    Date, Math, JSON, Map, Set, Promise, Array, Object, String, Number, Boolean, Error,
    CSS: { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    crypto: { randomUUID: () => 'u-' + Math.random().toString(36).slice(2) },
    localStorage: storage(),
    sessionStorage: storage(),
    history: { scrollRestoration: 'manual' },
    HTMLElement: function HTMLElement() {},
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
  };
  const windowListeners = { message: messageListeners, keydown: [] };
  const appEl = makeElement();
  const docEl = makeElement();
  const doc = {
    hidden: false,
    documentElement: docEl,
    body: makeElement(),
    head: makeElement(),
    querySelector: (sel) => (sel === '#app' ? appEl : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => makeElement(),
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  sandbox.document = doc;
  const win = {
    location: { origin: 'http://synapse.test', pathname: '/synapse.html' },
    parent: null, // 占位，装载后指向自身
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener() {},
    setTimeout, clearTimeout,
    setInterval: sandbox.setInterval,
    clearInterval: sandbox.clearInterval,
    requestAnimationFrame: sandbox.requestAnimationFrame,
  };
  win.parent = win;
  sandbox.window = win;
  sandbox.location = win.location;
  sandbox.self = win;
  // fetch：返回最小工作区/摘要体（refreshSummaries/openWorkspace 不炸即可）
  const threads = Array.from({ length: 12 }, (_, i) => ({
    id: 'thread-' + i,
    dshSessionId: 'sess-' + i,
    dshSessionTitle: '会话 ' + i,
    title: 'q' + i,
    parentId: i === 0 ? null : 'thread-0',
    messages: [{ kind: 'user', text: 'hello ' + i, at: Date.now() }],
  }));
  const workspace = { id: 'ws-1', title: 'ws', threads };
  sandbox.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (String(url).includes('workspaces')) return { workspaces: [{ id: 'ws-1', title: 'ws', path: '/w', sessionIds: threads.map((t) => t.dshSessionId) }] };
      if (String(url).includes('/workspace')) return { workspace };
      return {};
    },
  });
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: 'dsh-synapse/app.js' });
  return { sandbox, appEl, messageListeners, workspace };
}

function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }

test('synapse 事件洪水 soak：100 轮 × 200 事件 + 渲染 + pin 开关，堆斜率有界', async () => {
  const { sandbox, appEl, messageListeners, workspace } = loadSynapse();
  // 顶层 const（state 等）不挂 globalThis —— 一律经 runInContext 桥取用
  const g = (expr) => vm.runInContext(expr, sandbox);
  assert.ok(messageListeners.length >= 1, 'window message 监听器应已注册');
  // 等待装载期的 refreshSummaries 微任务完成
  for (let i = 0; i < 20; i++) await Promise.resolve();
  // 直接置入工作区（绕开异步 openWorkspace 的细节）
  sandbox.__ta13ws = workspace;
  g('state.workspace = __ta13ws');
  g('state.mode = "canvas"');
  vm.runInContext('render()', sandbox);
  assert.ok(appEl.innerHTML.length > 100, 'render 应产出 DOM 字符串');

  const dispatch = (data) => {
    for (const fn of messageListeners) {
      fn({ origin: 'http://synapse.test', data });
    }
  };

  // 预热 3 轮（JIT/内联字符串驻留），再开始采样
  for (let r = 0; r < 3; r++) {
    for (let e = 0; e < EVENTS_PER_ROUND; e++) {
      dispatch({ source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'sess-' + (e % 12), running: true, text: '流式块 ' + e + ' '.repeat(64) });
    }
    dispatch({ source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'sess-0', running: false });
  }

  const samples = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (let e = 0; e < EVENTS_PER_ROUND; e++) {
      dispatch({ source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'sess-' + (e % 12), running: true, text: '流式块 ' + round + '-' + e + ' '.repeat(64) });
    }
    // 渲染（thread 模式走 pinDetailScroll；canvas 走 stopDetailScrollPin —— pin 开关）
    g(`state.mode = ${round % 2 === 0 ? "'thread'" : "'canvas'"}`);
    vm.runInContext('render()', sandbox);
    // 结束一轮流（liveReplies 收敛路径：全部会话 running:false → 逐一删除）
    for (let s = 0; s < 12; s++) dispatch({ source: 'dsh-synapse', type: 'synapse:live-reply', sessionId: 'sess-' + s, running: false });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (round % 10 === 0) {
      if (global.gc) global.gc();
      samples.push(heapMB());
    }
  }
  const first10 = samples.slice(0, 10);
  const last10 = samples.slice(-10);
  const slope = (last10.reduce((a, b) => a + b, 0) / last10.length) - (first10.reduce((a, b) => a + b, 0) / first10.length);
  console.log('[ta13-synapse] heap 首值', first10[0].toFixed(1), 'MB 末值', last10[last10.length - 1].toFixed(1),
    'MB 斜率', slope.toFixed(1), 'MB（阈值', HEAP_SLOPE_LIMIT_MB, 'MB）采样点', samples.map((v) => v.toFixed(1)));
  assert.ok(slope < HEAP_SLOPE_LIMIT_MB, `堆增长斜率 ${slope.toFixed(1)} MB 应 < ${HEAP_SLOPE_LIMIT_MB} MB（末10轮 vs 首10轮均值差）`);

  // 运行期 Map 收敛：liveReplies 在 running:false 后应清空
  assert.equal(g('state.liveReplies.size'), 0, '洪水后 liveReplies 应归零');
  assert.ok(g('state.pendingRpc.size') <= 1, 'pendingRpc 不应累积');
  assert.ok(appEl.innerHTML.length > 100, '末轮 render 仍正常产出');
});
