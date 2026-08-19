'use strict';

// plugin-core 状态存储（state-store）深测：写穿合并（跨进程删除复活修复）、
// tombstone、落盘失败回滚、只读模式、损坏处理、v1→v2 迁移、危险键、深拷贝、
// reason 截断、幂等、helper、锁目录位置。全部临时目录注入，绝不触碰真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PluginStateStore, createPluginStateStore, STATE_VERSION } = require('../plugin-core/lib/state-store');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-state-deep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const emptyV2 = () => JSON.stringify({ v: 2, uninstalled: {}, quarantine: {} });

// ── 1. 写穿合并（跨进程删除复活修复）────────────────────────────────────────

test('state-store: 写穿合并——不复活他进程删除、不丢他进程新增', async (t) => {
  // 场景 A：A 记 X → B 清 X → A 记 Y；重载后 X 不在、Y 在（陈旧快照不复活删除）。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'desktop-plugin-state.json');
    const A = new PluginStateStore({ file });
    await A.markUninstalled('X', 'pkg-x'); // 磁盘 {X}
    const B = new PluginStateStore({ file }); // B 读到 {X}
    await B.clearUninstalled('X'); // 磁盘 {}
    await A.markUninstalled('Y', 'pkg-y'); // A 陈旧快照仍含 X，写穿只叠加 dirty{Y}
    const reloaded = new PluginStateStore({ file });
    assert.ok(!reloaded.isUninstalled('X'), 'X 不得被陈旧快照复活');
    assert.ok(reloaded.isUninstalled('Y'), 'Y 应写入');
  }

  // 场景 B：A 记 X → B 记 Z → A 记 Y；重载后 X、Y、Z 全在（不丢他进程新增）。
  {
    const dir = tmp(t);
    const file = path.join(dir, 'desktop-plugin-state.json');
    const A = new PluginStateStore({ file });
    const B = new PluginStateStore({ file });
    await A.markUninstalled('X', 'pkg-x'); // 磁盘 {X}
    await B.markUninstalled('Z', 'pkg-z'); // B 快照无 X，写穿合并 → {X,Z}
    await A.markUninstalled('Y', 'pkg-y'); // A 快照 {X,Y}，写穿合并 → {X,Y,Z}
    const reloaded = new PluginStateStore({ file });
    assert.ok(reloaded.isUninstalled('X'), 'X 保留');
    assert.ok(reloaded.isUninstalled('Y'), 'Y 写入');
    assert.ok(reloaded.isUninstalled('Z'), 'Z 保留（不丢他进程新增）');
  }
});

// ── 2. pendingDeletes / tombstone ────────────────────────────────────────────

test('state-store: tombstone 被重新标记取消（clear 后 re-mark 仍持久化）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const store = new PluginStateStore({ file });
  await store.markUninstalled('X', 'pkg-x');
  assert.ok(store.isUninstalled('X'));

  // 同一拍内 clear（入队 tombstone）＋ re-mark（取消 tombstone）：写穿合并时
  // pendingDeletes 已空、dirty 含 X → X 不被删除，最终仍持久化。
  const [cleared, remarked] = await Promise.all([
    store.clearUninstalled('X'),
    store.markUninstalled('X', 'pkg-x'),
  ]);
  assert.equal(cleared, true);
  assert.equal(remarked, true);

  const reloaded = new PluginStateStore({ file });
  assert.ok(reloaded.isUninstalled('X'), 're-mark 取消 tombstone，X 仍持久化');
});

// ── 3. 落盘失败回滚 ──────────────────────────────────────────────────────────

