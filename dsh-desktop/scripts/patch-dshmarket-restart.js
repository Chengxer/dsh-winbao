// 一次性补丁脚本：dshmarket 客户端桌面监管重启适配（[desktop-restart-fix]）
// 背景：dshmarket「立即重启」直连服务端自重启端点 /dsh-market/restart，
// 该端点 SIGTERM 掉被壳层监管的 dsh web 进程再 detached 拉起替身——壳层把
// 自杀当「服务意外退出」弹窗，替身脱离监管。桌面环境下应走 preload 暴露的
// window.dshDesktop.restartService()（chrome:restart-service，壳层原地监管重启）。
'use strict';
const fs = require('fs');
const path = require('path');

const f = path.join(__dirname, '..', 'assets', 'plugins', 'dshmarket', 'client', 'client.js');
let s = fs.readFileSync(f, 'utf8');
if (s.includes('[desktop-restart-fix]')) {
  console.log('already patched, skip');
  process.exit(0);
}

const NL = s.includes('\r\n') ? '\r\n' : '\n';
const TAB = '\t';

// 补丁 1：桥存在时即使服务端禁用自重启也允许显示重启按钮（走桥）
const anchor1 = 'setRestartEnabled(status.restart === true);';
if (!s.includes(anchor1)) throw new Error('anchor1 missing');
const bridgeCheck = '(typeof window !== "undefined" && window.dshDesktop !== undefined && typeof window.dshDesktop.restartService === "function")';
s = s.replace(
  anchor1,
  'setRestartEnabled(status.restart === true || ' + bridgeCheck + '); // [desktop-restart-fix] 桌面壳层桥可监管重启时也给按钮'
);

// 补丁 2：doRestart 优先走壳层桥；awaitNewBoot 的 boot-id 轮询逻辑原样复用
const anchor2 = TAB + TAB + TAB + 'const requestRestart = (attemptsLeft) => {';
if (!s.includes(anchor2)) throw new Error('anchor2 missing');
const bridgeRestart = [
  TAB + TAB + TAB + TAB + '// [desktop-restart-fix] 桌面壳层监管下走桥接重启（chrome:restart-service）：',
  TAB + TAB + TAB + TAB + '// 服务端自重启会 SIGTERM 掉被监管进程再拉游离替身，壳层会当「服务意外退出」弹窗。',
  TAB + TAB + TAB + TAB + 'const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;',
  TAB + TAB + TAB + TAB + 'if (bridge !== undefined && typeof bridge.restartService === "function") {',
  TAB + TAB + TAB + TAB + TAB + 'Promise.resolve().then(() => bridge.restartService()).catch(() => {});',
  TAB + TAB + TAB + TAB + TAB + 'awaitNewBoot();',
  TAB + TAB + TAB + TAB + TAB + 'return;',
  TAB + TAB + TAB + TAB + '}',
  '',
].join(NL);
s = s.replace(anchor2, bridgeRestart + anchor2);

fs.writeFileSync(f, s);
console.log('patched OK:', f);
