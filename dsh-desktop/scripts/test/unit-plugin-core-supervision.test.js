'use strict';

// supervision.js 单测：dsh web 存活探针（防「假活」）。全部依赖注入
// （getBaseUrl/httpGet/isBusy/onZombie/log/timers.now），以 fake now + 手动驱动
// tick() 获得确定性，不依赖真实定时器时序（除 probeTimeout 竞速用真实短超时）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupervision, ZOMBIE_MARKER } = require('../plugin-core/lib/supervision');

/**
 * 构造被测实例 + 观测点。返回对象本身携带可变 `now`（getter/setter 指向闭包变量），
 * 供测试用 `s.now = n` 推进假时钟（注意：不可用 `s.sup.now = n`——那会写到实例上）。
 */
function makeSup(overrides = {}) {
  let now = 0;
  const log = [];
  const counters = { http: 0, zombie: 0 };
  const userHttpGet = overrides.httpGet;
  const httpGet = (url, opts) => {
    counters.http += 1;
    if (userHttpGet) return userHttpGet(url, opts);
    return Promise.resolve({ statusCode: 200 });
  };
  const opts = Object.assign({}, {
    getBaseUrl: () => 'http://127.0.0.1:8321',
    httpGet,
    isBusy: () => false,
    onZombie: () => { counters.zombie += 1; },
    log: (m) => log.push(m),
    intervalMs: 30000,
    graceMs: 0,
    cooldownMs: 0,
    failThreshold: 3,
    probeTimeoutMs: 3000,
    timers: { now: () => now },
  }, overrides, { httpGet });

  const sup = createSupervision(opts);
  return {
    sup,
    log,
    counters,
    get now() { return now; },
    set now(v) { now = v; },
    advance(ms) { now += ms; },
  };
}

// ── probeOnce：状态码判定 ────────────────────────────────────────────────────

test('supervision: statusCode 500 → 不健康', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 500 }) });
  assert.equal(await s.sup.probeOnce(), false);
});

test('supervision: statusCode 404 → 健康（<500 即健康）', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 404 }) });
  assert.equal(await s.sup.probeOnce(), true);
});

test('supervision: statusCode 0 → 不健康', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 0 }) });
  assert.equal(await s.sup.probeOnce(), false);
});

test('supervision: httpGet reject → 不健康', async () => {
  const s = makeSup({ httpGet: () => Promise.reject(new Error('boom')) });
  assert.equal(await s.sup.probeOnce(), false);
});

test('supervision: httpGet 永不 resolve → probeTimeout 竞速判不健康', async () => {
  const s = makeSup({ httpGet: () => new Promise(() => {}), probeTimeoutMs: 20 });
  const started = Date.now();
  assert.equal(await s.sup.probeOnce(), false);
  assert.ok(Date.now() - started < 1000, '超时竞速应在短超时内返回');
});

test('supervision: getBaseUrl null → probe 解析为 falsy（false）', async () => {
  const s = makeSup({ getBaseUrl: () => null });
  assert.equal(await s.sup.probeOnce(), false);
});

test('supervision: getBaseUrl 抛错 → probe 解析为 false', async () => {
  const s = makeSup({ getBaseUrl: () => { throw new Error('no url'); } });
  assert.equal(await s.sup.probeOnce(), false);
});

// ── tick()：计数 / 假活判定 ──────────────────────────────────────────────────

test('supervision: 成功探活重置连续失败计数', async () => {
  let healthy = false;
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: healthy ? 200 : 500 }) });
  s.sup.start();
  await s.sup.tick();
  await s.sup.tick();
  assert.equal(s.sup.state().consecutiveFailures, 2);
  healthy = true;
  await s.sup.tick();
  assert.equal(s.sup.state().consecutiveFailures, 0);
});

test('supervision: 连续 3 次失败 → onZombie 恰好一次 + log 含 ZOMBIE_MARKER', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 500 }) });
  s.sup.start();
  await s.sup.tick();
  await s.sup.tick();
  assert.equal(s.counters.zombie, 0, '未到阈值不触发');
  await s.sup.tick();
  assert.equal(s.counters.zombie, 1, '第三次失败触发 onZombie 一次');
  await s.sup.tick();
  assert.equal(s.counters.zombie, 1, '触发后连续计数归零，不会重复触发');
  const zombieLogs = s.log.filter((m) => m.includes(ZOMBIE_MARKER));
  assert.equal(zombieLogs.length, 1, 'log 恰好收到一次 ZOMBIE_MARKER');
});

test('supervision: getBaseUrl null 计入失败', async () => {
  const s = makeSup({ getBaseUrl: () => null });
  s.sup.start();
  await s.sup.tick();
  assert.equal(s.sup.state().consecutiveFailures, 1);
  assert.equal(s.counters.http, 0, 'baseUrl 为空时不发 httpGet');
});

