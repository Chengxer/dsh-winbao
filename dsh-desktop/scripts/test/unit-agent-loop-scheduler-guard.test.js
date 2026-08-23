'use strict';

// unit-agent-loop-scheduler-guard.test.js —— E2/问题B 回归：
// 「Cannot read properties of undefined (reading 'prepare')」（issue #147 同款，
// v0.5.3 用户在工具执行中断后仍复现；IS1 定位到 dsh-agent-loop/lib/index.js:193
// 的 ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare）。
//
// 根因形态（V8 报错语义实证——报 'prepare' 而非 'Symbol(...)' 说明 ctx.tools
// 是对象、符号字段取值 undefined）：TOOL_RUNTIME_SCHEDULER 是 Symbol(...)（副本
// 唯一），进程内出现第二份 @deepseek-ai/dsh-tools 实例（插件嵌套自带副本）时
// 两份符号互不相认 → 裸读 undefined → `.prepare` 炸；另一形态是 ctx.tools 被
// 替代实现顶替（同样无该字段）。
//
// 补丁（scripts/lib/scheduler-guard-patch.js）：
//   · dsh-agent-loop 四处裸读 → __dshDesktopScheduler(ctx)：私有符号 →
//     Symbol.for 全局镜像 → 带修复指引的显式错误（不伪造工具结果）；
//   · dsh-tools ToolRuntime 补挂 Symbol.for 全局镜像字段。
//
// 本测试：transform 契约 + 注入解析器的行为级验证（跨副本命中 / 显式报错）+
// 真实 dsh-tools 类的镜像语义（构造真实 ToolRuntime 实例取 Symbol.for 面）。
// 运行：node --test scripts/test/unit-agent-loop-scheduler-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  SCHEDULER_GLOBAL_KEY,
  SCHEDULER_GUARD_MARKER,
  SCHEDULER_GUARD_FN,
  SCHEDULER_MIRROR_MARKER,
  SCHEDULER_MIRROR_FIELD,
  transformSchedulerGuard,
  transformSchedulerMirror,
  patchSchedulerGuard,
} = require('../lib/scheduler-guard-patch');

const NM = path.join(__dirname, '..', '..', 'node_modules');

// ---------------------------------------------------------------------------
// 1) transform 契约（agent-loop）
// ---------------------------------------------------------------------------

/** dsh-agent-loop pristine 节选：import 行 + runGroup 的四处裸读。 */
function agentLoopFixture() {
  return [
    'import { Service } from "@deepseek-ai/cordis";',
    'import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER } from "@deepseek-ai/dsh-tools";',
    'async function runGroup(ctx, turn, step, group, mode, signal, acceptContext) {',
    '\tconst commitReady = async () => {',
    '\t\tconst result = slot.needsPost ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result) : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result);',
    '\t};',
    '\tconst startCall = async (index) => {',
    '\t\tconst prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);',
    '\t\tconst promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec);',
    '\t};',
    '}',
  ].join('\n');
}

