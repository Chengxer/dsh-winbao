'use strict';

// ta4-synapse-lock-stale.test.js — TA4 回归锁定（synapse 锁「pid 活不偷锁」修复的边界补锁）。
//
// 修复背景（S2 睡眠唤醒偷锁）：A 实例持锁写入时合盖 > LOCK_STALE_MS（60s），
// 墙钟 mtime 照走，B 实例唤醒后按龄把活锁判成陈锁偷走 → 双写互覆画布。
// 修复后 lockIsStale：pid 存活 → 一律不 stale；陈龄只用于 pid 不可解析的孤儿锁。
//
// 本文件补两组负面/反向用例（断言现状并标注）：
//   1. 【已知限制】pid 复用：锁持有者已死但 pid 被无关进程复用（mtime>24h）
//      → 当前行为仍不偷锁（孤儿锁永不清回收）；
//   2. 【反向用例】EPERM：pid 活着但本进程无权 signal（多用户 Windows），
//      process.kill 抛 EPERM → 当前 catch 一律判 stale → 活锁被偷。
//      现状断言 + 标注（语义上 EPERM ≠ 进程不存在，EPERM 应视为「活着」）。
// 运行：node --test scripts/test/ta4-synapse-lock-stale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const INDEX = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-synapse', 'index.js');

async function loadStore() {
  const mod = await import(pathToFileURL(INDEX).href);
  return mod.WorkspaceStore;
}

function tmpDataFile(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ta4-syn-${tag}-`));
  // WorkspaceStore 构造会调度防抖落盘（SAVE_DEBOUNCE_MS=800ms）——清理须
  // 等落盘结束后再删，否则未写完的 tmp 文件触发 ENOTEMPTY/unhandledRejection。
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  });
  return path.join(root, 'workspaces.json');
}

function writeLock(dataFile, content, mtimeAgoMs) {
  const lock = `${dataFile}.lock`;
  fs.writeFileSync(lock, content);
  const at = new Date(Date.now() - mtimeAgoMs);
  fs.utimesSync(lock, at, at);
  return lock;
}

/** 存活子进程（测试结束回收）。 */
function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600e3)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

test('pid 活（真实子进程）且 mtime 超 24h → 不偷锁（S2 修复主行为）', async (t) => {
  const Store = await loadStore();
  const dataFile = tmpDataFile(t, 'live-old');
  writeLock(dataFile, `${liveChild(t)}\n`, 25 * 3600e3);
  const store = new Store(dataFile);
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), false, 'pid 活即不 stale，龄不参与（S2）');
});

test('【已知限制】pid 复用：持有者已死但 pid 被复用 + mtime>24h → 现状仍不偷锁', async (t) => {
  const Store = await loadStore();
  const dataFile = tmpDataFile(t, 'pid-reuse');
  // 复用形态：锁内容是一个活 pid（此处用本测试子进程模拟复用者），但 mtime
  // 远超任何合法持锁窗口（25h）——真持有者必死，pid 只是复用。
  writeLock(dataFile, `${liveChild(t)}\n`, 25 * 3600e3);
  const store = new Store(dataFile);
  // 现状断言：lockIsStale 仅凭 pid 存活判「不 stale」——孤儿锁不回收。
  // 已知限制记录：理想行为需结合 mtime 上限（如 >24h 时二次校验进程启动时刻）。
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), false, '现状：pid 复用时孤儿锁不被回收（已知限制，记录勿修）');
});

test('【反向用例】EPERM：活 pid 无权 signal → 现状 catch 判 stale（活锁被偷，记录勿修）', async (t) => {
  const Store = await loadStore();
  const dataFile = tmpDataFile(t, 'eperm');
  writeLock(dataFile, `${liveChild(t)}\n`, 1000); // 活锁、新鲜 mtime
  const store = new Store(dataFile);

  const origKill = process.kill;
  process.kill = (pid, sig) => {
    const e = new Error(`operation not permitted, kill ${pid} ${sig}`);
    e.code = 'EPERM';
    throw e;
  };
  t.after(() => { process.kill = origKill; });
  try {
    // 已修（TA4 #2）：EPERM/EACCES = 持有者存活但无权 signal → 不偷锁。
    assert.equal(await store.lockIsStale(`${dataFile}.lock`), false, '已修：EPERM 视为持有者存活（不偷活锁）');
  } finally {
    process.kill = origKill;
  }
});

test('ESRCH（进程确死）→ stale；孤儿锁（pid 不可解析）按龄判定', async (t) => {
  const Store = await loadStore();
  const dataFile = tmpDataFile(t, 'dead');
  // 死 pid：先起子进程拿 pid，等其退出。
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  writeLock(dataFile, `${child.pid}\n`, 5 * 60e3);
  const store = new Store(dataFile);
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), true, '持有者已死 → 陈锁');

  // 孤儿锁：内容不可解析。新鲜 → 不 stale；超 LOCK_STALE_MS(60s) → stale。
  writeLock(dataFile, 'not-a-pid\n', 10e3);
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), false, '孤儿锁龄内不回收');
  writeLock(dataFile, 'not-a-pid\n', 2 * 60e3);
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), true, '孤儿锁超龄回收');

  // 自身 pid 持锁 → 永不 stale。
  writeLock(dataFile, `${process.pid}\n`, 25 * 3600e3);
  assert.equal(await store.lockIsStale(`${dataFile}.lock`), false, '自身 pid 不 stale');
});
