'use strict';

// ---------------------------------------------------------------------------
// 单插件故障隔离收口。
//
// 三层「单插件不拖垮整树」统一收口：
//   1. transform 安全网：transformSlotErrorIsolation（registry 的
//      slot-error-isolation spec）——缺 key 时 warn + 派生 key，不 throw；
//   2. 只读预检：preScanPluginHealth 迁入，按 ui-slots 实际落盘 marker 判定
//      「已补丁 / 失配 / 未覆盖」三态；
//   3. 守护触发：plugin-guard.js 的 heal 触发/判定收口到健康检查管线
//      （P1-10），fault-isolation 只提供「预检结果」作为输入。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { markers } = require('../lib/patch-adapters');
const { SLOT_KEY_COMPAT_PKG_REL, resolveNmRoots } = require('../lib/patch-target-resolver');
const { checkServicePresence } = require('./composition-integrity');

/**
 * 预检目标 ui-slots（dsh-client-ui-slots/lib/index.js）实际会被写入的 marker。
 * 显式列出，避免从 registry 反推时误收「锚点只在 cordis-client-runner、其
 * marker 从不写入 ui-slots」的 slot-unkeyed-compat 补丁 marker（历史 QA 曾因此
 * 误报）。同时兼容 error-isolation 的 v1 / v2 两种标记（v2 修复了无条件 throw）。
 * @returns {string[]}
 */
function uiSlotsMarkers() {
  return [markers.SLOT_KEY_COMPAT_MARKER, markers.SLOT_ERROR_ISOLATE_MARKER, markers.SLOT_ERROR_ISOLATE_MARKER_V2];
}

// ---------------------------------------------------------------------------
// K1 自检兜底：宿主组合关键服务在位探测 + 修复（compositionPreflight）。
//
// 背景（2026-08 偶发「credentials service is absent」根因链的第 3 层防线）：
// dsh-base 的宿主组合固定挂载 `credentials → @deepseek-ai/dsh-credentials-local`
// （cordis.patch.yml），该包经 `$DSH_HOME/profiles/node_modules` fallback
// junction 解析。fallback 树半套/悬空时（heal 单点中断、便携安装被清理、双
// 安装并发 heal 竞态），loader-isolation 把导入失败静默降级，boot 照常成功，
// 用户直到在模型设置页保存 API key 才看到报错。
//
// 本探测在 sidecar preflight 阶段（内核 spawn 之前/之后均幂等）做静态断言：
// 关键服务包必须能从 profile 目录解析（profile 自有 node_modules → fallback
// junction → realpath package.json）。缺席则就地修复（把 fallback 链接重指向
// 本安装）；不可修复（真实目录占位等）则显式报告并给出指引——绝不让
// 「保存 key 才炸」成为用户看到问题的第一种方式。
//
// 只读 + 最小写入：仅对「关键服务名单」内的名字重建 junction；绝不删除
// 真实目录（可能是 pnpm hoisted 副本/用户数据，删除交给 repairProfileFallback
// 的白名单清理与用户决策）。
// ---------------------------------------------------------------------------

/** 宿主组合关键服务：loader 条目 id → 提供者包名（与 dsh-base 组合并行维护，扩充时同步 composition-integrity.criticalServices）。 */
const CRITICAL_SERVICE_ROWS = { credentials: '@deepseek-ai/dsh-credentials-local' };

/** @deepseek-ai/<pkg> 短名（junction 位于 fallback 的 scope 目录内）。 */
function scopeShortName(name) {
  return name.startsWith('@') && name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
}

/** 关键服务包能否从 profile 目录（profile nm → fallback junction）解析。 */
function criticalServiceResolvable(home, profile, name) {
  const short = scopeShortName(name);
  const localDir = path.join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', short);
  if (fs.existsSync(path.join(localDir, 'package.json'))) return true;
  const link = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', short);
  let real;
  try {
    real = fs.realpathSync(link);
  } catch {
    return false; // 不存在或悬空 junction
  }
  return fs.existsSync(path.join(real, 'package.json'));
}

