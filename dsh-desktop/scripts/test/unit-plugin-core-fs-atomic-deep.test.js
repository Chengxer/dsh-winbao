'use strict';

// plugin-core fs-atomic 深测：原子写（字节级往返/缺失目录/目录目标/只读目标/并发）、
// 陈旧 tmp 清扫、writeJsonAtomic、backupFile 轮转、WriteGate 获取/释放/互斥/抢占/
// 心跳/重入、safeLockKey、sharedWriteGate、pidAlive。全部临时目录注入。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeFileAtomic,
  writeJsonAtomic,
  backupFile,
  pidAlive,
  WriteGate,
  sharedWriteGate,
} = require('../plugin-core/lib/fs-atomic');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fsa-deep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── 1. writeFileAtomic ───────────────────────────────────────────────────────

test('fs-atomic: writeFileAtomic 字节级往返（CRLF/LF/混合/无尾换行/二进制）', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'x.txt');
  const cases = [
    'a\r\nb\r\nc\r\n',
    'a\nb\nc\n',
    'a\r\nb\nc\r\nd\n',
    'no trailing newline',
  ];
  for (const content of cases) {
    writeFileAtomic(file, content);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  const buf = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff, 0x0a, 0x00]);
  writeFileAtomic(file, buf);
  assert.deepEqual(fs.readFileSync(file), buf, '二进制字节级一致');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

test('fs-atomic: writeFileAtomic 目标目录缺失 → 抛错且不创建目录', (t) => {
  const dir = tmp(t);
  const missing = path.join(dir, 'not-here');
  assert.throws(() => writeFileAtomic(path.join(missing, 'x.txt'), 'data'));
  assert.ok(!fs.existsSync(missing), '不隐式创建目录');
});

test('fs-atomic: writeFileAtomic 目标是目录 → 抛错且无 tmp 残留', (t) => {
  const dir = tmp(t);
  const target = path.join(dir, 'adir');
  fs.mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, 'data'));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

test('fs-atomic: writeFileAtomic 只读目标 → 重试后抛错、原内容完好、无 tmp',
  { skip: process.platform !== 'win32' && '只读目标阻断 rename 仅 Windows 成立' },
  (t) => {
    const dir = tmp(t);
    const file = path.join(dir, 'x.txt');
    fs.writeFileSync(file, 'original');
    fs.chmodSync(file, 0o444);
    try {
      assert.throws(() => writeFileAtomic(file, 'replacement'));
      assert.equal(fs.readFileSync(file, 'utf8'), 'original', '失败时原文件完好');
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], '无 tmp 残留');
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });

test('fs-atomic: writeFileAtomic 20 并发写者 → 最终内容恰为其中一个输入（无交错）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'x.txt');
  const inputs = Array.from({ length: 20 }, (_, i) => 'writer-' + i + '-' + 'x'.repeat(50 + i));
  await Promise.all(inputs.map((c) => writeFileAtomic(file, c)));
  const finalContent = fs.readFileSync(file, 'utf8');
  assert.ok(inputs.includes(finalContent), '最终内容恰为某一完整输入，无交错');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

// ── 2. sweep ─────────────────────────────────────────────────────────────────

test('fs-atomic: 清扫陈旧 tmp（>1h）且保留新鲜 tmp（<1h）', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'x.json');
  const stale = file + '.tmp-99999-abc';
  fs.writeFileSync(stale, 'junk');
  const oldTime = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, oldTime, oldTime);

  const fresh = file + '.tmp-88888-def';
  fs.writeFileSync(fresh, 'fresh');

  writeFileAtomic(file, '{"v":2}');
  assert.ok(!fs.existsSync(stale), '陈旧 tmp 被清除');
  assert.ok(fs.existsSync(fresh), '新鲜 tmp 保留');
});

// ── 3. writeJsonAtomic ───────────────────────────────────────────────────────

test('fs-atomic: writeJsonAtomic 创建父目录 + 尾换行 + CRLF 字符串字节级保留', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a', 'b', 'x.json');
  writeJsonAtomic(file, { crlf: 'a\r\nb' });
  assert.ok(fs.existsSync(path.dirname(file)), '父目录已创建');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.endsWith('\n'), '尾换行');
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed, { crlf: 'a\r\nb' });
  assert.equal(parsed.crlf, 'a\r\nb', '字符串内的 CRLF 字节级保留');
});

// ── 4. backupFile ────────────────────────────────────────────────────────────

