'use strict';

// ---------------------------------------------------------------------------
// loader 自动隔离补丁（loader-isolation）：单插件失败不拖垮整棵插件树。
//
// 上游 cordis-loader 在两处把单条目失败 re-throw 成整树崩溃：
//   · EntryGroup.update —— 条目 apply 失败（启动/HMR/热更新）；
//   · EntryTree.await —— fiber 结算失败（启动 settle）；
// dsh-app-boot 又在两处 fail-loud：
//   · assertEntriesLoaded / assertEntriesActivated —— 无 fiber / 未激活即抛；
//   · installFailLoud —— 就绪前的迟到 rejection 直接 exit(1)。
//
// 本模块把它们改写为「自动隔离」语义（与 loader 自身的
// `entry.options.disabled = true` 先例同族，但**不落盘**——落盘由壳层
// 观察 stderr 标记后经 plugin-core/quarantine 统一执行，避免 loader 与壳层
// 并发写 cordis.patch.yml）：
//   · 失败条目 → stderr 打 `[loader-isolation] entry <id> (<name>) ...`
//     标记并跳过，其余条目照常组合（其他功能完全不受影响）；
//   · 受保护的核心条目（@deepseek-ai/dsh-base / dsh-web-app）失败仍是
//     fatal——核心缺失是安装损坏，跳过只会让整树更糟；
//   · installFailLoud 在崩溃屏蔽已武装（DSH_CRASH_SHIELD_ARMED=1，即就绪
//     横幅之后）时不再 exit(1)，改为记录后返回——就绪后的插件运行时
//     rejection 不再杀死宿主；启动期仍保持 fail-fast（壳层启动自愈照常）。
//
// 所有 transform 为纯函数：锚点失配返回 anchor-missing（调用方告警跳过），
// 已注入返回 already（幂等）。锚点与 vendored rc.7 构建产物逐字节对齐
// （单测直接对 node_modules 真实产物断言命中）。
// ---------------------------------------------------------------------------

const LOADER_TREE_ISOLATION_MARKER = 'dsh-desktop isolation: a failed loader entry must not take down the tree';
const LOADER_ACTIVATION_ISOLATION_MARKER = 'dsh-desktop isolation: inactive entries are skipped instead of aborting the boot';
const FAIL_LOUD_ISOLATION_MARKER = 'dsh-desktop isolation: post-ready load failures are isolated';

// ── cordis-plugin-loader：EntryGroup.update 失败分支 ─────────────────────────
const LOADER_UPDATE_OUTCOMES_OLD = [
  '\t\t\tconst outcomes = await Promise.allSettled(config.map((options) => this.create(options)));',
  '\t\t\tif (this.ctx.fiber.uid === null) return;',
  '\t\t\tconst failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);',
  '\t\t\tif (failures.length === 1) throw failures[0];',
  '\t\t\tif (failures.length > 1) throw new AggregateError(failures, "loader entries failed to apply");',
].join('\n');

const LOADER_UPDATE_OUTCOMES_NEW = [
  '\t\t\tconst outcomes = await Promise.allSettled(config.map((options) => this.create(options)));',
  '\t\t\tif (this.ctx.fiber.uid === null) return;',
  '\t\t\tconst failures = [];',
  '\t\t\tfor (let _oIdx = 0; _oIdx < outcomes.length; _oIdx += 1) {',
  '\t\t\t\tconst _o = outcomes[_oIdx];',
  '\t\t\t\tif (_o.status === "rejected") failures.push({ options: config[_oIdx], reason: _o.reason });',
  '\t\t\t}',
  '\t\t\tisolateEntryApplyFailures(failures);',
].join('\n');

// ── cordis-plugin-loader：EntryTree.await 失败分支 ───────────────────────────
const LOADER_AWAIT_FAILURES_OLD = [
  '\t\t\tconst failures = (await Promise.allSettled([...this.entries()].map((entry) => entry._await()))).filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);',
  '\t\t\tif (failures.length === 1) throw failures[0];',
  '\t\t\tif (failures.length > 1) throw new AggregateError(failures, "loader fibers failed");',
].join('\n');

const LOADER_AWAIT_FAILURES_NEW = [
  '\t\t\tconst _settled = await Promise.allSettled([...this.entries()].map((entry) => entry._await().then(() => null, (reason) => ({ entry, reason }))));',
  '\t\t\tconst failures = _settled.filter((outcome) => outcome.status === "fulfilled" && outcome.value !== null).map((outcome) => outcome.value);',
  '\t\t\tisolateFiberFailures(failures);',
].join('\n');

