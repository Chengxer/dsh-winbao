'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { zstdCompressSync } = require('node:zlib');
const { patchSessionPersistence } = require('../patch-session-persistence');
const {
  PERSISTENCE_PKG_REL,
  PERSISTENCE_TORN_MARKER,
  transformPersistenceTornTail,
  PERSISTENCE_CORRUPT_MARKER,
  transformPersistenceCorruptGuard,
} = require('../lib/runtime-patches');

// 本单测绝不 patch 真实 dev node_modules：优先把仓库根 .tmp-rc2-stage 的
// pristine 装配产物（或回退 dev node_modules）拷入 os.tmpdir 临时树，再对临时
// 树应用 patchSessionPersistence 并断言产物。避免全量测试并发时污染共享 dev 树，
// 进而让「内核源应命中锚点（pristine）」类断言假失败。
const devNmRoot = path.join(path.resolve(__dirname, '..', '..'), 'node_modules');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRISTINE_NM = path.join(REPO_ROOT, '.tmp-rc2-stage', 'node_modules');

/** 惰性构建一份「已打 patch」的隔离 node_modules 树（进程内共享，仅拷一次）。 */
let _shared = null;
function sharedTree() {
  if (_shared) return _shared;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persist-rec-'));
  const nmRoot = path.join(root, 'node_modules');
  const src = fs.existsSync(PRISTINE_NM) ? PRISTINE_NM : devNmRoot;
  fs.cpSync(src, nmRoot, { recursive: true });
  const target = path.join(nmRoot, '@deepseek-ai', PERSISTENCE_PKG_REL);
  patchSessionPersistence(nmRoot);
  process.on('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }
  });
  _shared = { root, nmRoot, target };
  return _shared;
}

function frame(value) {
  return zstdCompressSync(Buffer.from(value, 'utf8'));
}

function fixture() {
  const header = {
    type: 'session',
    version: 0,
    id: 'session-recovery-test',
    createdAt: 1,
    cwd: 'C:/fake',
    delegationDepth: 0,
    agentPreset: 'standard',
  };
  const start = {
    type: 'turn/start',
    seq: 0,
    time: 1,
    data: { turn: 0 },
  };
  const headerFrame = frame(JSON.stringify(header) + '\n');
  return {
    headerFrame,
    start,
    header,
  };
}

test('session persistence patch is applied and idempotent', () => {
  const { nmRoot, target } = sharedTree();
  patchSessionPersistence(nmRoot); // 幂等：临时树已应用，二次应用应 no-op
  const source = fs.readFileSync(target, 'utf8');
  assert.match(source, new RegExp(PERSISTENCE_TORN_MARKER));
  assert.equal(transformPersistenceTornTail(source, target).status, 'already');
  // 上游 #112：patchSessionPersistence 现经 transformPersistenceAll 同时应用
  // 「损坏会话日志容错」补丁，两个补丁都应已应用（幂等）。
  assert.match(source, new RegExp(PERSISTENCE_CORRUPT_MARKER));
  assert.equal(transformPersistenceCorruptGuard(source, target).status, 'already');
});

test('complete final zstd frame with torn JSONL returns a repair marker', async () => {
  const { target } = sharedTree();
  const mod = await import(`${pathToFileURL(target).href}?recovery-final-frame`);
  const backend = Object.create(mod.JsonlSessionPersistence.prototype);
  const { headerFrame, start } = fixture();
  const eventFrame = frame(JSON.stringify(start) + '\n{"type":"assistant/message","seq":1');

  const result = await backend.readZstdPrefix(Buffer.concat([headerFrame, eventFrame]));
  assert.deepEqual(result.events.map((event) => event.type), ['turn/start']);
  assert.deepEqual(result.tornMarker.recoveredEvents.map((event) => event.type), ['turn/start']);
  assert.equal(result.tornMarker.truncateTo, headerFrame.length);
});

test('complete newline-terminated frame keeps the normal no-marker path', async () => {
  const { target } = sharedTree();
  const mod = await import(`${pathToFileURL(target).href}?recovery-clean-frame`);
  const backend = Object.create(mod.JsonlSessionPersistence.prototype);
  const { headerFrame, start } = fixture();
  const end = {
    type: 'turn/end',
    seq: 1,
    time: 2,
    data: { turn: 0, reason: { kind: 'completed' } },
  };

  const result = await backend.readZstdPrefix(Buffer.concat([
    headerFrame,
    frame(JSON.stringify(start) + '\n' + JSON.stringify(end) + '\n'),
  ]));
  assert.deepEqual(result.events.map((event) => event.type), ['turn/start', 'turn/end']);
  assert.equal(result.tornMarker, undefined);
});

test('torn JSONL in a non-final complete frame remains corruption', async () => {
  const { target } = sharedTree();
  const mod = await import(`${pathToFileURL(target).href}?recovery-middle-frame`);
  const backend = Object.create(mod.JsonlSessionPersistence.prototype);
  const { headerFrame, start } = fixture();
  const tornFrame = frame(JSON.stringify(start) + '\n{"type":"assistant/message","seq":1');
  const followingFrame = frame(JSON.stringify({
    type: 'turn/end',
    seq: 1,
    time: 2,
    data: { turn: 0, reason: { kind: 'completed' } },
  }) + '\n');

  await assert.rejects(
    backend.readZstdPrefix(Buffer.concat([headerFrame, tornFrame, followingFrame])),
    /complete frame contains a torn JSONL record/,
  );
});
