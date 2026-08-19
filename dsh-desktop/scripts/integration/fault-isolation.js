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
    return { scanned: nmRoots.length, unpatched };
  } catch (err) {
    ctx.log('插件健康预检失败（不影响启动）: ' + ((err && err.message) || err));
    return { scanned: 0, unpatched: [] };
  }
}

module.exports = { preflight, uiSlotsMarkers };