test('state-store: 落盘失败回滚（mark/clear，恢复 prev 条目）',
  { skip: process.platform !== 'win32' && '只读目标行为仅在 Windows 上阻断 rename（POSIX rename 不受目标写位影响）' },
  async (t) => {
    // 3a. markUninstalled 新 id：失败返回 false、内存回滚、后续 save 不含失败 id。
    {
      const dir = tmp(t);
      const file = path.join(dir, 'desktop-plugin-state.json');
      fs.writeFileSync(file, emptyV2());
      const store = new PluginStateStore({ file });
      fs.chmodSync(file, 0o444);
      let ok;
      try { ok = await store.markUninstalled('X', 'pkg-x'); } finally { fs.chmodSync(file, 0o666); }
      assert.equal(ok, false);
      assert.equal(store.isUninstalled('X'), false, '失败 mark 回滚，内存不含 X');
      await store.markUninstalled('Y', 'pkg-y');
      const reloaded = new PluginStateStore({ file });
      assert.ok(!reloaded.isUninstalled('X'), '失败 id 不落盘');
      assert.ok(reloaded.isUninstalled('Y'));
    }

    // 3b. markQuarantined 已有 id：失败后恢复 prev 条目（reason 保持旧值）。
    {
      const dir = tmp(t);
      const file = path.join(dir, 'desktop-plugin-state.json');
      fs.writeFileSync(file, JSON.stringify({ v: 2, uninstalled: {}, quarantine: { Q: { name: 'pkg-q', at: 't0', source: 'runtime', reason: 'old' } } }));
      const store = new PluginStateStore({ file });
      fs.chmodSync(file, 0o444);
      let ok;
      try { ok = await store.markQuarantined('Q', 'pkg-q', 'runtime', 'new reason'); } finally { fs.chmodSync(file, 0o666); }
      assert.equal(ok, false);
      assert.equal(store.getQuarantined()['Q'].reason, 'old', 'prev quarantine 条目恢复');
    }

    // 3c. clearUninstalled：失败后恢复被删除的条目。
    {
      const dir = tmp(t);
      const file = path.join(dir, 'desktop-plugin-state.json');
      fs.writeFileSync(file, JSON.stringify({ v: 2, uninstalled: { X: { name: 'pkg-x', at: 't0', source: 'ui' } }, quarantine: {} }));
      const store = new PluginStateStore({ file });
      fs.chmodSync(file, 0o444);
      let ok;
      try { ok = await store.clearUninstalled('X'); } finally { fs.chmodSync(file, 0o666); }
      assert.equal(ok, false);
      assert.ok(store.isUninstalled('X'), 'clear 失败后条目恢复');
    }

    // 3d. clearQuarantined：失败后恢复被删除的条目。
    {
      const dir = tmp(t);
      const file = path.join(dir, 'desktop-plugin-state.json');
      fs.writeFileSync(file, JSON.stringify({ v: 2, uninstalled: {}, quarantine: { Q: { name: 'pkg-q', at: 't0', source: 'runtime', reason: 'r' } } }));
      const store = new PluginStateStore({ file });
      fs.chmodSync(file, 0o444);
      let ok;
      try { ok = await store.clearQuarantined('Q'); } finally { fs.chmodSync(file, 0o666); }
      assert.equal(ok, false);
      assert.ok(store.isQuarantined('Q'), 'clear quarantine 失败后条目恢复');
    }
  });

// ── 4. gate 失败 → false 不抛 ────────────────────────────────────────────────

test('state-store: gate 拒绝时 save 解析为 false、不抛、内存保持未写状态', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const failingGate = { run: () => Promise.reject(new Error('lock dir unavailable')) };
  const store = new PluginStateStore({ file, gate: failingGate });
  const ok = await store.markUninstalled('X', 'pkg-x');
  assert.equal(ok, false, 'gate 失败 → save 返回 false');
  assert.equal(store.isUninstalled('X'), false, '失败 mark 后 isUninstalled 仍 false');
  assert.equal(store.isQuarantined('X'), false);
});

// ── 5. readOnly 模式 ─────────────────────────────────────────────────────────

