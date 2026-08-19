'use strict';

// plugin-core 基础层单测：ids（全局唯一 id 税）/ text（EOL 保持）/ fs-atomic
// （原子写 + WriteGate 跨进程互斥）/ state-store（v2 schema + 迁移 + 损坏恢复）。
// 全部临时目录注入，绝不触碰真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LOADER_ID_RE, PACKAGE_NAME_RE, isLoaderId, isPackageName, assertLoaderId, packageDirName } = require('../plugin-core/lib/ids');
const { escRegExp, detectEol, preserveEol, yamlQuote } = require('../plugin-core/lib/text');
const { writeFileAtomic, backupFile, WriteGate, sharedWriteGate } = require('../plugin-core/lib/fs-atomic');
const { PluginStateStore, STATE_VERSION } = require('../plugin-core/lib/state-store');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-basic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── ids ─────────────────────────────────────────────────────────────────────

test('ids: loader id 统一字符集（含点号，点号 id 插件可写可愈）', () => {
  assert.ok(LOADER_ID_RE.test('balance'));
  assert.ok(LOADER_ID_RE.test('my.plugin'));
  assert.ok(LOADER_ID_RE.test('compaction-acp'));
  assert.ok(LOADER_ID_RE.test('x.y-z_1'));
  assert.ok(!LOADER_ID_RE.test('.leading-dot'));
  assert.ok(!LOADER_ID_RE.test('-leading-dash'));
  assert.ok(!LOADER_ID_RE.test('has space'));
  assert.ok(!LOADER_ID_RE.test('quote"id'));
  assert.ok(isLoaderId('a.b-c_1'));
  assert.ok(!isLoaderId(''));
  assert.throws(() => assertLoaderId('bad id'), /非法字符/);
  assert.equal(assertLoaderId('ok.id'), 'ok.id');
});

test('ids: 包名白名单与历史 pluginManagerPackageDir 同构', () => {
  assert.ok(isPackageName('dsh-better-sidebar'));
  assert.ok(isPackageName('@scope/pkg'));
  assert.ok(isPackageName('@deepseek-ai/dsh-balance'));
  assert.ok(isPackageName('pkg.v2_x'));
  assert.ok(!isPackageName('../evil'));
  assert.ok(!isPackageName('a/b/c'));
  assert.equal(packageDirName('@scope/pkg'), 'pkg');
  assert.equal(packageDirName('plain'), 'plain');
});

// ── text ────────────────────────────────────────────────────────────────────

test('text: escRegExp 转义全部元字符', () => {
  assert.equal(escRegExp('a.b'), 'a\\.b');
  assert.equal(escRegExp('a+b(c)'), 'a\\+b\\(c\\)');
});

test('text: detectEol / preserveEol 保持 CRLF 与 LF', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  const crlf = 'a\r\nb\r\n';
  assert.equal(preserveEol(crlf, 'x\ny\n'), 'x\r\ny\r\n');
  assert.equal(preserveEol('a\nb', 'x\r\ny'), 'x\ny');
});

test('text: yamlQuote 单引号加倍', () => {
  assert.equal(yamlQuote("it's"), "'it''s'");
});

// ── fs-atomic ───────────────────────────────────────────────────────────────

test('fs-atomic: 原子写 + 内容正确 + 无临时残留', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'x.json');
  writeFileAtomic(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  writeFileAtomic(file, '{"a":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('fs-atomic: backupFile 保留最近 N 份（时间戳 + pid 不碰撞）', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, 'v0');
  for (let i = 1; i <= 7; i += 1) {
    fs.writeFileSync(file, 'v' + i);
    backupFile(file, { keep: 3 });
  }
  const backups = fs.readdirSync(dir).filter((n) => /^package\.json\.bak-\d+-\d+$/.test(n));
  assert.equal(backups.length, 3, '只保留最近 3 份备份');
});

test('fs-atomic: WriteGate 同 key 串行 + 跨实例互斥（死 pid 可抢占）', async (t) => {
  const dir = tmp(t);
  const gate = new WriteGate({ lockDir: path.join(dir, 'locks'), staleMs: 1000, retryMs: 10 });
  const order = [];
  await Promise.all([
    gate.run('k', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 50)); order.push('a2'); }),
    gate.run('k', async () => { order.push('b1'); await new Promise((r) => setTimeout(r, 20)); order.push('b2'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2'], '同 key 串行');

  // 死 pid 抢占：写入一个持有者 pid=999999 的锁文件，应能立即获取。
  const staleFile = gate.lockFileOf('dead');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, JSON.stringify({ pid: 99999999, at: Date.now() }));
  const started = Date.now();
  await gate.run('dead', async () => { assert.ok(true); });
  assert.ok(Date.now() - started < 3000, '死锁持有者可被立即抢占');
});

test('fs-atomic: WriteGate 活持有者超时抛 PLUGIN_BUSY', async (t) => {
  const dir = tmp(t);
  const gate = new WriteGate({ lockDir: path.join(dir, 'locks'), timeoutMs: 200, staleMs: 60000, retryMs: 20 });
  const other = new WriteGate({ lockDir: path.join(dir, 'locks'), timeoutMs: 200, staleMs: 60000, retryMs: 20 });
  let release;
  const hold = other.run('k', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 80)); // 确保 other 已持锁
  await assert.rejects(gate.run('k', async () => {}), (err) => err.code === 'PLUGIN_BUSY');
  release();
  await hold;
});