test('transform 契约(agent-loop): 四处裸读全改写、幂等、锚点漂移退役', () => {
  const src = agentLoopFixture();
  const r = transformSchedulerGuard(src, 'f.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(SCHEDULER_GUARD_MARKER));
  assert.ok(r.src.includes('function __dshDesktopScheduler(ctx)'));
  // 调用面四处全部改写（.finalize/.finish/.prepare/.dispatch）。
  for (const method of ['finalize', 'finish', 'prepare', 'dispatch']) {
    assert.ok(r.src.includes(`await __dshDesktopScheduler(ctx).${method}`) || r.src.includes(`= __dshDesktopScheduler(ctx).${method}`) || r.src.includes(`__dshDesktopScheduler(ctx).${method}`), `调用面 ${method} 应经解析器`);
  }
  // 代码路径上不再有裸读（唯一残留是解析器注释里的原文引用——文档说明用）。
  const bare = r.src.split('ctx.tools[TOOL_RUNTIME_SCHEDULER]').length - 1;
  assert.equal(bare, 1, '唯一残留应仅在解析器注释内（文档），代码零裸读');
  const commentZone = r.src.slice(r.src.indexOf(SCHEDULER_GUARD_MARKER), r.src.indexOf('function __dshDesktopScheduler'));
  assert.ok(r.src.slice(r.src.indexOf('function __dshDesktopScheduler')).split('ctx.tools[TOOL_RUNTIME_SCHEDULER]').length === 1);
  assert.ok(commentZone.includes('ctx.tools[TOOL_RUNTIME_SCHEDULER]'), '残留确实位于注释区');
  // 幂等 + 漂移。
  assert.equal(transformSchedulerGuard(r.src, 'f.js').status, 'already');
  assert.equal(transformSchedulerGuard('export {};', 'f.js').status, 'anchor-missing');
});

test('transform 契约(agent-loop): 注入的解析器不被全量替换自噬（注释保留原文）', () => {
  const r = transformSchedulerGuard(agentLoopFixture(), 'f.js');
  const helper = r.src.slice(r.src.indexOf(SCHEDULER_GUARD_MARKER));
  const at = helper.indexOf('// ctx.tools');
  assert.ok(at >= 0, '解析器注释含裸读原文');
  assert.ok(helper.slice(at, at + 80).startsWith('// ctx.tools[TOOL_RUNTIME_SCHEDULER] reads undefined'), '注释首行应保留原始裸读字样（未被改写）');
});

// ---------------------------------------------------------------------------
// 2) transform 契约（dsh-tools 镜像字段）
// ---------------------------------------------------------------------------

/** dsh-tools pristine 节选：ToolRuntime 的调度器字段。 */
function toolsFixture() {
  return [
    'var ToolRuntime = class extends Service {',
    '\tstatic inject = ["systemPrompt"];',
    '\t[TOOL_RUNTIME_SCHEDULER] = {',
    '\t\tprepare: (exec) => this.prepareScheduledExecution(exec),',
    '\t\tdispatch: (exec) => this.dispatchScheduledExecution(exec),',
    '\t\tfinalize: (exec, result) => this.finalizeScheduledExecution(exec, result),',
    '\t\tfinish: (exec, result) => this.finishScheduledExecution(exec, result)',
    '\t};',
    '\tdeferredContexts = /* @__PURE__ */ new WeakMap();',
    '};',
  ].join('\n');
}

test('transform 契约(dsh-tools): 镜像字段追加在调度器字段之后、幂等、漂移退役', () => {
  const r = transformSchedulerMirror(toolsFixture(), 'g.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(SCHEDULER_MIRROR_MARKER));
  assert.ok(r.src.includes(`[Symbol.for("${SCHEDULER_GLOBAL_KEY}")] = this[TOOL_RUNTIME_SCHEDULER];`));
  // 镜像字段必须在原字段之后（类字段初始化顺序：镜像读取 this[TOOL_RUNTIME_SCHEDULER]）。
  assert.ok(r.src.indexOf(SCHEDULER_MIRROR_FIELD.split('\n').pop()) > r.src.indexOf('finish: (exec, result) => this.finishScheduledExecution(exec, result)'), '镜像字段位于原字段之后');
  assert.equal(transformSchedulerMirror(r.src, 'g.js').status, 'already');
  assert.equal(transformSchedulerMirror('export {};', 'g.js').status, 'anchor-missing');
});

// ---------------------------------------------------------------------------
// 3) 行为验证：注入的解析器（跨副本命中 / 显式报错，双 Symbol() 副本仿真）
// ---------------------------------------------------------------------------

/** 以某一副本的私有符号闭包构造解析器（真实注入代码）。 */
function makeGuard(moduleSymbol) {
  return new Function('TOOL_RUNTIME_SCHEDULER', `"use strict";\n${SCHEDULER_GUARD_FN}\nreturn __dshDesktopScheduler;`)(moduleSymbol);
}

test('行为: 同副本（私有符号命中）直接返回调度器', () => {
  const symA = Symbol('@deepseek-ai/dsh-tools.scheduler');
  const sched = { prepare() {}, dispatch() {}, finalize() {}, finish() {} };
  const guard = makeGuard(symA);
  const ctx = { tools: { [symA]: sched } };
  assert.equal(guard(ctx), sched);
});

test('行为: 跨副本（私有符号 miss）经 Symbol.for 全局镜像命中——真修复面', () => {
  // 两份 dsh-tools 副本：各自 Symbol() 描述相同但实例不同。
  const symA = Symbol('@deepseek-ai/dsh-tools.scheduler');
  const symB = Symbol('@deepseek-ai/dsh-tools.scheduler');
  assert.notEqual(symA, symB, '前置：Symbol() 副本唯一（根因）');
  // B 副本提供的 ToolRuntime 实例：带 B 私有符号 + 全局镜像（补丁后形态）。
  const schedB = { prepare() {}, from: 'B' };
  const toolsB = { [symB]: schedB, [Symbol.for(SCHEDULER_GLOBAL_KEY)]: schedB };
  // A 副本的 agent-loop（guard 闭包 symA）读 B 实例：裸读本会 undefined 炸。
  assert.equal(toolsB[symA], undefined, '前置：旧代码在此 undefined（reading prepare 形态）');
  assert.equal(makeGuard(symA)({ tools: toolsB }), schedB, '解析器经全局镜像命中');
});

test('行为: tools 无任何调度器面 → 带修复指引的显式错误（非 reading prepare）', () => {
  const symA = Symbol('@deepseek-ai/dsh-tools.scheduler');
  const guard = makeGuard(symA);
  // 形态一：ctx.tools 是替代实现（无字段）。
  assert.throws(() => guard({ tools: {} }), /tool runtime scheduler unavailable.*duplicate @deepseek-ai\/dsh-tools copy/s);
  // 形态二：ctx.tools 缺席（旧代码报 reading 'Symbol(...)'，现在统一显式错误）。
  assert.throws(() => guard({}), /tool runtime scheduler unavailable/);
});

test('行为: 解析器对 cordis traceable 代理形态（symbol get 透传）同义', () => {
  const symA = Symbol('@deepseek-ai/dsh-tools.scheduler');
  const sched = { prepare() {} };
  const target = { [symA]: sched };
  // cordis createTraceable 的 symbol get 语义 = Reflect.get(target, symbol, receiver)。
  const proxied = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
      return t[prop];
    },
  });
  assert.equal(makeGuard(symA)({ tools: proxied }), sched);
});

