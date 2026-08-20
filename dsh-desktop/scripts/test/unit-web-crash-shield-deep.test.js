'use strict';

// unit-web-crash-shield-deep.test.js — scripts/lib/web-crash-shield.js 深水区单测。
// 与 unit-web-crash-shield.test.js 互补：那一个做冒烟断言；本文件做穷举级断言——
//   · createCrashShield 全桩 process（真实 EventEmitter + env/stdout/stderr 捕获）；
//   · 启动期 fail-fast（uncaughtException 同步重抛 / unhandledRejection 经
//     immediate 延后重抛、非 Error 包装）；
//   · 就绪后吞错 + 原始 stack / JSON.stringify 转述；
//   · 风暴断路（默认 20/60s、窗口过期、env 覆盖）；
//   · attributeSources（裸包/scoped/.pnpm 过滤/去重排序/loader entry/非 Error）；
//   · noteAttributes（阈值发射一次、窗口去重、过期重置、异源独立、env 覆盖）；
//   · arm / wrapStdout（拆分横幅累加、多次命中单次 arm、字节透传）；
//   · install 注册次数 + 模块级 auto-install guard（子进程验证监听数）。
// 纯 Node 核心依赖，零 Electron、零网络。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

// 保证本测试进程 require 模块时走默认常量（不误装、不误读 env 覆盖）。
delete process.env.DSH_CRASH_SHIELD;
delete process.env.DSH_CRASH_SHIELD_LIMIT;
delete process.env.DSH_CRASH_SHIELD_WINDOW_MS;
delete process.env.DSH_CRASH_SHIELD_ATTRIBUTE_THRESHOLD;
delete process.env.DSH_CRASH_SHIELD_ATTRIBUTE_WINDOW_MS;

const {
  createCrashShield,
  attributeSources,
  STORM_LIMIT,
  STORM_WINDOW_MS,
  ATTRIBUTE_THRESHOLD,
  ATTRIBUTE_WINDOW_MS,
} = require('../lib/web-crash-shield');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'web-crash-shield.js');

/** 全桩 process：真实 EventEmitter + env/stderr/stdout 捕获 + on 计数。 */
function makeProc() {
  const proc = new EventEmitter();
  const env = {};
  const stderrLines = [];
  const stdoutChunks = [];
  const onCounts = {};
  proc.env = env;
  proc.stderr = { write(chunk) { stderrLines.push(String(chunk)); return true; } };
  proc.stdout = { write(chunk, ...rest) { stdoutChunks.push({ chunk: String(chunk), rest }); return stdoutChunks.length; } };
  const origOn = proc.on.bind(proc);
  proc.on = (ev, fn) => { onCounts[ev] = (onCounts[ev] || 0) + 1; return origOn(ev, fn); };
  return { proc, env, stderrLines, stdoutChunks, onCounts };
}

// ── 默认常量（编码 §4.6 规范：风暴 20/60s，归因阈值 3/10min） ─────────────
test('默认常量编码规范: STORM 20/60s、ATTRIBUTE 3/10min', () => {
  assert.equal(STORM_LIMIT, 20);
  assert.equal(STORM_WINDOW_MS, 60000);
  assert.equal(ATTRIBUTE_THRESHOLD, 3);
  assert.equal(ATTRIBUTE_WINDOW_MS, 10 * 60 * 1000);
});

// ── 启动期 fail-fast ────────────────────────────────────────────────────────
test('pre-arm uncaughtException 同步重抛同一错误对象', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  const boom = new Error('boot failure');
  assert.throws(() => shield.onUncaughtException(boom), (e) => e === boom);
  assert.equal(proc.stderrLines.length, 0, 'no diagnostic in pre-arm fail-fast');
});

