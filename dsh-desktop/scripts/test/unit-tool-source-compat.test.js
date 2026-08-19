'use strict';

// unit-tool-source-compat.test.js — 空 tool-call 容错补丁单测。
// 覆盖：读端/写端变换幂等与锚点命中；打补丁后的 dsh-session 对空 callId 的
// tool/result 就地修复放行、真损坏（双非空不一致）仍拒绝、正常事件不受影响。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  SESSION_VALIDATION_REL,
  AGENT_LOOP_REL,
  TOOL_SOURCE_MARKER,
  EMPTY_TOOLCALL_MARKER,
  transformToolSourceTolerance,
  transformEmptyToolCallGuard,
  patchToolSourceCompat,
} = require('../lib/tool-source-patch');

const repoRoot = path.resolve(__dirname, '..', '..');
const nmRoot = path.join(repoRoot, 'node_modules');
const sessionTarget = path.join(nmRoot, '@deepseek-ai', SESSION_VALIDATION_REL);
const loopTarget = path.join(nmRoot, '@deepseek-ai', AGENT_LOOP_REL);

function badToolResultEvent(seq) {
  // 事故形态：tool/result 的 source.callId 与 block.toolCallId 都是空串。
  return {
    type: 'tool/result',
    seq,
    time: 1,
    data: {
      turn: 0,
      step: 1,
      message: {
        id: 'msg-' + seq,
        role: 'user',
        source: { kind: 'tool', callId: '' },
        content: [{ type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'ok' }] }],
      },
    },
  };
}

test('读端变换：真实 vendored 文件锚点命中、幂等', () => {
  const src = fs.readFileSync(sessionTarget, 'utf8');
  const r1 = transformToolSourceTolerance(src, sessionTarget);
  assert.ok(r1.status === 'changed' || r1.status === 'already', '锚点应命中: ' + r1.status);
  if (r1.status === 'changed') {
    const r2 = transformToolSourceTolerance(r1.src, sessionTarget);
    assert.equal(r2.status, 'already');
  }
});

test('写端变换：真实 vendored 文件锚点命中、幂等', () => {
  const src = fs.readFileSync(loopTarget, 'utf8');
  const r1 = transformEmptyToolCallGuard(src, loopTarget);
  assert.ok(r1.status === 'changed' || r1.status === 'already', '锚点应命中: ' + r1.status);
  if (r1.status === 'changed') {
    const r2 = transformEmptyToolCallGuard(r1.src, loopTarget);
    assert.equal(r2.status, 'already');
  }
});

test('patchToolSourceCompat 应用到 dev node_modules 且幂等', () => {
  patchToolSourceCompat(nmRoot);
  const s1 = fs.readFileSync(sessionTarget, 'utf8');
  const s2 = fs.readFileSync(loopTarget, 'utf8');
  assert.match(s1, new RegExp(TOOL_SOURCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(s2, new RegExp(EMPTY_TOOLCALL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // 二次应用返回 0 变更。
  assert.equal(patchToolSourceCompat(nmRoot), 0);
});

test('打补丁后的 dsh-session：空 callId 的 tool/result 就地修复放行', async () => {
  patchToolSourceCompat(nmRoot);
  const mod = await import(`${pathToFileURL(sessionTarget).href}?tool-source-tolerance`);
  const ev = badToolResultEvent(450516);
  const adopted = mod.adoptSessionEvent(ev);
  const source = adopted.data.message.source;
  assert.equal(source.kind, 'tool');
  assert.equal(source.callId, 'recovered-seq-450516');
  assert.equal(adopted.data.message.content[0].toolCallId, 'recovered-seq-450516');
});

test('打补丁后的 dsh-session：source.callId 缺失（非空串形态）同样修复', async () => {
  patchToolSourceCompat(nmRoot);
  const mod = await import(`${pathToFileURL(sessionTarget).href}?tool-source-tolerance`);
  const ev = badToolResultEvent(7);
  delete ev.data.message.source.callId;
  ev.data.message.content[0].toolCallId = 'real-call-1';
  // 一侧为空一侧非空 → 以非空侧为准。
  const adopted = mod.adoptSessionEvent(ev);
  assert.equal(adopted.data.message.source.callId, 'real-call-1');
});

test('打补丁后的 dsh-session：双非空不一致仍是硬损坏，继续拒绝', async () => {
  patchToolSourceCompat(nmRoot);
  const mod = await import(`${pathToFileURL(sessionTarget).href}?tool-source-tolerance`);
  const ev = badToolResultEvent(9);
  ev.data.message.source.callId = 'call-a';
  ev.data.message.content[0].toolCallId = 'call-b';
  assert.throws(() => mod.adoptSessionEvent(ev), /mismatched tool call ids/);
});

test('打补丁后的 dsh-session：正常的 tool/result 事件不受影响', async () => {
  patchToolSourceCompat(nmRoot);
  const mod = await import(`${pathToFileURL(sessionTarget).href}?tool-source-tolerance`);
  const ev = badToolResultEvent(11);
  ev.data.message.source.callId = 'call-ok';
  ev.data.message.content[0].toolCallId = 'call-ok';
  const adopted = mod.adoptSessionEvent(ev);
  assert.equal(adopted.data.message.source.callId, 'call-ok');
});
