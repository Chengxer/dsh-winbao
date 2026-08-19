'use strict';

// ---------------------------------------------------------------------------
// plugin-core 服务存活探针（supervision）：补上「进程存活但 HTTP 不响应」
//（插件把宿主挂死而不退出）的自愈盲区——即审计发现的「假活」缺陷。
//
// 语义：
//   · 就绪后每 intervalMs 探活 GET <baseUrl>/（3s 超时，状态 <500 即健康）；
//   · 连续 failThreshold 次失败（≈90s）且 isBusy() 为假（无插件变更/重启/
//     崩溃环进行中）→ 判定「假活」→ 调 onZombie()（壳层执行守护重启）；
//   · 启动 graceMs 内与每次恢复后 cooldownMs 内不判定（与慢启动/大负载
//     误伤隔离）；stop() 后不再有任何定时器活动。
// 全部依赖注入（httpGet / isBusy / onZombie / now），纯 Node 可测。
// ---------------------------------------------------------------------------

const ZOMBIE_MARKER = '[supervision] service unresponsive (zombie) detected';

function createSupervision(opts) {
  const {
    getBaseUrl,
    httpGet,
    isBusy = () => false,
    onZombie = () => {},
    log = () => {},
    intervalMs = 30000,
    graceMs = 120000,
    cooldownMs = 60000,
    failThreshold = 3,
    probeTimeoutMs = 3000,
    timers = { now: () => Date.now() },
  } = opts;

  let stopped = true;
  let timer = null;
  let startAt = 0;
  let lastRecoveryAt = 0;
  let consecutiveFailures = 0;
  let probing = false;

  function probeOnce() {
    let baseUrl;
    try { baseUrl = getBaseUrl(); } catch { return Promise.resolve(false); }
    if (!baseUrl) return Promise.resolve(false);
    // 竞速兜底计时器不能 unref：它承担「Promise 必然结算」的语义——unref 后，
    // 当事件循环里只剩该计时器时会提前排空（CI 最小环境下 node:test 报
    // "Promise resolution is still pending but the event loop has already
    // resolved"，并连带取消本文件其余用例）。结算后必须 clearTimeout，
    // 避免 httpGet 先返回时计时器拖慢进程退出。
    let settleTimer = null;
    const fallback = new Promise((resolve) => {
      settleTimer = setTimeout(() => resolve({ statusCode: 0, timedOut: true }), probeTimeoutMs);
    });
    let req;
    try {
      req = Promise.resolve(httpGet(baseUrl + '/', { timeout: probeTimeoutMs }));
    } catch (err) {
      // 注入的 httpGet 同步抛错：立即判不健康并清掉兜底计时器（不残留 ref 计时器）。
      if (settleTimer) clearTimeout(settleTimer);
      return Promise.resolve(false);
    }
    return Promise.race([req, fallback]).then((res) => {
      const healthy = !!(res && typeof res.statusCode === 'number' && res.statusCode > 0 && res.statusCode < 500);
      return healthy;
    }).catch(() => false).finally(() => {
      if (settleTimer) clearTimeout(settleTimer);
    });
  }

  async function tick() {
    if (stopped) return;
    const now = timers.now();
    // lastRecoveryAt=0 表示「从未触发过 zombie」：注入时钟从 0 开始时不得误入
    // cooldown 窗口（now - 0 恒大于 cooldownMs 的假象会随假时钟翻转）。
    if (now - startAt < graceMs || (lastRecoveryAt !== 0 && now - lastRecoveryAt < cooldownMs)) {
      schedule();
      return;
    }
    if (probing) { schedule(); return; }
    probing = true;
    let healthy;
    try {
      healthy = await probeOnce();
    } catch {
      // 探活异常（注入的 httpGet 同步抛错等）与探活失败同口径，绝不打断定时循环。
      healthy = false;
    } finally {
      probing = false;
    }
    if (stopped) return;
    if (healthy) {
      consecutiveFailures = 0;
      schedule();
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= failThreshold && !isBusy()) {
      consecutiveFailures = 0;
      lastRecoveryAt = now;
      log(ZOMBIE_MARKER + '（连续 ' + failThreshold + ' 次探活失败，触发守护重启）');
      try { await onZombie(); } catch (err) { log('supervision: onZombie 失败: ' + (err && err.message)); }
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    startAt = timers.now();
    consecutiveFailures = 0;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function state() {
    return { stopped, consecutiveFailures, startAt, lastRecoveryAt };
  }

  return { start, stop, state, probeOnce, tick };
}

module.exports = { createSupervision, ZOMBIE_MARKER };