/**
 * 宿主组合关键服务在位断言 + 修复。
 * @param {Object} ctx { home, appDir, log }（与 preflight 同层注入）
 * @returns {{checked: string[], repaired: Array<{id:string,name:string,from:string}>,
 *            broken: Array<{id:string,name:string,reason:string}>}}
 */
function compositionPreflight(ctx) {
  const report = { checked: [], repaired: [], broken: [] };
  for (const profile of ['web']) {
    for (const [id, name] of Object.entries(CRITICAL_SERVICE_ROWS)) {
      if (report.checked.includes(id)) continue;
      const short = scopeShortName(name);
      const installCopy = path.join(ctx.appDir, 'node_modules', '@deepseek-ai', short);
      // 安装副本不存在（测试夹具/异构布局）：静默跳过，不在错误的 appDir 上误报。
      if (!fs.existsSync(path.join(installCopy, 'package.json'))) continue;
      report.checked.push(id);
      if (criticalServiceResolvable(ctx.home, profile, name)) continue;
      const link = path.join(ctx.home, 'profiles', 'node_modules', '@deepseek-ai', short);
      let stat;
      try { stat = fs.lstatSync(link); } catch { stat = undefined; }
      try {
        if (stat === undefined) {
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.symlinkSync(installCopy, link, 'junction');
          report.repaired.push({ id, name, from: 'missing junction' });
        } else if (stat.isSymbolicLink()) {
          // 悬空/指向已消失安装的 junction：重指向本安装（与内核 heal 同语义）。
          fs.rmSync(link, { force: true, recursive: true, maxRetries: 3, retryDelay: 150 });
          fs.symlinkSync(installCopy, link, 'junction');
          report.repaired.push({ id, name, from: 'stale/dangling junction' });
        } else {
          // 真实目录/文件占位：不删（可能是 pnpm hoisted 副本或用户数据）。
          report.broken.push({ id, name, reason: link + ' 存在且不是 symlink（真实副本占位）；删除该目录后重启即可由 fallback 接管' });
          continue;
        }
      } catch (err) {
        report.broken.push({ id, name, reason: '修复失败: ' + ((err && err.message) || err) });
        continue;
      }
      if (!criticalServiceResolvable(ctx.home, profile, name)) {
        report.broken.push({ id, name, reason: '修复后仍不可解析: ' + link });
      }
    }
  }
  if (report.repaired.length > 0) {
    ctx.log('宿主组合关键服务自检: 已修复 profile 模块 fallback 链接（' +
      report.repaired.map((r) => r.name).join(', ') +
      '）——不修复的话保存 API key 会报 credentials service is absent');
  }
  if (report.broken.length > 0) {
    ctx.log('宿主组合关键服务自检失败: ' + JSON.stringify(report.broken) +
      ' — 本次启动保存 API key 将报「credentials service is absent」；按 reason 处理或重启 DSH Desktop 自动修复');
  }
  return report;
}

/**
 * 启动前 bundle 健康预检（只读，不修改任何文件）。
 * 扫描 profile bundle 的 dsh-client-ui-slots 副本，检查是否已被补丁覆盖；
 * 未覆盖时记录「版本差异」告警 + 升级建议（与旧 preScanPluginHealth 文案一致）。
 * @param {Object} ctx { home, appDir, userDataDir, log }
 * @returns {{scanned: number, unpatched: string[]}}
 */
