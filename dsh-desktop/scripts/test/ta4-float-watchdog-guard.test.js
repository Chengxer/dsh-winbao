'use strict';

// ta4-float-watchdog-guard.test.js — TA4 回归锁定（FW1 浮窗看门狗 about:blank
// protocol 守卫的行为级补锁）。
//
// 修复背景：看门狗脚本经 AddScriptToExecuteOnDocumentCreated 注入——该通道
// 在**导航前文档（about:blank）也会执行一次**。若不守卫，about:blank 上
// body 恒空 → 3s 后 reload about:blank → 白屏/死循环。修复以
// `location.protocol !== 'http:' && !== 'https:'` 提前返回。
// windows.rs 已有形态测（脚本文本含 location.protocol）；本文件补**行为级**：
// 从 windows.rs 提取真实脚本常量，在 vm 桩环境中执行，验证守卫矩阵。
// 运行：node --test scripts/test/ta4-float-watchdog-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WINDOWS_RS = path.resolve(__dirname, '..', '..', '..', 'dsh-tauri', 'src-tauri', 'src', 'app', 'src', 'windows.rs');

/** 从 windows.rs 提取 FLOAT_WATCHDOG_SCRIPT 原文（r#"..."# 原始字符串）。 */
function extractWatchdogScript() {
  const src = fs.readFileSync(WINDOWS_RS, 'utf8');
  const m = src.match(/const FLOAT_WATCHDOG_SCRIPT: &str = r#"\r?\n([\s\S]*?)"#;/);
  assert.ok(m, 'windows.rs 必须含 FLOAT_WATCHDOG_SCRIPT（FW1 回归即坏）');
  return m[1];
}

/**
 * 桩环境执行脚本（不真等 3s）：setTimeout 捕获回调与 delay，由测试手动触发。
 * 返回操控/观测句柄。
 */
function runWatchdog({ protocol, flag, bodyChildren }) {
  const timers = [];
  const ops = { reload: 0, removeItem: [], setItem: [], errorCard: 0, titleSet: null };
  const store = flag ? { __dsh_float_watchdog_reloaded__: '1' } : {};
  const sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); ops.setItem.push(k); },
    removeItem: (k) => { delete store[k]; ops.removeItem.push(k); },
  };
  const mkEl = () => ({
    style: {}, children: [],
    appendChild(c) { this.children.push(c); },
  });
  const body = { childElementCount: bodyChildren, appendChild(c) { ops.errorCard++; this.children = this.children || []; this.children.push(c); } };
  const errorHost = { children: [], appendChild(c) { ops.errorCard++; this.children.push(c); } };
  const document = {
    body,
    title: null,
    getElementById: (id) => (ops.errorCard > 0 && id === '__dsh_float_load_error__' ? { exists: true } : null),
    createElement: () => mkEl(),
    documentElement: errorHost,
  };
  Object.defineProperty(document, 'title', {
    set(v) { ops.titleSet = v; }, get() { return null; },
  });
  const sandbox = {
    location: {
      protocol,
      reload: () => { ops.reload++; },
    },
    document,
    sessionStorage,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.window.dshDesktop = undefined;
  vm.runInNewContext(extractWatchdogScript(), sandbox);
  return {
    timers,
    ops,
    fireTimer() {
      assert.equal(timers.length, 1, '脚本只应注册一个定时器');
      timers[0].fn();
    },
  };
}

test('about:blank（预导航文档）→ protocol 守卫直接返回，零定时器零 reload', () => {
  const w = runWatchdog({ protocol: 'about:', flag: false, bodyChildren: 0 });
  assert.equal(w.timers.length, 0, 'about: 文档不得注册看门狗定时器（init script 双执行洞）');
  assert.equal(w.ops.reload, 0);
});

test('非 http(s) 协议（file:/tauri:）同样被守卫挡下', () => {
  for (const protocol of ['file:', 'tauri:', 'data:', '']) {
    const w = runWatchdog({ protocol, flag: false, bodyChildren: 0 });
    assert.equal(w.timers.length, 0, `${protocol || '(空)'} 不得注册定时器`);
  }
});

test('http: 死页面（body 空、无重试标记）→ 3s 定时器 → reload 恰一次并立标记', () => {
  const w = runWatchdog({ protocol: 'http:', flag: false, bodyChildren: 0 });
  assert.equal(w.timers.length, 1, 'http 文档必须注册看门狗');
  assert.equal(w.timers[0].delay, 3000, '3s 检查窗锚点');
  w.fireTimer();
  assert.equal(w.ops.reload, 1, '首次死页面 reload 一次');
  assert.deepEqual(w.ops.setItem, ['__dsh_float_watchdog_reloaded__'], 'reload 前立 sessionStorage 标记（每窗最多一次）');
  assert.equal(w.ops.errorCard, 0, '首次不发错误卡');
});

test('http: 死页面 + 已重试标记 → 不再 reload，转可见错误卡（重试/关闭）', () => {
  const w = runWatchdog({ protocol: 'https:', flag: true, bodyChildren: 0 });
  w.fireTimer();
  assert.equal(w.ops.reload, 0, '已重试过不得再 reload（防死循环）');
  assert.equal(w.ops.errorCard, 1, '必须呈现错误卡（不留纯白屏）');
  assert.equal(w.ops.titleSet, '浮窗加载失败', '错误态改标题可辨识');
});

test('http: 活页面（body 有子元素）→ 清除重试标记、零 reload 零错误卡', () => {
  const w = runWatchdog({ protocol: 'http:', flag: true, bodyChildren: 3 });
  w.fireTimer();
  assert.equal(w.ops.reload, 0);
  assert.equal(w.ops.errorCard, 0);
  assert.deepEqual(w.ops.removeItem, ['__dsh_float_watchdog_reloaded__'], '恢复健康须清标记（下轮死页面可再救一次）');
});