test('pre-arm unhandledRejection 经 immediate 延后重抛（非 Error 包装为 Error）', () => {
  const proc = makeProc();
  const shield = createCrashShield({
    process: proc.proc,
    emit: () => {},
    timers: { now: () => 0, immediate: (fn) => fn() },
  });
  const boom = new Error('early rej');
  assert.throws(() => shield.onUnhandledRejection(boom), (e) => e === boom);
  assert.throws(() => shield.onUnhandledRejection('plain'), (e) => e instanceof Error && e.message === 'plain');
});

test('pre-arm unhandledRejection 默认延后到下一 tick（不同步抛、回调再抛）', () => {
  const proc = makeProc();
  let scheduled = null;
  const shield = createCrashShield({
    process: proc.proc,
    emit: () => {},
    timers: { now: () => 0, immediate: (fn) => { scheduled = fn; } },
  });
  assert.doesNotThrow(() => shield.onUnhandledRejection('plain reason'));
  assert.ok(scheduled, 'rethrow callback must be scheduled via immediate');
  assert.throws(() => scheduled(), (e) => e instanceof Error && e.message === 'plain reason');
});

// ── 就绪后吞错 ──────────────────────────────────────────────────────────────
test('post-arm uncaughtException 吞掉并写含原始 stack 的标记行', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc });
  shield.arm();
  const err = new Error('plugin bug');
  assert.doesNotThrow(() => shield.onUncaughtException(err));
  assert.equal(proc.stderrLines.length, 1);
  assert.ok(proc.stderrLines[0].includes('[crash-shield] uncaughtException'));
  assert.ok(proc.stderrLines[0].includes(err.stack), 'emitted line must embed the original stack');
});

test('post-arm unhandledRejection 非 Error 原因 JSON.stringify 转述', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc });
  shield.arm();
  assert.doesNotThrow(() => shield.onUnhandledRejection({ code: 'E_BROKEN', n: 1 }));
  assert.equal(proc.stderrLines.length, 1);
  assert.ok(proc.stderrLines[0].includes('[crash-shield] unhandledRejection'));
  assert.ok(proc.stderrLines[0].includes('{"code":"E_BROKEN","n":1}'));
});

// ── 风暴断路 ────────────────────────────────────────────────────────────────
test('storm breaker: 窗口内第 (STORM_LIMIT+1) 次抛出，前 STORM_LIMIT 次吞掉', () => {
  let now = 0;
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, emit: () => {}, timers: { now: () => now } });
  shield.arm();
  for (let i = 0; i < STORM_LIMIT; i += 1) {
    assert.doesNotThrow(() => shield.onUncaughtException(new Error('e' + i)));
    now += 1;
  }
  assert.throws(() => shield.onUncaughtException(new Error('storm')));
});

test('storm window 过期后计数清零，恢复吞错', () => {
  let now = 0;
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, emit: () => {}, timers: { now: () => now } });
  shield.arm();
  for (let i = 0; i < STORM_LIMIT; i += 1) shield.onUncaughtException(new Error('e'));
  now += STORM_WINDOW_MS + 1;
  assert.doesNotThrow(() => shield.onUncaughtException(new Error('recovered')));
});

test('storm 常量: 模块加载时读取 env 覆盖 (LIMIT/WINDOW_MS)', () => {
  const src = 'const m = require(' + JSON.stringify(MODULE_PATH) + '); process.stdout.write(JSON.stringify({ L: m.STORM_LIMIT, W: m.STORM_WINDOW_MS }));';
  const r = spawnSync(process.execPath, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CRASH_SHIELD_LIMIT: '5', DSH_CRASH_SHIELD_WINDOW_MS: '1000' },
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.L, 5);
  assert.equal(v.W, 1000);
});

// ── attributeSources ────────────────────────────────────────────────────────
test('attributeSources: 裸包 / scoped / .pnpm 链（过滤噪声 token）', () => {
  assert.deepEqual(attributeSources('C:\\x\\node_modules\\broken-plugin\\lib\\i.js'), ['broken-plugin']);
  assert.deepEqual(attributeSources('node_modules/@scope/pkg/lib/x.js'), ['@scope/pkg']);
  // pnpm 隔离布局：`.pnpm` 段被丢弃，真实包名在内层 node_modules 命中。
  assert.deepEqual(attributeSources('node_modules\\.pnpm\\broken-plugin@1.0.0\\node_modules\\broken-plugin\\lib\\x.js'), ['broken-plugin']);
});