// 两个 helper 注入到 updateError 声明之前（模块作用域，函数声明提升）。
const LOADER_HELPERS_ANCHOR = 'function updateError(stage, options, cause) {';
const LOADER_HELPERS_CODE = [
  'const LOADER_PROTECTED_ENTRY_NAMES = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);',
  'function loaderIsolationDetail(reason) {',
  '\treturn reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);',
  '}',
  'function isolateEntryApplyFailures(failures) {',
  '\tconst fatal = [];',
  '\tfor (const { options, reason } of failures) {',
  '\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(options.name)) { fatal.push(reason); continue; }',
  '\t\tprocess.stderr.write(`[loader-isolation] entry ${options.id} (${options.name}) failed to apply: ${loaderIsolationDetail(reason)}\\n`);',
  '\t}',
  '\tif (fatal.length === 1) throw fatal[0];',
  '\tif (fatal.length > 1) throw new AggregateError(fatal, "loader entries failed to apply");',
  '}',
  'function isolateFiberFailures(failures) {',
  '\tconst fatal = [];',
  '\tfor (const { entry, reason } of failures) {',
  '\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(entry.options.name)) { fatal.push(reason); continue; }',
  '\t\tprocess.stderr.write(`[loader-isolation] entry ${entry.options.id} (${entry.options.name}) failed: ${loaderIsolationDetail(reason)}\\n`);',
  '\t}',
  '\tif (fatal.length === 1) throw fatal[0];',
  '\tif (fatal.length > 1) throw new AggregateError(fatal, "loader fibers failed");',
  '}',
].join('\n');

/**
 * cordis-plugin-loader/lib/index.js 变换：EntryGroup.update / EntryTree.await
 * 失败分支 → 自动隔离（受保护核心仍 fatal）。
 * @returns {{status:'already'|'anchor-missing'|'changed', src?: string, detail?: string}}
 */
