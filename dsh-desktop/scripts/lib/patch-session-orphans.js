'use strict';

// patch-session-orphans.js — 删除会话时终结其名下进程树（孤儿进程补丁）。
//
// 背景（2026-08 事件洪水调查定案，详见调查报告）：
//   内核（@deepseek-ai/dsh 0.1.0-rc.x）的 agent 只随 composition teardown
//   （内核进程退出）卸载，没有按会话卸载的路径：
//     · dsh-session 的 session/disposed 监听者只有 persistence /
//       projection-cache / telemetry / title（dsh-session/lib/index.js:1792
//       emitDisposed 的消费面），没有任何子进程清理；
//     · bash 背景进程（run_in_background）经 jobs.start({owner: agent}）挂在
//       agent 名下（dsh-tool-bash/lib/index.js:417），jobs-local 的 owner 清理
//       （dsh-jobs-local/lib/index.js:400 ensureOwnerCleanup）只在 agent 的
//       cordis fiber dispose 时触发——即内核退出；
//     · PTY 持久终端同理（dsh-terminal/lib/index.js:239）。
//   因此「删除会话」后，空闲 agent 永驻注册表，其名下的 python/node 背景进程
//   与持久终端一直活到内核退出：孤儿进程占 CPU/内存、写爆 spill 目录，并可能
//   把内核事件循环拖到假死（喂给壳侧 supervisor 的 60s 假死受控重启环）。
//   用户实测「任务管理器杀光 python+node 后恢复」与此一致。
//
//   注：孤儿进程本身不会直接产生会话事件（输出是 pull 模型，须有活跃 agent
//   读它），事件洪水的主嫌疑是「僵尸 agent 循环」；本补丁消除的是其进程侧
//   放大器与资源泄漏，不修改任何事件流行为。
//
// 修法：在 workspace.deleteSession（session-manage 补丁注入的 RPC）摘除 live
// 会话后，复用内核自有的 owner 清理 API 终结该 agent 名下的全部工作：
//     agent.cancel({kind:"user"}, {keepInbox:true}) —— 防御性取消（运行中会话
//       已被 deleteSession 上方守卫拒绝，此时是 no-op）；
//     ctx.jobs.disposeOwned(agent)     —— job.cancel → proc.kill() →
//       SIGTERM→SIGKILL 杀梯（dsh-subprocess-local terminate），并删除作业记录；
//     ctx.terminals.disposeOwned(agent) —— PTY close → terminate 收割整树。
//   两个 disposeOwned 都是内核自有方法且幂等（agent 后续再走 owner 清理时
//   已无记录，为空操作）。缺失服务（typeof 守卫）时静默降级，不影响删除主链。
//
// 锚点依赖：锚点是 session-manage 补丁注入的文本（deleteSession 体内的
// ctx.sessions.remove 行）。本补丁必须在 session-manage（registry order 190）
// 之后应用（order 195）；session-manage 未应用时按 anchor-missing 跳过。
//
// 幂等 / 容错契约对齐 scripts/lib 下既有补丁：marker 短路 already、锚点失配
// 不改写、异常逐文件吸收。上游若原生内置「会话删除即卸载 agent / 清理名下
// 进程」，本补丁经 already / anchor-missing 自然退役（参照 vision-key-fix 先例）。

const path = require('node:path');
const fs = require('node:fs');
const { applyPatchToFiles } = require('./patch-engine');

/** 目标文件（相对 node_modules/@deepseek-ai 根）。 */
const HOST_APIPROXY_REL = path.join('dsh-host-apiproxy', 'lib', 'index.js');

/** 幂等 marker（产物注释 + registry preflight 同源）。 */
const SESSION_ORPHANS_MARKER = 'dsh-desktop patch (session orphans)';

// ---------------------------------------------------------------------------
// transform：deleteSession 内注入 owner 清理
// ---------------------------------------------------------------------------
// 锚点 = session-manage 补丁注入的两行（摘除 live 注册表 + 合成移除帧广播）。
// 用双行锚点保证唯一性与依赖顺序（session-manage 已应用）。
const SESSION_ORPHANS_ANCHOR = [
  '\t\t\t\tconst removed = ctx.sessions.remove(sessionId);',
  '\t\t\t\tif (!removed) ctx.emit("session/disposed", { id: sessionId });',
].join('\n');

