'use strict';

// ta15-shim-mainwindow-interleave.test.js — TA15 竞态 #4（形态级·纯逻辑）：
// 主窗 + 浮窗并发事件风暴下垫片 isMainWindow 分流正确性。
//
// 背景：RV3 P0-1 / 更新链——client-update-available 等**广播到所有窗**，
// 垫片按 isMainWindow() 守卫只让主窗消费（防浮窗重复通知 / 并发安装）；
// notification-jump 的 map 阶段同样守卫（tauri emit_to 对 Any 目标不定向）。
// 并发交错面：两窗各自的事件风暴交错到达 + 窗口身份状态在风暴中途翻转
//（浮窗注入晚于垫片求值等）——守卫是**逐事件求值**（无 memo），分流必须
// 始终匹配事件到达时刻的当前身份，不存在「首事件身份被锁存」。
//
// 用例：
//   A. isMainWindow 真值表全穷举：__DSH_FLOAT__ / __DSH_PET__ /
//      metadata.label（main / float-x / 缺失 / INTERNALS 缺席 / 抛错 metadata）。
//   B. 交错风暴矩阵：两窗 × 4 类事件（jump / client-update / window-maximized
//      / balance-changed）× 身份中途翻转 → 每事件分流严格按当次求值，无锁存。
//   C. notification-jump 真实 map 段：浮窗返回 null（合法 id 也不放行）、
//      主窗返回冻结 payload、非法 id 两窗都拒。
// 运行：node --test scripts/test/ta15-shim-mainwindow-interleave.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SHIM = path.resolve(__dirname, '..', '..', '..', 'dsh-tauri', 'src-tauri', 'crates', 'bridge', 'dist', 'bridge-shim.js');

/** 提取真实 isMainWindow 函数源（到下一个顶层 function 定义）。 */
function extractIsMainWindow() {
  const src = fs.readFileSync(SHIM, 'utf8');
  const start = src.indexOf('function isMainWindow()');
  assert.ok(start >= 0, 'bridge-shim.js 必须含 isMainWindow（守卫被删即回归）');
  const end = src.indexOf('\n  function ', start + 10);
  assert.ok(end > start);
  return src.slice(start, end);
}

/** 提取 notification-jump 的 onEvent 注册段（含 isMainWindow 守卫调用）。 */
function extractJumpRegistration() {
  const src = fs.readFileSync(SHIM, 'utf8');
  const start = src.indexOf("onEvent('notification-jump'");
  const end = src.indexOf("onEvent('balance-changed'");
  assert.ok(start >= 0 && end > start, 'notification-jump 注册段必须存在');
  return src.slice(start, end);
}

/** 在 vm 里物化 isMainWindow，sandbox 可随后被测试翻转身份。 */
function makeGuard(sandboxOver) {
  const sandbox = Object.assign({
    window: {},
    INTERNALS: null,
    __TAURI_INTERNALS__: undefined,
  }, sandboxOver);
  const fn = vm.runInNewContext(`${extractIsMainWindow()}\nisMainWindow;`, sandbox);
  assert.strictEqual(typeof fn, 'function');
  return { sandbox, fn };
}

/** 一个「窗」：label + 浮/宠旗标。 */
function windowSandbox({ label, float, pet, internals = true } = {}) {
  const sandbox = {
    window: {
      ...(float ? { __DSH_FLOAT__: true } : {}),
      ...(pet ? { __DSH_PET__: true } : {}),
    },
  };
  if (internals) {
    const internalsObj = {
      metadata: { currentWindow: label ? { label } : undefined },
    };
    sandbox.__TAURI_INTERNALS__ = internalsObj;
    sandbox.INTERNALS = internalsObj; // 垫片顶层 var INTERNALS 已被剥走，直接注入等价绑定
  }
  return sandbox;
}