function transformLoaderTreeIsolation(src, file) {
  // CRLF 归一化匹配（上游重构/换行风格漂移不应击穿隔离）；写回保持原 EOL。
  const crlf = src.includes('\r\n');
  const text = crlf ? src.replace(/\r\n/g, '\n') : src;
  // 幂等判定 = marker 存在 **且** 注入体存在（仅 marker 残留的损坏文件必须重注入）。
  const injected = text.includes('function isolateEntryApplyFailures(') && text.includes('function isolateFiberFailures(');
  if (text.includes(LOADER_TREE_ISOLATION_MARKER) && injected) return { status: 'already' };
  if (!text.includes(LOADER_UPDATE_OUTCOMES_OLD) || !text.includes(LOADER_AWAIT_FAILURES_OLD)) {
    return { status: 'anchor-missing', detail: '未找到 loader 失败分支锚点（版本可能已变更），跳过 ' + file };
  }
  if (!text.includes(LOADER_HELPERS_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 loader helper 注入锚点（版本可能已变更），跳过 ' + file };
  }
  let out = text.replace(LOADER_UPDATE_OUTCOMES_OLD, LOADER_UPDATE_OUTCOMES_NEW);
  out = out.replace(LOADER_AWAIT_FAILURES_OLD, LOADER_AWAIT_FAILURES_NEW);
  out = out.replace(LOADER_HELPERS_ANCHOR, LOADER_HELPERS_CODE + '\n\n' + LOADER_HELPERS_ANCHOR);
  if (!out.includes(LOADER_TREE_ISOLATION_MARKER)) out = '// ' + LOADER_TREE_ISOLATION_MARKER + '\n' + out;
  return { status: 'changed', src: crlf ? out.replace(/\n/g, '\r\n') : out };
}

// ── dsh-app-boot：boot 审计自动隔离 ─────────────────────────────────────────
const APP_BOOT_BOOT_CALL_OLD = [
  '\t\tawait ctx.get("loader")?.await();',
  '\t\tif (ctx.get("loader") === void 0) return ctx;',
  '\t\tawait assertEntriesActivated(ctx, binName);',
].join('\n');
const APP_BOOT_BOOT_CALL_NEW = [
  '\t\tawait ctx.get("loader")?.await();',
  '\t\tif (ctx.get("loader") === void 0) return ctx;',
  '\t\tawait isolateInactiveEntries(ctx, binName);',
].join('\n');

const APP_BOOT_INSERT_ANCHOR = 'function composeEntries(layers, warn = () => {}) {';
const APP_BOOT_ISOLATION_CODE = [
  'const LOADER_PROTECTED_ENTRY_NAMES = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);',
  'async function isolateInactiveEntries(ctx, binName) {',
  '\tconst report = (entry, reason) => {',
  '\t\tprocess.stderr.write(`[loader-isolation] entry ${entry.options.id} (${entry.options.name}): ${reason}\\n`);',
  '\t};',
  '\tconst fatal = [];',
  '\tfor (const entry of ctx.loader.entries()) {',
  '\t\tif (entry.fiber === void 0 && !entry.disabled) {',
  '\t\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(entry.options.name)) fatal.push(`${entry.options.name}: failed to load`);',
  '\t\t\telse report(entry, "failed to load — auto-isolated (other plugins unaffected)");',
  '\t\t}',
  '\t}',
  '\tfor (const entry of ctx.loader.entries()) {',
  '\t\tconst fiber = entry.fiber;',
  '\t\tif (fiber === void 0 || entry.disabled) continue;',
  '\t\tconst state = fiber.state;',
  '\t\tif (state === FIBER_ACTIVE) continue;',
  '\t\tif (state === FIBER_FAILED) {',
  '\t\t\ttry {',
  '\t\t\t\tawait fiber.await();',
  '\t\t\t} catch (error) {',
  '\t\t\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(entry.options.name)) fatal.push(`${entry.options.name}: ${formatActivationError(error)}`);',
  '\t\t\t\telse report(entry, "failed to activate: " + (error instanceof Error ? error.message : String(error)) + " — auto-isolated (other plugins unaffected)");',
  '\t\t\t}',
  '\t\t\tcontinue;',
  '\t\t}',
  '\t\tif (state === FIBER_PENDING) {',
  '\t\t\tconst missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === void 0);',
  '\t\t\tconst reason = "pending (waiting for " + (missing.join(", ") || "unknown") + ") — auto-isolated (other plugins unaffected)";',
  '\t\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(entry.options.name)) fatal.push(`${entry.options.name}: ${reason}`);',
  '\t\t\telse report(entry, reason);',
  '\t\t\tcontinue;',
  '\t\t}',
  '\t\tif (LOADER_PROTECTED_ENTRY_NAMES.has(entry.options.name)) fatal.push(`${entry.options.name}: fiber state ${String(state)}`);',
  '\t\telse report(entry, "fiber state " + String(state) + " — auto-isolated (other plugins unaffected)");',
  '\t}',
  '\tif (fatal.length > 0) throw new Error(`${binName}: core plugin(s) failed:\\n${fatal.join("\\n")}`);',
  '}',
].join('\n');

/**
 * dsh-app-boot/lib/index.js 变换：boot 的激活审计改为自动隔离
 * （无 fiber / 未激活 / pending 条目跳过并打标记；受保护核心仍 fatal）。
 * @returns {{status:'already'|'anchor-missing'|'changed', src?: string, detail?: string}}
 */
function transformLoaderActivationIsolation(src, file) {
  const crlf = src.includes('\r\n');
  const text = crlf ? src.replace(/\r\n/g, '\n') : src;
  const injected = text.includes('async function isolateInactiveEntries(');
  if (text.includes(LOADER_ACTIVATION_ISOLATION_MARKER) && injected) return { status: 'already' };
  if (!text.includes(APP_BOOT_BOOT_CALL_OLD) || !text.includes(APP_BOOT_INSERT_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 boot 审计锚点（版本可能已变更），跳过 ' + file };
  }
  let out = text.replace(APP_BOOT_BOOT_CALL_OLD, APP_BOOT_BOOT_CALL_NEW);
  out = out.replace(APP_BOOT_INSERT_ANCHOR, APP_BOOT_ISOLATION_CODE + '\n\n' + APP_BOOT_INSERT_ANCHOR);
  if (!out.includes(LOADER_ACTIVATION_ISOLATION_MARKER)) out = '// ' + LOADER_ACTIVATION_ISOLATION_MARKER + '\n' + out;
  return { status: 'changed', src: crlf ? out.replace(/\n/g, '\r\n') : out };
}

// ── dsh-app-boot：installFailLoud 就绪后不再 exit ────────────────────────────
const FAIL_LOUD_NO_RELEASE_OLD = [
  '\t\tif (release === void 0) {',
  '\t\t\tproc.exit(1);',
  '\t\t\treturn;',
  '\t\t}',
].join('\n');
const FAIL_LOUD_NO_RELEASE_NEW = [
  '\t\tif (release === void 0) {',
  '\t\t\tif (process.env.DSH_CRASH_SHIELD_ARMED === "1") {',
  '\t\t\t\tproc.stderr.write(`[crash-shield] isolated fatal load failure: ${err instanceof Error ? err.message : String(err)}\\n`);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t\tproc.exit(1);',
  '\t\t\treturn;',
  '\t\t}',
].join('\n');
const FAIL_LOUD_RELEASE_BLOCK_OLD = [
  '\t\t(async () => {',
  '\t\t\tlet timer;',
  '\t\t\ttry {',
  '\t\t\t\tawait Promise.race([(async () => release())(), new Promise((resolve) => {',
  '\t\t\t\t\ttimer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);',
  '\t\t\t\t})]);',
  '\t\t\t} catch {}',
  '\t\t\tclearTimeout(timer);',
  '\t\t\tproc.exit(1);',
  '\t\t})();',
].join('\n');
// 就绪后（已武装）绝不能执行 release：release 是「退出前把终端/插件树交还」的
// 拆除钩子——宿主要继续运行，执行它会把整棵树拆掉而进程存活（僵尸）。
// 武装判定必须在 release 之前，直接记录并返回。
const FAIL_LOUD_RELEASE_BLOCK_NEW = [
  '\t\t(async () => {',
  '\t\t\tif (process.env.DSH_CRASH_SHIELD_ARMED === "1") {',
  '\t\t\t\tproc.stderr.write(`[crash-shield] isolated fatal load failure: ${err instanceof Error ? err.message : String(err)}\\n`);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t\tlet timer;',
  '\t\t\ttry {',
  '\t\t\t\tawait Promise.race([(async () => release())(), new Promise((resolve) => {',
  '\t\t\t\t\ttimer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);',
  '\t\t\t\t})]);',
  '\t\t\t} catch {}',
  '\t\t\tclearTimeout(timer);',
  '\t\t\tproc.exit(1);',
  '\t\t})();',
].join('\n');

// 旧 transform 注入的「先 release 后判 armed」形态（已废弃；用于修复已打补丁的
// dev 树：release 先执行会把插件树拆掉而进程存活 → 僵尸宿主）。
const FAIL_LOUD_RELEASE_BLOCK_OLD_INJECTED = [
  '\t\t(async () => {',
  '\t\t\tlet timer;',
  '\t\t\ttry {',
  '\t\t\t\tawait Promise.race([(async () => release())(), new Promise((resolve) => {',
  '\t\t\t\t\ttimer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);',
  '\t\t\t\t})]);',
  '\t\t\t} catch {}',
  '\t\t\tclearTimeout(timer);',
  '\t\t\tif (process.env.DSH_CRASH_SHIELD_ARMED === "1") {',
  '\t\t\t\tproc.stderr.write(`[crash-shield] isolated fatal load failure: ${err instanceof Error ? err.message : String(err)}\\n`);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t\tproc.exit(1);',
  '\t\t})();',
].join('\n');

/**
 * dsh-app-boot/lib/index.js 变换：installFailLoud 在崩溃屏蔽已武装
 * （就绪横幅之后）时不再 exit(1)——就绪后的插件 rejection 被隔离；
 * 启动期（未武装）保持 fail-fast。
 * @returns {{status:'already'|'anchor-missing'|'changed', src?: string, detail?: string}}
 */
function transformFailLoudIsolation(src, file) {
  const crlf = src.includes('\r\n');
  const text = crlf ? src.replace(/\r\n/g, '\n') : src;
  // 幂等判定 = marker 存在 且 新形态注入体存在；仅 marker 残留（或旧形态
  // 「先 release 后判 armed」）都进入修复路径。
  if (text.includes(FAIL_LOUD_ISOLATION_MARKER) && text.includes(FAIL_LOUD_RELEASE_BLOCK_NEW)) return { status: 'already' };
  // 修复路径 1：旧注入形态 → 替换为「武装判定先于 release」的新形态。
  if (text.includes(FAIL_LOUD_RELEASE_BLOCK_OLD_INJECTED)) {
    const out = text.replace(FAIL_LOUD_RELEASE_BLOCK_OLD_INJECTED, FAIL_LOUD_RELEASE_BLOCK_NEW);
    return { status: 'changed', src: crlf ? out.replace(/\n/g, '\r\n') : out };
  }
  if (!text.includes(FAIL_LOUD_NO_RELEASE_OLD) || !text.includes(FAIL_LOUD_RELEASE_BLOCK_OLD)) {
    return { status: 'anchor-missing', detail: '未找到 installFailLoud 锚点（版本可能已变更），跳过 ' + file };
  }
  let out = text.replace(FAIL_LOUD_NO_RELEASE_OLD, FAIL_LOUD_NO_RELEASE_NEW);
  out = out.replace(FAIL_LOUD_RELEASE_BLOCK_OLD, FAIL_LOUD_RELEASE_BLOCK_NEW);
  if (!out.includes(FAIL_LOUD_ISOLATION_MARKER)) out = '// ' + FAIL_LOUD_ISOLATION_MARKER + '\n' + out;
  return { status: 'changed', src: crlf ? out.replace(/\n/g, '\r\n') : out };
}

module.exports = {
  LOADER_TREE_ISOLATION_MARKER,
  LOADER_ACTIVATION_ISOLATION_MARKER,
  FAIL_LOUD_ISOLATION_MARKER,
  markers: {
    LOADER_TREE_ISOLATION_MARKER,
    LOADER_ACTIVATION_ISOLATION_MARKER,
    FAIL_LOUD_ISOLATION_MARKER,
  },
  transformLoaderTreeIsolation,
  transformLoaderActivationIsolation,
  transformFailLoudIsolation,
};
