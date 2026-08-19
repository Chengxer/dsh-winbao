'use strict';

// ---------------------------------------------------------------------------
// 补丁编排（注册表驱动，逐补丁容错）。
//
// 替代 main.js 里顺序硬编码的 18 个 apply* 函数与 WSL/本地两份列表：遍历
// patch-registry 的 PATCH_SPECS（order 升序），逐补丁 try-catch + failPolicy
// 分级，异常绝不越出补丁边界，全部进 patchReport。
//
//   kind='file' ：resolvePatchTargets → applyPatchToFiles（复用唯一引擎）；
//   kind='root' ：resolveNmRoots → 逐根调用 patch-*.js 的根应用器。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { applyPatchToFiles } = require('../lib/patch-engine');
const { getSpecsByGroup } = require('../lib/patch-registry');
const { resolvePatchTargets, resolveNmRoots } = require('../lib/patch-target-resolver');
const { probe, missingBridgeWarning } = require('../lib/host-capabilities');

/**
 * 解析单个 file 补丁的落盘文件列表。profile-boot 防护需要运行时 glob
 * `profile-boot-*.js`，其余布局直接经 resolvePatchTargets 解析。
 * @param {Object} ctx
 * @param {Object} spec
 * @returns {string[]}
 */
function resolveFiles(ctx, spec) {
  const layoutKey = (spec.wslLayout && ctx.wslMode) ? spec.wslLayout : spec.layout;
  if (layoutKey === 'profile-boot-dirs') {
    const dirs = resolvePatchTargets(ctx, spec);
    const files = [];
    for (const dir of dirs) {
      let names;
      try { names = fs.readdirSync(dir).filter((f) => /^profile-boot-.+\.js$/.test(f)); } catch { continue; }
      for (const name of names) files.push(path.join(dir, name));
    }
    return files;
  }
  return resolvePatchTargets(ctx, spec);
}

/**
 * 单次落盘调用（applyPatchToFiles 的日志契约封装）。
 * options 为场景覆盖（CLI 同步期：dryRun + donePrefix:false + anchorLog=warn）。
 */
function applyToFiles(ctx, spec, prefix, logs, files, stats, options = {}) {
  const doneLog = logs.doneLog || ((file) => '已应用 ' + file);
  return applyPatchToFiles({
    prefix,
    files,
    log: (m) => ctx.log(m),
    transform: spec.transform,
    alreadyLog: logs.alreadyLog || null,
    doneLog,
    donePrefix: options.donePrefix ?? logs.donePrefix ?? true,
    anchorLog: options.anchorLog ?? ((m) => ctx.log(m)),
    failLog: logs.failLog || ((file, err) => `${prefix}失败(${file}): ${err.message}`),
    dryRun: options.dryRun ?? false,
    // doneLog 默认以「已」开头，replace(/^已/,'') 只剥首个「已」（无「已」前缀时原样），
    // 语义更稳健；registry 的 cli spec 未来提供独立 dryRunChangedLog 时经 options 透传优先。
    dryRunChangedLog: options.dryRunChangedLog ?? ((file, note) => 'dry-run: 将' + doneLog(file, note).replace(/^已/, '')),
    stats,
  });
}

/**
 * file 补丁：多文件相对路径时逐份应用（shell-description / slot-compat 共用）。
 *
 * 布局分两类：
 *   - 逐文件布局（runtime-local / guard / wsl / slot-compat / slot-compat-wsl）：
 *     布局函数读单个 spec.pkgRel，须对每个 pkgRel 循环调用一次；
 *   - 无 pkgRel 语义布局（profile-boot-dirs 内部 glob）或单 pkgRel 补丁：
 *     直接调用一次 resolveFiles(spec)，不得覆盖 pkgRel 为 undefined。
 */
function applyFile(ctx, spec, stats, options = {}) {
  const logs = spec.logs || {};
  const prefix = logs.prefix || spec.id;
  let written = 0;
  const multi = Array.isArray(spec.pkgRels) && spec.pkgRels.length > 0;
  if (multi) {
    for (const pkgRel of spec.pkgRels) {
      written += applyToFiles(ctx, spec, prefix, logs, resolveFiles(ctx, { ...spec, pkgRel }), stats, options);
    }
  } else {
    written += applyToFiles(ctx, spec, prefix, logs, resolveFiles(ctx, spec), stats, options);
  }
  return written;
}

