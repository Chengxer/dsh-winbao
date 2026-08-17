'use strict';
// 逻辑级验证：dsh-balance 客户端 BalanceDock 修复（parts -> joined 数组）
// 1) 不再抛 ReferenceError；2) Go 用量 chip 正常渲染；3) children 为数组而非 join 字符串
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-balance', 'lib', 'client.js');
const src = fs.readFileSync(file, 'utf8');

// ---------- 最小 React mock：支持 useState / useEffect / jsx ----------
// hookStore[0] = balance data state；presetData 模拟「事件已推送后的状态」，
// 直接作为 useState 初始值（贴近真实：setData 后组件重渲染读到新值）。
let hookStore = [];
let hookIndex = 0;
let pendingEffects = [];
let presetData = null; // 非 null 时 = 第一个 useState 的直接初始值（模拟推送后）

function resetHooks() {
  hookIndex = 0;
  pendingEffects = [];
}

const mockReact = {
  useState(init) {
    const i = hookIndex++;
    if (i === 0 && presetData !== null) {
      hookStore[0] = { value: presetData };
      return [presetData, () => {}];
    }
    if (hookStore[i] === undefined) {
      hookStore[i] = { value: typeof init === 'function' ? init() : init };
    }
    const slot = hookStore[i];
    const set = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
    };
    return [slot.value, set];
  },
  useEffect(cb) {
    hookIndex++;
    pendingEffects.push({ cb });
    return undefined;
  },
};

const mockJsxRuntime = {
  jsx(type, props, key) {
    return { __isReactElement: true, type, props: props || {}, key: key === undefined ? null : key };
  },
};

function runEffects() {
  for (const { cb } of pendingEffects) cb();
}

// ---------- 加载插件（window.__ModuleLoader__ 捕获 factory） ----------
let capturedLoad = null;
const sandboxWindow = {
  __ModuleLoader__: { load: (obj) => { capturedLoad = obj; } },
  dshDesktop: { refreshBalance: () => Promise.resolve() },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
sandboxWindow.window = sandboxWindow;

const sandbox = {
  window: sandboxWindow,
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'client.js' });

if (!capturedLoad) throw new Error('未能捕获 ModuleLoader.load');
const mod = capturedLoad.factory((name) => {
  if (name === 'react') return mockReact;
  if (name === 'react/jsx-runtime') return mockJsxRuntime;
  throw new Error('unexpected require: ' + name);
});
if (typeof mod.apply !== 'function') throw new Error('exports.apply 缺失');

// ---------- 通过 slots 注册捕获 BalanceDock ----------
let dockComponent = null;
const fakeCtx = {
  slots: { register(slotInfo, Component) { dockComponent = Component; } },
  effect(cb) { cb(); },
};
mod.apply(fakeCtx);
if (typeof dockComponent !== 'function') throw new Error('未能从 slots.register 捕获 BalanceDock');

// ---------- 渲染驱动器：preset 为「事件已推送」的状态数据 ----------
function renderDock(data, usage) {
  presetData = data; // 模拟推送后：useState 直接拿到最新数据
  resetHooks();
  try {
    const result = dockComponent({ useProjection: () => usage });
    return { threw: null, result };
  } catch (err) {
    return { threw: err, result: undefined };
  }
}

