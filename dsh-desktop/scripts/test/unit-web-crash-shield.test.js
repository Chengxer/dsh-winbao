'use strict';

// unit-web-crash-shield.test.js — scripts/lib/web-crash-shield.js 单测。
// 覆盖：启动期 fail-fast / 就绪后吞错并落日志 / 风暴断路恢复抛出 /
// 就绪横幅探测 arm / unhandledRejection 同语义。

const test = require('node:test');
const assert = require('node:assert');

const { createCrashShield } = require('../lib/web-crash-shield');

/** 桩 process：只记录事件监听与 stderr 输出。 */
function fakeProc() {
  const handlers = {};
  const stderrLines = [];
  const stdoutChunks = [];
  return {
    handlers,
    stderrLines,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    stderr: { write(line) { stderrLines.push(String(line)); return true; } },
    stdout: {
      write(chunk) { stdoutChunks.push(String(chunk)); return true; },
      chunks: stdoutChunks,
    },
    fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
  };
}

test('启动期（未 arm）uncaughtException 原样重抛（fail-fast）', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc, emit: () => {} });
  shield.install();
  const boom = new Error('boot failure');
  assert.throws(() => shield.onUncaughtException(boom), /boot failure/);
  assert.strictEqual(proc.stderrLines.length, 0);
});

test('就绪后 uncaughtException 被吞并写日志，宿主继续', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc });
  shield.install();
  shield.arm();
  assert.doesNotThrow(() => shield.onUncaughtException(new Error('plugin bug')));
  assert.strictEqual(proc.stderrLines.length, 1);
  assert.match(proc.stderrLines[0], /crash-shield.*uncaughtException/);
  assert.match(proc.stderrLines[0], /plugin bug/);
});

test('就绪后 unhandledRejection 被吞并写日志；非 Error 原因安全转述', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc });
  shield.install();
  shield.arm();
  assert.doesNotThrow(() => shield.onUnhandledRejection(new Error('rej')));
  assert.doesNotThrow(() => shield.onUnhandledRejection('plain string reason'));
  assert.strictEqual(proc.stderrLines.length, 2);
  assert.match(proc.stderrLines[1], /plain string reason/);
});

test('启动期 unhandledRejection 重抛（fail-fast）', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc, emit: () => {} });
  shield.install();
  assert.throws(() => shield.onUnhandledRejection(new Error('early rej')), /early rej/);
  assert.throws(() => shield.onUnhandledRejection('x'));
});

test('风暴断路：窗口内超上限后恢复抛出（交壳层崩溃环自愈）', () => {
  const proc = fakeProc();
  let now = 0;
  const shield = createCrashShield({
    process: proc,
    emit: () => {},
    timers: { now: () => now },
  });
  shield.install();
  shield.arm();
  // 默认上限 20：前 20 次吞掉，第 21 次抛出。
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => shield.onUncaughtException(new Error('e' + i)));
    now += 1; // 全部落在 60s 窗口内
  }
  assert.throws(() => shield.onUncaughtException(new Error('storm')));
});

test('风暴窗口过期后计数清零，恢复吞错', () => {
  const proc = fakeProc();
  let now = 0;
  const shield = createCrashShield({
    process: proc,
    emit: () => {},
    timers: { now: () => now },
  });
  shield.install();
  shield.arm();
  for (let i = 0; i < 20; i += 1) shield.onUncaughtException(new Error('e'));
  now += 61000; // 跨过窗口
  assert.doesNotThrow(() => shield.onUncaughtException(new Error('recovered')));
});

test('wrapStdout：stdout 命中就绪横幅后自动 arm', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc, emit: () => {} });
  shield.install();
  assert.strictEqual(shield.isArmed(), false);
  proc.stdout.write('loading plugins...\n');
  assert.strictEqual(shield.isArmed(), false);
  proc.stdout.write('dsh web: http://127.0.0.1:63899\n');
  assert.strictEqual(shield.isArmed(), true);
  // 原 write 行为保留
  assert.strictEqual(proc.stdout.chunks.length, 2);
});

test('install 注册两个进程级事件监听', () => {
  const proc = fakeProc();
  const shield = createCrashShield({ process: proc, emit: () => {} });
  shield.install();
  assert.strictEqual((proc.handlers.uncaughtException || []).length, 1);
  assert.strictEqual((proc.handlers.unhandledRejection || []).length, 1);
});
