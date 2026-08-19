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
    return Promise.race([
      httpGet(baseUrl + '/', { timeout: probeTimeoutMs }),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve({ statusCode: 0, timedOut: true }), probeTimeoutMs);
        if (t.unref) t.unref();
      }),
    ]).then((res) => {
      const healthy = !!(res && typeof res.statusCode === 'number' && res.statusCode > 0 && res.statusCode < 500);
      return healthy;
    }).catch(() => false);
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
