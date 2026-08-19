'use strict';

// web-crash-shield.js — dsh web 进程的运行时崩溃屏蔽（经 --require 注入）。
//
// 背景（插件市场崩溃事故）：社区插件在宿主进程内的运行时错误
//（uncaughtException / unhandledRejection）会把整个 dsh web 拖死，
// 用户全部会话中断，桌面壳弹出「服务意外退出」。
//
// 策略（保守且可测试）：
//   · 启动期（就绪横幅出现前）保持 fail-fast：原样重抛，启动失败的
//     快速退出语义不变，壳层既有的启动自愈（体检/修复/回滚）照常工作；
//   · 就绪后：吞掉异常并打日志到 stderr（随壳层管道落 dsh-web.log），
//     宿主继续服务——单个坏插件的错误不再击穿整个桌面端；
//   · 风暴断路：短窗口内错误超过上限说明宿主已处于不可用状态，
//     恢复默认抛出（进程退出 → 壳层崩溃环自愈接管回滚）。
//
// 本模块必须是纯 Node 核心依赖（--require 发生在任何业务模块之前）。

const STORM_LIMIT = Number(process.env.DSH_CRASH_SHIELD_LIMIT || 20);
const STORM_WINDOW_MS = Number(process.env.DSH_CRASH_SHIELD_WINDOW_MS || 60000);
const READY_RE = /dsh web:\s+https?:\/\//;

function createCrashShield(options = {}) {
  const proc = options.process || process;
  const timers = options.timers || { now: () => Date.now() };
  const emit = options.emit || ((line) => { try { proc.stderr.write(line); } catch { /* ignore */ } });

  let armed = false;
  const stamps = [];

  function arm() { armed = true; }
  function isArmed() { return armed; }

  // 风暴判定：滚动窗口内超过 STORM_LIMIT 即放行抛出（fail 回壳层自愈）。
  function stormExceeded() {
    const now = timers.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > STORM_WINDOW_MS) stamps.shift();
    return stamps.length > STORM_LIMIT;
  }

  function describe(kind, err) {
    let detail;
    if (err instanceof Error) detail = (err.stack || String(err));
    else { try { detail = JSON.stringify(err); } catch { detail = String(err); } }
    return `[crash-shield] ${kind}（已隔离，宿主继续运行）：\n${detail}\n`;
  }

  function onUncaughtException(err) {
    if (!armed) throw err; // 启动期 fail-fast
    if (stormExceeded()) throw err; // 风暴断路 → 交壳层崩溃环自愈
    emit(describe('uncaughtException', err));
  }

  function onUnhandledRejection(reason) {
    if (!armed) throw reason instanceof Error ? reason : new Error(String(reason));
    if (stormExceeded()) throw reason instanceof Error ? reason : new Error(String(reason));
    emit(describe('unhandledRejection', reason));
  }

  // 就绪横幅探测：包住 stdout.write，命中「dsh web: http(s)://」即 arm。
  function wrapStdout() {
    const orig = proc.stdout.write;
    proc.stdout.write = function patchedWrite(chunk, ...rest) {
      if (!armed) {
        try { if (READY_RE.test(String(chunk))) arm(); } catch { /* 探测失败不影响输出 */ }
      }
      return orig.apply(this, [chunk, ...rest]);
    };
  }

  function install() {
    proc.on('uncaughtException', onUncaughtException);
    proc.on('unhandledRejection', onUnhandledRejection);
    wrapStdout();
  }

  return { install, arm, isArmed, onUncaughtException, onUnhandledRejection, stormExceeded };
}

module.exports = { createCrashShield, STORM_LIMIT, STORM_WINDOW_MS };

// --require 注入路径：壳层 spawn 时设 DSH_CRASH_SHIELD=1 才装到真实 process
//（--require 下 require.main 不是本模块，不能用它判定；单测 require 本模块
// 取 createCrashShield 注桩，不会误装到测试进程）。
if (process.env.DSH_CRASH_SHIELD === '1') {
  createCrashShield().install();
}
