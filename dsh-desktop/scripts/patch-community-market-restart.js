'use strict';
// ---------------------------------------------------------------------------
// 一次性/可重放补丁脚本：dsh-community-market 客户端桌面监管重启适配
// （[desktop-restart-fix]，取代已退役的 patch-dshmarket-restart.js）。
//
// 背景：上游市场的「立即重启」走 POST /api/community-market/desktop/
// request-restart → host 半边 desktopActions.requestRestart()。在 DSH
// Desktop 里内核进程受壳层监管，重启权归壳层：桥接插件
// （dsh-market-desktop-bridge）的 requestRestart 是 no-op，实际重启应由
// 页面侧转接壳层桥 window.dshDesktop.restartService()（Tauri 命令
// restart-service：supervisor 记录 graceful restart 后原地拉起，不断链、
// 不进崩溃环）。直接让 host 自杀会触发壳层「服务意外退出」弹窗/恢复页。
//
// 本脚本在构建产物 client.js 上打锚点补丁（幂等：已含标记即跳过），
// 每次从上游源码重新构建市场包后需重跑一次。
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'assets', 'plugins', 'dsh-community-market', 'lib', 'client.js');
let text = fs.readFileSync(file, 'utf8');

// [module-table-bare-require] 上游构建产物可能带子路径 require
// ("@deepseek-ai/dsh-client-runtime/client")——内核模块表对 inject 图行按
// 裸包名注册，子路径形态必 miss（#124 整树加载失败形态）。重建后统一改写
// 为裸包名（package.json 的 dsh.client.external 已声明裸名，静态/动态契约
// 与真实 loader 三方一致）。幂等：无子路径形态即跳过。
const SUBPATH_REQUIRE = 'require("@deepseek-ai/dsh-client-runtime/client")';
const BARE_REQUIRE = 'require("@deepseek-ai/dsh-client-runtime")';
if (text.includes(SUBPATH_REQUIRE)) {
  text = text.split(SUBPATH_REQUIRE).join(BARE_REQUIRE);
  fs.writeFileSync(file, text);
  console.log('module-table bare require rewritten');
}

if (text.includes('[desktop-restart-fix]')) {
  console.log('already patched, skip');
  process.exit(0);
}

const anchor = 'async function requestMarketRestart(restartToken, signal) {\n  return await readJson(await fetch("/api/community-market/desktop/request-restart", {';
if (!text.includes(anchor)) {
  throw new Error('anchor missing: requestMarketRestart head changed — regenerate the patch (see scripts/patch-community-market-restart.js)');
}

const patched = [
  'async function requestMarketRestart(restartToken, signal) {',
  '  // [desktop-restart-fix] DSH Desktop 受监管环境：重启权归壳层。host 半边的',
  '  // desktopActions.requestRestart() 是 no-op；这里转接壳层桥',
  '  // window.dshDesktop.restartService()（原地监管重启，不走 host 自杀路径）。',
  '  // HTTP 确认仍先发（消费一次性 restartToken），再触发壳层重启。',
  '  try {',
  '    const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;',
  '    if (bridge !== undefined && typeof bridge.restartService === "function") {',
  '      await readJson(await fetch("/api/community-market/desktop/request-restart", {',
  '        method: "POST",',
  '        headers: { "content-type": "application/json" },',
  '        body: JSON.stringify({ restartToken }),',
  '        ...signal === void 0 ? {} : { signal }',
  '      }));',
  '      Promise.resolve().then(() => bridge.restartService()).catch(() => {});',
  '      return { ok: true };',
  '    }',
  '  } catch { /* 桥路径失败时回落原生 HTTP 重启路径 */ }',
  '  return await readJson(await fetch("/api/community-market/desktop/request-restart", {',
].join('\n');

text = text.replace(anchor, patched);
fs.writeFileSync(file, text);
console.log('patched OK:', file);