// ---------------------------------------------------------------------------
// 4) 真实文件与真实类（dev node_modules）
// ---------------------------------------------------------------------------

test('真实类: 打补丁的 dsh-tools ToolRuntime 实例经 Symbol.for 取到 prepare 可调面', async () => {
  const toolsPkg = path.join(NM, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  if (!fs.existsSync(toolsPkg)) { assert.ok(true, 'dev node_modules 不存在，跳过'); return; }
  const src = fs.readFileSync(toolsPkg, 'utf8');
  if (!src.includes(SCHEDULER_MIRROR_MARKER)) {
    assert.ok(true, 'dev 树未打补丁（postinstall/boot 链覆盖），transform 契约已由 1-3 覆盖');
    return;
  }
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
  const fakeCtx = {
    systemPrompt: { tools() {}, section() { return () => {}; } },
    reflect: { provide() {} },
    fiber: { effect() { return () => {}; } },
  };
  const rt = new ToolRuntime(fakeCtx, {});
  const viaFor = rt[Symbol.for(SCHEDULER_GLOBAL_KEY)];
  assert.equal(typeof viaFor?.prepare, 'function', '镜像经 Symbol.for 可达且带 prepare（#147 形态的修复面）');
  assert.equal(typeof viaFor?.dispatch, 'function');
  // 真实 agent-loop 文件：已应用即幂等。
  const loopFile = path.join(NM, '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js');
  if (fs.existsSync(loopFile)) {
    const loopSrc = fs.readFileSync(loopFile, 'utf8');
    if (loopSrc.includes(SCHEDULER_GUARD_MARKER)) {
      assert.equal(transformSchedulerGuard(loopSrc, loopFile).status, 'already');
      assert.equal(patchSchedulerGuard(NM, () => {}), 0, 'root 应用器对已应用树幂等（0 写入）');
    }
  }
});