test('fs-atomic: WriteGate token 所有权——被抢占后不删新持有者的锁', async (t) => {
  const dir = tmp(t);
  const lockDir = path.join(dir, 'locks');
  const gateA = new WriteGate({ lockDir, staleMs: 60000, timeoutMs: 5000, retryMs: 10 });
  // 直接构造「B 持锁」场景：先让 A 获取锁，再手工模拟 B 抢占（A 的 token 失效）。
  const held = await gateA.acquire('k');
  assert.ok(fs.existsSync(held.file));
  // 模拟另一进程抢占：写入新 token（A 的 release 不得删除它）。
  fs.writeFileSync(held.file, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'new-owner-token' }));
  gateA.release(held);
  assert.ok(fs.existsSync(held.file), 'token 不匹配时不得删除新持有者的锁');
  assert.equal(JSON.parse(fs.readFileSync(held.file, 'utf8')).token, 'new-owner-token');
  // A 自己的锁正常释放（token 匹配才删除）。
  const held2 = await gateA.acquire('k2');
  gateA.release(held2);
  assert.ok(!fs.existsSync(held2.file));
});

// ── state-store ─────────────────────────────────────────────────────────────

test('state-store: 缺失文件 → 空状态；mark/clear 卸载与隔离决策', async (t) => {
  const dir = tmp(t);
  const store = new PluginStateStore({ file: path.join(dir, 'desktop-plugin-state.json') });
  assert.deepEqual(store.getUninstalled(), {});
  assert.deepEqual(store.getQuarantined(), {});
  await store.markUninstalled('better-sidebar', 'dsh-better-sidebar');
  await store.markQuarantined('evil-plugin', 'evil-plugin', 'runtime', '持续异常');
  assert.ok(store.isUninstalled('better-sidebar'));
  assert.ok(store.isQuarantined('evil-plugin'));
  const reloaded = new PluginStateStore({ file: path.join(dir, 'desktop-plugin-state.json') });
  assert.ok(reloaded.isUninstalled('better-sidebar'));
  assert.ok(reloaded.isQuarantined('evil-plugin'));
  assert.equal(reloaded.getQuarantined()['evil-plugin'].reason, '持续异常');
  await reloaded.clearUninstalled('better-sidebar');
  await reloaded.clearQuarantined('evil-plugin');
  assert.ok(!reloaded.isUninstalled('better-sidebar'));
  assert.ok(!reloaded.isQuarantined('evil-plugin'));
});

test('state-store: v1 原位迁移到 v2（uninstalled 保留，quarantine 为空）', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, uninstalled: { old: { name: 'old-pkg', at: 'x', source: 'ui' } } }));
  const store = new PluginStateStore({ file });
  assert.ok(store.isUninstalled('old'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, STATE_VERSION);
  assert.deepEqual(store.getQuarantined(), {});
});

test('state-store: 损坏 → 备份重建空状态，绝不抛错阻塞启动', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  fs.writeFileSync(file, '{broken json');
  const logs = [];
  const store = new PluginStateStore({ file, log: (m) => logs.push(m) });
  assert.deepEqual(store.getUninstalled(), {});
  assert.ok(logs.some((m) => m.includes('损坏')));
  const backups = fs.readdirSync(dir).filter((n) => n.includes('.broken-'));
  assert.equal(backups.length, 1);
});

test('state-store: 非法条目被净化（非法 id / 非法包名不进入状态）', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  fs.writeFileSync(file, JSON.stringify({
    v: 2,
    uninstalled: { 'bad id': { name: 'x', at: '', source: 'ui' }, good: { name: 'ok-pkg', at: '', source: 'ui' } },
    quarantine: { 'ok.q': { name: '../evil', at: '', source: 'runtime' } },
  }));
  const store = new PluginStateStore({ file });
  assert.deepEqual(Object.keys(store.getUninstalled()), ['good']);
  assert.equal(store.getQuarantined()['ok.q'].name, '', '非法包名置空');
});