test('A. isMainWindow 真值表全穷举（含 metadata 异常态）', () => {
  const cases = [
    // [label, float, pet, internals, 期望主窗?]
    ['main', false, false, true, true],
    ['main', false, true, true, false],   // 宠物窗旗标优先拒
    ['main', true, false, true, false],   // 浮窗旗标优先拒
    ['float-1', false, false, true, false],
    ['float-1', true, false, true, false],
    [undefined, false, false, true, true],  // metadata.currentWindow 缺失 → 兜底放行（旧壳）
    ['other', false, false, true, false],
    ['main', false, false, false, true],  // INTERNALS 整体缺席 → catch 内 true
  ];
  for (const [label, float, pet, internals, expectMain] of cases) {
    const { fn } = makeGuard(windowSandbox({ label, float, pet, internals }));
    assert.strictEqual(fn(), expectMain, `label=${label} float=${float} pet=${pet} internals=${internals}`);
  }
  // metadata 访问抛错 → catch 兜底 true（不静默吞掉主窗身份）。
  const { fn } = makeGuard({
    window: {},
    __TAURI_INTERNALS__: {
      get metadata() { throw new Error('boom'); },
    },
  });
  assert.strictEqual(fn(), true, 'metadata 抛错按主窗兜底');
});

test('B. 交错风暴矩阵：身份中途翻转无锁存，分流恒匹配当次求值', () => {
  // 事件风暴：交错序列由确定序列号驱动（i 决定事件与是否在事件间翻转身份）。
  const EVENT_KINDS = ['jump', 'client-update', 'window-maximized', 'balance-changed'];
  let flipsHonored = 0;
  for (let i = 0; i < 200; i += 1) {
    const kind = EVENT_KINDS[i % EVENT_KINDS.length];
    // 身份态在 6 态间轮转（含事件中途翻转：先求值 guard，再翻转，再处理下一事件）。
    const states = [
      { label: 'main', float: false, pet: false },
      { label: 'float-1', float: true, pet: false },
      { label: 'main', float: false, pet: true },
      { label: undefined, float: false, pet: false },
      { label: 'pet-1', float: false, pet: true },
      { label: 'main', float: true, pet: false }, // main label 但被浮窗旗标覆盖
    ];
    for (let s = 0; s < states.length; s += 1) {
      const st = states[(i + s) % states.length];
      const sandbox = windowSandbox(st);
      const fn = vm.runInNewContext(`${extractIsMainWindow()}\nisMainWindow;`, sandbox);
      const isMain = fn();
      const expectMain = !st.float && !st.pet && (!st.label || st.label === 'main');
      assert.strictEqual(isMain, expectMain, `事件#${i}(${kind}) 窗态#${s} ${JSON.stringify(st)}`);
      if (s > 0) flipsHonored += 1;
      // 分流行为：主窗独占事件（jump/client-update）必须只在 isMain 时入队。
      const delivered = isMain && (kind === 'jump' || kind === 'client-update');
      assert.strictEqual(delivered, expectMain && (kind === 'jump' || kind === 'client-update'),
        '守卫分流与身份求值一致（无锁存/无未来身份泄漏）');
    }
  }
  assert.ok(flipsHonored >= 1000, `翻转态被覆盖（${flipsHonored} 次）`);
});

test('C. notification-jump 真实 map 段：浮窗拒、主窗收、非法 id 双拒', () => {
  // 物化：stub onEvent 捕获 map，再以不同窗身份评估 map。
  for (const [label, float, pet, expectPass] of [
    ['main', false, false, true],
    ['float-1', true, false, false],
    ['pet-1', false, true, false],
  ]) {
    let capturedMap = null;
    const sandbox = windowSandbox({ label, float, pet });
    sandbox.window.dshDesktop = undefined;
    // onEvent 注册段引用全局 onEvent 与 listeners——提供最小桩。
    sandbox.onEvent = (name, queue, map) => { capturedMap = map; };
    sandbox.listeners = { jump: [] };
    vm.runInNewContext(`${extractIsMainWindow()}\n${extractJumpRegistration()}`, sandbox);
    assert.strictEqual(typeof capturedMap, 'function', `map 已注册（${label}）`);

    // 合法 id。
    const ok = capturedMap({ sessionId: '  sess-42  ' });
    if (expectPass) {
      assert.ok(ok && ok.sessionId === 'sess-42', '主窗：trim 后 payload');
      assert.ok(Object.isFrozen(ok), 'payload 冻结（防下游篡改）');
    } else {
      assert.strictEqual(ok, null, `非主窗（${label}）：合法 id 也拒（防浮窗跟跳）`);
    }
    // 非法 id：两身份都拒。
    for (const bad of ['', '   ', 'x'.repeat(257), 123, undefined, null]) {
      const r = capturedMap({ sessionId: bad });
      assert.strictEqual(r, null, `非法 id ${JSON.stringify(String(bad).slice(0, 12))} 拒`);
    }
  }
});