test('state-store: readOnly 构造不写盘、save 返回 false 且不写', async (t) => {
  const dir = tmp(t);

  // 5a. v1 文件 + readOnly → 文件字节不变（内存仍迁移）。
  const v1File = path.join(dir, 'v1.json');
  const v1Raw = JSON.stringify({ v: 1, uninstalled: { old: { name: 'old-pkg', at: 'x', source: 'ui' } } });
  fs.writeFileSync(v1File, v1Raw);
  const s1 = new PluginStateStore({ file: v1File, readOnly: true });
  assert.equal(fs.readFileSync(v1File, 'utf8'), v1Raw, 'readOnly 构造不改变 v1 文件字节');
  assert.ok(s1.isUninstalled('old'), '内存仍完成 v1→v2 迁移');

  // 5b. 损坏文件 + readOnly → 不产生 .broken-* 备份。
  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{broken');
  const s2 = new PluginStateStore({ file: corruptFile, readOnly: true });
  assert.deepEqual(s2.getUninstalled(), {});
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.broken-')).length, 0, 'readOnly 不落盘备份');

  // 5c. save() → false 且不写盘。
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, emptyV2());
  const before = fs.readFileSync(stateFile, 'utf8');
  const s3 = new PluginStateStore({ file: stateFile, readOnly: true });
  const ok = await s3.markUninstalled('X', 'pkg-x');
  assert.equal(ok, false, 'readOnly save 返回 false');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'readOnly save 不写盘');
});

// ── 6. 损坏处理 ──────────────────────────────────────────────────────────────

test('state-store: 损坏 → 备份重建空状态；{"v":2} 无 uninstalled 非损坏（钉住现状）', (t) => {
  const dir = tmp(t);

  // 6a. 垃圾 JSON → 备份原始字节 + 空状态。
  const f1 = path.join(dir, 'a.json');
  fs.writeFileSync(f1, '{broken json');
  const s1 = new PluginStateStore({ file: f1 });
  assert.deepEqual(s1.getUninstalled(), {});
  const backups1 = fs.readdirSync(dir).filter((n) => n.startsWith('a.json.broken-'));
  assert.equal(backups1.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups1[0]), 'utf8'), '{broken json', '备份字节与原始一致');

  // 6b. {"v":99} → 视为损坏（备份）。
  const f2 = path.join(dir, 'b.json');
  fs.writeFileSync(f2, '{"v":99}');
  const s2 = new PluginStateStore({ file: f2 });
  assert.deepEqual(s2.getUninstalled(), {});
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('b.json.broken-')).length, 1);

  // 6c. [] 与 null → 视为损坏（备份）。
  for (const [name, content] of [['c.json', '[]'], ['d.json', 'null']]) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    const s = new PluginStateStore({ file: f });
    assert.deepEqual(s.getUninstalled(), {});
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(name + '.broken-')).length, 1);
  }

  // 6d. {"v":2} 无 uninstalled：现状为「非损坏」，返回空状态、不备份（钉住现状）。
  const f5 = path.join(dir, 'e.json');
  fs.writeFileSync(f5, '{"v":2}');
  const s5 = new PluginStateStore({ file: f5 });
  assert.deepEqual(s5.getUninstalled(), {});
  assert.deepEqual(s5.getQuarantined(), {});
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('e.json.broken-')).length, 0,
    '{"v":2} 无 uninstalled 现状视为合法空状态（不备份）');
});

// ── 7. v1→v2 迁移 ────────────────────────────────────────────────────────────