function flattenChildren(node) {
  const out = [];
  (function walk(n) {
    if (n == null) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (n.__isReactElement) {
      out.push('<' + (typeof n.type === 'string' ? n.type : (n.type.name || 'Comp')) + (n.props.className ? ' class=' + n.props.className : ''));
      if (n.props.children !== undefined) walk(n.props.children);
    } else out.push(String(n));
  })(node);
  return out;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ✔ ' + name);
  else { failures++; console.log('  ✘ ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('场景1：无余额、无用量、无 Go（disabled 之外的空数据）→ 整体隐藏');
{
  const r = renderDock({ ok: false }, null);
  check('不抛异常', r.threw === null, r.threw ? r.threw.message : '');
  check('渲染 null', r.result === null);
}

console.log('场景2：有余额 + 有 Go 用量（修复前此场景炸 ReferenceError）');
{
  const go = {
    rolling: { status: 'ok', percent: 14, resetsAt: '2026-08-17T08:00:00Z' },
    weekly: { status: 'ok', percent: 42, resetsAt: '2026-08-20T00:00:00Z' },
    monthly: { status: 'ok', percent: 71, resetsAt: '2026-09-01T00:00:00Z' },
  };
  const data = {
    ok: true, peak: true,
    balances: [{ currency: 'CNY', total: 88.5, granted: 10, toppedUp: 78.5 }],
    prices: { cacheMiss: 3, cacheHit: 0.1, output: 9 },
    opencodeGo: { ok: true, usage: go },
  };
  const r = renderDock(data, { outputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  check('不抛异常（核心回归点 parts 已修复）', r.threw === null, r.threw ? r.threw.message : '');
  const flat = flattenChildren(r.result).join('|');
  check('包含余额文本', flat.includes('¥88.50'), flat);
  check('包含高峰价 chip', flat.includes('<span class=dsh-balance-peak'), flat);
  check('包含 Go chip（class=dsh-balance-go）', flat.includes('dsh-balance-go'), flat);
  check('Go 文本含 5h/周/月 三窗口', flat.includes('5h14%') && flat.includes('周42%') && flat.includes('月71%'), flat);
  const wrapper = r.result;
  check('顶层为 wrapper span', wrapper && wrapper.type === 'span' && wrapper.props.className === 'dsh-balance-wrap');
  check('children 为数组（非字符串 join）', Array.isArray(wrapper && wrapper.props.children), typeof (wrapper && wrapper.props.children));
}

console.log('场景3：仅 Go 用量（无余额）');
{
  const data = {
    ok: false, balances: [],
    opencodeGo: { ok: true, usage: { rolling: { status: 'ok', percent: 5, resetsAt: '' } } },
  };
  const r = renderDock(data, null);
  check('不抛异常', r.threw === null, r.threw ? r.threw.message : '');
  check('直接渲染 goDock', r.result && r.result.type === 'a' && r.result.props.className.includes('dsh-balance-go'), JSON.stringify(r.result && r.result.props && r.result.props.className));
  check('go 文本 = Go 5h5%', r.result.props.children === 'Go 5h5%', JSON.stringify(r.result.props.children));
}

console.log('场景4：事件推送驱动链路（useBalanceData 的 dsh-balance-changed handler）');
{
  // 首次渲染（无预设）：loading 期不渲染
  presetData = null;
  hookStore = []; // 清空 hook 状态，模拟全新 mount
  resetHooks();
  let handler = null;
  sandboxWindow.addEventListener = (name, cb) => { if (name === 'dsh-balance-changed') handler = cb; };
  sandboxWindow.removeEventListener = () => {};
  const r1 = dockComponent({ useProjection: () => null });
  check('loading 期不渲染', r1 === null);
  runEffects(); // 执行 useEffect：注册 handler + refreshBalance().then
  const data = { ok: true, balances: [{ currency: 'CNY', total: 1, granted: 0, toppedUp: 1 }],
    opencodeGo: { ok: true, usage: { weekly: { status: 'ok', percent: 33, resetsAt: 'x' } } } };
  check('handler 已注册（可接收 dsh-balance-changed）', typeof handler === 'function');
  handler({ detail: data }); // 事件推送 → setData
  // 用 set 后的状态重渲染（同真实 React 的 re-render）
  presetData = data;
  resetHooks();
  const r2 = dockComponent({ useProjection: () => null });
  const flat2 = flattenChildren(r2).join('|');
  check('事件推送后渲染出 Go 用量', flat2.includes('周33%'), flat2);
}

console.log('场景5：disabled 配置（用户关闭显示）→ 隐藏');
{
  const r = renderDock({ ok: false, disabled: true }, { outputTokens: 100, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  check('不抛异常', r.threw === null, r.threw ? r.threw.message : '');
  check('渲染 null（整体隐藏）', r.result === null);
}

console.log('\n' + (failures === 0 ? '🎉 全部断言通过' : '❌ ' + failures + ' 项失败'));
process.exit(failures === 0 ? 0 : 1);