/** root 补丁：逐 node_modules 根 try-catch（单根失败不拖垮其余根）。 */
function applyRoot(ctx, spec, stats, options = {}) {
  let written = 0;
  const roots = resolveNmRoots(ctx, spec);
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const n = spec.apply(root, (m) => ctx.log(m), stats, options);
      if (n > 0 && options.donePrefix !== false) ctx.log(spec.successLog(root));
      written += n;
    } catch (err) {
      ctx.log(spec.failLog(root, err));
      if (stats) stats.failed += 1;
    }
  }
  return written;
}

/**
 * 遍历注册表应用全部补丁，返回 patchReport。
 * @param {Object} ctx { home, appDir, userDataDir, wslMode, log, hostDetectors? }
 * @param {Array<Object>} [specs] 补丁清单（默认 getSpecsByGroup()，供单测注入）。
 * @param {Object} [options] 场景覆盖（CLI 同步期用 dryRun + donePrefix:false + anchorLog=warn）。
 * @returns {{total:number, changed:number, degraded:string[], warnings:string[], errors:string[], host:Object}}
 */
function applyAll(ctx, specs = getSpecsByGroup(), options = {}) {
  const host = probe(ctx.hostDetectors);
  // warnings 为降级告警但非硬失败（requires 缺失且非 degrade/required 时），已通过
  // ctx.log 输出，notifyPatchFailures 不重复提示——避免「未消费」歧义。
  const report = { total: 0, changed: 0, anchorMissing: 0, failed: 0, degraded: [], warnings: [], errors: [], host };
  for (const spec of specs) {
    const policy = spec.failPolicy || 'warn';
    const stats = { anchorMissing: 0, failed: 0 };
    report.total += 1; // 每个 spec 处理即计数（含异常），修复规格级异常时 total 低报。
    try {
      let n = 0;
      if (spec.kind === 'root') n = applyRoot(ctx, spec, stats, options);
      else n = applyFile(ctx, spec, stats, options);
      if (n > 0) report.changed += n;
      report.failed += stats.failed;
      // failPolicy 分流（互斥）：degrade/fatal 档补丁的 anchor-missing（失配）视为
      // 降级告警，只进 report.degraded；warn 档才计入 report.anchorMissing（版本
      // 差异）。二者互斥，避免同一事件在汇总日志与用户通知中被双计数。
      if (policy === 'degrade' || policy === 'fatal') {
        if (stats.anchorMissing > 0) report.degraded.push(spec.id);
      } else {
        report.anchorMissing += stats.anchorMissing;
      }
      // 宿主能力依赖：required 能力缺失 → 降级告警 + 记入报告。
      for (const capKey of (spec.requires || [])) {
        const cap = host[capKey];
        if (cap && cap.available === false) {
          const warn = missingBridgeWarning(capKey);
          if (warn) ctx.log(warn);
          if (policy === 'degrade' || cap.required) report.degraded.push(spec.id);
          else report.warnings.push(spec.id);
        }
      }
    } catch (err) {
      // 异常不越出补丁边界；按 failPolicy 分级入账（此前 failPolicy 是未执行的死字段）。
      if (policy === 'fatal') {
        // fatal 仅 build 期语义：运行时降级为「降级 + 告警」，绝不 throw 中断启动。
        ctx.log(`${spec.id} 补丁应用失败（fatal→degrade）: ${err.message}`);
        report.degraded.push(spec.id);
      } else if (policy === 'degrade') {
        ctx.log(`${spec.id} 补丁应用失败（降级）: ${err.message}`);
        report.degraded.push(spec.id);
      } else {
        ctx.log(`${spec.id} 补丁应用异常: ${err.message}`);
        report.errors.push(spec.id);
      }
    }
  }
  // 汇总日志：让「失配 / 部分失败 / 降级 / 告警」在启动日志中显式可见，避免静默失效。
  // 互斥分流后，anchorMissing 仅计 warn 档失配（版本差异）；degrade/fatal 档失配体现
  // 在 degraded（降级 J 项）；failed 为逐文件回流计数（含逐根失败）；warnings（requires
  // 缺失非降级）显式列出，消除「采集但静默」。
  ctx.log(`补丁应用汇总: 写入 ${report.changed} 处 / 失配 ${report.anchorMissing} 项 / 失败 ${report.failed + report.errors.length} 项 / 降级 ${report.degraded.length} 项 / 告警 ${report.warnings.length} 项 / 共 ${report.total} 项`);
  return report;
}

module.exports = { applyAll, applyFile, applyRoot, resolveFiles };