test('state-store: v1→v2 迁移——仅保留合法条目、非法包名置空、危险键丢弃', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const v1Raw = '{"v":1,"uninstalled":{' +
    '"valid":{"name":"ok-pkg","at":"t","source":"ui"},' +
    '"badname":{"name":"../evil","at":"t","source":"ui"},' +
    '"bad id":{"name":"x","at":"t","source":"ui"},' +
    '"__proto__":{"name":"proto-pkg","at":"t","source":"ui"}' +
    '}}';
  fs.writeFileSync(file, v1Raw);
  const store = new PluginStateStore({ file });
  assert.ok(store.isUninstalled('valid'));
  assert.ok(store.isUninstalled('badname'), '非法包名条目保留（name 置空）');
  assert.ok(!store.isUninstalled('bad id'), '非法 id 丢弃');
  assert.ok(!store.isUninstalled('__proto__'), '危险键丢弃');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.v, STATE_VERSION, '迁移后 v=2');
  assert.deepEqual(onDisk.quarantine, {}, '迁移后 quarantine 为空对象');
  assert.deepEqual(Object.keys(onDisk.uninstalled).sort(), ['badname', 'valid']);
  assert.equal(onDisk.uninstalled.badname.name, '', '非法包名 name 置空');
});

// ── 8. 危险键 ────────────────────────────────────────────────────────────────

test('state-store: __proto__ 等危险键——mark 返回 false、净化丢弃', async (t) => {
  const dir = tmp(t);

  // 8a. markUninstalled('__proto__') → false，不存储，后续 save 仍正常。
  const file = path.join(dir, 'state.json');
  const store = new PluginStateStore({ file });
  assert.equal(await store.markUninstalled('__proto__', 'proto-pkg'), false);
  assert.equal(await store.markQuarantined('constructor', 'c', 'runtime'), false);
  assert.equal(await store.markUninstalled('prototype', 'p'), false);
  assert.deepEqual(store.getUninstalled(), {});
  assert.deepEqual(store.getQuarantined(), {});
  assert.equal(await store.markUninstalled('ok', 'ok-pkg'), true, '危险键拒绝后 save 仍正常');
  const reloaded = new PluginStateStore({ file });
  assert.ok(reloaded.isUninstalled('ok'));
  assert.ok(!reloaded.isUninstalled('__proto__'));

  // 8b. 磁盘上的危险键被净化丢弃。
  const file2 = path.join(dir, 'disk.json');
  const raw = '{"v":2,"uninstalled":{' +
    '"__proto__":{"name":"a","at":"t","source":"ui"},' +
    '"constructor":{"name":"b","at":"t","source":"ui"},' +
    '"prototype":{"name":"c","at":"t","source":"ui"},' +
    '"good":{"name":"good-pkg","at":"t","source":"ui"}' +
    '},"quarantine":{}}';
  fs.writeFileSync(file2, raw);
  const s2 = new PluginStateStore({ file: file2 });
  assert.deepEqual(Object.keys(s2.getUninstalled()), ['good'], '__proto__/constructor/prototype 条目被丢弃');
});

// ── 9. 深拷贝 getter ─────────────────────────────────────────────────────────

test('state-store: getUninstalled/getQuarantined 深拷贝，改动返回值不影响存储', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const store = new PluginStateStore({ file });
  await store.markUninstalled('X', 'pkg-x');
  await store.markQuarantined('Q', 'pkg-q', 'runtime', 'r');

  const u = store.getUninstalled();
  u['X'].name = 'MUTATED';
  u['X'].at = 'MUTATED';
  u['X'].source = 'MUTATED';
  u['NEW'] = { name: 'leak', at: 'x', source: 'ui' };
  delete u['X'];
  assert.equal(store.getUninstalled()['X'].name, 'pkg-x', '深拷贝：字段改动不影响存储');
  assert.ok(store.isUninstalled('X'), '删除返回映射条目不影响存储');
  assert.ok(!store.isUninstalled('NEW'), '返回映射新增键不泄漏');

  const q = store.getQuarantined();
  q['Q'].reason = 'MUTATED';
  assert.equal(store.getQuarantined()['Q'].reason, 'r', '深拷贝：quarantine 字段改动不影响存储');
  assert.ok(store.isQuarantined('Q'));
});

// ── 10. reason 截断 ──────────────────────────────────────────────────────────