test('fs-atomic: backupFile 缺失源→null、字节一致、轮转保留 5、不同基名不动、同 ms 碰撞钉现状', async (t) => {
  // 4a. 缺失源 → null。
  {
    const dir = tmp(t);
    assert.equal(backupFile(path.join(dir, 'missing.json')), null);
  }

  // 4b. 字节一致。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, 'orig bytes \r\n');
    const backup = backupFile(file, { keep: 5 });
    assert.ok(backup);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'orig bytes \r\n', '备份字节与原始一致');
  }

  // 4c. 轮转保留最近 5 份（创建 8 份 → 剩 5 份，最旧 3 份被删，最新保留）。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, 'v0');
    const created = [];
    for (let i = 1; i <= 8; i += 1) {
      fs.writeFileSync(file, 'v' + i);
      created.push(backupFile(file, { keep: 5 }));
      await new Promise((r) => setTimeout(r, 3)); // 保证时间戳唯一
    }
    const backups = fs.readdirSync(dir).filter((n) => /^package\.json\.bak-\d+-\d+$/.test(n));
    assert.equal(backups.length, 5, '仅保留最近 5 份');
    const tsOf = (name) => Number(/\.bak-(\d+)-/.exec(name)[1]);
    const createdTs = created.map((p) => tsOf(path.basename(p)));
    const remainingTs = backups.map(tsOf);
    assert.deepEqual(remainingTs.slice().sort((a, b) => a - b),
      createdTs.slice().sort((a, b) => a - b).slice(-5), '保留的是最新 5 份，最旧 3 份已删');
  }

  // 4d. 不同基名 / 非匹配后缀的兄弟文件不受影响。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, 'v0');
    fs.writeFileSync(file + '.bak-123-foo', 'other'); // 后缀非数字 → 不匹配轮转
    fs.writeFileSync(path.join(dir, 'other.json.bak-111-222'), 'other2'); // 基名不同
    backupFile(file, { keep: 2 });
    assert.ok(fs.existsSync(file + '.bak-123-foo'), '非匹配后缀不动');
    assert.ok(fs.existsSync(path.join(dir, 'other.json.bak-111-222')), '不同基名不动');
  }

  // 4e. 同毫秒同 pid 边界：第二次调用仍成功产生备份（名称 = 文件 + .bak-<ts>-<pid>）。
  // 现状钉住：快速两次调用间 Date.now() 可能前进若干 ms（同步 fs 操作间时间流逝）产生
  // 2 份；若恰落在同一 ms 则同名碰撞覆盖为 1 份。无论哪种，均至少保留 1 份、绝不为 0。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, 'v0');
    const b1 = backupFile(file, { keep: 5 });
    const b2 = backupFile(file, { keep: 5 });
    assert.ok(b1 && b2, '两次调用均返回备份路径');
    assert.ok(fs.existsSync(b1));
    assert.ok(fs.existsSync(b2));
    assert.match(path.basename(b1), /^package\.json\.bak-\d+-\d+$/);
    assert.match(path.basename(b2), /^package\.json\.bak-\d+-\d+$/);
    const count = fs.readdirSync(dir).filter((n) => /^package\.json\.bak-\d+-\d+$/.test(n)).length;
    assert.ok(count >= 1 && count <= 2, '两次调用后至少 1 份备份（同 ms 碰撞为 1，否则为 2）');
  }
});

// ── 5. WriteGate acquire/release ─────────────────────────────────────────────

test('fs-atomic: WriteGate acquire 建锁{pid,at,token}、release 删除、外 token 不删、字符串路径兼容', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gate = new WriteGate({ lockDir });

  // 基本 acquire。
  const held = await gate.acquire('k');
  assert.ok(fs.existsSync(held.file));
  const content = JSON.parse(fs.readFileSync(held.file, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.equal(typeof content.at, 'number');
  assert.equal(typeof content.token, 'string');
  assert.ok(content.token.length > 0);

  // release 删除。
  gate.release(held);
  assert.ok(!fs.existsSync(held.file));

  // 外 token：改写锁内容后 release 不得删除。
  const held2 = await gate.acquire('k2');
  fs.writeFileSync(held2.file, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'foreign' }));
  gate.release(held2);
  assert.ok(fs.existsSync(held2.file), 'token 不匹配不得删除新持有者锁');
  fs.rmSync(held2.file, { force: true });

  // 旧式字符串路径 release 仍删除。
  const held3 = await gate.acquire('k3');
  gate.release(held3.file);
  assert.ok(!fs.existsSync(held3.file));
});

// ── 6. 互斥 ─────────────────────────────────────────────────────────────────

test('fs-atomic: WriteGate 互斥——持有超时 PLUGIN_BUSY，释放后重试成功', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gateA = new WriteGate({ lockDir, staleMs: 60000, timeoutMs: 5000, retryMs: 10 });
  const gateB = new WriteGate({ lockDir, staleMs: 60000, timeoutMs: 300, retryMs: 10 });

  let release;
  const hold = gateA.run('k', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 80)); // 确保 A 已持锁
  await assert.rejects(gateB.run('k', async () => {}), (err) => err.code === 'PLUGIN_BUSY');
  release();
  await hold;

  let ran = false;
  await gateB.run('k', async () => { ran = true; });
  assert.ok(ran, 'A 释放后 B 重试成功');
});