test('attributeSources: 多来源去重保序 + loader entry + 非 Error → []', () => {
  assert.deepEqual(
    attributeSources('node_modules/pkg-a/a.js node_modules/pkg-a/b.js node_modules/pkg-b/c.js loader entry foo.bar ('),
    ['pkg-a', 'pkg-b', 'foo.bar']
  );
  assert.deepEqual(attributeSources('loader entry foo.bar ('), ['foo.bar']);
  assert.deepEqual(attributeSources('plain text without packages'), []);
  assert.deepEqual(attributeSources(12345), []);
});

// ── noteAttributes（归因计数） ───────────────────────────────────────────────
test('noteAttributes: 阈值内同源发射一次、窗口去重、过期重置', () => {
  const emitted = [];
  let now = 0;
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, timers: { now: () => now }, emit: (l) => emitted.push(l) });
  shield.arm();
  const bad = () => 'node_modules/broken-plugin/lib/i.js';
  shield.noteAttributes(bad());
  shield.noteAttributes(bad());
  shield.noteAttributes(bad());
  assert.deepEqual(emitted, ['[crash-shield] attribute: broken-plugin count: 3\n']);
  shield.noteAttributes(bad()); // 第 4 次同窗口不再二次发射
  assert.equal(emitted.length, 1);
  // 窗口过期 → 计数重置，再次达阈值再发射一次
  now += ATTRIBUTE_WINDOW_MS + 1;
  shield.noteAttributes(bad());
  shield.noteAttributes(bad());
  assert.equal(emitted.length, 1, 'reset after window expiry must not emit until threshold again');
  shield.noteAttributes(bad());
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1], '[crash-shield] attribute: broken-plugin count: 3\n');
});

test('noteAttributes: 不同来源独立计数', () => {
  const emitted = [];
  let now = 0;
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, timers: { now: () => now }, emit: (l) => emitted.push(l) });
  shield.arm();
  const a = () => 'node_modules/pkg-a/x.js';
  const b = () => 'node_modules/pkg-b/y.js';
  shield.noteAttributes(a());
  shield.noteAttributes(a());
  shield.noteAttributes(b());
  shield.noteAttributes(b());
  assert.equal(emitted.length, 0);
  shield.noteAttributes(a());
  shield.noteAttributes(b());
  assert.equal(emitted.length, 2);
  assert.ok(emitted.includes('[crash-shield] attribute: pkg-a count: 3\n'));
  assert.ok(emitted.includes('[crash-shield] attribute: pkg-b count: 3\n'));
});

test('attribute 常量: 模块加载时读取 env 覆盖 (THRESHOLD/WINDOW_MS)', () => {
  const src = 'const m = require(' + JSON.stringify(MODULE_PATH) + '); process.stdout.write(JSON.stringify({ T: m.ATTRIBUTE_THRESHOLD, W: m.ATTRIBUTE_WINDOW_MS }));';
  const r = spawnSync(process.execPath, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CRASH_SHIELD_ATTRIBUTE_THRESHOLD: '7', DSH_CRASH_SHIELD_ATTRIBUTE_WINDOW_MS: '2000' },
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.T, 7);
  assert.equal(v.W, 2000);
});

// ── arm ─────────────────────────────────────────────────────────────────────
test('arm(): 置 env、isArmed 翻转、二次 arm 幂等、只读 env 不抛', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc });
  assert.equal(shield.isArmed(), false);
  shield.arm();
  assert.equal(shield.isArmed(), true);
  assert.equal(proc.env.DSH_CRASH_SHIELD_ARMED, '1');
  shield.arm();
  assert.equal(shield.isArmed(), true);

  const proc2 = makeProc();
  Object.freeze(proc2.env);
  const shield2 = createCrashShield({ process: proc2.proc });
  assert.doesNotThrow(() => shield2.arm());
  assert.equal(shield2.isArmed(), true, 'armed flag must flip even when env is read-only');
});

