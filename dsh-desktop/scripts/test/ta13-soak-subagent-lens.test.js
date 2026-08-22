'use strict';

// ta13-soak-subagent-lens.test.js — TA13 极限压测：dsh-subagent-lens 纯函数
// 重放 soak —— 600 个会话快照（每快照 = 事件流 + 块树 + 子会话目录条目），
// 展开视界（maxItems 全量）/收起视界（maxItems 5）×100 轮。
//
// 每轮对 600 快照跑 activityFromEvents + activityFromBlocks +
// toolCallRootsFromChatSnapshot + mergeFiles + summarizeActivity +
// parseBlockFace + matchChildEntry（无累积中间态：全部纯函数，累积只能来自
// 实现内部意外缓存/闭包持有）。断言末 10 轮 vs 首 10 轮堆增量 < 阈值。
// 运行：node --test scripts/test/ta13-soak-subagent-lens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-subagent-lens');
const CLIENT_SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');

const SESSIONS = 600;
const ROUNDS = 100;
const HEAP_SLOPE_LIMIT_MB = 30;

function loadClientModule() {
  const reactStub = {
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (f) => (typeof f === 'function' ? f() : undefined),
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (_sub, getSnap) => getSnap(),
    Fragment: '::Fragment::',
  };
  const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: '::Fragment::' };
  const moduleTable = { 'react': reactStub, 'react/jsx-runtime': jsxStub };
  const loads = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => loads.push(def) } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'dsh-subagent-lens/lib/client.js' });
  const mod = loads[0].factory((spec) => moduleTable[spec]);
  return mod;
}

function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }

function callEvent(callId, name, args, seq) {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } };
}
function resultEvent(callId, isError, seq) {
  return { type: 'tool/result', seq, data: { message: { source: { callId }, content: [{ type: 'tool-result', isError }] } } };
}

/** 600 个会话快照（复用同批输入对象 —— soak 观察的是实现侧累积，非输入分配）。 */
function makeSnapshots() {
  const snapshots = [];
  for (let s = 0; s < SESSIONS; s++) {
    const events = [
      callEvent('c1' + s, 'subagent', { description: '调研 ' + s, prompt: '读源码并总结 ' + 'x'.repeat(120), run_in_background: false }, 1),
      callEvent('c2' + s, 'bash', { command: 'node --check lib/index.js #' + s }, 2),
      callEvent('c3' + s, 'read', { file_path: 'C:/src/a' + s + '.js' }, 3),
      callEvent('c4' + s, 'write', { path: 'C:/src/b' + s + '.js', content: 'y'.repeat(200) }, 4),
      resultEvent('c2' + s, s % 3 === 0, 5),
    ];
    const blocks = [
      { callId: 'r1' + s, name: 'subagent', argsRaw: JSON.stringify({ description: '调研 ' + s, prompt: 'p' + s }), subCalls: [
        { callId: 'r1a' + s, name: 'pwsh', argsRaw: JSON.stringify({ command: 'dir ' + s }), subCalls: [] },
      ] },
      { kind: 'tool-result', callId: 'r2' + s, isError: s % 4 === 0, call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'src/z' + s + '.ts' }) }, content: [{ type: 'text', text: 'ok' }], subCalls: [] },
    ];
    const root0 = { callId: 'root' + s, name: 'bash', argsRaw: JSON.stringify({ command: 'ls ' + s }), subCalls: [] };
    const chatSnapshot = { nodes: new Map([['k1', { kind: 'tool-call', data: { root: root0 } }], ['k2', { kind: 'user' }]]) };
    const catalog = { entries: [
      { kind: 'child', id: 'child-' + s, label: '子会话 ' + s, mode: 'continuable', activity: 'running' },
    ] };
    snapshots.push({ events, blocks, chatSnapshot, catalog });
  }
  return snapshots;
}

test('subagent-lens soak：600 会话快照 × 展开/收起 100 轮，无累积', () => {
  const lens = loadClientModule();
  const snapshots = makeSnapshots();
  const samples = [];
  let totalCommands = 0;

  // 预热 3 轮
  for (let w = 0; w < 3; w++) runRound(50);
  function runRound(maxItems) {
    let acc = 0;
    for (const snap of snapshots) {
      const a = lens.activityFromEvents(snap.events, {});
      const b = lens.activityFromBlocks(snap.blocks, {});
      const roots = lens.toolCallRootsFromChatSnapshot(snap.chatSnapshot);
      const files = lens.mergeFiles([...a.fileSeeds, ...b.fileSeeds]);
      const sum = lens.summarizeActivity({ commands: [...a.commands, ...b.commands], fileSeeds: files }, { maxItems });
      lens.parseBlockFace(snap.blocks[0]);
      lens.matchChildEntry(snap.catalog, '子会话');
      acc += sum.commandCount + roots.length;
    }
    return acc;
  }

  for (let round = 0; round < ROUNDS; round++) {
    // 展开（maxItems=200 全量）与收起（maxItems=5）交替
    totalCommands += runRound(round % 2 === 0 ? 200 : 5);
    if (round % 10 === 0) {
      if (global.gc) global.gc();
      samples.push(heapMB());
    }
  }
  const first = samples.slice(0, 10);
  const last = samples.slice(-10);
  const slope = (last.reduce((x, y) => x + y, 0) / last.length) - (first.reduce((x, y) => x + y, 0) / first.length);
  console.log('[ta13-subagent-lens] heap 首', first[0].toFixed(1), 'MB 末', last[last.length - 1].toFixed(1),
    'MB 斜率', slope.toFixed(1), 'MB（阈值', HEAP_SLOPE_LIMIT_MB, 'MB）总命令计数', totalCommands, '采样', samples.map((v) => v.toFixed(1)));
  assert.ok(totalCommands > 0, '重放应产生非零活动计数');
  assert.ok(slope < HEAP_SLOPE_LIMIT_MB, `堆斜率 ${slope.toFixed(1)} MB 应 < ${HEAP_SLOPE_LIMIT_MB} MB`);
});
