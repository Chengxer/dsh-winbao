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
//   · 归因计数：从异常栈/消息中提取肇事来源（node_modules 包名 / loader
//     entry id），滚动窗口内同一来源达到阈值即输出机器可读标记
//     `[crash-shield] attribute: <source> count: <n>`——壳层据此自动写入
//     quarantine（disabled 覆盖）+ 守护重启，实现「肇事插件自动隔离」；
//   · 武装标记：arm 时置 process.env.DSH_CRASH_SHIELD_ARMED=1，
//     dsh-app-boot 的 installFailLoud（被 loader-isolation 补丁改写）据此
//     在就绪后不再 exit(1)，与吞错策略闭环；
//   · 风暴断路：短窗口内错误超过上限说明宿主已处于不可用状态，
//     恢复默认抛出（进程退出 → 壳层崩溃环自愈接管回滚）。
//
// 本模块必须是纯 Node 核心依赖（--require 发生在任何业务模块之前）。

const STORM_LIMIT = Number(process.env.DSH_CRASH_SHIELD_LIMIT || 20);
const STORM_WINDOW_MS = Number(process.env.DSH_CRASH_SHIELD_WINDOW_MS || 60000);
const ATTRIBUTE_THRESHOLD = Number(process.env.DSH_CRASH_SHIELD_ATTRIBUTE_THRESHOLD || 3);
const ATTRIBUTE_WINDOW_MS = Number(process.env.DSH_CRASH_SHIELD_ATTRIBUTE_WINDOW_MS || 10 * 60 * 1000);
const READY_RE = /dsh web:\s+https?:\/\//;

/** 从异常中提取肇事来源（包名 / entry id），去重返回。 */
function attributeSources(err) {
  const text = err instanceof Error ? (String(err.stack || '') + '\n' + String(err.message || '')) : String(err);
  const out = new Set();
  const pkgRe = /node_modules[\\/](?:@([^\\/]+)[\\/])?([A-Za-z0-9._-]+)/gi;
  let m;
  while ((m = pkgRe.exec(text)) !== null) {
    out.add(m[1] ? '@' + m[1] + '/' + m[2] : m[2]);
  }
  const entryRe = /(?:loader entry|entry)\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*\(/gi;
  while ((m = entryRe.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

function createCrashShield(options = {}) {
  const proc = options.process || process;
  const timers = options.timers || { now: () => Date.now() };
  const emit = options.emit || ((line) => { try { proc.stderr.write(line); } catch { /* ignore */ } });

  let armed = false;
  const stamps = [];
  const attributed = new Map(); // source -> { count, windowStart, reported }

  function arm() {
    if (armed) return;
    armed = true;
    try { proc.env.DSH_CRASH_SHIELD_ARMED = '1'; } catch { /* env 只读场景忽略 */ }
  }
  function isArmed() { return armed; }

  // 风暴判定：滚动窗口内超过 STORM_LIMIT 即放行抛出（fail 回壳层自愈）。
  function stormExceeded() {
    const now = timers.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > STORM_WINDOW_MS) stamps.shift();
    return stamps.length > STORM_LIMIT;
  }

  // 归因计数：同一来源在 ATTRIBUTE_WINDOW_MS 内达到 ATTRIBUTE_THRESHOLD 即
  // 输出一次标记（窗口内去重），供壳层执行 quarantine。
  function noteAttributes(err) {
    const now = timers.now();
    for (const source of attributeSources(err)) {
      let rec = attributed.get(source);
      if (!rec || now - rec.windowStart > ATTRIBUTE_WINDOW_MS) {
        rec = { count: 0, windowStart: now, reported: false };
        attributed.set(source, rec);
      }
      rec.count += 1;
      if (rec.count >= ATTRIBUTE_THRESHOLD && !rec.reported) {
        rec.reported = true;
        emit(`[crash-shield] attribute: ${source} count: ${rec.count}\n`);
      }
    }
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
    noteAttributes(err);
    emit(describe('uncaughtException', err));
  }

  function onUnhandledRejection(reason) {
    if (!armed) throw reason instanceof Error ? reason : new Error(String(reason));
    if (stormExceeded()) throw reason instanceof Error ? reason : new Error(String(reason));
    noteAttributes(reason);
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

  return { install, arm, isArmed, onUncaughtException, onUnhandledRejection, stormExceeded, attributeSources, noteAttributes };
}

module.exports = { createCrashShield, attributeSources, STORM_LIMIT, STORM_WINDOW_MS, ATTRIBUTE_THRESHOLD, ATTRIBUTE_WINDOW_MS };

// --require 注入路径：壳层 spawn 时设 DSH_CRASH_SHIELD=1 才装到真实 process
//（--require 下 require.main 不是本模块，不能用它判定；单测 require 本模块
// 取 createCrashShield 注桩，不会误装到测试进程）。
if (process.env.DSH_CRASH_SHIELD === '1') {
  createCrashShield().install();
}
