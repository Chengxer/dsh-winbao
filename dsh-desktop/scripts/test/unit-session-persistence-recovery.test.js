'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { zstdCompressSync } = require('node:zlib');
const { patchSessionPersistence } = require('../patch-session-persistence');
const {
  PERSISTENCE_PKG_REL,
  PERSISTENCE_TORN_MARKER,
  transformPersistenceTornTail,
} = require('../lib/runtime-patches');

const repoRoot = path.resolve(__dirname, '..', '..');
const nmRoot = path.join(repoRoot, 'node_modules');
const target = path.join(nmRoot, '@deepseek-ai', PERSISTENCE_PKG_REL);

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
  patchSessionPersistence(nmRoot);
  const source = fs.readFileSync(target, 'utf8');
  assert.match(source, new RegExp(PERSISTENCE_TORN_MARKER));
  assert.equal(transformPersistenceTornTail(source, target).status, 'already');
});

test('complete final zstd frame with torn JSONL returns a repair marker', async () => {
  patchSessionPersistence(nmRoot);
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
  patchSessionPersistence(nmRoot);
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
  patchSessionPersistence(nmRoot);
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