test('state-store: markQuarantined reason 截断到 ≤500 字符', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const store = new PluginStateStore({ file });
  await store.markQuarantined('Q', 'pkg-q', 'runtime', 'x'.repeat(1000));
  const reloaded = new PluginStateStore({ file });
  const reason = reloaded.getQuarantined()['Q'].reason;
  assert.equal(reason.length, 500, 'reason 截断到 500 字符');
});

// ── 11. 幂等性 ───────────────────────────────────────────────────────────────

test('state-store: mark 幂等（两次 true、时间戳更新）、clear 不存在返回 false', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const store = new PluginStateStore({ file });

  assert.equal(await store.markUninstalled('X', 'pkg-x'), true);
  const at1 = store.getUninstalled()['X'].at;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await store.markUninstalled('X', 'pkg-x'), true);
  const at2 = store.getUninstalled()['X'].at;
  assert.ok(at2 >= at1, '时间戳更新（ISO 字典序单调）');

  const reloaded = new PluginStateStore({ file });
  assert.ok(reloaded.isUninstalled('X'));
  assert.equal(reloaded.getUninstalled()['X'].at, at2, '持久化的是最新一次 mark 的条目');

  assert.equal(await store.clearUninstalled('absent-id'), false, 'clear 不存在返回 false');
});

// ── 12. createPluginStateStore helper 路径 ───────────────────────────────────

test('state-store: createPluginStateStore 按 homeDir 拼接状态文件路径', () => {
  const home = path.join(os.tmpdir(), 'fake-dsh-home-' + process.pid);
  const store = createPluginStateStore(home, { readOnly: true });
  assert.equal(store.file, path.join(home, 'desktop-plugin-state.json'));
  assert.equal(store.readOnly, true, 'opts 透传');
});

// ── 13. 锁目录位置 ───────────────────────────────────────────────────────────

test('state-store: 默认 gate 锁文件位于 <home>/.dsh-locks/（非嵌套）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'desktop-plugin-state.json');
  const store = new PluginStateStore({ file });

  assert.equal(store.gate.lockDir, path.join(dir, '.dsh-locks'));
  const held = await store.gate.acquire('desktop-plugin-state');
  assert.equal(held.file, path.join(dir, '.dsh-locks', 'desktop-plugin-state.lock'));
  store.gate.release(held);

  await store.markUninstalled('X', 'pkg-x');
  assert.ok(fs.existsSync(path.join(dir, '.dsh-locks')), 'save 后锁目录存在');
  assert.ok(!fs.existsSync(path.join(dir, '.dsh-locks', '.dsh-locks')), '无嵌套 .dsh-locks/.dsh-locks');
});

test('state-store: 磁盘被回退为 v1 时（构造期迁移写盘失败兜底）写穿合并保留 v1 决策，不静默丢弃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-state-v1fb-'));
  const file = path.join(dir, 'desktop-plugin-state.json');
  // 先落一个 v1 文件（含一个卸载决策）。
  const v1 = { v: 1, uninstalled: { old: { name: 'old-pkg', at: '2026-01-01T00:00:00.000Z', source: 'ui' } } };
  fs.writeFileSync(file, JSON.stringify(v1));
  const store = new PluginStateStore({ file });
  assert.ok(store.isUninstalled('old'), '构造期 v1 迁移内存生效');
  // 模拟「迁移写盘失败 → 磁盘仍为 v1」：把磁盘回退为 v1 原文。
  fs.writeFileSync(file, JSON.stringify(v1));
  const saved = await store.markUninstalled('new', 'new-pkg');
  assert.ok(saved, 'save 成功');
  const reloaded = new PluginStateStore({ file });
  assert.ok(reloaded.isUninstalled('old'), 'v1 决策不得被静默丢弃');
  assert.ok(reloaded.isUninstalled('new'), '新决策写入');
  fs.rmSync(dir, { recursive: true, force: true });
});
