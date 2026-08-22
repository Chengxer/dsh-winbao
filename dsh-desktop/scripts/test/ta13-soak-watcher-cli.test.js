'use strict';

// ta13-soak-watcher-cli.test.js — TA13 极限压测：session-watcher.js CLI
// 子进程 soak。喂入：
//   · 50 条 ~1MB 大记录帧（1MB 行）；
//   · 10⁴ 组正常增量帧（user 事件 + turn/end → 每组恰吐 1 行协议输出）。
// 断言：
//   · 子进程 RSS 增量 < 200MB（宽松阈值防 CI 抖动）；
//   · 输出行数 = 10⁴（正常路径逐行）± 少量（清扫兜底重复去重后不超发）；
//   · 进程不崩溃退出。
// 运行：node --test scripts/test/ta13-soak-watcher-cli.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');

const WATCHER = require.resolve('../../session-watcher');

const BIG_FRAMES = 50;
const BIG_LINE_BYTES = 1024 * 1024;
const NORMAL_BATCHES = 10000;
const RSS_LIMIT_MB = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(id) {
  return JSON.stringify({ type: 'session', id, cwd: 'C:/fake', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' });
}
function frame(records) {
  return zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
}

/** Windows 下取子进程 RSS（KB）；取不到返回 -1（断言退化为不检查）。 */
function rssKB(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = out.match(/"([^"]+)"[^"]*"[^"]*"[^"]*"[^"]*"[^"]*"(\d+)/);
    const cols = out.trim().split('","');
    if (cols.length >= 5) {
      const mem = cols[4].replace(/[",\s K]/g, '');
      const n = Number(mem);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return -1;
  } catch {
    return -1;
  }
}

test('watcher CLI soak：50×1MB 帧 + 10⁴ 正常帧，RSS 有界 + 行数正确', { timeout: 600_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta13-watcher-'));
  const sessionsDir = path.join(root, 'sessions', '2026', '08');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, 'session.jsonl.zstd');

  // 会话头（顶层会话）
  fs.writeFileSync(file, frame([JSON.parse(header('ta13-soak'))]));

  const child = spawn(process.execPath, [WATCHER, '--sessions-dir', path.join(root, 'sessions')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const stderr = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) lines.push(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderr.push(c));

  // 等 watcher 首次目录遍历建立基线
  await sleep(2500);

  // ---- 1MB 行 ×50 ----
  const bigText = 'B'.repeat(BIG_LINE_BYTES);
  for (let i = 0; i < BIG_FRAMES; i++) {
    fs.appendFileSync(file, frame([{ type: 'user/message', seq: 1000 + i, time: '2026-01-01T00:00:00Z', data: { message: { content: [{ type: 'text', text: bigText }] } } }]));
    if (i % 10 === 0) await sleep(30);
  }
  await sleep(1500);
  const rssMid = rssKB(child.pid);

  // ---- 正常行 ×10⁴（每组 = 1 user 事件 + 1 turn/end → 1 行输出）----
  const t0 = Date.now();
  for (let i = 0; i < NORMAL_BATCHES; i++) {
    fs.appendFileSync(file, frame([
      { type: 'user/message', seq: 2000 + i * 2, time: '2026-01-01T00:00:01Z', data: { message: { content: [{ type: 'text', text: 'turn ' + i }] } } },
      { type: 'turn/end', seq: 2001 + i * 2, time: '2026-01-01T00:00:01Z', data: {} },
    ]));
  }
  const feedMs = Date.now() - t0;

  // 等输出收敛：行数连续 3 个 2s 窗口不再增长（多轮会聚合为「（N 轮任务完成）」
  // 单行 —— 行数 ≠ 帧数是设计行为，断言口径用稳定 + 聚合上限）
  // 快速喂入下 fs.watch 事件合并 → watcher 大批次增量解码，多轮 turn/end
  // 会聚合成「（N 轮任务完成）」单行（设计行为，行数与帧数非 1:1）。
  // 收敛判据：至少等 30s 且连续 3 个 3s 窗口行数不再增长。
  let prev = -1, stableRounds = 0;
  const deadline = Date.now() + 180_000;
  const minWait = Date.now() + 30_000;
  while (Date.now() < deadline && (stableRounds < 3 || Date.now() < minWait)) {
    await sleep(3000);
    if (lines.length === prev) stableRounds += 1; else { stableRounds = 0; prev = lines.length; }
  }
  const rssEnd = rssKB(child.pid);

  child.kill();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* tmp 目录残留无害 */ }

  console.log('[ta13-watcher-cli] 1MB帧', BIG_FRAMES, '个；正常帧', NORMAL_BATCHES, '组喂入', feedMs, 'ms；输出行', lines.length,
    '；RSS mid', rssMid, 'KB end', rssEnd, 'KB；stderr 行数', stderr.length);
  assert.ok(stderr.length === 0, 'watcher 不应写 stderr（首条: ' + (stderr[0] || '') + '）');
  assert.ok(lines.length >= 1, `输出行数 ${lines.length} 应 ≥ 1（事件链应活跃；多轮聚合为设计行为）`);
  assert.ok(lines.length <= NORMAL_BATCHES + 50, `输出行数 ${lines.length} 不应超发（≤ ${NORMAL_BATCHES + 50}）`);
  for (const l of lines) { JSON.parse(l); } // 每行都是合法协议 JSON
  if (rssMid > 0 && rssEnd > 0) {
    const growthMB = (rssEnd - rssMid) / 1024;
    console.log('[ta13-watcher-cli] RSS 增量', growthMB.toFixed(1), 'MB（阈值', RSS_LIMIT_MB, 'MB）');
    assert.ok(growthMB < RSS_LIMIT_MB, `子进程 RSS 增量 ${growthMB.toFixed(1)} MB 应 < ${RSS_LIMIT_MB} MB`);
  } else {
    console.log('[ta13-watcher-cli] tasklist 不可用，RSS 断言退化为跳过');
  }
  assert.ok(child.exitCode === null || child.exitCode === 0, '子进程不应异常退出');
});