// ── wrapStdout ──────────────────────────────────────────────────────────────
test('wrapStdout: 完整横幅 arm + 字节透传 + 返回值/参数保留', () => {
  const proc = makeProc();
  const calls = [];
  proc.proc.stdout.write = function (chunk, ...rest) { calls.push({ chunk, rest }); return 'ORIG_RET'; };
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  shield.install();
  const ret = proc.proc.stdout.write('dsh web: http://127.0.0.1:8321', 'utf8', 'cb');
  assert.equal(shield.isArmed(), true);
  assert.equal(ret, 'ORIG_RET');
  assert.deepEqual(calls[0], { chunk: 'dsh web: http://127.0.0.1:8321', rest: ['utf8', 'cb'] });
});

test('wrapStdout: 横幅跨两次写（累加器）→ arm', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  shield.install();
  proc.proc.stdout.write('dsh web: htt');
  assert.equal(shield.isArmed(), false);
  proc.proc.stdout.write('p://127.0.0.1:8321');
  assert.equal(shield.isArmed(), true);
});

test('wrapStdout: 非横幅写不 arm', () => {
  const proc = makeProc();
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  shield.install();
  proc.proc.stdout.write('loading plugins...\n');
  proc.proc.stdout.write('another line\n');
  assert.equal(shield.isArmed(), false);
});

test('wrapStdout: 多次命中横幅仅 arm 一次', () => {
  const proc = makeProc();
  let envWrites = 0;
  Object.defineProperty(proc.env, 'DSH_CRASH_SHIELD_ARMED', {
    configurable: true,
    set(v) { envWrites += 1; this._armedValue = v; },
    get() { return this._armedValue; },
  });
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  shield.install();
  proc.proc.stdout.write('dsh web: http://127.0.0.1:8321');
  proc.proc.stdout.write('dsh web: http://127.0.0.1:9999');
  assert.equal(shield.isArmed(), true);
  assert.equal(envWrites, 1, 'arm() must set env exactly once across multiple banner hits');
});

// ── install ─────────────────────────────────────────────────────────────────
test('install(): 注册两个处理器各一次并包住 stdout', () => {
  const proc = makeProc();
  const origWrite = proc.proc.stdout.write;
  const shield = createCrashShield({ process: proc.proc, emit: () => {} });
  shield.install();
  assert.equal(proc.onCounts.uncaughtException, 1);
  assert.equal(proc.onCounts.unhandledRejection, 1);
  assert.equal(proc.proc.listenerCount('uncaughtException'), 1);
  assert.equal(proc.proc.listenerCount('unhandledRejection'), 1);
  assert.notEqual(proc.proc.stdout.write, origWrite, 'stdout.write must be wrapped');
});

// ── 模块级 auto-install guard（子进程验证真实 process 监听数） ─────────────
test('module auto-install guard: DSH_CRASH_SHIELD 未设 → 不注册任何监听', () => {
  const src = 'require(' + JSON.stringify(MODULE_PATH) + '); process.stdout.write(JSON.stringify({ ue: process.listenerCount("uncaughtException"), ur: process.listenerCount("unhandledRejection") }));';
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ue, 0);
  assert.equal(v.ur, 0);
});

test('module auto-install guard: DSH_CRASH_SHIELD=1 → 安装两处理器', () => {
  const src = 'require(' + JSON.stringify(MODULE_PATH) + '); process.stdout.write(JSON.stringify({ ue: process.listenerCount("uncaughtException"), ur: process.listenerCount("unhandledRejection") }));';
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', env: { ...process.env, DSH_CRASH_SHIELD: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ue, 1);
  assert.equal(v.ur, 1);
});