test('supervision: 启动 grace 期内跳过探活', async () => {
  const s = makeSup({ graceMs: 100 });
  s.sup.start(); // startAt = now = 0
  await s.sup.tick(); // now=0，在 grace 内
  assert.equal(s.counters.http, 0);
  s.now = 99;
  await s.sup.tick();
  assert.equal(s.counters.http, 0);
  s.now = 100;
  await s.sup.tick();
  assert.equal(s.counters.http, 1);
});

test('supervision: 假活恢复后 cooldown 期内跳过探活', async () => {
  const s = makeSup({ failThreshold: 1, cooldownMs: 100, httpGet: () => Promise.resolve({ statusCode: 500 }) });
  // 初始时钟远离 0：lastRecoveryAt 以 0 为哨兵，若 now 从 0 起步，首 tick 会被
  // `now - 0 < cooldownMs` 误判为 cooldown 内（生产用 Date.now() 恒为大数，无此现象）。
  s.now = 10000;
  s.sup.start(); // startAt = 10000
  await s.sup.tick(); // 首次失败即触发假活（阈值 1），lastRecoveryAt = 10000
  assert.equal(s.counters.http, 1);
  assert.equal(s.counters.zombie, 1);
  s.now = 10050;
  await s.sup.tick(); // 10050 - 10000 = 50 < 100，cooldown 内跳过
  assert.equal(s.counters.http, 1, 'cooldown 内不再探活');
  s.now = 10100;
  await s.sup.tick(); // 10100 - 10000 = 100，恰好跨过 cooldown
  assert.equal(s.counters.http, 2);
});

test('supervision: 阈值时 isBusy 为真 → 不触发假活', async () => {
  let busy = true;
  const s = makeSup({ isBusy: () => busy, httpGet: () => Promise.resolve({ statusCode: 500 }) });
  s.sup.start();
  await s.sup.tick();
  await s.sup.tick();
  await s.sup.tick(); // 第三次失败达阈值，但 busy → 不触发
  assert.equal(s.counters.zombie, 0);
  assert.equal(s.sup.state().consecutiveFailures, 3, 'busy 时计数不清零');
});

test('supervision: busy 转假后继续失败 → 触发假活', async () => {
  let busy = true;
  const s = makeSup({ isBusy: () => busy, httpGet: () => Promise.resolve({ statusCode: 500 }) });
  s.sup.start();
  await s.sup.tick();
  await s.sup.tick();
  await s.sup.tick();
  assert.equal(s.counters.zombie, 0);
  busy = false;
  await s.sup.tick(); // 继续失败且不 busy → 触发
  assert.equal(s.counters.zombie, 1);
  assert.equal(s.sup.state().consecutiveFailures, 0, '触发后计数归零');
});

// ── 生命周期 ────────────────────────────────────────────────────────────────

test('supervision: stop() 置 stopped 且不再 tick', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 500 }) });
  s.sup.start();
  await s.sup.tick();
  assert.equal(s.counters.http, 1);
  s.sup.stop();
  assert.equal(s.sup.state().stopped, true);
  await s.sup.tick(); // stopped → 立即返回，不探活
  assert.equal(s.counters.http, 1, 'stop 后不再探活');
});

test('supervision: start() 重复调用只保留单一定时循环（startAt 不变）', () => {
  const s = makeSup();
  s.now = 123;
  s.sup.start();
  assert.equal(s.sup.state().stopped, false);
  assert.equal(s.sup.state().startAt, 123);
  s.now = 456;
  s.sup.start(); // 已启动 → no-op
  assert.equal(s.sup.state().startAt, 123, '第二次 start() 不重置 startAt');
  assert.equal(s.sup.state().stopped, false);
});

test('supervision: tick()/probeOnce() 导出且可手动驱动（fake now 确定性）', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 500 }) });
  assert.equal(typeof s.sup.tick, 'function');
  assert.equal(typeof s.sup.probeOnce, 'function');
  s.sup.start();
  s.now = 0;
  await s.sup.tick(); // 手动驱动，不等真实 intervalMs
  assert.equal(s.counters.http, 1);
  assert.equal(s.sup.state().consecutiveFailures, 1);
});

test('supervision: state() 反映各计数器', async () => {
  const s = makeSup({ httpGet: () => Promise.resolve({ statusCode: 500 }) });
  assert.deepEqual(s.sup.state(), { stopped: true, consecutiveFailures: 0, startAt: 0, lastRecoveryAt: 0 });
  s.now = 100;
  s.sup.start();
  assert.deepEqual(s.sup.state(), { stopped: false, consecutiveFailures: 0, startAt: 100, lastRecoveryAt: 0 });
  await s.sup.tick();
  assert.equal(s.sup.state().consecutiveFailures, 1);
  await s.sup.tick();
  assert.equal(s.sup.state().consecutiveFailures, 2);
  await s.sup.tick(); // 第三次触发假活：lastRecoveryAt=now=100，计数归零
  assert.equal(s.sup.state().consecutiveFailures, 0);
  assert.equal(s.sup.state().lastRecoveryAt, 100);
  s.sup.stop();
  assert.equal(s.sup.state().stopped, true);
});
