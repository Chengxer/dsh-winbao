'use strict';

// 会话持久化「损坏会话日志容错」单元测试（node --test）。
// 覆盖上游 #112 新增的两个 transform（纯函数，无文件 I/O）：
//   1) transformPersistenceCorruptGuard —— 三态（匹配 / 已应用 / 失配）
//   2) transformPersistenceAll       —— 尾部撕裂恢复 + 损坏会话跳过的组合语义
// 背景：2026-08 事故——卷影恢复带回零填充头部的会话日志，导致 listArtifacts
// 读首行时整个 plugin tree 初始化崩溃。这两个 transform 把「读首行」包进
// try-catch，损坏时告警跳过该会话（continue），不再击穿启动扫描。
//
// 隔离：纯字符串变换，不读写文件，不触碰真实 ~/.dsh 或 node_modules。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PERSISTENCE_CORRUPT_MARKER,
  PERSISTENCE_TORN_MARKER,
  transformPersistenceCorruptGuard,
  transformPersistenceAll,
} = require('../lib/runtime-patches');

// 以下 OLD 锚点镜像 runtime-patches.js 的内部常量（未导出），
// 与源文件逐字节一致，用于构造「未打补丁」的 fixtures。
const CORRUPT_OLD = 'const first = this.compression === "zstd" ? await this.readFirstZstdLine(path, signal) : await this.readFirstLine(path, signal);';
const FRAME_LOOP_OLD = 'let remainingFrames = frames.length - 1;\n\t\t\tfor (const plaintext of decodedFrames) {';
const WRITE_OLD = '\t\t\t\tscanner.write(plaintext);\n\t\t\t\tremainingFrames -= 1;';
const COMPLETE_CHECK = '\t\t\tif (complete.committedBytes !== complete.inputBytes) throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");';

// 同时含「尾部撕裂」三个锚点 + 「损坏会话」锚点的完整原始源码。
const FULL_SRC = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK, CORRUPT_OLD].join('\n');

test('transformPersistenceCorruptGuard：匹配 → 注入 try-catch 跳过损坏会话', () => {
  const changed = transformPersistenceCorruptGuard(CORRUPT_OLD, 't.js');
  assert.equal(changed.status, 'changed');
  // 注入的核心语义：读首行包进 try-catch，损坏时告警并 continue（跳过该会话）。
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '应写入 corrupt-guard marker');
  assert.ok(changed.src.includes('try {'), '应注入 try 块');
  assert.ok(changed.src.includes('catch (corruptError)'), '应注入 catch 块');
  assert.ok(changed.src.includes('signal?.throwIfAborted()'), 'catch 内应先重抛中止信号');
  assert.ok(changed.src.includes('skipping corrupt session log'), '告警文案应含 skipping corrupt session log');
  assert.ok(changed.src.includes('continue;'), '损坏时应 continue 跳过该会话');
  // 原读首行逻辑保留在 try 内（去掉 const，改为 let first; 声明）。
  assert.ok(changed.src.includes('let first;'), '应改为 let first 声明');
  assert.ok(changed.src.includes('first = this.compression === "zstd"'), '读首行逻辑应保留在 try 内');
  // 原「const first = ...」整句不再原样存在（已改写）。
  assert.ok(!changed.src.includes(CORRUPT_OLD), '旧的 const first 语句应被改写');
});

test('transformPersistenceCorruptGuard：已应用 → already', () => {
  assert.equal(transformPersistenceCorruptGuard('// ' + PERSISTENCE_CORRUPT_MARKER, 't.js').status, 'already');
});

test('transformPersistenceCorruptGuard：失配 → anchor-missing 且绝不改写', () => {
  const src = 'export const x = 1;';
  const miss = transformPersistenceCorruptGuard(src, 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('损坏会话容错锚点'), 'detail 应说明是损坏会话容错锚点失配');
  assert.ok(miss.detail.includes('版本可能已变更'), 'detail 应提示版本可能已变更');
});

test('transformPersistenceAll：两个补丁都命中 → 同时应用（changed）', () => {
  const changed = transformPersistenceAll(FULL_SRC, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '应含尾部撕裂 marker');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '应含损坏会话 marker');
  // 尾部撕裂：三个锚点均被改写。
  assert.ok(!changed.src.includes(FRAME_LOOP_OLD), 'FRAME_LOOP 旧锚点应被改写');
  assert.ok(!changed.src.includes(WRITE_OLD), 'WRITE 旧锚点应被改写');
  assert.ok(changed.src.includes('tornCompleteFrameStart'), '应注入 tornCompleteFrameStart 逻辑');
});

test('transformPersistenceAll：仅损坏会话补丁命中（尾部撕裂已应用）→ changed', () => {
  const src = ['// ' + PERSISTENCE_TORN_MARKER, CORRUPT_OLD].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话 marker 应写入');
  assert.ok(!changed.src.includes(CORRUPT_OLD), '旧 const first 应被改写');
});

test('transformPersistenceAll：仅尾部撕裂补丁命中（损坏会话已应用）→ changed', () => {
  const src = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK, '// ' + PERSISTENCE_CORRUPT_MARKER].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂 marker 应写入');
  assert.ok(!changed.src.includes(FRAME_LOOP_OLD), 'FRAME_LOOP 旧锚点应被改写');
});

test('transformPersistenceAll：两个补丁都已应用 → already', () => {
  const src = ['// ' + PERSISTENCE_TORN_MARKER, '// ' + PERSISTENCE_CORRUPT_MARKER].join('\n');
  assert.equal(transformPersistenceAll(src, 't.js').status, 'already');
});

test('transformPersistenceAll：幂等——首次 changed，二次 already', () => {
  const once = transformPersistenceAll(FULL_SRC, 't.js');
  assert.equal(once.status, 'changed');
  const twice = transformPersistenceAll(once.src, 't.js');
  assert.equal(twice.status, 'already');
});

test('transformPersistenceAll：全部失配 → anchor-missing（损坏会话 detail 优先）', () => {
  const miss = transformPersistenceAll('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('损坏会话容错锚点'), '应返回损坏会话容错锚点失配的 detail');
});

test('transformPersistenceAll：尾部撕裂命中 + 损坏会话失配 → 仅撕裂应用（互不阻塞）', () => {
  // 只有尾部撕裂三个锚点，无损坏会话锚点：撕裂照常应用，损坏会话失配不阻断。
  const src = [FRAME_LOOP_OLD, WRITE_OLD, COMPLETE_CHECK].join('\n');
  const changed = transformPersistenceAll(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂 marker 应写入');
  assert.ok(!changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话失配，不应写入其 marker');
});

test('transformPersistenceAll：尾部撕裂失配 + 损坏会话命中 → 仅损坏会话应用（互不阻塞）', () => {
  // 只有损坏会话锚点，无尾部撕裂锚点：损坏会话容错照常应用。
  const changed = transformPersistenceAll(CORRUPT_OLD, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(PERSISTENCE_CORRUPT_MARKER), '损坏会话 marker 应写入');
  assert.ok(!changed.src.includes(PERSISTENCE_TORN_MARKER), '尾部撕裂失配，不应写入其 marker');
});