const SESSION_ORPHANS_INJECTION = [
  '\t\t\t\tconst removed = ctx.sessions.remove(sessionId);',
  '\t\t\t\tif (!removed) ctx.emit("session/disposed", { id: sessionId });',
  '\t\t\t\t// ' + SESSION_ORPHANS_MARKER + ': 上游 agent 只随内核退出卸载，删除会话后',
  '\t\t\t\t// 其名下背景进程与持久终端一直活到内核退出（孤儿泄漏：CPU/内存/spill 挤压，',
  '\t\t\t\t// 甚至把事件循环拖进壳侧假死重启环）。这里复用内核自有的 owner 清理 API',
  '\t\t\t\t// 终结该 agent 名下全部工作：jobs.disposeOwned → job.cancel → proc.kill()',
  '\t\t\t\t// → SIGTERM→SIGKILL 杀梯；terminals.disposeOwned → PTY terminate 收割整树。',
  '\t\t\t\t// 两者幂等（agent 后续 owner 清理为空操作）；服务缺失时 typeof 守卫静默',
  '\t\t\t\t// 降级。运行中会话已被上方守卫拒绝，cancel 只是防御性 no-op。',
  '\t\t\t\ttry {',
  '\t\t\t\t\tconst dshDeletedAgent = ctx.agents.get(sessionId);',
  '\t\t\t\t\tif (dshDeletedAgent !== void 0) {',
  '\t\t\t\t\t\ttry { dshDeletedAgent.cancel({ kind: "user" }, { keepInbox: true }); } catch {}',
  '\t\t\t\t\t\tconst dshDeletedJobs = ctx.get("jobs");',
  '\t\t\t\t\t\tif (dshDeletedJobs && typeof dshDeletedJobs.disposeOwned === "function") void Promise.resolve(dshDeletedJobs.disposeOwned(dshDeletedAgent)).catch(() => {});',
  '\t\t\t\t\t\tconst dshDeletedTerminals = ctx.get("terminals");',
  '\t\t\t\t\t\tif (dshDeletedTerminals && typeof dshDeletedTerminals.disposeOwned === "function") void Promise.resolve(dshDeletedTerminals.disposeOwned(dshDeletedAgent)).catch(() => {});',
  '\t\t\t\t\t}',
  '\t\t\t\t} catch {}',
].join('\n');

/**
 * transform：向 deleteSession 注入 owner 清理（幂等、锚点失配不改写）。
 * @param {string} src 源文件内容
 * @param {string} file 文件路径（日志用）
 * @returns {{status:'already'}|{status:'anchor-missing',detail:string}|{status:'changed',src:string}}
 */
function transformSessionOrphans(src, file) {
  if (src.includes(SESSION_ORPHANS_MARKER)) return { status: 'already' };
  if (!src.includes(SESSION_ORPHANS_ANCHOR)) {
    return {
      status: 'anchor-missing',
      detail: '未找到 deleteSession 的 sessions.remove 锚点（session-manage 补丁未应用或版本已变化），跳过 ' + file,
    };
  }
  // 注入文本含 ${...} 之外无 $ 序列，replace 字面量安全；用函数替换器规避任何替换语义歧义。
  return { status: 'changed', src: src.replace(SESSION_ORPHANS_ANCHOR, () => SESSION_ORPHANS_INJECTION) };
}

// ---------------------------------------------------------------------------
// 应用入口（root 应用器契约：返回变更文件数）
// ---------------------------------------------------------------------------
/**
 * 对某个 node_modules 根目录应用会话孤儿进程补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchSessionOrphans(nmRoot, log = () => {}) {
  const file = path.join(nmRoot, '@deepseek-ai', HOST_APIPROXY_REL);
  if (!fs.existsSync(file)) return 0;
  return applyPatchToFiles({
    prefix: '会话孤儿进程补丁',
    files: [file],
    log,
    transform: transformSessionOrphans,
    alreadyLog: (f) => '已应用，跳过 ' + f,
    doneLog: (f) => '已让删除会话终结其名下进程树 ' + f,
    anchorLog: log,
    failLog: (f, err) => '会话孤儿进程补丁失败(' + f + '): ' + err.message,
  });
}

module.exports = {
  HOST_APIPROXY_REL,
  SESSION_ORPHANS_MARKER,
  SESSION_ORPHANS_ANCHOR,
  transformSessionOrphans,
  patchSessionOrphans,
};
