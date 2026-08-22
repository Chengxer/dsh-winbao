'use strict';

// ta4-balance-client-legacy-inject.test.js — TA4 回归锁定（dsh-balance 槽竞态修复的降级面补锁）。
//
// 修复背景（槽竞态，issue 0.5.0 实机）：dsh-balance dock 子条目从裸
// slots.register 改为 ctx.slots.inject(key, factory)——inject 把注册推迟到
// 父 entry（conversation 大 bundle）就绪后派发，消除冷缓存首启竞态。
// unit-companion-client-rc8 已锁 rc.8/rc.7 模块表双端物化；本文件补：
// **宿主 slots kit 不提供 inject 时（旧内核形态 mock）apply 的现状行为**。
//
// 【已知产品缺口（记录勿修）】当前 apply 对 ctx.slots.inject 无 typeof
// 回退：旧宿主（slots 无 inject 方法）下 effect 回调内 ctx.slots.inject(...)
// 抛 TypeError。本测试断言该现状并标注——一旦加回退（typeof inject ===
// 'function' ? inject : register 直注），把「旧形态不炸」断言翻正即可。
// 运行：node --test scripts/test/ta4-balance-client-legacy-inject.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-balance', 'lib', 'client.js');

/** 深层惰性 stub：任意属性/调用可继续链式使用（react 系 require 桩）。 */
function deepStub() {
  const f = () => stub;
  const stub = new Proxy(f, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}

/** 经 __ModuleLoader__ 捕获 factory 并物化 module.exports（rc8 测试同款思路）。 */
function loadPluginExports() {
  let def;
  const window = { __ModuleLoader__: { load: (d) => { def = d; } } };
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), { window, console });
  assert.ok(def && def.factory, 'client.js 必须经 __ModuleLoader__.load 注册');
  const requireStub = () => deepStub();
  return def.factory(requireStub);
}

function makeCtx({ withInject }) {
  const calls = { inject: [], register: [] };
  const slots = { register: (...a) => { calls.register.push(a); return undefined; } };
  if (withInject) slots.inject = (...a) => { calls.inject.push(a); return undefined; };
  const ctx = {
    effect: (fn) => fn(), // 立即派发（宿主 effect 语义的最小同构）
    slots,
  };
  return { ctx, calls };
}

test('dsh-balance apply：现代宿主（slots.inject 在位）→ 经 inject 注册 dock', () => {
  const exports_ = loadPluginExports();
  assert.ok(Array.isArray(exports_.inject) && exports_.inject.length === 1 && exports_.inject[0] === 'slots', 'capability 声明锚点');
  const { ctx, calls } = makeCtx({ withInject: true });
  exports_.apply(ctx);
  assert.equal(calls.inject.length, 1, '必须经 ctx.slots.inject 注册（槽竞态修复主行为）');
  assert.equal(calls.inject[0][0], 'conversation.composer.dock', 'keyed slot 名锚点');
  assert.equal(calls.register.length, 0, '现代宿主不得绕过 inject 直注 register');
});

test('dsh-balance apply：旧内核形态（slots 无 inject）——现状断言【已知产品缺口】', () => {
  const exports_ = loadPluginExports();
  const { ctx } = makeCtx({ withInject: false });
  // 已修（TA4 #1）：typeof inject === 'function' 守卫——旧宿主降级 register 不炸。
  exports_.apply(ctx); // 不应抛——降级走 register 路径
});

test('dsh-balance apply：无 document 环境不炸（ensureCss 纯浏览器守卫）', () => {
  const exports_ = loadPluginExports();
  const { ctx } = makeCtx({ withInject: true });
  // vm 上下文无 document——ensureCss 必须 typeof 守卫短路。
  assert.doesNotThrow(() => exports_.apply(ctx), '无 document 环境降级不炸');
});