function preflight(ctx) {
  try {
    const profileDir = path.join(ctx.home, 'profiles', 'web');
    const pkgJsonPath = path.join(profileDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return { scanned: 0, unpatched: [] };
    let pkgJson;
    try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')); } catch { return { scanned: 0, unpatched: [] }; }
    const bundles = (pkgJson['dsh'] && pkgJson['dsh'].profile && pkgJson['dsh'].profile.bundles) || [];
    if (!Array.isArray(bundles) || bundles.length === 0) return { scanned: 0, unpatched: [] };
    const nmRoots = resolveNmRoots(ctx, { layout: 'nm-roots' });
    // 局部用 slotMarkers 命名，避免遮蔽模块级的 markers 对象（单一导出源）。
    const slotMarkers = uiSlotsMarkers();
    const unpatched = [];
    for (const root of nmRoots) {
      const uiSlotsFile = path.join(root, '@deepseek-ai', SLOT_KEY_COMPAT_PKG_REL);
      if (!fs.existsSync(uiSlotsFile)) continue;
      try {
        const content = fs.readFileSync(uiSlotsFile, 'utf8');
        // 若三层补丁均未命中，说明 ui-slots 文件存在但锚点不匹配。
        const hasAnyPatch = slotMarkers.some((m) => content.includes(m));
        if (!hasAnyPatch) {
          unpatched.push(uiSlotsFile);
        }
      } catch {}
    }
    if (unpatched.length > 0) {
      ctx.log('插件健康预检: ui-slots 文件未被补丁覆盖（版本差异），slot 错误隔离可能未生效: ' + unpatched.join(', '));
      ctx.log('建议: 若启动后出现 "keyed slot requires options.key" 错误，请升级 DSH Desktop 或联系插件开发者添加 options.key');
    }
    const report = { scanned: nmRoots.length, unpatched };
    // 组合完整性（K1 修复 + K2 静态复核，统一常驻 composition 字段）：
    //   1. K1 compositionPreflight——关键服务（credentials 等）的 profile fallback
    //      junction 在位断言 + 悬空就地重建（半套树根因的自愈层）；
    //   2. K2 checkServicePresence——宿主组合 yml 全量服务行静态在位断言，
    //      Loader 故障隔离的静默降级在 boot 日志变成显式告警。
    // 顺序：先修复后复核，修复生效后 K2 复核应转绿。两者都只在真实 payload
    // （组合源/安装副本在位）时生效——空 home / 测试夹具不产生额外输出。
    const composition = { checked: [], repaired: [], broken: [], criticalMissing: [] };
    try {
      const k1 = compositionPreflight(ctx);
      composition.checked = k1.checked;
      composition.repaired = k1.repaired;
      composition.broken = k1.broken;
    } catch (err) {
      ctx.log('宿主组合关键服务自检异常（不影响启动）: ' + ((err && err.message) || err));
    }
    try {
      const baseYml = path.join(ctx.appDir || '', 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
      if (ctx.appDir && fs.existsSync(baseYml)) {
        const compositionCheck = checkServicePresence(ctx.appDir);
        if (!compositionCheck.ok) {
          for (const miss of compositionCheck.criticalMissing) {
            ctx.log('组合关键服务缺席: ' + miss.rowId + ' (' + miss.name + ') 状态=' + miss.status
              + ' → ' + miss.consequence + (miss.reason ? ' [' + miss.reason + ']' : ''));
          }
          ctx.log('建议: 完全退出并重启 DSH Desktop（启动链会尝试自动修复）；反复出现请导出诊断日志包反馈');
          composition.criticalMissing = compositionCheck.criticalMissing.map((m) => ({ rowId: m.rowId, name: m.name, status: m.status, consequence: m.consequence }));
        }
      }
    } catch (err) {
      ctx.log('组合完整性预检失败（不影响启动）: ' + ((err && err.message) || err));
    }
    report.composition = composition;
    return report;
  } catch (err) {
    ctx.log('插件健康预检失败（不影响启动）: ' + ((err && err.message) || err));
    return { scanned: 0, unpatched: [] };
  }
}

module.exports = { preflight, compositionPreflight, CRITICAL_SERVICE_ROWS, uiSlotsMarkers };