// ── 7. 陈旧抢占 ──────────────────────────────────────────────────────────────

test('fs-atomic: WriteGate 陈旧抢占——死 pid 与按锁龄均可抢占', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gate = new WriteGate({ lockDir, staleMs: 30000, retryMs: 10, timeoutMs: 5000 });
  fs.mkdirSync(lockDir, { recursive: true });

  // 死 pid。
  const deadFile = gate.lockFileOf('dead');
  fs.writeFileSync(deadFile, JSON.stringify({ pid: 99999999, at: Date.now(), token: 'x' }));
  const heldDead = await gate.acquire('dead');
  assert.ok(fs.existsSync(heldDead.file));
  gate.release(heldDead);

  // 按锁龄（持有者 pid 存活但 mtime 2h 前）→ 抢占并换新 token。
  const agedFile = gate.lockFileOf('aged');
  fs.writeFileSync(agedFile, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'x' }));
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(agedFile, old, old);
  const heldAged = await gate.acquire('aged');
  const agedContent = JSON.parse(fs.readFileSync(heldAged.file, 'utf8'));
  assert.equal(agedContent.pid, process.pid);
  assert.notEqual(agedContent.token, 'x', '按锁龄抢占后写入新 token');
  gate.release(heldAged);
});

// ── 8. 心跳 ──────────────────────────────────────────────────────────────────

test('fs-atomic: WriteGate 心跳保持锁新鲜——长时间持有不被按龄抢占', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gateA = new WriteGate({ lockDir, staleMs: 500, retryMs: 20, timeoutMs: 10000 });
  const gateB = new WriteGate({ lockDir, staleMs: 500, retryMs: 20, timeoutMs: 2200 });

  let release;
  const hold = gateA.run('k', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 100)); // A 已持锁

  const bResult = gateB.run('k', async () => {}).then(() => null, (err) => err);
  // A 持有超过 3*staleMs（1500ms），B 在 2200ms 内应超时而非抢占（心跳保活）。
  await new Promise((r) => setTimeout(r, 2500));
  release();
  await hold;

  const err = await bResult;
  assert.ok(err && err.code === 'PLUGIN_BUSY', '心跳保活 → B 超时而非按龄抢占');

  let ran = false;
  await gateB.run('k', async () => { ran = true; });
  assert.ok(ran, 'A 释放后 B 成功获取');
});

// ── 9. 重入 ──────────────────────────────────────────────────────────────────

test('fs-atomic: WriteGate 同键重入 PLUGIN_BUSY、异键嵌套可用、同键并发串行', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gate = new WriteGate({ lockDir });

  // 同键重入（同异步链）→ PLUGIN_BUSY，不死锁。
  await assert.rejects(
    gate.run('k', () => gate.run('k', async () => {})),
    (err) => err.code === 'PLUGIN_BUSY'
  );

  // 异键嵌套重入 → 正常完成。
  let innerRan = false;
  await gate.run('a', () => gate.run('b', async () => { innerRan = true; }));
  assert.ok(innerRan, '异键嵌套可用');

  // 同键不同异步链并发 → 串行，顺序保持。
  const order = [];
  await Promise.all([
    gate.run('s', async () => { order.push('x1'); await new Promise((r) => setTimeout(r, 30)); order.push('x2'); }),
    gate.run('s', async () => { order.push('y1'); await new Promise((r) => setTimeout(r, 10)); order.push('y2'); }),
  ]);
  assert.deepEqual(order, ['x1', 'x2', 'y1', 'y2'], '同键并发串行且顺序保持');
});

// ── 10. safeLockKey ──────────────────────────────────────────────────────────

test('fs-atomic: safeLockKey 非法字符转下划线（经 lockFileOf 观察）', (t) => {
  const dir = tmp(t);
  const gate = new WriteGate({ lockDir: path.join(dir, 'locks') });
  assert.equal(gate.lockFileOf('a/b: c'), path.join(dir, 'locks', 'a_b__c.lock'));
  assert.equal(gate.lockFileOf('ok.name-x_1'), path.join(dir, 'locks', 'ok.name-x_1.lock'));
});

// ── 11. sharedWriteGate ──────────────────────────────────────────────────────

test('fs-atomic: sharedWriteGate 同目录同实例、异目录异实例', (t) => {
  const dirA = tmp(t);
  const dirB = tmp(t);
  const g1 = sharedWriteGate(dirA);
  const g2 = sharedWriteGate(dirA);
  const g3 = sharedWriteGate(dirB);
  assert.strictEqual(g1, g2, '同目录 → 同实例');
  assert.notStrictEqual(g1, g3, '异目录 → 异实例');
  assert.equal(g1.lockDir, path.join(dirA, '.dsh-locks'));
});

// ── 12. pidAlive ─────────────────────────────────────────────────────────────

test('fs-atomic: pidAlive 0/-1 false、自身 pid true', () => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(process.pid), true);
});
