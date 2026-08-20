'use strict';

// DSH Desktop — Electron shell around the DeepSeek Harness browser UI.
//
// What it does:
//   1. Boots the bundled dsh CLI ("dsh web") with a standalone Node runtime.
//   2. Waits until the web UI answers HTTP on 127.0.0.1:<free-port>.
//   3. Shows it in a native window; quits the server when the app exits.
//   4. Checks for official @deepseek-ai/dsh releases and, with the user's
//      consent, self-updates the agent (see updater.js).
//
// The dsh CLI is spawned with the bundled Node runtime (vendor/node/node.exe
// on Windows, vendor/node/node on macOS/Linux in dev; resources/node/...
// when packaged) so that prebuilt native modules (sharp, node-pty, koffi,
// ...) match the Node ABI they were installed for. We deliberately never
// rebuild them against Electron.

const { app, BrowserWindow, Menu, Tray, shell, dialog, Notification, ipcMain, clipboard, crashReporter, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');

const updater = require('./updater');
const clientUpdater = require('./client-updater');
const balance = require('./balance');
const { createBalanceScheduler } = require('./balance-scheduler');
const wslBackend = require('./wsl-backend');
const { createGpuCrashGuard } = require('./scripts/gpu-crash-guard');
const { installBuiltinPresets } = require('./scripts/install-minimal-win-preset');
const { SessionWatcher, scanZstdFrames } = require('./session-watcher');
const { RendererRecovery } = require('./renderer-recovery');
const { parseFailedLoaderIds, mapPackagesToPatchIds, findMissingBundleDeclarations, scanBundleContracts, removeBundlesFromProfile } = require('./profile-patch-heal');
// profile manifest 装配对账（唯一实现）：启动前把 dsh.profile.bundles 对账到
// 「每条登记都可装配」状态（无效登记移除 + 隔离记录、核心补齐、损坏重建、
// 重置恢复），配合 profile-bundle-heal 的运行时防护构成双层防线。
const { createEntryListYamlParser } = require('./scripts/lib/profile-reconcile');
// 统一补丁引擎与共享数据源（scripts/lib/）：main.js 的运行时补丁、同步脚本
// 与 after-pack 共用同一实现，杜绝重复与漂移。
const { COMPANION_PLUGINS } = require('./scripts/lib/companion-plugins');
const { writeFileAtomic } = require('./scripts/lib/patch-io');
// 内置 Agent 预设保护：客户端更新（覆盖安装）前快照用户改过的预设，更新后恢复。
const presetGuard = require('./scripts/lib/preset-guard');
// 「设置 → 插件 → 诊断与管理」：诊断 / 备份与恢复 / 日志包导出 / 防砖体检 /
// bundle 顺序检测与重排（纯函数模块，node --test 单测覆盖）。
const desktopDiagnostics = require('./scripts/desktop-diagnostics');
const desktopBackup = require('./scripts/desktop-backup');
const desktopOrdering = require('./scripts/desktop-ordering');
const desktopValidity = require('./scripts/desktop-validity');
const zlib = require('node:zlib');
// 插件保护中心（借鉴 EAC）：快照 / 回滚 / 静态体检 / 自动修复 / 守护启动 /
// 事故报告。跑在 Electron 主进程里，绝不动 harness 内核或用户会话数据。
const { createGuard } = require('./plugin-guard');
// 第三方插件集成层（同步 / 补丁 / 预检 / 故障隔离）唯一编排入口：main.js 只
// 调 createPluginIntegration + 细粒度方法，不再各自维护 syncCompanionPlugins
// 与 18 个 apply* 样板。
const { createPluginIntegration } = require('./scripts/integration');
// 插件中心（plugin-center）：插件管理子系统的唯一门面（清单 / 生命周期 /
// 更新 / 自动隔离 / IPC 能力策略 / 存活探针）。main.js 只接线，不持有业务逻辑。
const { createPluginCenter } = require('./scripts/plugin-core');
const { parseMarkers, createMarkerAccumulator } = require('./scripts/plugin-core/lib/markers');

// ---------------------------------------------------------------------------
// 启动期崩溃兜底（issue #30「便携版有进程无界面」）：模块加载 / 启动早期
// 的任何未捕获异常都落盘 <userData>/logs/startup-crash.log，且启动完成前置
// 可见错误框（绝不静默失败）。userData 可能尚未重定向，故便携版优先写到
// exe 旁 data/logs，失败再退回系统临时目录。
// ---------------------------------------------------------------------------
let bootFinished = false; // boot() 建窗完成后置 true，之后不再弹启动期错误框
function startupCrashLogFile() {
  let base;
  try {
    base = process.env.PORTABLE_EXECUTABLE_DIR
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
      : app.getPath('userData');
  } catch {
    base = path.join(os.tmpdir(), 'dsh-desktop');
  }
  const dir = path.join(base, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'startup-crash.log');
}
function recordStartupCrash(kind, err) {
  try {
    fs.appendFileSync(startupCrashLogFile(), `[${new Date().toISOString()}] [${kind}] ${(err && err.stack) || err}\n`, 'utf8');
  } catch {}
}
process.on('uncaughtException', (err) => {
  // 单处理器收敛（历史两处重复注册，boot 前会弹两个错误框）：
  // 启动崩溃取证 + 主进程日志 + 单个错误框。
  recordStartupCrash('uncaughtException', err);
  const stack = (err && (err.stack || err.message)) || String(err);
  log('crash', 'uncaughtException: ' + stack);
  try {
    if (!bootFinished) {
      dialog.showErrorBox('DSH Desktop JXZ 启动异常', String((err && err.message) || err) + '\n\n详细日志：' + startupCrashLogFile());
    } else {
      dialog.showErrorBox('DSH Desktop JXZ 遇到异常', '应用已记录该错误并继续运行。\n\n' + stack.slice(0, 500));
    }
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  recordStartupCrash('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  log('crash', 'unhandledRejection: ' + String((reason && (reason.stack || reason.message)) || reason));
});

// ---------------------------------------------------------------------------
// H2/H3 路径围栏：文件还原/打开只允许「会话 cwd」之下的项目文件。
// 任意绝对路径（如写入 Startup\*.bat）一律拒绝；缓存 5 分钟。
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;
const fileRootsCache = { at: 0, roots: [], sig: '' };
// 轻量会话清单签名：只收集 session.jsonl.zstd 文件路径（不做 zstd 解码，开销远小于
// fileRoots 的全量遍历+解压）。isUnderFileRoots 在 miss 时用它比对——若目录清单变化
// （新增会话目录），说明缓存滞后于新会话，应主动失效缓存而非干等冷却窗口，从而
// 避免「新建会话后约 5 秒内文件被围栏误拒」（issue #68）。
function sessionFilesSignature() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  walk(path.join(dshHome, 'sessions'));
  return out.join('\n');
}
// 强制刷新冷却：isUnderFileRoots 在 miss 时会强制失效缓存以兜住「TTL 内新建会话」，
// 但每次 miss 都强制刷新会被高频/恶意探测放大为「全目录遍历 + 逐文件 zstd 解压」
// 的本地 DoS（预览/还原服务监听 127.0.0.1，浏览器恶意页面即可触发）。用冷却窗口
// 把强制刷新限制为至多每 5s 一次；冷却期内的 miss 直接按当前缓存判定返回 false，
// 新会话由下一次冷却到期后的刷新或 5 分钟 TTL 自然收敛。
const FILE_ROOTS_FORCE_COOLDOWN_MS = 5000;
let fileRootsForceAt = 0;

function fileRoots() {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const roots = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.jsonl.zstd') continue;
      try {
        const buf = fs.readFileSync(p);
        const { frames } = scanZstdFrames(buf);
        if (frames.length === 0) continue;
        const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
        const header = JSON.parse(text.split('\n', 1)[0]);
        if (header && typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
      } catch { /* 跳过损坏日志 */ }
    }
  };
  walk(path.join(dshHome, 'sessions'));
  fileRootsCache.roots = [...new Set(roots)];
  fileRootsCache.at = Date.now();
  fileRootsCache.sig = sessionFilesSignature();
  return fileRootsCache.roots;
}

function isUnderFileRoots(p) {
  const resolved = path.resolve(p);
  // Windows 上路径比较大小写不敏感：同一真实文件的路径大小写变体（如
  // D:\QODER 与 D:\Qoder）应归一化后比较，避免合法文件被误拒（fail-closed
  // 不越权，但会破坏合法的打开/预览/还原）。
  const normalize = IS_WIN ? (s) => s.toLowerCase() : (s) => s;
  const nResolved = normalize(resolved);
  const check = () => fileRoots().some((r) => {
    const rp = normalize(path.resolve(r));
    return nResolved === rp || nResolved.startsWith(rp + path.sep);
  });
  if (check()) return true;
  // 缓存可能滞后于新会话：若会话目录清单已变化（新增/删除会话文件），主动失效
  // 缓存重新判定，不受强制刷新冷却窗口限制——这样新建会话后其 cwd 能立即进入
  // 围栏根集合，项目文件预览/打开/还原不被短暂误拒（issue #68）。
  if (fileRootsCache.sig && sessionFilesSignature() !== fileRootsCache.sig) {
    fileRootsCache.at = 0;
    return check();
  }
  if (Date.now() - fileRootsForceAt < FILE_ROOTS_FORCE_COOLDOWN_MS) return false;
  fileRootsForceAt = Date.now();
  fileRootsCache.at = 0;
  return check();
}

const IS_WIN = process.platform === 'win32';
const APP_VERSION = app.getVersion();
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverProc = null;
let webUrl = null;
let quitting = false;
let updateBusy = false;
let notifyOnTurnEnd = true;
let currentSessionId = ''; // 主窗当前正在观看的会话（渲染进程上报），现仅用于完成通知的调试日志
let sessionWatcher = null;
let supervision = null; // dsh web 服务存活探针（防「假活」）
let userDataDir = '';
let logsDir = '';
let dshHome = '';
let desktopLog = null;
let tray = null;
let forceQuit = false;
let clientUpdateBusy = false;
let balanceCache = null;
let balanceScheduler = null; // 余额刷新编排器（节流/并发仲裁/退避重试，见 balance-scheduler.js）
let restartingServer = false;
let trayRecoveryTimer = null;
let backendMode = 'local'; // local | wsl（WSL 托管后端见 wsl-backend.js）
let wslFallbackReason = ''; // WSL 模式探测失败回落 local 的原因（设置页/日志展示）
let recovery = null; // 渲染进程崩溃/挂起自恢复状态机（renderer-recovery.js）
let crashDumpsDir = "";
let pickerBrowseOverlay = null; // koffi 预检失败时注入的目录选择器降级 overlay
let epermRepairAttempted = false; // EPERM/symlink 自愈每次运行只尝试一次
// 诊断与管理的互斥写（恢复 / bundle 顺序写回 / 移除失效条目）：都是写 profile
// 文件的操作，并发执行会互相覆盖，串行化。
let diagMutationBusy = false;
// plugin-guard 的变更操作（快照/修复/回滚）互斥：与诊断写同源，串行化并
// 纳入存活探针 isBusy（探活失败期间正有配置变更时不误判假活）。
let guardMutationBusy = false;
// 恢复文件只能来自系统文件选择框。预览后签发一次性令牌并绑定内容哈希，
// 确认恢复时不接受渲染层提供的任意本地路径。
let pendingBackupRestore = null;
// bundle 契约（declares no dsh.bundle）自愈每次运行只尝试一次（主动扫描挂
// 在启动成功路径、失败兜底挂在 handleBootFailure，共用同一守卫防重复）。
let bundleContractRepairAttempted = false;

// ---------------------------------------------------------------------------
// 会话浮窗（分屏）：把会话弹出到独立窗口
// ---------------------------------------------------------------------------
const FLOAT_MAX = 8; // 浮窗总数上限，防资源滥用
const floatWindows = new Set(); // BrowserWindow 集合
const floatBySession = new Map(); // sessionId -> BrowserWindow（同一会话只允许一个浮窗）
let sponsorWindow = null; // 「请作者喝咖啡」独立小窗（单例）

// ---------------------------------------------------------------------------
// 桌面宠物原生小窗（harness-pet）：主窗最小化后宠物仍可见。
// 插件 PiP 方案在 Electron 里不可用（requestWindow 抛 Internal error），
// 这里用独立透明置顶 BrowserWindow 承载同一 Web UI 的「宠物小窗模式」
// （--dsh-pet=1，preload 据此隐藏除宠物外的全部界面）。
// ---------------------------------------------------------------------------
const PET_WINDOW_W = 360;
const PET_WINDOW_H = 420;
let petWindow = null; // 宠物小窗单例（BrowserWindow）
let petAutoOpen = false; // 主窗插件上报：宠物启用且开启「最小化自动弹出小窗」
let petPosTimer = null; // 小窗位置防抖保存定时器

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
  try { if (desktopLog) desktopLog.write(line); } catch {}
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// 运行状态标记 + 看门狗（防“进程/托盘凭空消失且无任何提醒”）
// ---------------------------------------------------------------------------

function runStatePath() {
  return path.join(userDataDir, 'run-state.json');
}

function writeRunState(extra = {}) {
  try {
    // 原子写（tmp + rename）：看门狗每 2s 读一次 run-state.json，直接
    // truncate-then-write 会让看门狗读到撕裂内容（JSON.parse 失败 → 误判
    // 进程已消失 → 拉起重复实例，或丢失 cleanExit 标记）。
    writeFileAtomic(runStatePath(), JSON.stringify({
      pid: process.pid,
      exe: process.execPath,
      cleanExit: false,
      startedAt: new Date().toISOString(),
      version: APP_VERSION,
      ...extra,
    }));
  } catch (err) {
    log('watchdog', '写运行状态失败: ' + err.message);
  }
}

function markCleanExit() {
  try {
    const p = runStatePath();
    let state = {};
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    state.cleanExit = true;
    state.endedAt = new Date().toISOString();
    writeFileAtomic(p, JSON.stringify(state));
  } catch (err) {
    log('watchdog', '写退出标记失败: ' + err.message);
  }
}

function detectUncleanPreviousRun() {
  try {
    const prev = JSON.parse(fs.readFileSync(runStatePath(), 'utf8'));
    if (prev && prev.cleanExit !== true && prev.pid && Number(prev.pid) !== process.pid) {
      log('crash', '检测到上次运行未正常退出: ' + JSON.stringify(prev));
      return prev;
    }
  } catch {}
  return null;
}

// Electron 的 Notification 若无 JS 侧强引用可能被 GC 而永不显示：
// 统一持有引用到 close 再释放（内存有界），全部系统通知共用此入口。
const activeNotifications = new Set();
function showNotification({ title, body, onClick } = {}) {
  try {
    const n = new Notification({
      title: String(title || ''),
      body: String(body || ''),
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    activeNotifications.add(n);
    n.on('close', () => activeNotifications.delete(n));
    // 点击系统通知默认回到应用前台：Windows toast 的点击激活依赖
    // AppUserModelID（boot() 里 setAppUserModelId）+ 开始菜单快捷方式
    //（maintainShortcuts 同 id 创建），二者均已就绪。showMainWindow 覆盖
    // 最小化/隐藏/失焦/关闭到托盘/窗口销毁后重建等全部恢复路径；调用方可
    // 传自定义 onClick 覆盖（如通知里带操作语义时）。
    n.on('click', () => {
      try {
        if (typeof onClick === 'function') onClick();
        else showMainWindow();
      } catch (err) {
        log('notify', '通知点击处理失败: ' + err.message);
      }
    });
    n.show();
    return n;
  } catch {
    return null;
  }
}

function notifyUncleanRestart(prev) {
  try {
    const started = prev && prev.startedAt ? new Date(prev.startedAt) : null;
    const when = started && !Number.isNaN(started.getTime())
      ? started.toLocaleString('zh-CN', { hour12: false })
      : '上次';
    showNotification({
      title: 'DSH Desktop JXZ 已自动恢复',
      body: `检测到应用在 ${when} 前后未正常退出，看门狗已重新启动应用。`,
      onClick: () => showMainWindow(),
    });
  } catch (err) {
    log('crash', '恢复通知发送失败: ' + err.message);
  }
}

function startWatchdog() {
  // 仅安装版启用：开发模式下重启 Electron 会与调试流程互相干扰。
  if (!app.isPackaged || !IS_WIN) return;
  const watchdogJs = path.join(__dirname, 'watchdog.js');
  if (!fs.existsSync(watchdogJs)) return;
  try {
    const child = spawn(nodeExe(), [
      watchdogJs,
      '--pid=' + process.pid,
      '--exe=' + process.execPath,
      '--state=' + runStatePath(),
      '--log=' + path.join(logsDir, 'watchdog.log'),
    ], {
      cwd: path.dirname(process.execPath),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    log('watchdog', `看门狗已启动 pid=${child.pid}`);
  } catch (err) {
    log('watchdog', '看门狗启动失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// profile fallback 自愈：dsh 要求 $DSH_HOME/profiles/node_modules 下属于
// 依赖闭包的包必须是指向其真实安装位置的符号链接。用户迁移/复制/云同步
// DSH_HOME 时这些链接常被还原成真实目录，dsh web 会以 exit code 1 启动失败。
// 这里在每次启动 dsh 前调用官方 healProfilesModuleFallback；它若报
// "exists and is not a symlink"，就移除该真实目录后重试，直到修复完成。
//
// 启动提速：健康状态下（依赖闭包未变、链接完好）用持久化快照做快速校验
// （逐项 lstat/readlink），全部一致就直接跳过耗时的
// import('@deepseek-ai/dsh-app-boot') + BFS + heal。快照签名包含 dsh
// package.json 的路径/大小/mtime，dsh 升级后自动失效重算（升级后首次
// 启动仍会完整 heal 一次，之后走快速路径）。
// ---------------------------------------------------------------------------
function dshPackageJson() {
  const bin = dshBin();
  const candidates = [
    path.join(path.dirname(bin), 'package.json'),
    path.join(path.dirname(bin), '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  try { return require.resolve('@deepseek-ai/dsh/package.json'); } catch { return candidates[1]; }
}

function fallbackSnapshotPath() {
  return path.join(userDataDir, 'profile-fallback-cache.json');
}

function fallbackAnchorSignature(anchor) {
  try {
    const st = fs.statSync(anchor);
    return anchor + '|' + st.size + '|' + Math.round(st.mtimeMs);
  } catch {
    return anchor + '|?';
  }
}

// 快照当前 fallback 目录：链接名（可能带 @scope 前缀）→ readlink 目标。
// heal 创建的链接里 @scope 目录本身是真实目录、包 junction 在它里面，所以
// 递归收集 `scope/pkg`；任何既不是 junction、也不是 @scope 真实目录的顶层
// 项（云同步还原成真实目录的典型症状）都返回 null，表示需要完整 heal。
function snapshotFallbackLinks(modulesRoot) {
  const entries = {};
  const addLink = (name) => {
    const link = path.join(modulesRoot, name);
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) return false;
      entries[name] = fs.readlinkSync(link);
      return true;
    } catch {
      return false;
    }
  };
  let top;
  try { top = fs.readdirSync(modulesRoot, { withFileTypes: true }); } catch { return null; }
  for (const e of top) {
    let st;
    try { st = fs.lstatSync(path.join(modulesRoot, e.name)); } catch { return null; }
    if (st.isSymbolicLink()) {
      if (!addLink(e.name)) return null;
      continue;
    }
    if (st.isDirectory() && e.name.startsWith('@')) {
      let inner;
      try { inner = fs.readdirSync(path.join(modulesRoot, e.name)); } catch { return null; }
      for (const pkg of inner) {
        if (!addLink(e.name + '/' + pkg)) return null;
      }
      continue;
    }
    return null;
  }
  return entries;
}

function verifyFallbackSnapshot(home, anchor, cache) {
  if (!cache || cache.v !== 1) return false;
  if (cache.home !== home || cache.anchor !== anchor) return false;
  if (cache.anchorSignature !== fallbackAnchorSignature(anchor)) return false;
  const expected = cache.entries;
  if (!expected || typeof expected !== 'object') return false;
  const names = Object.keys(expected);
  if (names.length === 0) return false;
  const modulesRoot = path.join(home, 'profiles', 'node_modules');
  for (const name of names) {
    const link = path.join(modulesRoot, name);
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) return false;
      if (fs.readlinkSync(link) !== expected[name]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function saveFallbackSnapshot(home, anchor, entries) {
  try {
    fs.writeFileSync(fallbackSnapshotPath(), JSON.stringify({
      v: 1,
      home,
      anchor,
      anchorSignature: fallbackAnchorSignature(anchor),
      entries,
    }));
  } catch (err) {
    log('boot', '写 profile fallback 快照失败: ' + err.message);
  }
}

async function repairProfileFallback(home) {
  const anchor = dshPackageJson();
  const modulesRoot = path.join(home, 'profiles', 'node_modules');
  // 快速路径：快照存在且逐项校验通过 → 跳过 import + BFS + heal。
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(fallbackSnapshotPath(), 'utf8')); } catch {}
  if (verifyFallbackSnapshot(home, anchor, cache)) {
    log('boot', 'profile fallback 健康（快照校验通过，跳过修复）');
    return;
  }
  let bootMod;
  try {
    bootMod = await import('@deepseek-ai/dsh-app-boot');
  } catch (err) {
    log('boot', 'profile fallback 修复模块不可用: ' + err.message);
    return;
  }
  if (typeof bootMod.healProfilesModuleFallback !== 'function') return;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      bootMod.healProfilesModuleFallback(anchor, home);
      if (attempt > 0) log('boot', `profile fallback 已修复（重试 ${attempt} 次）`);
      // 修复成功后记录健康快照，下次启动走快速校验。
      const snap = snapshotFallbackLinks(modulesRoot);
      if (snap) saveFallbackSnapshot(home, anchor, snap);
      return;
    } catch (err) {
      const message = String((err && err.message) || err);
      const match = /dsh: (.+) exists and is not a symlink/.exec(message);
      if (!match) {
        log('boot', 'profile fallback 修复失败: ' + message);
        return;
      }
      const badPath = match[1].trim();
      // 只清理 DSH_HOME 自己的 profile fallback 目录，拒绝越界删除。
      if (badPath !== modulesRoot && !badPath.startsWith(modulesRoot + path.sep)) {
        log('boot', '拒绝清理 profile fallback 之外的路径: ' + badPath);
        return;
      }
      log('boot', '检测到 profile fallback 非符号链接，移除并重试: ' + badPath);
      try { fs.rmSync(badPath, { recursive: true, force: true }); } catch (rmErr) {
        log('boot', '移除失败: ' + rmErr.message);
        return;
      }
    }
  }
}


// 主进程未捕获异常统一在文件顶部的单处理器记录（启动崩溃取证 + 日志 + 错误框），
// 这里不再重复注册第二个 uncaughtException/unhandledRejection 处理器。

process.on('exit', (code) => {
  const line = `[${new Date().toISOString()}] [crash] 主进程退出 code=${code}\n`;
  try {
    const lp = path.join(app.getPath('userData'), 'logs', 'desktop.log');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.appendFileSync(lp, line);
  } catch {}
  // 兜底：无论走哪条退出路径（含 app.exit 与异常退出），都同步终结 dsh
  // 进程树，兑现「退出即清理、不留孤儿进程」。正常退出路径此时已是空操作。
  killTreeSync(serverProc);
});

function nodeExe() {
  // Windows 用 node.exe，macOS/Linux 用无后缀的 node 可执行文件。
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', exeName);
  return path.resolve(__dirname, 'vendor', 'node', exeName);
}

function npmCli() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js');
  return path.resolve(__dirname, 'vendor', 'npm', 'bin', 'npm-cli.js');
}

// Context shared with the updater module.
function updCtx() {
  return { userDataDir, nodeExe, npmCli, log };
}

// Updated overlay (user-approved official release) takes precedence over the
// bundled copy; the bundled copy is the fallback.
function dshBin() {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) return ov;
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

function dshVersion() {
  if (isWslMode()) return wslBackend.activeVersion() || '未知';
  return updater.activeVersion(updCtx()) || '未知';
}

function dshVersionSource() {
  if (isWslMode()) return 'WSL 托管（' + wslBackend.installDirLinux() + '）';
  return updater.overlayVersion(updCtx()) ? '用户目录（已更新）' : '内置';
}

// ---------------------------------------------------------------------------
// dsh 进程树终结
//
// Windows 下 taskkill 不带 /F 只能向 GUI 进程发送 WM_CLOSE，对 node.exe 这类
// 控制台进程完全无效（实测报错 "can only be terminated forcefully"）。旧实现
// 「先优雅（无 /F）、1.5s 后再 /F 强杀」对 dsh web 从未优雅成功过：实际生效的
// 始终是 1.5s 后的 /F。由此产生两个真实缺陷：
//   1. 原地重启（插件市场）：优雅尝试无效，旧进程在「探测端口」时仍存活并
//      占着端口 → chooseStableWebPort 探测失败 → 换新端口 → origin 漂移 →
//      localStorage（会话分组/主题/隐藏输出等偏好）全部丢失；
//   2. 退出路径：主进程退出耗时通常远小于 1.5s（本机实测约 300ms），计时器
//      随主进程消亡永不触发，进程树清理完全依赖 Electron 的隐式行为，无任何保证。
// 因此拆分为两个 API：
//   · killTree —— 异步：立即以 /T /F 终结进程树并等待直接子进程 exit（3s
//     超时兜底）。供「原地重启」路径使用，调用方必须在探测端口前等待其完成。
//   · killTreeSync —— 同步强杀：供应用退出路径使用，保证主进程退出前
//     dsh 进程树已被终结，不依赖计时器或 Electron 隐式行为。
// 两处最终都是 /T /F 强杀，与旧实现实际生效的终结方式一致；只移除了无效的
// 优雅等待与竞态窗口，不改变「dsh 最终收到强杀」这一既有事实。
// ---------------------------------------------------------------------------
function killTreeSync(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  // WSL 托管模式：WSL 内进程经 pid 文件发 SIGTERM（绝不 wsl --terminate）；
  // 同步退出路径只能触发 stop 并强杀 wsl.exe 转发进程，不等待 WSL 内退出。
  if (isWslMode()) {
    wslBackend.stop().catch((err) => log('killTree', '停止 WSL dsh 失败: ' + String(err && err.message || err)));
    try { proc.kill(); } catch {}
    return;
  }
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
    }
  } catch (err) {
    log('killTree', String(err));
  }
}

async function killTree(proc) {
  // WSL 托管模式：等待 WSL 内进程按 pid 文件真正退出后再进入端口探测；
  // pid 丢失时兜底杀掉 wsl.exe 转发进程。
  if (isWslMode()) {
    try { await wslBackend.stop(); } catch (err) { log('killTree', '停止 WSL dsh 失败: ' + String(err && err.message || err)); }
    if (proc && proc.pid && proc.exitCode === null) {
      try { proc.kill(); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return;
  }
  return new Promise((resolve) => {
    if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let done = false; // finish 幂等守卫：exit / taskkill error / 兜底定时器可能同时触发
    const finish = () => {
      if (done) return;
      done = true;
      proc.removeListener('exit', finish);
      resolve();
    };
    proc.once('exit', finish);
    if (!IS_WIN) {
      // 非 Windows：保持原有语义（SIGTERM），等待进程退出（超时兜底）。
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      const timer = setTimeout(finish, 3000);
      if (timer.unref) timer.unref();
      return;
    }
    // spawn 的 'error' 事件异步抛出（taskkill 不可用 / PATH 损坏时），try/catch
    // 抓不到；不挂监听器会冒到 uncaughtException。挂上后与兜底定时器一起收敛到
    // finish（幂等，多次触发安全）。
    let tk;
    try {
      tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      log('killTree', String(err));
      finish();
      return;
    }
    if (tk) tk.on('error', (err) => { log('killTree', 'taskkill error: ' + String((err && err.message) || err)); finish(); });
    // 兜底：taskkill 异常或进程未按时退出时，不得让重启流程永久挂起。
    const timer = setTimeout(finish, 3000);
    if (timer.unref) timer.unref();
  });
}

// Environment for the dsh child: drop harness/session leftovers so the
// desktop instance boots clean, keep everything else (proxy, API keys, ...).
function childEnv() {
  const env = { ...process.env };
  for (const k of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    delete env[k];
  }
  if (dshHome) env.DSH_HOME = dshHome;
  env.NO_COLOR = '1';
  // 监管标识：dsh web 由本壳层 spawn/看管，重启权归壳层（chrome:restart-service）。
  // 插件（如 dshmarket 的自重启端点）见到此标识必须放弃进程自杀式重启，
  // 否则壳层会把自杀当「服务意外退出」弹窗，且游离的替身进程脱离监管。
  env.DSH_DESKTOP_SUPERVISED = '1';
  return env;
}

// ---------------------------------------------------------------------------
// koffi 预检与目录选择器降级：koffi 3.1.3/3.1.4 的 win32-x64 预编译二进制在
// 部分 Windows 机器上会在 load 时原生崩溃（0xC0000005），目录选择器 worker
// 会无消息退出。启动前用内置 node 在子进程里做一次 FFI 冒烟；失败则注入
// browse 后端 overlay，让客户机器不再卡在 native 目录选择器上。
// ---------------------------------------------------------------------------
function koffiPreflightScript() {
  return path.join(__dirname, 'scripts', 'koffi-preflight.cjs');
}

function pickerBrowseOverlayPath() {
  return path.join(userDataDir, 'picker-browse.overlay.yml');
}

function runKoffiPreflight() {
  if (!IS_WIN) return true;
  const script = koffiPreflightScript();
  if (!fs.existsSync(script)) {
    log('preflight', 'koffi 预检脚本不存在，跳过（视为通过）');
    return true;
  }
  // 启动提速：koffi 冒烟探针的结果只取决于壳自带二进制（node.exe、探针脚本、
  // koffi 预编译模块）。同一签名在本机已通过时直接复用缓存，省去每次启动
  // spawnSync 子进程（约 100ms+）。只缓存「通过」：失败不缓存，下次启动仍会
  // 重试，保证被安全软件误拦等瞬时失败可以自恢复。
  const signature = koffiPreflightSignature();
  if (koffiCachedPass(signature)) {
    log('preflight', 'koffi 预检缓存命中（同签名上次已通过），跳过子进程探测');
    return true;
  }
  try {
    const r = spawnSync(nodeExe(), [script], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
    const output = String((r.stdout || '') + (r.stderr || '')).trim();
    if (r.error) {
      log('preflight', 'koffi 预检无法执行: ' + r.error.message);
      return false;
    }
    if (r.status === 0) {
      saveKoffiPreflightPass(signature);
      log('preflight', 'koffi 预检通过');
      return true;
    }
    log('preflight', `koffi 预检失败（退出码 0x${(r.status >>> 0).toString(16)}）: ${output.slice(0, 400)}`);
    return false;
  } catch (err) {
    log('preflight', 'koffi 预检异常: ' + err.message);
    return false;
  }
}

// koffi 预检缓存：签名 = 壳版本 + node.exe + 探针脚本 + koffi 包内全部 .node
// 二进制（路径/大小/mtime）。任一环节随应用升级或文件被替换而变化 → 缓存
// 自动失效，下一次启动重新真实预检。
function koffiPreflightCachePath() {
  return path.join(userDataDir, 'koffi-preflight-cache.json');
}

function koffiPreflightSignature() {
  const parts = [APP_VERSION];
  const statParts = [nodeExe(), koffiPreflightScript()];
  const koffiDir = path.join(__dirname, 'node_modules', 'koffi');
  statParts.push(path.join(koffiDir, 'index.cjs'), path.join(koffiDir, 'package.json'));
  const collectNode = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) collectNode(p, depth + 1); continue; }
      if (e.name.endsWith('.node')) statParts.push(p);
    }
  };
  collectNode(koffiDir, 0);
  for (const p of statParts) {
    try {
      const st = fs.statSync(p);
      parts.push(p + '|' + st.size + '|' + Math.round(st.mtimeMs));
    } catch {
      parts.push(p + '|?');
    }
  }
  return parts.join('\n');
}

function koffiCachedPass(signature) {
  try {
    const c = JSON.parse(fs.readFileSync(koffiPreflightCachePath(), 'utf8'));
    return !!(c && c.v === 1 && c.signature === signature && c.ok === true);
  } catch {
    return false;
  }
}

function saveKoffiPreflightPass(signature) {
  try {
    fs.writeFileSync(koffiPreflightCachePath(), JSON.stringify({
      v: 1,
      signature,
      ok: true,
      at: new Date().toISOString(),
    }));
  } catch (err) {
    log('preflight', '写 koffi 预检缓存失败: ' + err.message);
  }
}

const PICKER_BROWSE_OVERLAY_MARKER = '# DSH-DESKTOP-AUTO: picker browse fallback';

function enablePickerBrowseOverlay() {
  const file = pickerBrowseOverlayPath();
  const content = [
    PICKER_BROWSE_OVERLAY_MARKER,
    '# koffi 预检未通过：禁用 native 目录选择器，改用浏览器内 browse 选择器。',
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: directory-picker-browse-client',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n');
  try {
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch {}
    if (prev === content) {
      pickerBrowseOverlay = file;
      return;
    }
    fs.writeFileSync(file, content);
    pickerBrowseOverlay = file;
    log('preflight', '已启用目录选择器降级 overlay: ' + file);
  } catch (err) {
    log('preflight', '写入目录选择器降级 overlay 失败: ' + err.message);
  }
}

function clearAutoPickerBrowseOverlay() {
  const file = pickerBrowseOverlayPath();
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(PICKER_BROWSE_OVERLAY_MARKER)) return;
    fs.rmSync(file, { force: true });
    if (pickerBrowseOverlay === file) pickerBrowseOverlay = null;
    log('preflight', 'koffi 预检已恢复，移除目录选择器降级 overlay');
  } catch (err) {
    log('preflight', '移除目录选择器降级 overlay 失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 安全启动：dsh web 退出码 1 且日志含 plugin tree 加载失败时，解析出失败的
// patch 插件 id，写入 --patch overlay 禁用后重试。overlay 不修改用户 patch。
// ---------------------------------------------------------------------------
function dshWebLogPath() {
  return path.join(logsDir, 'dsh-web.log');
}

// 日志体积封顶与尾部读取（资源治理）：desktop.log / dsh-web.log 无界追加，
// 长期运行会膨胀到数百 MB。启动时超过上限只保留尾部；读取侧统一改为
// 「fd 定位读末尾定长字节」，把诊断路径的成本从 O(日志大小) 降为 O(1)。
const MAX_LOG_BYTES = 4 * 1024 * 1024; // 超过即封顶
const LOG_KEEP_BYTES = 256 * 1024; // 封顶后保留的尾部字节
const LOG_TAIL_READ_BYTES = 256 * 1024; // 诊断读取的最多字节

/** 读取文件末尾最多 maxBytes 字节；文件缺失返回空串。 */
function readFileTailText(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size <= 0) return '';
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    let pos = 0;
    try {
      while (pos < len) {
        const n = fs.readSync(fd, buf, pos, len - pos, st.size - len + pos);
        if (n <= 0) break;
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    return buf.subarray(0, pos).toString('utf8');
  } catch {
    return '';
  }
}

/** 启动时封顶日志：超过 MAX_LOG_BYTES 则原子地只保留尾部 LOG_KEEP_BYTES。 */
function capLogFile(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_LOG_BYTES) return;
    const keep = Math.min(st.size, LOG_KEEP_BYTES);
    const tail = Buffer.alloc(keep);
    const fd = fs.openSync(file, 'r');
    let pos = 0;
    try {
      while (pos < keep) {
        const n = fs.readSync(fd, tail, pos, keep - pos, st.size - keep + pos);
        if (n <= 0) break;
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    const tmp = file + '.cap';
    fs.writeFileSync(tmp, tail.subarray(0, pos));
    fs.renameSync(tmp, file);
    log('boot', '日志已封顶: ' + file + ' (' + st.size + ' -> ' + pos + ' bytes)');
  } catch (err) {
    log('boot', '日志封顶失败 ' + file + ': ' + err.message);
  }
}

/** 清理超过保留期的崩溃转储（只动 *.dmp，settings.dat 与本次新转储不受影响）。 */
function pruneOldCrashDumps() {
  const MAX_DMP_AGE_MS = 14 * 24 * 3600 * 1000;
  try {
    const now = Date.now();
    for (const e of fs.readdirSync(crashDumpsDir)) {
      if (!e.endsWith('.dmp')) continue;
      const p = path.join(crashDumpsDir, e);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > MAX_DMP_AGE_MS) {
          fs.rmSync(p, { force: true });
          log('boot', '已清理过期崩溃转储: ' + e);
        }
      } catch {}
    }
  } catch {}
}

function readDshWebLogTail(maxLines = 80) {
  try {
    const file = dshWebLogPath();
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return ''; }
    const text = readFileTailText(file, LOG_TAIL_READ_BYTES);
    // 从文件中部起读时首行可能是半行：丢弃，避免产生半行/乱码 token。
    const lines = text.split(/\r?\n/);
    if (size > LOG_TAIL_READ_BYTES && lines.length > 0) lines.shift();
    return lines.filter(Boolean).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

function logTailSnippet(maxLines = 20) {
  const tail = readDshWebLogTail(maxLines);
  return tail ? '\n\n最近日志：\n' + tail : '';
}

// loader 失败条目的三种 id 形态解析已收口到 profile-patch-heal.js
// （parseFailedLoaderIds，含 issue #17 的 "duplicate loader entry id: X" 与
// 括号包名形态），这里不再保留本地实现。

function profilePatchText() {
  // WSL 托管模式下 DSH_HOME 是 WSL 安装目录的 UNC 等价路径（effectiveDshHome），
  // 不是本机 ~/.dsh：安全启动自愈必须读实际生效的 profile（历史 bug：这里用
  // 本地 dshHome，WSL 模式下 overlay 判定读到无关文件，用户拿不到坏插件自愈）。
  const patchFile = path.join(effectiveDshHome() || path.join(os.homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml');
  try { return fs.readFileSync(patchFile, 'utf8'); } catch { return ''; }
}

function profilePatchIds() {
  const text = profilePatchText();
  const ids = new Set();
  const re = /(?:^|\n)\s*-\s*id:\s*([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

function findFailedPatchPlugins() {
  const tokens = parseFailedLoaderIds(readDshWebLogTail(120));
  const known = new Set(profilePatchIds());
  // 括号包名（@scope/pkg）不是 patch id：先映射回条目 id 再参与 overlay 判定；
  // 其余 token（hash 形态与 duplicate loader entry id: X 形态）按既有逻辑过滤。
  const packages = tokens.filter((t) => t.includes('/'));
  const mapped = mapPackagesToPatchIds(profilePatchText(), packages);
  return [...new Set([...tokens.filter((t) => !t.includes('/')), ...mapped])].filter((id) => known.has(id));
}

function safeBootOverlayPath() {
  return path.join(userDataDir, 'safe-boot.overlay.yml');
}

function ensureSafeBootOverlay(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const file = safeBootOverlayPath();
  const existing = new Set();
  try {
    const text = fs.readFileSync(file, 'utf8');
    const re = /(?:^|\n)\s*-\s*id:\s*([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) existing.add(m[1]);
  } catch {}
  const merged = [...new Set([...existing, ...ids])];
  const content = [
    '# DSH Desktop 安全启动 overlay（自动生成）：以下插件启动失败，已被自动禁用。',
    '# 修复插件后可删除本文件恢复。',
    ...merged.map((id) => `- id: ${id}\n  disabled: true`),
    '',
  ].join('\n');
  try {
    fs.writeFileSync(file, content);
    log('boot', '已生成安全启动 overlay（禁用: ' + merged.join(', ') + '）: ' + file);
    return file;
  } catch (err) {
    log('boot', '写入安全启动 overlay 失败: ' + err.message);
    return null;
  }
}

function notifySafeBoot(ids) {
  try {
    showNotification({
      title: 'DSH Desktop JXZ 安全模式',
      body: '检测到启动配置错误，已自动禁用问题插件：' + ids.join(', ') + '。修复后可删除 ' + safeBootOverlayPath(),
    });
  } catch (err) {
    log('boot', '安全模式通知失败: ' + err.message);
  }
}

function notifyBundleRepair(removed) {
  try {
    const n = new Notification({
      title: 'DSH Desktop JXZ 启动自愈',
      body: '检测到启动层（dsh.profile.bundles）中存在未声明 dsh.bundle 的插件，已移出启动清单并备份配置：' + removed.join(', ') + '。正在重试启动。',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.show();
  } catch (err) {
    log('boot', 'bundle 自愈通知失败: ' + err.message);
  }
}

// 补丁层自愈重置的用户可见提示：cordis.patch.yml 解析失败被重置为最小文件（原内容
// 已备份到 backup）。用户数据被改写，属数据类事件，须给出可见提示 + 备份路径。
function notifyPatchReset(kind, backup) {
  if (process.env.DSH_DESKTOP_TEST === '1') return;
  try {
    const label = kind === 'home' ? '家级补丁层（cordis.patch.yml）' : 'profile 补丁层（cordis.patch.yml）';
    showNotification({
      title: 'DSH Desktop 补丁配置已重置',
      body: `检测到 ${label} 无法解析，已备份原内容并重置为最小文件，避免启动失败。原配置已备份为 ${path.basename(backup)}，完整路径见「设置 → 插件 → 诊断与管理 → 诊断」。`,
    });
    appendSelfHealHistory('patch-layer', ['补丁配置'], backup);
  } catch (err) {
    log('boot', '补丁重置提示失败: ' + err.message);
  }
}

// 插件补丁应用失败的用户可见提示：消除「部分失败静默」。区分三类信号——
// degraded（关键补丁已降级，建议升级）、errors/failed（补丁未生效）、
// anchorMissing（锚点失配，版本差异）——任一非零即提示。集成测试态不弹真实
// 通知（与其它自愈提示一致，断言走 desktop.log）。
function notifyPatchFailures(report) {
  try {
    if (!report) return;
    const degradedCount = (report.degraded || []).length;
    const hardCount = (report.errors || []).length + (report.failed || 0);
    const anchorMiss = report.anchorMissing || 0;
    if (degradedCount === 0 && hardCount === 0 && anchorMiss === 0) return;
    const parts = [];
    if (degradedCount > 0) parts.push(`${degradedCount} 个关键补丁已降级（建议升级 DSH Desktop）`);
    if (hardCount > 0) parts.push(`${hardCount} 个插件补丁未生效`);
    if (anchorMiss > 0) parts.push(`${anchorMiss} 处补丁锚点失配（版本差异）`);
    if (process.env.DSH_DESKTOP_TEST === '1') return;
    showNotification({
      title: 'DSH Desktop 插件补丁提示',
      body: `检测到 ${parts.join('、')}，相关第三方插件可能异常，建议升级 DSH Desktop 后重试。`,
    });
  } catch (err) {
    log('boot', '补丁提示失败: ' + err.message);
  }
}

// 自愈事件持久化：模态框/系统通知都是一次性的，错过就没了；写入
// userData/self-heal-history.json 后，用户随时可在「设置 → 插件 →
// 诊断与管理 → 诊断」中回看「上次启动自愈了什么」。
function appendSelfHealHistory(kind, names, backup) {
  try {
    const file = path.join(userDataDir, 'self-heal-history.json');
    let items = [];
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) items = parsed;
    }
    const entry = {
      kind,
      names: Array.isArray(names) ? names : [names],
      ts: Date.now(),
    };
    if (typeof backup === 'string' && backup) entry.backup = backup;
    items.unshift(entry);
    fs.writeFileSync(file, JSON.stringify(items.slice(0, 5), null, 2) + '\n', 'utf8');
  } catch (err) {
    log('boot', '自愈历史写入失败: ' + err.message);
  }
}

// 自愈成功后的模态提示：系统通知可能被折叠/错过，模态框保证用户看到
// 「应用曾自动修复过启动问题」，并说明做了什么、是否还需要操作。
// kind: 'bundle'（移出启动清单）| 'overlay'（禁用失败插件）。
function showSelfHealNotice(kind, names) {
  const list = Array.isArray(names) && names.length > 0 ? names.join('、') : '';
  const isBundle = kind === 'bundle';
  // 弹窗前确保主窗口已显示并置前：窗口若刚创建还未 show，模态框挂到隐藏
  // 窗口上用户会看不到（「好像是单纯打开」的根因之一）。
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  } catch { /* 窗口操作失败不阻塞提示 */ }
  showBox({
    type: 'info',
    title: 'DSH Desktop JXZ 已自动修复启动问题',
    message: isBundle
      ? '检测到启动清单中有插件缺少启动声明（会导致应用启动失败），已移出启动清单并恢复启动。'
      : '检测到上次启动失败的插件，已自动禁用并恢复启动。',
    detail: (isBundle ? '已移出启动清单：' : '已禁用的插件：') + list +
      '\n\n原配置已自动备份，无需任何操作。' +
      '修复对应插件后可在「设置 → 插件 → 诊断与管理」中重新启用或查看。',
    buttons: ['知道了'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }).catch((err) => log('boot', '自愈提示框失败: ' + err.message));
}

// issue #48：profile manifest 重置是数据丢失类事件，除了日志还要给用户可见
// 提示。集成测试实例与用户正在使用的桌面端并存（showBox 抑制的同一原因），
// 测试态不弹真实通知，断言走 desktop.log。
function notifyManifestResetRecovered(recovered) {
  if (process.env.DSH_DESKTOP_TEST === '1') return;
  try {
    showNotification({
      title: 'DSH Desktop JXZ 配置自愈',
      body: Array.isArray(recovered) && recovered.length > 0
        ? 'profile 配置损坏，已备份并重建；检测到您安装的插件并已自动恢复：' + recovered.join(', ')
        : 'profile 配置损坏，已备份并重建（原文件保留在 profile 目录的 .broken- 备份中，可对比找回原配置）',
    });
  } catch (err) {
    log('boot', '配置自愈通知失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// EPERM/symlink 自愈：部分 Windows 环境下 profiles/node_modules 的目录联接
// 创建被拒绝（EPERM），或上次失败留下半成品实体目录。这里只处理自动生成的
// profiles/node_modules：改名备份后重跑官方 healProfilesModuleFallback 重建
// 联接，绝不触碰 profiles/web、会话与设置。
// ---------------------------------------------------------------------------
function dshWebLogHasEpermSymlink() {
  const tail = readDshWebLogTail(300);
  return /EPERM: operation not permitted, symlink[\s\S]{0,500}profiles[\\/]node_modules/i.test(tail);
}

function backupAndRebuildProfileModules(home) {
  const modules = path.join(home, 'profiles', 'node_modules');
  if (!fs.existsSync(modules)) return true;
  const backup = `${modules}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(modules, backup);
    log('boot', 'EPERM/symlink 自愈：已将 profiles/node_modules 改名备份为 ' + backup);
    return true;
  } catch (err) {
    log('boot', 'EPERM/symlink 自愈：改名备份失败 ' + err.message);
    return false;
  }
}

// 对话框串行化：服务启动失败/更新/错误弹窗不会同时叠成多个，
// 避免「重启后连续弹出多个启动失败窗口」。
let boxChain = Promise.resolve();
function showBox(opts) {
  if (process.env.DSH_DESKTOP_TEST === '1') {
    // 集成测试模式：不弹真实对话框。失败弹窗会直接出现在用户屏幕上（测试
    // 实例与用户正在用的桌面端并存），且模态框会挂起测试场景直到超时。
    // 改为记录日志并按 cancelId 处理（boot 失败弹窗 → 退出，场景快速失败）。
    const cancel = opts.cancelId != null ? opts.cancelId : (Array.isArray(opts.buttons) ? opts.buttons.length - 1 : 0);
    log('test', 'showBox 已抑制（测试模式）: ' + (opts.title || '') + ' :: ' + (opts.message || '') + ' :: ' + String(opts.detail || '').slice(0, 300));
    return Promise.resolve({ response: cancel, checkboxChecked: false });
  }
  const run = () => {
    if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, opts);
    return dialog.showMessageBox(opts);
  };
  const p = boxChain.then(run, run);
  boxChain = p.then(() => {}, () => {});
  // reject 兜底（issue #89）：dialog 异常（如窗口销毁瞬间）时降级为 cancel
  // 响应而不是让 promise 悬挂 reject —— await 调用方拿到可用的 {response}，
  // fire-and-forget 调用方（.then 无 .catch）也不产生 unhandledRejection。
  return p.catch((err) => {
    log('boot', '对话框调用失败（按取消处理）: ' + ((err && err.message) || err));
    const cancel = opts.cancelId != null ? opts.cancelId : (Array.isArray(opts.buttons) ? opts.buttons.length - 1 : 0);
    return { response: cancel, checkboxChecked: false };
  });
}

// 选择一个尽量稳定的 127.0.0.1 端口并保存到 settings.json。
// Web UI 的部分偏好（如左侧会话分组方式）存在 localStorage，而
// localStorage 按 origin 隔离；每次 --port 0 都会换 origin，导致偏好丢失。
const CHROMIUM_RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

function restrictedPortOf(url) {
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? '443' : '80'));
    return CHROMIUM_RESTRICTED_PORTS.has(port) ? port : 0;
  } catch {
    return 0;
  }
}

// 集成测试专用：DSH_DESKTOP_TEST_FORCE_UNSAFE=1 时把第一次探测到的端口
// 强制视为受限端口（6000），端到端验证「重启换端口」交接路径。
let testForceUnsafeOnce = process.env.DSH_DESKTOP_TEST_FORCE_UNSAFE === '1';

function chooseStableWebPort() {
  return new Promise((resolve) => {
    const settings = updater.loadSettings(updCtx());
    const rawPreferred = Number(settings.webPort);
    // 越界/非法端口（<=0 或 >65535）不直接尝试——net.listen 对越界端口会
    // 同步抛 ERR_SOCKET_BAD_PORT，导致启动失败；统一按「无偏好」走空闲端口。
    const preferred = Number.isInteger(rawPreferred) && rawPreferred > 0 && rawPreferred <= 65535 ? rawPreferred : 0;
    const save = (port) => {
      // 启动提速：端口与已保存值一致时不写盘，避免每次启动都改写
      // settings.json（无意义的写入 + mtime 抖动）。
      if (settings.webPort !== port) {
        settings.webPort = port;
        updater.saveSettings(updCtx(), settings);
      }
      resolve(port);
    };
    const tryPort = (port, done) => {
      const probe = net.createServer();
      const finish = (ok) => {
        probe.removeAllListeners();
        probe.close(() => done(ok));
      };
      probe.once('error', () => finish(false));
      probe.listen(port, '127.0.0.1', () => finish(true));
    };
    const pickFree = (retriesLeft = 5) => {
      const probe = net.createServer();
      probe.once('error', () => {
        if (retriesLeft > 0) pickFree(retriesLeft - 1);
        else save(0);
      });
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => {
          if (CHROMIUM_RESTRICTED_PORTS.has(port) && retriesLeft > 0) pickFree(retriesLeft - 1);
          else save(port);
        });
      });
    };
    if (preferred && !CHROMIUM_RESTRICTED_PORTS.has(preferred)) tryPort(preferred, (ok) => ok ? save(preferred) : pickFree());
    else pickFree();
  });
}

// ---------------------------------------------------------------------------
// 后端模式（配置优先级：环境变量 > settings.json）：
//   local —— 启动内置 dsh（默认，行为不变）
//   wsl   —— 壳经 wsl.exe 在 WSL 内安装/更新/运行自己的 dsh（见 wsl-backend.js），
//            agent 自更新、插件同步、运行时补丁全部闭环。
// 环境变量：DSH_DESKTOP_BACKEND=local|wsl
//           DSH_DESKTOP_WSL_DISTRO / DSH_DESKTOP_WSL_DIR（wsl）
// settings.json：backend / wslDistro / wslInstallDir
// ---------------------------------------------------------------------------
async function resolveBackendConfig() {
  const s = updater.loadSettings(updCtx());
  const want = String(process.env.DSH_DESKTOP_BACKEND || s.backend || '').trim().toLowerCase();
  if (want === 'remote') {
    // remote 附加模式已移除（如需连接外部已运行的 dsh，用 WSL 托管或浏览器直开）。
    log('boot', 'settings.backend=remote 已不再支持，回落为 local 模式');
  }
  if (want === 'wsl') {
    try {
      // 解析发行版/安装目录并探活（异步，不阻塞主进程；boot 等待结果）。
      await wslBackend.configureAsync({
        distro: String(process.env.DSH_DESKTOP_WSL_DISTRO || s.wslDistro || '').trim(),
        installDir: String(process.env.DSH_DESKTOP_WSL_DIR || s.wslInstallDir || '').trim(),
        log,
      });
      backendMode = 'wsl';
      wslFallbackReason = '';
    } catch (err) {
      // issue #54：WSL 配置错误（未安装发行版 / 发行版内缺 node 等）不再让
      // 应用启动失败——回落到本地模式继续启动。已保存的 WSL 配置原样保留，
      // 用户可在 设置 → WSL 后端 修正后重启切回；本地模式行为与未配置
      // WSL 时完全一致。
      backendMode = 'local';
      wslFallbackReason = String((err && err.message) || err);
      log('boot', 'WSL 托管模式探测失败，已回落到本地模式: ' + wslFallbackReason);
    }
  } else {
    backendMode = 'local';
    wslFallbackReason = '';
  }
  return { mode: backendMode };
}

function isWslMode() { return backendMode === 'wsl'; }

// 各模式下的 DSH_HOME 落点（Windows 视角）：
//   local → Windows 的 DSH_HOME
//   wsl   → WSL 安装目录的 UNC 等价路径（供会话通知/余额/插件同步直读 WSL 文件）
function effectiveDshHome() {
  if (isWslMode()) return wslBackend.uncHome();
  return dshHome || path.join(os.homedir(), '.dsh');
}

// ---------------------------------------------------------------------------
// 插件保护中心（plugin-guard.js）：快照 / 回滚 / 静态体检 / 自动修复 /
// 守护启动 / 事故报告。实例延迟创建（依赖 dshHome 与后端模式解析就绪，
// 首次调用发生在 boot 或 IPC 阶段）。桌面端运行在共享 web profile。
// ---------------------------------------------------------------------------
let guardInstance = null;
function ensureGuard() {
  if (!guardInstance) {
    guardInstance = createGuard({
      getHome: () => effectiveDshHome() || path.join(os.homedir(), '.dsh'),
      getProfile: () => 'web',
      dshBin: () => dshBin(),
      log,
    });
  }
  return guardInstance;
}

// ---------------------------------------------------------------------------
// 插件集成门面实例（scripts/integration）。延迟创建：依赖 userDataDir / dshHome
// / 后端模式解析就绪，首次调用发生在 boot 或更新流程阶段。
// ---------------------------------------------------------------------------
let pluginIntegration = null;
function ensurePluginIntegration() {
  if (!pluginIntegration) {
    pluginIntegration = createPluginIntegration({
      getHome: () => effectiveDshHome(),
      appDir: __dirname,
      getUserDataDir: () => userDataDir,
      wslMode: () => isWslMode(),
      log: (m) => log('boot', m),
      loadYaml: () => loadDshYamlDialect(),
      loadSettings: () => updater.loadSettings(updCtx()),
      saveSettings: (s) => updater.saveSettings(updCtx(), s),
      getInstallAnchorDir: () => path.dirname(dshPackageJson()),
      onManifestResetRecovered: (recovered) => notifyManifestResetRecovered(recovered),
      onHealReset: (kind, backup) => notifyPatchReset(kind, backup),
      hostDetectors: {
        // preload 在 Electron 壳内始终暴露 window.dshDesktop.openPath。
        openPath: () => true,
        // 桥 window.__dshSessionManager 由 dsh-session-manager 插件提供：
        // 以「插件已同步落盘」作为主进程侧探测信号（渲染进程运行时仍以注入的
        // 桥守卫为准，二者共同构成显式降级 + 告警）。
        deleteSession: () => fs.existsSync(path.join(effectiveDshHome() || path.join(os.homedir(), '.dsh'), 'profiles', 'web', 'node_modules', 'dsh-session-manager')),
      },
    });
  }
  return pluginIntegration;
}
// 服务稳定性看管（插件市场崩溃事故根治面之二）：
//   · 就绪后稳定窗口：服务需连续存活 SERVICE_STABLE_MS 才把本次启动快照
//     落定为「最后良好」（guard.confirmPendingGood）并清零崩溃环计数；
//   · 就绪后崩溃环自愈：进程达就绪后短窗口内意外退出（典型：坏插件拖死
//     宿主）不走普通弹窗，而是直接走守护重启（体检/修复/回滚），上限
//     CRASH_LOOP_MAX 次，耗尽后才降级为弹窗。
// ---------------------------------------------------------------------------
const SERVICE_STABLE_MS = 30000;
const CRASH_LOOP_MAX = 2;
// 假活（zombie）重启配额：同一 10 分钟窗口内连续「进程存活但 HTTP 不响应」
// 判定最多自动重启 ZOMBIE_RESTART_MAX 次，耗尽后停止自动重启并提示用户
// （插件占死事件循环的场合，无限重启只会无限失败——闭环必须有上限）。
const ZOMBIE_RESTART_MAX = 2;
const ZOMBIE_WINDOW_MS = 10 * 60 * 1000;
let zombieRestartCount = 0;
let zombieWindowStart = 0;
let zombieGiveUpNotified = false;
// 测试钩子：探活强制失败（仅 DSH_DESKTOP_TEST=1 的集成场景使用）。
let testForceProbeFail = false;
let crashLoopCount = 0;
let crashLoopRecovering = false;
let serviceStableTimer = null;
const procReadyAt = new WeakMap(); // proc -> 达就绪横幅的时间戳

// ── 自动隔离（quarantine）观测：dsh web 子进程 stderr 的机器可读标记 ────────
//   [loader-isolation] entry <id> (<name>): ...   → 启动/热更新期条目自动隔离
//   [crash-shield] attribute: <source> count: n   → 运行时异常归因
// 壳层据此落盘 quarantine（disabled 覆盖）并通知/守护重启。
const ATTRIBUTE_WINDOW_MS = 10 * 60 * 1000;
const ATTRIBUTE_THRESHOLD = 3;
const isolatedEntryIds = new Set(); // 本次运行已处理过的隔离条目（通知去重）
const attributeCounts = new Map(); // source -> { count, windowStart, applied }

function noteLoaderIsolation({ id, name }) {
  if (!id || isolatedEntryIds.has(id)) return;
  isolatedEntryIds.add(id);
  log('dsh', 'loader 自动隔离条目: ' + id + ' (' + name + ')');
  // 落盘 quarantine（写入官方 disabled 覆盖），使下次启动不再重复尝试。
  ensurePluginCenter().quarantine.apply(id, { source: 'boot', reason: 'loader 自动隔离' })
    .then((res) => {
      if (res && res.ok && res.applied) {
        showNotification({
          title: '插件已自动隔离',
          body: '插件 ' + name + ' 加载失败已被自动隔离，其他功能不受影响；可在设置 → 插件 中恢复。',
        });
      }
    })
    .catch((err) => log('dsh', 'quarantine 落盘失败: ' + ((err && err.message) || err)));
}

function quarantineBySource(source) {
  log('dsh', '运行时归因触发自动隔离: ' + source);
  ensurePluginCenter().quarantine.applyBySource(source, { source: 'runtime', reason: '运行时异常归因超阈值' })
    .then((res) => {
      if (!res || !res.ok || !res.applied) return;
      showNotification({
        title: '插件已自动隔离',
        body: '检测到插件持续出错，已自动隔离（' + source + '）；其他功能不受影响，可在设置 → 插件 中恢复。',
      });
      // 守护重启使隔离生效（每源仅一次；重启/崩溃环互斥兜底）。
      if (serverProc && !restartingServer && !crashLoopRecovering) {
        restartService().catch((err) => log('dsh', '自动隔离后重启失败: ' + ((err && err.message) || err)));
      }
    })
    .catch((err) => log('dsh', 'quarantine 落盘失败: ' + ((err && err.message) || err)));
}

function handleAttributeMarkers(attributes) {
  const now = Date.now();
  for (const { source, count } of attributes) {
    if (!source) continue;
    let rec = attributeCounts.get(source);
    if (!rec || now - rec.windowStart > ATTRIBUTE_WINDOW_MS) {
      rec = { count: 0, windowStart: now, applied: false };
      attributeCounts.set(source, rec);
    }
    rec.count = Math.max(rec.count, count);
    if (rec.count >= ATTRIBUTE_THRESHOLD && !rec.applied) {
      rec.applied = true;
      quarantineBySource(source);
    }
  }
}

function armStabilityWatch(proc) {
  if (serviceStableTimer) { clearTimeout(serviceStableTimer); serviceStableTimer = null; }
  serviceStableTimer = setTimeout(() => {
    serviceStableTimer = null;
    if (serverProc !== proc) return; // 已换进程/已退出，不作数
    crashLoopCount = 0;
    zombieRestartCount = 0; // 稳定落地 → 假活重启配额复位
    try { ensureGuard().confirmPendingGood(); } catch (err) { log('guard', '稳定落定失败: ' + ((err && err.message) || err)); }
  }, SERVICE_STABLE_MS);
  if (serviceStableTimer.unref) serviceStableTimer.unref();
}

// 就绪后短窗口内意外退出 → 守护重启自愈（含回滚到最后良好快照）。
// 返回 true 表示已接管（调用方不再弹窗）。
function tryCrashLoopRecovery() {
  if (crashLoopRecovering || crashLoopCount >= CRASH_LOOP_MAX) return false;
  crashLoopRecovering = true;
  crashLoopCount += 1;
  log('dsh', `就绪后 ${SERVICE_STABLE_MS / 1000}s 内意外退出（第 ${crashLoopCount}/${CRASH_LOOP_MAX} 次），守护重启自愈（体检/修复/回滚）`);
  startAndShowGuarded()
    .then(() => log('dsh', '崩溃环自愈成功，服务已恢复'))
    .catch((err) => {
      log('dsh', '崩溃环自愈失败: ' + ((err && err.message) || err));
      handleBootFailure(err);
    })
    .finally(() => { crashLoopRecovering = false; });
  return true;
}

// 设置页「WSL 后端」用的状态快照：当前 local 模式（未配置过）或 force 时，
// 按已保存的 wslDistro/wslInstallDir 做一次探测；失败不抛错，错误进 status。
// 全部探测走异步原语（configureAsync/statusAsync），绝不阻塞主进程
// （历史实现在此做多段 spawnSync，WSL 冷启动时设置页打开会冻结数分钟）。
async function wslStatusSnapshotAsync(opts = {}) {
  if (!wslBackend.isConfigured() || opts.force) {
    try {
      const s = updater.loadSettings(updCtx());
      await wslBackend.configureAsync({
        distro: String(s.wslDistro || '').trim(),
        installDir: String(s.wslInstallDir || '').trim(),
        log,
      });
    } catch (err) {
      return {
        configured: false,
        lastError: String((err && err.message) || err),
      };
    }
  }
  return wslBackend.statusAsync();
}

// ---------------------------------------------------------------------------
// dsh web server lifecycle
// ---------------------------------------------------------------------------

async function startServer(unsafePortRetries = 4, overlays = []) {
  // M1 修复：重入前先终结旧进程并等待其真正退出，避免孤儿 harness 同时写
  // 同一 DSH_HOME。等待必须在端口探测之前完成：taskkill /F 异步生效，若旧
  // 进程仍占着端口，chooseStableWebPort 会探测失败并换新端口，导致 origin
  // 漂移（localStorage 偏好丢失）。旧的「先选端口、后杀进程」顺序正是
  // 插件市场每次重启都换端口的根因。
  if (serverProc && !serverProc.killed && !quitting) {
    log('dsh', 'startServer 重入：先终结旧进程再启动');
    await killTree(serverProc);
    serverProc = null;
  }
  ensurePluginIntegration().healBeforeServer();
  if (isWslMode()) {
    // WSL 托管模式：经 wsl.exe 在 WSL 内启动 dsh web（仍 --port 0 由 WSL 内 OS
    // 分配；稳定端口持久化只作用于本地 spawn）。受限端口重启走同一递归。
    if (!wslBackend.isReady()) {
      return Promise.reject(new Error('WSL 托管后端未就绪: ' + wslBackend.lastError()));
    }
    const out = fs.createWriteStream(path.join(logsDir, 'dsh-web.log'), { flags: 'a' });
    // 写流 error 静默监听：磁盘满/权限变更等写失败时避免 uncaughtException 崩主进程（issue #86）。
    out.on('error', (e) => log('dsh', 'dsh-web.log 写入失败: ' + ((e && e.message) || e)));
    log('dsh', `WSL 托管模式：在 ${wslBackend.installDirLinux()}/agent 内启动 dsh web`);
    const proc = wslBackend.spawnServer();
    serverProc = proc;
    return watchServerProc(proc, out, { expectedPort: null, unsafePortRetries, overlays });
  }
  const webPort = await chooseStableWebPort();
  return new Promise((resolve, reject) => {
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fs.existsSync(nodeBin)) {
      return reject(new Error(
        '找不到内置 Node 运行时: ' + nodeBin + '\n' +
        (app.isPackaged ? '安装包可能不完整，请重新安装。' : '开发模式请先运行: npm run fetch-node')
      ));
    }
    const out = fs.createWriteStream(path.join(logsDir, 'dsh-web.log'), { flags: 'a' });
    // 同上：写流 error 静默监听，防 uncaughtException（issue #86）。
    out.on('error', (e) => log('dsh', 'dsh-web.log 写入失败: ' + ((e && e.message) || e)));
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port ${webPort}`);
    // --use-system-ca: 让 dsh web 进程信任系统证书库（代理/MITM 场景下内置 node 的
    // 默认 CA 无法验证，导致插件市场等对外 fetch 失败）。
    const patchArgs = overlays
      .filter((p) => typeof p === 'string' && p && fs.existsSync(p))
      .flatMap((p) => ['--patch', p]);
    // web 子命令在遇到第一个应用参数（如 --host）后会透传剩余参数，故
    // --patch 必须位于 --host 之前，否则 overlay 不会被 dsh 启动器解析。
    // --require 崩溃屏蔽：就绪后插件运行时错误不再拖死宿主（启动期保持
    // fail-fast，不影响启动自愈）。文件不存在时不注入（dev 检出兜底）。
    const crashShield = path.join(__dirname, 'scripts', 'lib', 'web-crash-shield.js');
    const shieldArgs = fs.existsSync(crashShield) ? ['--require', crashShield] : [];
    const spawnEnv = childEnv();
    if (shieldArgs.length) spawnEnv.DSH_CRASH_SHIELD = '1'; // 防护垫自装开关
    // rc.8 起 dsh web 默认 openBrowser=true（非 SSH 环境自动拉系统浏览器）。
    // 桌面内嵌场景必须显式关闭；但 rc.7 及更早的 web 命令没有 --no-open 选项
    // （commander 会按未知选项直接报错），故按当前内核版本门控传参。
    const noOpenArgs = updater.compareVersions(dshVersion(), '0.1.0-rc.8') >= 0 ? ['--no-open'] : [];
    const proc = spawn(nodeBin, ['--use-system-ca', ...shieldArgs, bin, 'web', ...patchArgs, ...noOpenArgs, '--host', '127.0.0.1', '--port', String(webPort)], {
      cwd: userDataDir,
      env: spawnEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;
    watchServerProc(proc, out, { expectedPort: webPort, unsafePortRetries, overlays }).then(resolve, reject);
  });
}

// 等待 dsh web 子进程 stdout 出现就绪 URL 行；进程提前退出 / 启动超时则拒绝。
// 退出时若服务已就绪过（webUrl 已设）且非主动重启，弹「DSH 服务已停止」对话框。
// opts.expectedPort 为 null（WSL 托管）时不参与稳定端口持久化；受限端口重启
// 两种模式共用（WSL 下经 killTree → pid 文件终止后递归重起）。
function watchServerProc(proc, out, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let handedOff = false; // 受限端口重启：本实例的退出不再影响外层 Promise/弹窗
    let bootTimer = null;
    const finish = (fn, value) => {
      if (!settled) { settled = true; fn(value); }
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    };
    const onData = (chunk) => {
      out.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (!m) continue;
        // 本 chunk 已 resolve/reject 就不再处理后续行：dsh web 偶发输出多行
        // 「dsh web: <url>」时，第二行会进入受限端口分支 killTree 刚就绪的
        // 服务，而调用方已拿到（已死的）第一行 URL。
        if (settled) return;
        let blocked;
        if (testForceUnsafeOnce) {
          testForceUnsafeOnce = false;
          blocked = 6000; // 测试钩子：仅第一次强制视为受限端口
        } else {
          blocked = restrictedPortOf(m[1]);
        }
        if (blocked && opts.unsafePortRetries > 0) {
          // 端口命中 Chromium 受限列表：结束该实例重启换端口（有上限）。
          // 标记 handedOff，本实例的 exit 事件不得提前 reject 外层 Promise
          // 或弹出「服务已停止」对话框，结果交由递归重启决定。
          handedOff = true;
          log('dsh', `端口 ${blocked} 属于 Chromium 受限端口（ERR_UNSAFE_PORT），重启服务换端口（剩余重试 ${opts.unsafePortRetries} 次）`);
          killTree(proc);
          setTimeout(() => {
            if (quitting) return finish(reject, new Error('应用正在退出'));
            startServer(opts.unsafePortRetries - 1, opts.overlays).then(
              (url) => finish(resolve, url),
              (err) => finish(reject, err)
            );
          }, 600);
          return;
        }
        // 稳定端口：若 dsh 最终监听端口与请求的不同（极端兜底），以实际为准并保存。
        try {
          const actual = Number(new URL(m[1]).port) || 0;
          if (opts.expectedPort != null && actual > 0 && actual !== opts.expectedPort) {
            const settings = updater.loadSettings(updCtx());
            settings.webPort = actual;
            updater.saveSettings(updCtx(), settings);
          }
        } catch {}
        // 就绪看管：记录达就绪时刻 + 挂稳定窗口计时（存活达标才落定
        // 「最后良好」快照，防坏插件污染回滚基线）。
        procReadyAt.set(proc, Date.now());
        armStabilityWatch(proc);
        finish(resolve, m[1]);
      }
    };
    // out（dsh-web.log 写流）在 spawn 'error'（进程未启动即失败，不触发 exit）
    // 路径下原先不会关闭，反复 boot 失败会泄漏文件描述符。用幂等 endOut 在
    // error 与 exit 两条路径统一收口；end 之后到达的 stderr chunk 用 try 兜住，
    // 避免 out.write 抛错冒到 uncaughtException。
    let outEnded = false;
    const endOut = () => { if (!outEnded) { outEnded = true; try { out.end(); } catch {} } };
    // 自动隔离标记观测：stderr 分块到达，跨 chunk 断裂的标记经累积器拼接。
    const markerAccum = createMarkerAccumulator();
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c) => {
      try { out.write(c); } catch {}
      try {
        const markers = markerAccum(c.toString());
        for (const iso of markers.isolations) noteLoaderIsolation(iso);
        if (markers.attributes.length > 0) handleAttributeMarkers(markers.attributes);
      } catch (err) {
        log('dsh', '隔离标记解析失败: ' + ((err && err.message) || err));
      }
    });
    proc.on('error', (err) => { endOut(); finish(reject, err); });
    proc.on('exit', (code, signal) => {
      endOut();
      if (serviceStableTimer) { clearTimeout(serviceStableTimer); serviceStableTimer = null; }
      log('dsh', `进程退出 code=${code} signal=${signal}`);
      // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清掉新进程的句柄。
      const intentional = restartingServer || serverProc !== proc;
      if (serverProc === proc) serverProc = null;
      if (!handedOff) {
        finish(reject, new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${path.join(logsDir, 'dsh-web.log')}`));
      }
      if (!quitting && !intentional && !handedOff && webUrl && mainWindow && !mainWindow.isDestroyed()) {
        // 就绪后崩溃环：进程曾达就绪但在稳定窗口内意外退出（典型：坏插件
        // 拖死宿主）——直接走守护重启自愈（体检/修复/回滚到最后良好快照），
        // 不打扰用户；自愈次数耗尽才降级为弹窗。
        const readyAt = procReadyAt.get(proc) || 0;
        const uptime = readyAt ? Date.now() - readyAt : Infinity;
        if (readyAt && uptime < SERVICE_STABLE_MS && tryCrashLoopRecovery()) return;
        // 普通意外退出：稍等再弹窗，给 stderr 尾部的真实崩溃栈落盘窗口
        // （exit 事件可能早于最后几个 stdio data 事件，立即读日志会丢现场）。
        setTimeout(() => {
          if (quitting || crashLoopRecovering) return;
          if (!mainWindow || mainWindow.isDestroyed()) return;
          showBox({
            type: 'error',
            title: 'DSH 服务已停止',
            message: 'DeepSeek Harness 服务意外退出。',
            detail: '日志文件：' + path.join(logsDir, 'dsh-web.log') + logTailSnippet(),
            buttons: ['重新启动', '退出'],
            defaultId: 0,
            cancelId: 1,
          }).then(({ response }) => {
            // 守护重启：坏插件导致的启动失败会先体检/修复/回滚，避免死循环。
            if (response === 0) startAndShowGuarded().catch((err) => handleBootFailure(err));
            else app.quit();
          });
        }, 500);
      }
    });
    // Safety net in case the URL line never appears.
    bootTimer = setTimeout(() => finish(reject, new Error('等待 dsh web 启动超时（60 秒）')), 60000);
    bootTimer.unref();
  });
}

function waitUntilUp(url, timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      // retry 单路触发守卫：timeout → destroy → error 会产生「双重重试」（双 setTimeout
      // 排队 → 双倍探测请求）；统一收敛为每个 tick 至多重试一次（issue #86）。
      let retried = false;
      const once = () => { if (!retried) { retried = true; retry(); } };
      const req = http.get(url + '/', { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) { retried = true; resolve(url); }
        else { req.destroy(); once(); }
      });
      req.on('error', once);
      req.on('timeout', () => { req.destroy(); once(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('Web UI 未在预期时间内就绪'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

// 启动成功后主动清理坏 bundle 条目（软跳过保证不崩，但坏条目会每次启动
// 告警；清理后 manifest 干净）。异步执行不阻塞 UI；守卫与失败兜底共用。
function runBundleContractMaintenance() {
  if (bundleContractRepairAttempted) return;
  bundleContractRepairAttempted = true;
  setImmediate(async () => {
    try {
      const home = effectiveDshHome() || dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const missing = scanBundleContracts(profileDir);
      if (missing.length > 0) {
        const removed = await removeBundlesFromProfile(profileDir, missing);
        if (removed.length > 0) {
          log('boot', '已从 profile 启动层移除无声明插件（备份于 package.json.bak-*）: ' + removed.join(', '));
          notifyBundleRepair(removed);
          appendSelfHealHistory('bundle', removed);
          showSelfHealNotice('bundle', removed);
        }
      }
    } catch (err) {
      log('boot', 'bundle 契约维护失败: ' + ((err && err.message) || err));
    }
  });
}

function startAndShow(overlays = []) {
  const merged = [];
  if (pickerBrowseOverlay && fs.existsSync(pickerBrowseOverlay)) merged.push(pickerBrowseOverlay);
  for (const p of overlays) {
    if (typeof p === 'string' && p && fs.existsSync(p) && !merged.includes(p)) merged.push(p);
  }
  return startServer(4, merged)
    .then(waitUntilUp)
    .then((url) => {
      webUrl = url;
      log('boot', 'Web UI 就绪: ' + url);
      // 启动成功后主动清理无 dsh.bundle 声明的坏 bundle 条目：维护者软跳过
      // 保证「不崩」但不清理，坏条目会每次启动告警；这里顺带清理 + 留痕 +
      // 提示。旧世代 boot 的失败兜底在 handleBootFailure，两路共用守卫。
      runBundleContractMaintenance();
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.loadURL(url).then(() => url);
      return url;
    });
}

// 守护启动（plugin-guard.js）：快照 → 拉起 → 失败则体检/修复/回滚再试，
// 仍失败落事故报告。调用方统一走这里，用户不再面对「装完插件起不来」。
async function startAndShowGuarded(overlays = []) {
  const g = ensureGuard();
  // 回滚分支的重试也要能更新「最后良好」标记（restore 会留 pre-restore 快照，
  // 成功拉起后它就是最新一份 = 当前良好状态）。
  g.setRollbackLift(async () => {
    const url = await startAndShow(overlays);
    // 回滚后成功拉起：对当前（已回滚的）状态新拍一份快照作为待落定良好基线。
    // （旧实现 markGood(listSnapshots()[0]) 拿到的是 restore 前的 pre-restore
    // 快照 = 坏状态，会把坏配置固化成回滚基线。）稳定存活后由
    // armStabilityWatch 的 confirmPendingGood 落定。
    try {
      const meta = g.snapshot('boot-recovered');
      g.setPendingGood(meta ? meta.id : null);
    } catch { /* 快照失败无碍：下次启动重建 */ }
    return url;
  });
  return g.guardedBoot(
    () => startAndShow(overlays),
    () => '日志文件：' + path.join(logsDir, 'dsh-web.log')
  );
}

// 插件市场式原地重启：终结旧 dsh web 进程树并等待其真正退出，再重新启动。
// 等待是必需的：taskkill /F 异步生效，旧进程退出前仍占着端口，端口探测会
// 失败并换新端口（origin 漂移 → localStorage 偏好丢失）。集成测试通道的
// 'restart-service' 命令与 chrome:restart-service IPC 共用本函数。
async function restartService() {
  if (!serverProc || restartingServer) return { ok: false, error: 'not-running' };
  log('service', '请求重启 dsh web 服务');
  restartingServer = true;
  try {
    await killTree(serverProc);
    // 守护启动：重启后若新装的坏插件导致启动失败，先体检/修复/回滚，
    // 避免用户卡在「重启即崩」死循环（插件市场安装后重启是高危时刻）。
    const url = await startAndShowGuarded();
    log('service', 'dsh web 服务已重启: ' + url);
    return { ok: true, url };
  } catch (err) {
    log('service', '重启失败: ' + ((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    restartingServer = false;
  }
}

// 探测 overlay agent 本身能否运行（--version 快速退出 0 即视为可运行）。
// 用于区分「更新包坏了」与「其它原因（profile patch / 配置损坏等）导致的启动
// 失败」，避免把后者误判为更新问题、诱导用户回退一个健康的新版本。
async function probeOverlayAgent(bin) {
  return new Promise((resolve) => {
    const nodeBin = nodeExe();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(bin)) return resolve(false);
    let child;
    try {
      child = spawn(nodeBin, [bin, '--version'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15000,
      });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// 从 dsh-web.log 尾部扫描 settings 文档损坏的报错行（settings.yaml 整体无法
// 解析/非 map 时报 `settings-file: ...`，settings 服务起不来 → 一批插件 fiber
// 失败 → dsh web 退出）。返回损坏文件路径与该行。
function scanWebLogForSettingsFailure() {
  try {
    const file = path.join(logsDir, 'dsh-web.log');
    if (!fs.existsSync(file)) return null;
    // 只读末尾定长字节：settings-file 报错行属于最近一次失败启动，必在尾部；
    // 避免日志膨胀后整文件读入的线性成本。
    const text = readFileTailText(file, LOG_TAIL_READ_BYTES);
    const lines = text.split(/\r?\n/);
    const hit = lines.slice(-400).reverse().find((l) => l.includes('settings-file:'));
    if (!hit) return null;
    const m = hit.match(/settings-file: (?:invalid document at )?([^\n]+)/);
    if (!m) return null;
    let filePath = m[1].trim();
    const mapIdx = filePath.indexOf(' must be a map');
    if (mapIdx >= 0) filePath = filePath.slice(0, mapIdx);
    else {
      // 剥离尾部「:行:列」报错定位：lastIndexOf(':') 只剥最后一段，Windows
      // 路径 "C:\...\file.json:9:3" 会残留 ":9"；一次正则剥掉整段（盘符冒号
      // 不在行尾，不受影响）（issue #87）。
      filePath = filePath.replace(/:\d+(?::\d+)?\s*$/, '');
    }
    return { filePath, line: hit.trim() };
  } catch {
    return null;
  }
}
async function handleBootFailure(err, overlays = []) {
  if (isWslMode() && await wslBackend.hasPrevious()) {
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: 'WSL 内更新后的 agent 无法启动。',
      detail: (err && err.message || String(err)) + '\n\n可回退到 WSL 内的上一版本继续使用。',
      buttons: ['回退到上一版本并重试', '重试', '退出'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 0) {
        wslBackend.rollback().catch(() => {});
        startAndShow(overlays).catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if (response === 1) {
        startAndShow(overlays).catch((e2) => handleBootFailure(e2, overlays));
      } else {
        app.quit();
      }
    });
    return;
  }
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    // 先探测 overlay 本身能否运行。可运行 → 启动失败另有原因（如损坏的
    // cordis.patch.yml，现在已在启动前自愈），不归咎于更新，走通用失败弹窗。
    const runs = await probeOverlayAgent(ov);
    if (!runs) {
      showBox({
        type: 'error',
        title: 'DeepSeek Harness 启动失败',
        message: '更新后的 agent 无法启动。',
        detail: (err && err.message || String(err)) + logTailSnippet() + '\n\n可回退到内置版本继续使用。',
        buttons: ['回退到内置版本并重试', '重试', '退出'],
        defaultId: 0,
        cancelId: 2,
      }).then(({ response }) => {
        if (response === 0) {
          // 回退本身可能失败（overlay 目录被安全软件/句柄锁定）：失败时显式
          // 报错并给重试/退出出口，不能让异常成为 unhandledRejection 后静默卡住。
          try {
            updater.rollback(updCtx());
            startAndShow(overlays).catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
          } catch (rollbackErr) {
            log('boot', '回退 overlay 失败: ' + (rollbackErr && rollbackErr.message || String(rollbackErr)));
            showBox({
              type: 'error',
              title: '回退失败',
              message: '无法回退到内置版本，更新副本可能被安全软件占用。',
              detail: (rollbackErr && rollbackErr.message || String(rollbackErr)) + logTailSnippet(),
              buttons: ['重试回退', '退出'],
              defaultId: 0,
              cancelId: 1,
            }).then(({ response: r2 }) => {
              if (r2 === 0) startAndShow(overlays).catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
              else app.quit();
            });
          }
        } else if (response === 1) {
          startAndShow(overlays).catch((e2) => handleBootFailure(e2, overlays));
        } else {
          app.quit();
        }
      });
      return;
    }
    log('boot', 'overlay agent 可运行（--version 正常），启动失败不归咎于更新');
  }
  // EPERM/symlink 自愈（客户手册场景）：先于插件安全模式处理。
  if (!epermRepairAttempted && dshWebLogHasEpermSymlink()) {
    epermRepairAttempted = true;
    // WSL 模式走 effectiveDshHome()（UNC 等价路径），与 profilePatchText 同源。
    const home = effectiveDshHome() || dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    if (backupAndRebuildProfileModules(home)) {
      return repairProfileFallback(home).then(() =>
        startAndShow(overlays).catch((e2) => handleBootFailure(e2, overlays))
      );
    }
  }
  // 启动配置自愈：解析日志中加载失败的 patch 插件并写入安全 overlay 重试，
  // 让客户机器遇到「启动项配置生成错误」时也能打开应用。
  const failedIds = findFailedPatchPlugins();
  const safeOverlay = ensureSafeBootOverlay(failedIds);
  if (safeOverlay && !overlays.includes(safeOverlay)) {
    notifySafeBoot(failedIds);
    appendSelfHealHistory('overlay', failedIds);
    const next = [...overlays, safeOverlay];
    return startAndShow(next)
      .then(() => showSelfHealNotice('overlay', failedIds))
      .catch((e2) => handleBootFailure(e2, next));
  }
  // bundle 契约缺失自愈（旧世代 boot fail-loud 兜底）：维护者软跳过（
  // profile-bundle-heal 注入防护）保证新世代启动不崩；此分支只为旧世代
  // boot / 防护锚点失配（dsh 更新后）时兜底——备份 manifest → 移除坏条目 →
  // 重试；绝不触碰 @deepseek-ai/*。
  if (!bundleContractRepairAttempted) {
    bundleContractRepairAttempted = true;
    const home = effectiveDshHome() || dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profileDir = path.join(home, 'profiles', 'web');
    // 主路径：直接扫 manifest（不依赖日志，日志轮转/截断也能发现坏条目）；
    // 兜底：日志形态匹配（旧逻辑），两者合并去重。
    const missing = scanBundleContracts(profileDir);
    for (const n of findMissingBundleDeclarations(profileDir, readDshWebLogTail(120))) {
      if (!missing.includes(n)) missing.push(n);
    }
    if (missing.length > 0) {
      const removed = await removeBundlesFromProfile(profileDir, missing);
      if (removed.length > 0) {
        log('boot', '已从 profile 启动层移除无声明插件（备份于 package.json.bak-*）: ' + removed.join(', '));
        notifyBundleRepair(removed);
        appendSelfHealHistory('bundle', removed);
        return startAndShow(overlays)
          .then(() => showSelfHealNotice('bundle', removed))
          .catch((e2) => handleBootFailure(e2, overlays));
      }
    }
  }
  // settings.yaml 整体损坏（settings 服务起不来）时给出「备份并重置」的一键
  // 恢复（用户同意才动文件），而不是让用户面对无从下手的失败弹窗。
  const settingsFail = scanWebLogForSettingsFailure();
  if (settingsFail && fs.existsSync(settingsFail.filePath)) {
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: '检测到 settings 配置文件损坏。',
      detail: (err && err.message || String(err)) + '\n\n' + settingsFail.line + '\n\n可备份并重置该文件后重试（原文件保留为 .broken-<时间戳> 备份）。',
      buttons: ['备份并重置 settings 后重试', '重试', '退出'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 0) {
        try {
          fs.renameSync(settingsFail.filePath, settingsFail.filePath + '.broken-' + Date.now());
          log('boot', 'settings 已备份并重置: ' + settingsFail.filePath);
        } catch (e) {
          log('boot', 'settings 备份重置失败: ' + e.message);
        }
        startAndShow(overlays).catch((e2) => handleBootFailure(e2, overlays));
      } else if (response === 1) {
        startAndShow(overlays).catch((e2) => handleBootFailure(e2, overlays));
      } else {
        app.quit();
      }
    });
    return;
  }
  fatal('DeepSeek Harness 启动失败', err);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// 主窗口位置记忆：用户拖到哪里，下次启动就在哪里。此前主窗不指定 x/y，
// 每次启动位置由 Windows 层叠策略决定（左上角附近），表现为「拖到中间，
// 重启又跑回左边」。状态存 <userData>/window-state.json（原子写），恢复前
// 校验落在某块显示器工作区内，按掉的外接屏不会把窗口留在屏幕外。
function windowStateFile() {
  return path.join(userDataDir, 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const b = raw && raw.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v))) return null;
    return {
      bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      maximized: raw.maximized === true,
    };
  } catch { /* 首次启动/文件损坏 → 居中 */ }
  return null;
}

// 窗口至少有 100x100 区域落在某块显示器工作区内，才认为位置可恢复。
function boundsVisibleOnSomeDisplay(bounds) {
  try {
    for (const d of screen.getAllDisplays()) {
      const a = d.workArea;
      const ox = Math.max(0, Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x));
      const oy = Math.max(0, Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y));
      if (ox >= 100 && oy >= 100) return true;
    }
  } catch { /* screen 不可用时保守放行 */ return true; }
  return false;
}

let mainWindowStateTimer = null;
function saveWindowStateNow(win) {
  try {
    if (!win || win.isDestroyed()) return;
    // getNormalBounds：最大化时也返回还原尺寸，无需区分事件来源。
    const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    writeFileAtomic(windowStateFile(), JSON.stringify(state));
  } catch (err) {
    log('window', '位置保存失败: ' + ((err && err.message) || err));
  }
}

// move/resize 高频触发，防抖落盘（与宠物窗 petPosTimer 同策略）。
function scheduleSaveWindowState(win) {
  if (mainWindowStateTimer !== null) clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(() => {
    mainWindowStateTimer = null;
    saveWindowStateNow(win);
  }, 400);
}

function createWindow(opts = {}) {
  const savedState = loadWindowState();
  const visible = savedState && boundsVisibleOnSomeDisplay(savedState.bounds);
  mainWindow = new BrowserWindow({
    width: (visible && savedState.bounds.width) || 1400,
    height: (visible && savedState.bounds.height) || 900,
    ...(visible ? { x: savedState.bounds.x, y: savedState.bounds.y } : { center: true }),
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DSH Desktop JXZ',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 风格化无边框窗口：去掉原生标题栏/菜单栏，自绘玻璃栏 + Win11 原生圆角。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const win = mainWindow;

  win.loadFile(path.join(__dirname, 'assets', 'loading.html'));
  // startHidden：崩溃恢复重建窗口时保持「隐藏到托盘」状态，不突然弹出窗口。
  // 上次是最大化则恢复最大化（在 show 前调，避免可见的尺寸跳变）。
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (savedState && savedState.maximized) win.maximize();
    if (!opts.startHidden) win.show();
  });
  // 位置/尺寸变化防抖保存；最大化状态切换与关闭时立即保存。
  win.on('resize', () => scheduleSaveWindowState(win));
  win.on('move', () => scheduleSaveWindowState(win));
  win.on('maximize', () => saveWindowStateNow(win));
  win.on('unmaximize', () => saveWindowStateNow(win));
  win.on('close', () => {
    if (mainWindowStateTimer !== null) { clearTimeout(mainWindowStateTimer); mainWindowStateTimer = null; }
    saveWindowStateNow(win);
  });
  // Keep the app brand in the OS title bar (the web UI sets its own <title>).
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle('DSH Desktop JXZ');
  });

  // Open target=_blank / window.open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the window pinned to the local web UI; send external links out.
  // H1 修复：origin 精确比较（protocol+host+port），杜绝前缀/异域/userinfo 逃逸；
  // file: 一律拦截（同 webContents 下 file 页面仍持有 preload 桥）；will-redirect 同规则。
  // 判定函数为模块级 isAllowedWebUrl（浮窗守卫共用同一实现，见会话浮窗小节）。
  const guardNavigation = (event, url) => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  // 高频重复的 warning/error 会变成同步磁盘写入，明显拖慢渲染。
  // 同一签名 5 秒内只落一条日志。
  const pageConsoleThrottle = new Map();
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level === "error" || level === "warning") {
      const key = `${level}:${message}:${sourceId || "unknown"}:${line}`;
      const now = Date.now();
      if (now - (pageConsoleThrottle.get(key) || 0) < 5000) return;
      if (pageConsoleThrottle.size > 500) pageConsoleThrottle.clear();
      pageConsoleThrottle.set(key, now);
      log("page", `[${level}] ${message} (${sourceId || "unknown"}:${line})`);
    }
  });
  // 渲染进程崩溃/挂起的自恢复由 renderer-recovery.js 统一接管
  // （boot 阶段经 wireWindowRecovery() 挂载），这里不再只记日志。

  // 窗口显示（从托盘/最小化/二次启动恢复）时刷新余额，切回来即是最新。
  win.on('show', () => maybeRefreshBalance());

  // 页面（重）加载完成后补推一次余额缓存（reload/恢复重建后插件订阅事件
  // 已失效，直接推送当前缓存即可立即恢复显示）。
  win.webContents.on('did-finish-load', () => {
    if (balanceCache) {
      try { win.webContents.send('dsh:balance', balanceCache); } catch {}
    }
  });

  // 移除菜单栏后仍保留的键盘快捷键。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.key === 'F11') { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === 'F12') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && input.shift && key === 'i') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && key === 'r') { reloadMainWindow(); event.preventDefault(); }
    else if (input.alt && key === 'f4') { mainWindow.close(); event.preventDefault(); }
  });

  // 自绘最大化/还原按钮需要感知窗口状态。
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  mainWindow.on('enter-full-screen', sendMaxState);
  mainWindow.on('leave-full-screen', sendMaxState);

  // 关闭 → 隐藏到托盘（可在 chrome 菜单关闭该行为）。
  mainWindow.on('close', (event) => {
    // 主窗关闭（无论到托盘还是退出）时同步关闭会话浮窗。
    closeAllFloatWindows();
    if (!forceQuit && IS_WIN && closeToTrayEnabled() && tray) {
      event.preventDefault();
      mainWindow.hide();
      trayHintOnce();
    }
  });

  // 主窗最小化且宠物启用「最小化自动弹出小窗」→ 自动打开宠物小窗
  // （小窗为独立置顶窗口，主窗最小化/隐藏不影响其显示）。
  mainWindow.on('minimize', () => {
    if (petAutoOpen && (!petWindow || petWindow.isDestroyed())) createPetWindow();
  });

  mainWindow.on('closed', () => {
    // 崩溃恢复会销毁并重建主窗：旧窗口的 closed 可能晚于新窗口创建，
    // 必须校验身份，避免把新的 mainWindow 全局引用置空。
    if (mainWindow === win) mainWindow = null;
    if (sponsorWindow && !sponsorWindow.isDestroyed()) sponsorWindow.destroy();
    sponsorWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 渲染进程自恢复：装配 renderer-recovery 状态机（Issue #9 根治修复）
// ---------------------------------------------------------------------------

function initRendererRecovery() {
  if (recovery) return recovery;
  const opts = {
    log: (msg) => log('recovery', msg),
    isQuitting: () => quitting,
    isServerAlive: () => !!serverProc && serverProc.exitCode === null && !serverProc.killed,
    getTarget: () => (webUrl ? { kind: 'url', url: webUrl } : null),
    loadingPage: path.join(__dirname, 'assets', 'loading.html'),
    recoveryPage: path.join(__dirname, 'assets', 'recovery.html'),
    rebuildMainWindow: ({ startHidden } = {}) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      createWindow({ startHidden: !!startHidden });
      wireWindowRecovery();
      return mainWindow;
    },
    waitServerUp: (maxMs) => {
      if (!webUrl) return Promise.reject(new Error('webUrl 未知'));
      return waitUntilUp(webUrl, maxMs);
    },
    onGaveUp: (lastFailure) => {
      writeRunState({ renderer: { state: 'gave-up', lastFailure, at: new Date().toISOString() } });
    },
    onStable: () => {
      writeRunState({ renderer: { state: 'healthy', at: new Date().toISOString() } });
    },
    notify: (title, body) => {
      try {
        showNotification({ title, body, onClick: () => showMainWindow() });
      } catch (err) {
        log('recovery', '通知发送失败: ' + err.message);
      }
    },
  };
  // 集成测试专用：缩短「稳定期」，加快测试节奏。生产环境恒为默认 30s。
  if (process.env.DSH_DESKTOP_TEST && process.env.DSH_DESKTOP_TEST_STABILITY_MS) {
    opts.STABILITY_MS = Number(process.env.DSH_DESKTOP_TEST_STABILITY_MS);
  }
  recovery = new RendererRecovery(opts);
  return recovery;
}

function wireWindowRecovery() {
  if (recovery && mainWindow && !mainWindow.isDestroyed()) recovery.attach(mainWindow, 'main');
}

// 统一的「重新加载」入口：处于恢复页（已放弃自动恢复）时走恢复流程，
// 否则普通 reload。菜单与 Ctrl+R 共用。
function reloadMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const st = recovery ? recovery.stateOf(mainWindow) : null;
  if (st && st.gaveUp) {
    log('recovery', '用户在恢复页触发重新加载');
    recovery.retryNow(mainWindow);
    return;
  }
  mainWindow.reload();
}

function startHeartbeatLoop() {
  // renderer 心跳由 preload 每 5s 上报；这里周期性判定「可见窗口」是否失联。
  setInterval(() => { if (recovery) recovery.checkHeartbeats(); }, 15000).unref();
}

// 会话浮窗：共享的 Web 守卫 + 浮窗创建/生命周期
// ---------------------------------------------------------------------------

// 本地 Web 地址判定（浮窗与主窗共用，杜绝异域/文件导航逃逸）。
function isAllowedWebUrl(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (webUrl) {
      const base = new URL(webUrl);
      return target.origin === base.origin;
    }
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';
  } catch {
    return false;
  }
}

// 给一个 webContents 挂上导航围栏 + 外部链接 + 异常日志守卫（浮窗使用）。
function guardWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // 与主窗处理器同一标准签名（event, level, message, line, sourceId）。
    // 浮窗插件的排查日志是 console.log（info 级）：同样落进 desktop.log，
    // 不必再要求用户打开 DevTools。
    const text = message || '';
    const lvl = level;
    const lineNo = line;
    const src = sourceId || 'unknown';
    if (lvl === 'error' || lvl === 3 || lvl === 'warning' || lvl === 2 || /\[dsh-float-window\]/.test(text)) {
      log('float-page', `[${lvl}] ${text} (${src}:${lineNo})`);
    }
  });
  // 浮窗渲染进程崩溃/挂起的自恢复由 renderer-recovery.js 统一接管
  // （createFloatWindow 里经 recovery.attach 挂载），这里不再只记日志。
}

// 创建并登记一个会话浮窗。返回 BrowserWindow；失败返回 null。
function createFloatWindow(sessionId, { title } = {}) {
  if (!webUrl || floatWindows.size >= FLOAT_MAX) return null;
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: title || 'DSH 会话',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 与主窗一致的无边框；浮窗 preload 注入一条更细的纯拖拽条。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 独立分区：浮窗与主窗隔离 localStorage，避免互相覆盖 dsh.sessions.current。
      // 会话数据在服务端（~/.dsh），localStorage 仅存 UI 选中态，无 cookie 认证，
      // 独立分区安全。所有浮窗共享同一 partition 字符串。
      partition: 'persist:dsh-float',
      // 用 additionalArguments 而非 URL 参数，避免污染 Web UI 见到的地址；
      // preload 从 process.argv 读取 --dsh-float=<sessionId>。
      additionalArguments: ['--dsh-float=' + sessionId],
    },
  });
  floatWindows.add(win);
  floatBySession.set(sessionId, win);
  win.loadURL(webUrl).catch((err) => log('float', '浮窗加载失败: ' + ((err && err.message) || err)));

  // 窗口标题跟随会话（去掉通用前缀，保留会话相关标题）。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    const raw = String(event.title || win.getTitle() || '');
    const cleaned = raw.replace(/^DSH[·\-—\s/]*/i, '').trim();
    win.setTitle(cleaned || 'DSH 会话');
  });

  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => {
    floatWindows.delete(win);
    for (const [sid, w] of floatBySession) {
      if (w === win) { floatBySession.delete(sid); break; }
    }
  });
  guardWebContents(win.webContents);
  if (recovery) recovery.attach(win, "float");

  log('float', '已创建会话浮窗 sessionId=' + sessionId);
  return win;
}

// 关闭全部浮窗（主窗关闭 / app 退出时调用）。
function closeAllFloatWindows() {
  for (const win of floatWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  floatWindows.clear();
  floatBySession.clear();
  if (sponsorWindow && !sponsorWindow.isDestroyed()) sponsorWindow.destroy();
  sponsorWindow = null;
}

// ---------------------------------------------------------------------------
// 桌面宠物原生小窗
// ---------------------------------------------------------------------------

function petPositionFile() {
  return path.join(userDataDir, 'pet-window.json');
}

// 读取持久化的小窗位置：跨屏校验（目标点所在显示器存在则用），并钳制在
// 该显示器可视区内；读不到 / 不合法时返回 null（调用方落默认右下角）。
function loadPetPosition() {
  try {
    const raw = JSON.parse(fs.readFileSync(petPositionFile(), 'utf8'));
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      const probe = { x: Math.round(raw.x), y: Math.round(raw.y), width: PET_WINDOW_W, height: PET_WINDOW_H };
      const area = screen.getDisplayMatching(probe).workArea;
      return {
        x: Math.round(Math.min(Math.max(raw.x, area.x), area.x + area.width - PET_WINDOW_W)),
        y: Math.round(Math.min(Math.max(raw.y, area.y), area.y + area.height - PET_WINDOW_H)),
      };
    }
  } catch {}
  return null;
}

function savePetPosition(x, y) {
  try {
    fs.writeFileSync(petPositionFile(), JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
  } catch (err) {
    log('pet', '保存宠物小窗位置失败: ' + (err && err.message ? err.message : err));
  }
}

function pushPetState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('pet:state', { open: !!(petWindow && !petWindow.isDestroyed()) }); } catch {}
  }
}

function closePetWindow() {
  if (petPosTimer !== null) { clearTimeout(petPosTimer); petPosTimer = null; }
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

// 创建（或复用）宠物小窗：无边框、透明、置顶（screen-saver）、不进任务栏。
// 与主窗共用默认分区（共享 localStorage：会话选中态与 harness-pet 设置），
// preload 经 additionalArguments 的 --dsh-pet=1 进入小窗模式。
function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow;
  if (!webUrl) return null;
  const saved = loadPetPosition();
  const area = screen.getPrimaryDisplay().workArea;
  const pos = saved || {
    x: area.x + area.width - PET_WINDOW_W - 24,
    y: area.y + area.height - PET_WINDOW_H - 24,
  };
  const win = new BrowserWindow({
    width: PET_WINDOW_W,
    height: PET_WINDOW_H,
    x: pos.x,
    y: pos.y,
    show: false,
    title: 'DSH 宠物',
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 不设 partition：与主窗共享 localStorage（dsh.sessions.current 与
      // harness-pet:settings），小窗才能实时跟随主窗会话/设置。
      additionalArguments: ['--dsh-pet=1'],
    },
  });
  petWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(webUrl).catch((err) => log('pet', '小窗加载失败: ' + ((err && err.message) || err)));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  // 位置防抖保存（400ms）。
  win.on('move', () => {
    if (petPosTimer !== null) clearTimeout(petPosTimer);
    petPosTimer = setTimeout(() => {
      petPosTimer = null;
      if (petWindow === win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        savePetPosition(x, y);
      }
    }, 400);
  });
  win.on('closed', () => {
    if (petPosTimer !== null) { clearTimeout(petPosTimer); petPosTimer = null; }
    if (petWindow === win) petWindow = null;
    pushPetState();
  });
  guardWebContents(win.webContents);
  if (recovery) recovery.attach(win, "float");
  log('pet', '已创建宠物小窗 (' + PET_WINDOW_W + 'x' + PET_WINDOW_H + ')');
  pushPetState();
  return win;
}

// ---------------------------------------------------------------------------
// 赞助小窗：独立「请作者喝咖啡」收款码窗口
// ---------------------------------------------------------------------------

// 读取支付宝 / 微信收款码图片，返回 data URI（供 IPC 与小窗复用）。
function readSponsorQr() {
  const read = (name) => {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'sponsor', name));
      const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch { return ''; }
  };
  return { ok: true, alipay: read('sponsor-alipay.jpg'), wechat: read('sponsor-wechat.png') };
}

// 创建（或聚焦已有）赞助小窗。窗口为原生边框小窗，内嵌深色 HTML 展示两码。
function createSponsorWindow() {
  if (sponsorWindow && !sponsorWindow.isDestroyed()) {
    sponsorWindow.show();
    sponsorWindow.focus();
    return sponsorWindow;
  }
  const qr = readSponsorQr();
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0b1220;color:#e6ecff;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    display:flex;flex-direction:column;height:100vh;user-select:none}
  .head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
    border-bottom:1px solid rgba(255,255,255,.08)}
  .title{font-size:14px;font-weight:600}
  .close{width:26px;height:26px;display:grid;place-items:center;border:none;border-radius:8px;
    background:transparent;color:#a9b8de;cursor:pointer;font-size:16px;line-height:1}
  .close:hover{background:rgba(255,255,255,.1);color:#eef2ff}
  .sub{font-size:12px;color:#8b9ac4;line-height:18px;padding:10px 14px 0}
  .codes{flex:1;display:flex;gap:16px;justify-content:center;align-items:center;padding:8px 14px 16px}
  .code{flex:1;min-width:0;text-align:center}
  .code img{width:100%;max-width:150px;aspect-ratio:1/1;object-fit:contain;display:block;margin:0 auto;
    border-radius:10px;background:#fff;padding:8px;box-sizing:border-box}
  .code p{margin:8px 0 0;font-size:12px;color:#a9b8de}
  .empty{font-size:12px;color:#8b9ac4;text-align:center;padding:16px 0}
</style>
</head>
<body>
  <div class="head">
    <div class="title">☕ 请作者喝咖啡</div>
    <button class="close" title="关闭" aria-label="关闭" onclick="window.close()">×</button>
  </div>
  <div class="sub">如果这个桌面客户端帮到了你，欢迎扫一扫支持一下作者，谢谢你的鼓励～</div>
  <div class="codes" id="codes"></div>
  <script>
    var codes = [
      { name: '支付宝', src: \`${qr.alipay}\` },
      { name: '微信', src: \`${qr.wechat}\` },
    ].filter(function (c) { return c.src; });
    var box = document.getElementById('codes');
    if (!codes.length) {
      box.className = 'empty';
      box.textContent = '未找到收款码资源';
    } else {
      box.className = 'codes';
      box.innerHTML = codes.map(function (c) {
        return '<div class="code"><img alt="' + c.name + '收款码" src="' + c.src + '"><p>' + c.name + '</p></div>';
      }).join('');
    }
  </script>
</body>
</html>`;
  const win = new BrowserWindow({
    width: 360,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '请作者喝咖啡',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  sponsorWindow = win;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    .catch((err) => log('sponsor', '赞助小窗加载失败: ' + ((err && err.message) || err)));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => { if (sponsorWindow === win) sponsorWindow = null; });
  // Esc 关闭小窗。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      if (!win.isDestroyed()) win.close();
    }
  });
  log('sponsor', '已打开赞助小窗');
  return win;
}

function fatal(title, err) {
  log('fatal', title + ': ' + ((err && (err.stack || err.message)) || err));
  const detail = '错误：' + ((err && err.message) || err) + logTailSnippet() + '\n\n日志目录：' + logsDir;
  if (!mainWindow || mainWindow.isDestroyed()) {
    dialog.showErrorBox(title, detail);
    markCleanExit();
    killTreeSync(serverProc); // app.exit 不触发 before-quit，这里保证进程树被终结
    app.exit(1);
    return;
  }
  showBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['重试', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) startAndShow().catch((err2) => handleBootFailure(err2));
    else app.quit();
  });
}

// ---------------------------------------------------------------------------
// Self-update flow (official @deepseek-ai/dsh releases, user-consented)
// ---------------------------------------------------------------------------

function showUpdateWindow(version, kind = 'agent') {
  // 更新进度窗必须保持主窗口可用：不设 parent/modal，并允许最小化与关闭。
  // 旧实现 modal:true + minimizable:false 会在整个下载期间禁用主窗口（下载
  // 安装包可长达数分钟），用户既不能继续使用应用，也无法把进度窗最小化；
  // 且模态进度窗未关闭时主窗处于禁用态，随后的「下载完成/更新完成」对话框
  // 可能无法正常弹出，表现为「下载成功但无法更新」。关闭本窗口不会取消
  // 后台更新/下载，完成对话框仍会照常弹出。
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: true,
    maximizable: false,
    closable: true,
    autoHideMenuBar: true,
    title: '正在更新',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'assets', 'updating.html')).then(() => {
    win.webContents
      .executeJavaScript(`window.__init && window.__init(${JSON.stringify({ version, kind })})`)
      .catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

function closeUpdateWindow(win) {
  if (win && !win.isDestroyed()) win.destroy();
}

async function runUpdateFlow(manual) {
  if (quitting) return;
  if (updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  // 守卫标志同步置位：checkLatest（网络，最长 90s）与发现新版本对话框（用户思考）
  // 都在旧实现的置位之前，自动更新定时器（6h）与手动触发可同时通过守卫并发
  // 执行 applyUpdate，双 npm 安装互踩 staging 会损坏 agent。整个流程包进
  // try/finally，所有提前返回路径都经 finally 复位标志，杜绝更新永久卡死。
  updateBusy = true;
  try {
    const ctx = updCtx();
    let latest;
    try {
      latest = await updater.checkLatest(ctx);
    } catch (err) {
      log('update', '检查失败: ' + err.message);
      if (manual) {
        await showBox({
          type: 'warning',
          title: '检查更新失败',
          message: '无法连接 GitHub Releases 或 npm registry。',
          detail: err.message + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置 npm 镜像；GitHub Releases 会在网络可用时自动重试。',
          buttons: ['确定'],
        });
      }
      return;
    }
    // 双保险：activeVersion 已兜底 '0.0.0'，此处再加 || '0.0.0' 防未来回归。
    const current = isWslMode()
      ? (wslBackend.activeVersion() || '0.0.0')
      : (updater.activeVersion(ctx) || '0.0.0');
    const settings = updater.loadSettings(ctx);
    if (updater.compareVersions(latest, current) <= 0) {
      if (manual) {
        await showBox({
          type: 'info',
          title: '检查更新',
          message: '当前已是最新版本。',
          detail: `@deepseek-ai/dsh@${current}`,
          buttons: ['确定'],
        });
      }
      return;
    }
    if (!manual && settings.skipVersion === latest) return;

    const { response } = await showBox({
      type: 'info',
      title: '发现新版本',
      message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
      detail: `当前版本：${current}\n\n是否立即更新？\n· 从 npm 官方源下载新版本及其依赖（首次约 250MB）\n· 更新期间界面保持可用，完成后重启应用生效\n· 失败会自动保留当前版本` + (isWslMode() ? '\n· WSL 托管模式：安装在 ' + wslBackend.installDirLinux() + '/agent' : ''),
      buttons: ['立即更新', '跳过此版本', '稍后'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) {
      settings.skipVersion = latest;
      updater.saveSettings(ctx, settings);
      log('update', '用户跳过版本 ' + latest);
      return;
    }
    if (response === 2) return;

    const progressWin = showUpdateWindow(latest);
    try {
      if (isWslMode()) {
        // WSL 托管：检查复用 Windows 侧 npm（纯 registry 查询），安装走 WSL 内
        // npm（staging + 原子切换，语义与本地模式一致）。
        await wslBackend.applyUpdate(latest, (line) => log('update', 'wsl: ' + line));
        // 新 WSL agent 已就位：与 local 一致，立即补同步配套插件/内置预设并重打
        // 运行时补丁（全部幂等），否则「稍后重启」后再重启服务会以未修复、且
        // 缺少壳内置模式的新版本启动。
        ensurePluginIntegration().syncPlugins();
        syncBuiltinAgentPresets();
        notifyPatchFailures(ensurePluginIntegration().applyPatches());
        ensurePluginIntegration().preflightHealth();
      } else {
        await updater.applyUpdate(ctx, latest);
        // 新 overlay 已就位：立即重打运行时补丁（全部幂等），否则「稍后重启」后再
        // 点「重启 dsh web 服务」会用未修复的新版本启动（识图发送、设置暴露等回归）。
        // 同时把壳内置 Agent 预设补进新 overlay（干净 npm 包不含 8 个壳预设）。
        syncLocalAgentPresets();
        notifyPatchFailures(ensurePluginIntegration().applyPatches());
        ensurePluginIntegration().preflightHealth();
      }
      // 进度窗已非模态，但完成对话框弹出前仍先关闭它，避免叠窗/对话框被遮挡。
      closeUpdateWindow(progressWin);
      const { response: r2 } = await showBox({
        type: 'info',
        title: '更新完成',
        message: `已更新到 @deepseek-ai/dsh@${latest}`,
        detail: '重启应用后生效。',
        buttons: ['立即重启', '稍后重启'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r2 === 0) {
        quitting = true;
        markCleanExit();
        killTreeSync(serverProc);
        // 立即重启前预热 profile fallback：先终结旧服务再重指向新 overlay 的
        // 联接并落新快照（新版本锚点与旧快照必然不同），重启后的首次启动直接
        // 走快照快速校验，不再把完整 heal（约 0.6s）压在启动关键路径上；旧
        // 服务已退出，重指向不会与旧进程的延迟加载产生版本错配。
        if (!isWslMode()) {
          await repairProfileFallback(dshHome || path.join(os.homedir(), '.dsh'));
        }
        app.relaunch();
        app.exit(0);
      }
    } catch (err) {
      closeUpdateWindow(progressWin);
      log('update', '更新失败: ' + err.message);
      await showBox({
        type: 'error',
        title: '更新失败',
        message: '未能完成更新，仍使用当前版本。',
        detail: err.message,
        buttons: ['确定'],
      });
    } finally {
      if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
    }
  } finally {
    updateBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Session-completion notifications
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map(); // sessionId -> timestamp (per-session rate-limit)
let lastGlobalNotifyAt = 0; // 全局限流：短时间窗口内至多一条，避免多会话同时完成刷屏

function onSessionTurnEnd(info) {
  log('notify', 'DEBUG turn detected: ' + JSON.stringify({ sid: info.sessionId, title: info.title, notifyOnTurnEnd, quitting, vis: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(), foc: mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(), curSid: currentSessionId }));
  // 回合完成 = 产生消耗：触发余额刷新（节流 30s），让余额显示及时同步。
  maybeRefreshBalance();
  if (!notifyOnTurnEnd || quitting) { log('notify', 'DEBUG skip: notifyOnTurnEnd=' + notifyOnTurnEnd + ' quitting=' + quitting); return; }
  // 主窗可见且聚焦：用户正在操作，不弹通知打扰。最小化/隐藏/失焦时不拦截。
  // 「当前正在观看的会话」不再单独拦截：同一会话在后台完成时（窗口被遮挡、
  // 最小化或切走）正是最需要系统提醒的场景，日志证实旧逻辑在这里把提醒全部吞掉。
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) { log('notify', 'DEBUG skip: window visible+focused'); return; }
  const now = Date.now();
  const last = lastNotifyAt.get(info.sessionId) || 0;
  if (now - last < 30000) return; // 同一会话：30s 内至多一条
  if (now - lastGlobalNotifyAt < 15000) return; // 全局限流：15s 内至多一条
  lastNotifyAt.set(info.sessionId, now);
  lastGlobalNotifyAt = now;
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    // 点击通知回前台：走 showNotification 的默认行为（showMainWindow 覆盖
    // 最小化/托盘隐藏/窗口销毁重建/moveTop 等全部恢复路径）。
    showNotification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      onClick: () => {
        showMainWindow();
        const sessionId = typeof info.sessionId === 'string' ? info.sessionId.trim() : '';
        if (!sessionId || sessionId.length > 256) return;
        try {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('dsh:notification-jump', { sessionId });
          }
        } catch (err) {
          log('notify', '通知跳转会话失败: ' + err.message);
        }
      },
    });
  } catch (err) {
    log('notify', '通知发送失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Chrome（自绘标题栏）IPC、托盘、余额、快捷方式
// ---------------------------------------------------------------------------

function closeToTrayEnabled() {
  const s = updater.loadSettings(updCtx());
  return s.closeToTray !== false;
}

function setCloseToTray(v) {
  const s = updater.loadSettings(updCtx());
  s.closeToTray = !!v;
  updater.saveSettings(updCtx(), s);
}

function balanceDockEnabled() {
  const s = updater.loadSettings(updCtx());
  return s.showBalanceDock !== false;
}

function setBalanceDock(v) {
  const s = updater.loadSettings(updCtx());
  s.showBalanceDock = !!v;
  updater.saveSettings(updCtx(), s);
}

function repoUrls() {
  const repos = clientUpdater.resolveRepos();
  return {
    github: 'https://github.com/' + repos.github,
    gitee: 'https://gitee.com/' + repos.gitee,
  };
}

async function showAbout() {
  const urls = repoUrls();
  const { response } = await showBox({
    type: 'info',
    title: '关于 DSH Desktop JXZ',
    message: 'DSH Desktop JXZ ' + APP_VERSION,
    detail: 'DeepSeek Harness 桌面客户端\n\nagent 版本：' + dshVersion() + '（' + dshVersionSource() + '）\n数据目录：' + userDataDir + '\nDSH_HOME：' + (isWslMode() ? 'WSL：' + wslBackend.installDirLinux() : (dshHome || '（dsh 默认）')) +
      '\n\n项目仓库：\n  GitHub: ' + urls.github + '\n  Gitee:  ' + urls.gitee,
    buttons: ['复制 GitHub 地址', '复制 Gitee 地址', '确定'],
  });
  if (response === 0) clipboard.writeText(urls.github);
  else if (response === 1) clipboard.writeText(urls.gitee);
}

// 图片粘贴保存（dsh-image-paste 插件，借鉴 EAC）：只接受 image/* 的 data URL，
// base64 解码后原子写入 %TEMP%/dsh-paste/<清洗名>-<时间戳><ext>，返回
// { ok, path, size }。文件在临时目录，随系统清理，不污染工作区。
const IMAGE_PASTE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PASTE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/ico': '.ico',
  'image/x-icon': '.ico',
  'image/tiff': '.tiff',
};

function imagePasteSave(dataUrl, name) {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: '不是合法的图片 data URL' };
  const mime = m[1].toLowerCase();
  if (!IMAGE_PASTE_EXT[mime]) return { ok: false, error: '不支持的图片类型: ' + mime };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return { ok: false, error: '图片内容为空' };
  if (buf.length > IMAGE_PASTE_MAX_BYTES) return { ok: false, error: '图片超过 15MB 上限' };
  const dir = path.join(os.tmpdir(), 'dsh-paste');
  fs.mkdirSync(dir, { recursive: true });
  const base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40) || '粘贴图片';
  const file = path.join(dir, base + '-' + Date.now() + IMAGE_PASTE_EXT[mime]);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, size: buf.length };
}

function registerChromeIpc() {
  ipcMain.handle('chrome:init', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    // 等待预览静态服务端口就绪（有界 1.5s）：消除「主窗加载早于 listen 回调」
    // 的竞态，消费方拿到的 staticPort 不会是 0。
    await Promise.race([previewPortReady, new Promise((r) => setTimeout(r, 1500))]);
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch {}
    const s = updater.loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: APP_VERSION,
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd,
      closeToTray: s.closeToTray !== false,
      showBalanceDock: s.showBalanceDock !== false,
      iconDataUri,
      repoUrls: urls,
      staticPort: previewStaticPort,
      mode: isWslMode() ? 'wsl' : 'local',
    };
  });

  ipcMain.on('dsh:renderer-heartbeat', (event) => {
    if (recovery) recovery.noteHeartbeat(event.sender.id);
  });

  // 恢复页面（assets/recovery.html）的三个按钮。全部校验来源必须是主窗。
  ipcMain.handle('chrome:recovery-state', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    return {
      appVersion: APP_VERSION,
      logsDir,
      crashDumpsDir,
      state: recovery ? recovery.stateOf(mainWindow) : null,
    };
  });

  ipcMain.handle('chrome:recovery-reload', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    // 服务进程已退出时先重启服务（可能换新端口），再恢复加载。
    if (!serverProc || serverProc.exitCode !== null || serverProc.killed) {
      try {
        await startAndShow();
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    recovery.retryNow(mainWindow);
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-restart', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    log('recovery', '用户在恢复页面选择重启客户端');
    quitting = true;
    forceQuit = true;
    markCleanExit();
    killTreeSync(serverProc);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('chrome:recovery-open-logs', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    shell.openPath(logsDir);
    return { ok: true };
  });
  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'toggle-maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
      case 'is-maximized': return mainWindow.isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { notifyOnTurnEnd, closeToTray: closeToTrayEnabled(), showBalanceDock: balanceDockEnabled() };
    }
    switch (action) {
        case 'reload': reloadMainWindow(); break;
      case 'devtools': mainWindow.webContents.toggleDevTools(); break;
      case 'fullscreen': mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
      case 'open-browser': if (webUrl) shell.openExternal(webUrl); break;
      case 'open-logs': shell.openPath(logsDir); break;
      case 'check-agent-update': runUpdateFlow(true); break;
      case 'check-client-update': runClientUpdateFlow(true); break;
      case 'toggle-notify': {
        notifyOnTurnEnd = !notifyOnTurnEnd;
        const s = updater.loadSettings(updCtx());
        s.notifyOnTurnEnd = notifyOnTurnEnd;
        updater.saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'toggle-balance': {
        setBalanceDock(!balanceDockEnabled());
        refreshBalance().catch(() => {});
        break;
      }
      case 'about': showAbout(); break;
      case 'quit': forceQuit = true; app.quit(); break;
    }
    return { notifyOnTurnEnd, closeToTray: closeToTrayEnabled(), showBalanceDock: balanceDockEnabled() };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  // 测试通道 'restart-service' 复用同一实现，保证集成测试覆盖真实 IPC 路径。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if (payload?.intent !== 'restart-service') return { ok: false, error: 'missing-intent' };
    // 与其余插件管理 IPC 同口径：frame-origin 精确校验（修复历史只查 sender）。
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    return restartService();
  });

  // 插件保护中心（plugin-guard.js）：快照 / 回滚 / 体检 / 修复 / 事故报告。
  // 设置页「插件保护」分区从这里取数与触发动作（借鉴 EAC）。
  ipcMain.handle('guard:action', async (event, { action, value } = {}) => {
    // 与其余插件管理 IPC 同口径：frame-origin 精确校验（修复历史只查 sender 的不一致）。
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    const g = ensureGuard();
    switch (action) {
      case 'status': {
        return {
          ok: true,
          profile: 'web',
          shareWebProfile: false,
          snapshots: g.listSnapshots().slice(0, 20),
          incidents: g.listIncidents().slice(0, 20),
          lastGood: g.lastGoodSnapshot(),
        };
      }
      case 'snapshot': {
        const s = g.snapshot(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        if (serverProc && !restartingServer) {
          // 服务运行中不能换配置文件（文件锁 + 进程内存态）：走标准重启窗口。
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        // 回滚属破坏性操作：主进程二次确认（测试通道自动放行）。
        if (!(await confirmPluginAction('确定要回滚到快照 ' + String(value) + ' 吗？'))) {
          return { ok: false, error: '用户取消', canceled: true };
        }
        guardMutationBusy = true;
        try {
          return g.restore(value);
        } finally {
          guardMutationBusy = false;
        }
      }
      case 'check':
        return { ok: true, report: g.healthCheck() };
      case 'repair': {
        guardMutationBusy = true;
        try {
          const r = g.repair();
          return { ok: true, applied: r.applied };
        } finally {
          guardMutationBusy = false;
        }
      }
      case 'incident':
        return g.readIncident(value);
      case 'resolve-incident':
        return g.resolveIncident(value);
      default:
        return { ok: false, error: 'unknown action' };
    }
  });

  // 图片粘贴（dsh-image-paste 插件，借鉴 EAC）：把剪贴板图片存到临时目录供
  // agent 的 inspect_image 读取。只接受 image/* 的 data URL，限 15MB。
  ipcMain.handle('dsh:image-paste-save', async (event, { dataUrl, name } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    try {
      const res = imagePasteSave(String(dataUrl || ''), String(name || '粘贴图片'));
      if (!res.ok) return res;
      log('plugin-manager', '已保存粘贴图片: ' + res.path);
      return res;
    } catch (err) {
      log('plugin-manager', '保存粘贴图片失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 会话浮窗：主窗请求把某个会话弹出到独立窗口（校验来源与数量上限）。
  ipcMain.handle('chrome:float-window', (event, { action, sessionId } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (action !== 'open') return { ok: false, error: 'bad-action' };
    if (!webUrl) return { ok: false, error: 'not-ready' };
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'bad-session' };
    // 同一会话只保留一个浮窗：拖出/按钮连续触发或重复请求时，
    // 复用已有窗口而不是再开第二个。
    const existing = floatBySession.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, id: existing.id, reused: true };
    }
    if (existing) floatBySession.delete(sessionId);
    if (floatWindows.size >= FLOAT_MAX) return { ok: false, error: 'too-many' };
    const win = createFloatWindow(sessionId);
    if (!win) return { ok: false, error: 'too-many' };
    return { ok: true, id: win.id };
  });

  // 浮窗关闭：仅允许浮窗关闭自身（校验发送者属于某个浮窗）。
  ipcMain.on('float:close', (event) => {
    for (const win of floatWindows) {
      if (!win.isDestroyed() && win.webContents === event.sender) { win.close(); break; }
    }
  });

  // -------------------------------------------------------------------------
  // 桌面宠物原生小窗（harness-pet 插件对接，双端契约见 docs/pet-desktop.md）
  // -------------------------------------------------------------------------

  // 主窗请求宠物小窗 open / toggle / state（校验发送者必须是主窗）。
  ipcMain.handle('chrome:pet-window', (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (action === 'state') {
      return { ok: true, open: !!(petWindow && !petWindow.isDestroyed()) };
    }
    if (action === 'open' || action === 'toggle') {
      if (petWindow && !petWindow.isDestroyed()) {
        if (action === 'toggle') {
          closePetWindow();
          return { ok: true, open: false };
        }
        petWindow.show();
        petWindow.focus();
        return { ok: true, open: true, id: petWindow.id, reused: true };
      }
      const win = createPetWindow();
      if (!win) return { ok: false, error: 'not-ready' };
      return { ok: true, open: true, id: win.id };
    }
    return { ok: false, error: 'bad-action' };
  });

  // 小窗关闭自身（校验发送者是小窗）。
  ipcMain.on('pet:close', (event) => {
    if (petWindow && !petWindow.isDestroyed() && petWindow.webContents === event.sender) {
      petWindow.close();
    }
  });

  // 小窗搬窗：绝对目标位置（光标屏幕坐标 + 抓取偏移），钳制在当前显示器
  // 可视区（至少露出 80px，防止拖出视口找不回来）+ 取整（校验发送者是小窗）。
  ipcMain.on('pet:move-to', (event, { x, y } = {}) => {
    try {
      if (!petWindow || petWindow.isDestroyed() || petWindow.webContents !== event.sender) return;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      let area;
      try {
        const probe = { x: Math.round(x), y: Math.round(y), width: PET_WINDOW_W, height: PET_WINDOW_H };
        const display = screen.getDisplayMatching(probe);
        area = display && display.workArea;
      } catch { return; }
      if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y) || !Number.isFinite(area.width) || !Number.isFinite(area.height)) return;
      const nx = Math.min(Math.max(x, area.x - PET_WINDOW_W + 80), area.x + area.width - 80);
      const ny = Math.min(Math.max(y, area.y - PET_WINDOW_H + 80), area.y + area.height - 80);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      petWindow.setPosition(Math.round(nx), Math.round(ny));
    } catch (err) {
      log('warn', 'pet:move-to failed: ' + String((err && err.message) || err));
    }
  });

  // 主窗插件上报「最小化自动弹出小窗」开关（校验发送者必须是主窗）。
  ipcMain.on('pet:set-auto-open', (event, { enabled } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    petAutoOpen = enabled === true;
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  // 请作者喝咖啡：读取赞助二维码图片（支付宝 / 微信），以 data URI 返回给渲染进程。
  ipcMain.handle('dsh:sponsor-qr', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    return readSponsorQr();
  });

  // 赞助小窗：打开独立「请作者喝咖啡」窗口（校验来源是主窗）。
  ipcMain.handle('chrome:sponsor-window', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    createSponsorWindow();
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    log('page-error', String(payload));
  });

  // 渲染进程上报「当前观看的会话」ID，供完成通知的调试日志记录。
  ipcMain.on('dsh:current-session', (event, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return;
    currentSessionId = sessionId;
  });

  ipcMain.handle('dsh:balance-refresh', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    // 单一投递契约：处理器只触发刷新（数据经 'dsh:balance' 事件推送），
    // 不返回值——杜绝「处理器返回值 + 事件推送」双通道重复投递。
    // 显式触发绕过节流（页面挂载即要最新数据；并发由编排器仲裁）。
    maybeRefreshBalance(true).catch(() => {});
    return null;
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results = [];
    for (const c of changes) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) { fs.rmSync(p); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) { fs.writeFileSync(p, oldText, 'utf8'); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: 'conflict' });
        } else {
          // oldText 与 newText 双空：无任何变更意图，直接跳过（split/join 空串
          // 会恒满足 includes('') 并误报 reverted 虚假成功）（issue #87）。
          if (oldText === '' && newText === '') {
            results.push({ path: p, status: 'skipped' });
            continue;
          }
          if (content !== null && content.includes(newText)) {
            // oldText 需按字面量写回（split/join 不做 $ 替换模式展开，且全量替换），
            // 避免 $& / $' / $` 等被 String.replace 当替换模式吞掉、以及只还原首处。
            fs.writeFileSync(p, content.split(newText).join(oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err && err.message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    if (!isUnderFileRoots(p)) return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p)) return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // -------------------------------------------------------------------------
  // WSL 后端配置（设置页 dsh-wsl-settings 插件消费）：
  //   get     —— 当前后端模式 + 已保存的 wslDistro/wslInstallDir + WSL 探测状态
  //   save    —— 校验并持久化到 settings.json（重启应用生效）
  //   recheck —— 用已保存配置重新探测 WSL，返回最新状态
  // -------------------------------------------------------------------------
  ipcMain.handle('dsh:wsl-config', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const s = updater.loadSettings(updCtx());
    return {
      backend: backendMode,
      wslDistro: String(s.wslDistro || ''),
      wslInstallDir: String(s.wslInstallDir || ''),
      status: await wslStatusSnapshotAsync(),
      // 启动时 WSL 探测失败回落 local 的原因（空 = 未发生回落）。
      fallbackReason: wslFallbackReason,
    };
  });

  ipcMain.handle('dsh:wsl-config-save', async (event, { cfg } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'bad-payload' };
    const backend = String(cfg.backend || '').trim().toLowerCase();
    if (backend !== 'local' && backend !== 'wsl') return { ok: false, error: '后端模式必须是 local 或 wsl' };
    const wslDistro = String(cfg.wslDistro || '').trim();
    const wslInstallDir = String(cfg.wslInstallDir || '').trim();
    if (wslInstallDir && !wslInstallDir.startsWith('/') && !wslInstallDir.startsWith('~')) {
      return { ok: false, error: 'WSL 安装目录必须是 WSL 内绝对路径（以 / 或 ~ 开头）' };
    }
    if (/\s/.test(wslInstallDir)) return { ok: false, error: 'WSL 安装目录不能包含空白字符' };
    // 目标为 wsl 时预检一次，让用户在重启前就能发现配置问题（异步探测，
    // 不阻塞界面）。
    if (backend === 'wsl') {
      try {
        await wslBackend.configureAsync({ distro: wslDistro, installDir: wslInstallDir, log });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    const s = updater.loadSettings(updCtx());
    s.backend = backend;
    if (wslDistro) s.wslDistro = wslDistro; else delete s.wslDistro;
    if (wslInstallDir) s.wslInstallDir = wslInstallDir; else delete s.wslInstallDir;
    updater.saveSettings(updCtx(), s);
    log('wsl-config', '已保存后端配置: ' + JSON.stringify({ backend, wslDistro, wslInstallDir }));
    return { ok: true, restartRequired: true };
  });

  ipcMain.handle('dsh:wsl-recheck', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    const s = updater.loadSettings(updCtx());
    return {
      backend: backendMode,
      wslDistro: String(s.wslDistro || ''),
      wslInstallDir: String(s.wslInstallDir || ''),
      status: await wslStatusSnapshotAsync({ force: true }),
      fallbackReason: wslFallbackReason,
    };
  });

  // -------------------------------------------------------------------------
  // 插件管理（设置页「插件」页「管理」标签，dsh-plugin-manager 插件消费）。
  // 业务全部收口到 plugin-center（清单 / 生命周期 / 更新 / 自动隔离）。
  // 鉴权：list/set 与其余高危动作统一 frame-origin 精确校验。
  // -------------------------------------------------------------------------
  ipcMain.handle('dsh:plugin-list', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return [];
    const center = ensurePluginCenter();
    return center.inventory.collect().map((row) => ({
      ...row,
      description: pluginManagerPackageDescription(row.name),
    }));
  });

  ipcMain.handle('dsh:plugin-set-enabled', async (event, { id, enabled } = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const res = await pluginSetEnabled(String(id), !!enabled);
      if (!res.ok) return res;
      log('plugin-manager', '已' + (enabled ? '启用' : '关闭') + '插件 ' + id);
      return { ok: true, restartRequired: true };
    } catch (err) {
      log('plugin-manager', '设置插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, code: err && err.code, error: String((err && err.message) || err) };
    }
  });

  // 卸载：内置配套 = 标记卸载（可恢复，重启后不再同步/装配）；
  // 第三方 = 完整移除（bundles 登记 + dependencies + 目录 + store 副本）。
  ipcMain.handle('dsh:plugin-uninstall', async (event, { id } = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages.uninstall))) {
      return { ok: false, error: '用户取消', canceled: true };
    }
    try {
      const res = await ensurePluginCenter().lifecycle.uninstall(String(id));
      if (res.ok) log('plugin-manager', '已卸载插件 ' + id);
      return res;
    } catch (err) {
      log('plugin-manager', '卸载插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, code: err && err.code, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dsh:plugin-restore', async (event, { id } = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    // 恢复 = 重新装配（含解除自动隔离）：与卸载/更新同级的破坏性确认。
    if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages.restore))) {
      return { ok: false, error: '用户取消', canceled: true };
    }
    try {
      const res = await ensurePluginCenter().lifecycle.restore(String(id));
      if (res.ok) {
        // 恢复同样解除隔离：清掉本会话去重，插件若仍坏可再次触发自动隔离（闭环）。
        isolatedEntryIds.delete(String(id));
        log('plugin-manager', '已恢复插件 ' + id);
      }
      return res;
    } catch (err) {
      log('plugin-manager', '恢复插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, code: err && err.code, error: String((err && err.message) || err) };
    }
  });

  // 检查插件更新（npm 官方 + npmmirror 镜像 / GitHub 官方 + 加速镜像）。
  ipcMain.handle('dsh:plugin-check-updates', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      return { ok: true, items: await ensurePluginCenter().updates.checkUpdates() };
    } catch (err) {
      log('plugin-manager', '检查插件更新失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 更新单个插件：下载 → 校验（fail-closed）→ 归档预检 → 解压 → 扫描 →
  // 原子替换 → 失败回滚 → 重启生效。
  ipcMain.handle('dsh:plugin-update', async (event, { id } = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages.update))) {
      return { ok: false, error: '用户取消', canceled: true };
    }
    try {
      const res = await ensurePluginCenter().updates.update(String(id));
      // 更新链返回 { ok:false, error: PluginError }：统一收敛为
      // { ok:false, code, error } 形态（与 set-enabled/uninstall 同构，
      // 渲染端无需识别两种错误形状）。
      if (res && res.ok === false && res.error) {
        return { ok: false, code: res.error && res.error.code, error: String((res.error && res.error.message) || res.error) };
      }
      return res;
    } catch (err) {
      log('plugin-manager', '更新插件 ' + id + ' 失败: ' + ((err && err.message) || err));
      return { ok: false, code: err && err.code, error: String((err && err.message) || err) };
    }
  });

  // ----------------------- 诊断与管理（设置 → 插件 → 诊断与管理） -----------------------

  ipcMain.handle('dsh:diag-run', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const report = desktopDiagnostics.runDiagnostics({
        profileDir,
        patchFile: path.join(profileDir, 'cordis.patch.yml'),
        assetsDir: path.join(__dirname, 'assets', 'plugins'),
        coreDirDshAt: path.join(__dirname, 'node_modules', '@deepseek-ai'),
        crashDir: crashDumpsDir || null,
        logs: {
          desktop: logsDir ? path.join(logsDir, 'desktop.log') : null,
          web: logsDir ? path.join(logsDir, 'dsh-web.log') : null,
        },
        selfHealHistoryFile: path.join(userDataDir, 'self-heal-history.json'),
        yaml: loadDshYamlDialect(),
        env: {
          appVersion: app.getVersion(),
          electron: process.versions.electron || '',
          node: process.versions.node || '',
          platform: process.platform,
          arch: process.arch,
          home,
          profileName: 'web',
        },
      });
      return { ok: true, report };
    } catch (err) {
      log('diagnostics', '运行诊断失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 备份：收集 profile 配置 + 全局设置 → 用户选保存路径 → 写 JSON 备份文件。
  // 返回 { ok, file, files, secretFiles }。
  ipcMain.handle('dsh:backup-export', async (event, payload = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const label = payload && typeof payload.label === 'string' ? payload.label : '';
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const backup = desktopBackup.createBackup({ profileDir, homeDir: home, label: String(label || '') }, fs, path);
      const defaultName = 'dsh-desktop-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      const chosen = await dialog.showSaveDialog(mainWindow, {
        title: '导出 DSH 配置备份',
        defaultPath: defaultName,
        filters: [{ name: 'DSH 备份文件', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
      const json = JSON.stringify(backup, null, 2) + '\n';
      writeFileAtomic(chosen.filePath, json); // tmp+rename 原子写，避免写一半断电损坏备份
      log('diagnostics', '已导出备份: ' + chosen.filePath + ' (' + backup.files.length + ' 文件)');
      return {
        ok: true,
        file: chosen.filePath,
        files: backup.files.length,
        secretFiles: backup.secretFiles,
        bytes: Buffer.byteLength(json),
      };
    } catch (err) {
      log('diagnostics', '导出备份失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 恢复：预览时由主进程选文件并签发一次性令牌；确认时令牌必须匹配，且
  // 文件内容哈希必须与预览时一致，避免任意路径读取与预览后替换（TOCTOU）。
  ipcMain.handle('dsh:backup-restore', async (event, payload = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const preview = Boolean(payload && payload.preview === true);
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      let file;
      let expectedDigest = '';
      if (preview) {
        pendingBackupRestore = null;
        const chosen = await dialog.showOpenDialog(mainWindow, {
          title: '选择要恢复的 DSH 备份文件',
          filters: [{ name: 'DSH 备份文件', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (chosen.canceled || !chosen.filePaths || chosen.filePaths.length === 0) return { ok: false, canceled: true };
        file = chosen.filePaths[0];
      } else {
        const token = payload && typeof payload.token === 'string' ? payload.token : '';
        const approved = pendingBackupRestore;
        if (!approved || token !== approved.token || Date.now() > approved.expiresAt) {
          pendingBackupRestore = null;
          return { ok: false, error: '恢复确认已失效，请重新选择并预览备份文件' };
        }
        file = approved.file;
        expectedDigest = approved.digest;
      }
      if (!fs.existsSync(file)) return { ok: false, error: '备份文件不存在（' + file + '）' };
      const stat0 = fs.statSync(file);
      if (!stat0.isFile()) return { ok: false, error: '所选备份路径不是普通文件' };
      if (stat0.size > 4 * 1024 * 1024) {
        return { ok: false, error: `备份文件过大（${stat0.size} 字节 > 4MB），拒绝恢复` };
      }
      const raw = fs.readFileSync(file);
      const digest = require('node:crypto').createHash('sha256').update(raw).digest('hex');
      if (!preview && digest !== expectedDigest) {
        pendingBackupRestore = null;
        return { ok: false, error: '备份文件在预览后已发生变化，请重新选择' };
      }
      const parsed = JSON.parse(raw.toString('utf8'));
      const backup = desktopBackup.validatedBackup(parsed); // 严格校验（格式/路径/体积）
      if (backup.secretFiles && backup.secretFiles.length > 0) {
        log('diagnostics', '恢复备份含密钥文件，需用户确认: ' + backup.secretFiles.join(', '));
      }
      if (preview) {
        const token = require('node:crypto').randomBytes(24).toString('hex');
        pendingBackupRestore = { token, file, digest, expiresAt: Date.now() + 10 * 60 * 1000 };
        return {
          ok: true,
          preview: {
            file,
            token,
            files: backup.files.length,
            secretFiles: backup.secretFiles || [],
            createdAt: backup.createdAt,
            label: backup.label || '',
          },
        };
      }
      if (diagMutationBusy) return { ok: false, error: '另有恢复/重排任务进行中，请稍候' };
      if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages['backup-restore']))) {
        return { ok: false, error: '用户取消', canceled: true };
      }
      // 恢复前落一份「回滚前」快照：配置覆盖后若启动异常，可经守护回滚。
      try { ensureGuard().snapshot('pre-restore'); } catch (err) { log('diagnostics', '恢复前快照失败: ' + ((err && err.message) || err)); }
      pendingBackupRestore = null;
      diagMutationBusy = true;
      try {
        const result = desktopBackup.restoreBackup(backup, { profileDir, homeDir: home }, fs, path);
        log('diagnostics', '已恢复备份 ' + file + '（' + result.files + ' 文件），需要完全重启后生效');
        return { ok: true, files: result.files, restartRequired: true };
      } finally {
        diagMutationBusy = false;
      }
    } catch (err) {
      log('diagnostics', '恢复备份失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 一键导出诊断日志包：诊断报告 + 日志尾部聚合 + 崩溃转储元信息 + 环境，
  // 打码 home/userData 路径后存为单个 JSON 文件（本地操作，不上传任何数据）。
  ipcMain.handle('dsh:diag-export', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const report = desktopDiagnostics.runDiagnostics({
        profileDir,
        patchFile: path.join(profileDir, 'cordis.patch.yml'),
        assetsDir: path.join(__dirname, 'assets', 'plugins'),
        coreDirDshAt: path.join(__dirname, 'node_modules', '@deepseek-ai'),
        crashDir: crashDumpsDir || null,
        logs: {
          desktop: logsDir ? path.join(logsDir, 'desktop.log') : null,
          web: logsDir ? path.join(logsDir, 'dsh-web.log') : null,
        },
        selfHealHistoryFile: path.join(userDataDir, 'self-heal-history.json'),
        yaml: loadDshYamlDialect(),
        env: {
          appVersion: app.getVersion(),
          electron: process.versions.electron || '',
          node: process.versions.node || '',
          platform: process.platform,
          arch: process.arch,
          home,
          profileName: 'web',
        },
      });
      const bundle = {
        format: 'dsh-desktop-diagnostics',
        version: 1,
        generatedAt: new Date().toISOString(),
        appVersion: app.getVersion(),
        report,
      };
      // 脱敏：在 JSON.stringify 之前对对象内全部字符串做路径打码。
      // 关键：不能在 stringify 之后 split——JSON.stringify 会把 Windows 单反斜杠
      // 转义为双反斜杠（C:\Users → C:\\Users），split(home) 永远匹配不上（静默失效）。
      // 掩码集合：home（DSH 数据）、userDataDir（日志/崩溃）、os.homedir()、应用安装目录、
      // 可执行文件路径；顺序先具体后宽泛（userDataDir 在 home 内、home 在 homedir 内）。
      const maskPairs = [
        [String(userDataDir), '<USERDATA>'],
        [String(home), '<HOME>'],
        [String(os.homedir() || ''), '<HOME2>'],
        [String(__dirname), '<APPDIR>'],
        [String(process.execPath || ''), '<APPDIR>'],
      ].filter(([k]) => k && k.length > 1);
      const maskStr = (s) => {
        let t = String(s);
        for (const [key, label] of maskPairs) {
          if (!t.includes(key)) continue;
          const esc = key.replace(/\\/g, '\\\\').replace(/\//g, '\\/'); // JSON 转义后形态（保守双替换防绕）
          if (esc !== key) t = t.split(esc).join(label);
          t = t.split(key).join(label);
        }
        return t;
      };
      const maskDeep = (o) => {
        if (typeof o === 'string') return maskStr(o);
        if (Array.isArray(o)) return o.map(maskDeep);
        if (o && typeof o === 'object') {
          const r = {};
          for (const k of Object.keys(o)) r[k] = maskDeep(o[k]);
          return r;
        }
        return o;
      };
      const json = JSON.stringify(maskDeep(bundle), null, 2) + '\n';
      const defaultName = 'dsh-diagnostics-' + new Date().toISOString().slice(0, 10) + '.json';
      const chosen = await dialog.showSaveDialog(mainWindow, {
        title: '导出诊断日志包',
        defaultPath: defaultName,
        filters: [{ name: '诊断日志包', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
      writeFileAtomic(chosen.filePath, json);
      log('diagnostics', '已导出诊断日志包: ' + chosen.filePath);
      return { ok: true, file: chosen.filePath, bytes: Buffer.byteLength(json) };
    } catch (err) {
      log('diagnostics', '导出诊断日志包失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 防砖体检：逐个检查已装配的社区/配套插件包（dsh 清单 / 补丁入口 / 跨包 loader id 冲突）。
  // 只读；返回每个包的 issue 清单与冲突列表。
  ipcMain.handle('dsh:diag-validate', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const result = desktopValidity.validatePlugins(
        profileDir,
        path.join(__dirname, 'node_modules', '@deepseek-ai'),
        path.join(__dirname, 'assets', 'plugins'),
        loadDshYamlDialect(),
        fs
      );
      return { ok: true, report: result };
    } catch (err) {
      log('diagnostics', '防砖体检失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // bundle 顺序检测：只读分析当前顺序 vs 声明规则/依赖，给出建议顺序（拓扑排序）。
  ipcMain.handle('dsh:diag-order', async (event) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      const opts = {
        coreDirDshAt: path.join(__dirname, 'node_modules', '@deepseek-ai'),
        assetsDir: path.join(__dirname, 'assets', 'plugins'),
      };
      const stack = desktopOrdering.readBundleStack(profileDir, fs);
      const rules = desktopOrdering.readBundleRules(profileDir, fs, opts);
      const edges = desktopOrdering.collectDependencyEdges(profileDir, fs, opts);
      const conflicts = desktopOrdering.validateOrder(stack.bundles, rules);
      const suggested = desktopOrdering.suggestOrder(stack.bundles, rules, edges);
      return {
        ok: true,
        report: {
          bundles: stack.bundles,
          community: stack.community,
          error: stack.error || null,
          rules,
          dependencyEdges: edges,
          conflicts,
          suggested,
        },
      };
    } catch (err) {
      log('diagnostics', 'bundle 顺序检测失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // bundle 顺序应用：把建议顺序写回 profile package.json（官方内置保持原位，原子写）。
  ipcMain.handle('dsh:diag-order-apply', async (event, payload = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const order = payload && payload.order;
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) {
        return { ok: false, error: '顺序清单格式错误' };
      }
      if (diagMutationBusy) return { ok: false, error: '另有恢复/重排任务进行中，请稍候' };
      if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages['order-apply']))) {
        return { ok: false, error: '用户取消', canceled: true };
      }
      diagMutationBusy = true;
      try {
        const result = desktopOrdering.applyBundleOrder(profileDir, order, fs);
        if (result.ok && result.changed) {
          log('diagnostics', '已应用 bundle 顺序（' + order.length + ' 个社区 bundle），重启后生效');
        }
        return result;
      } finally {
        diagMutationBusy = false;
      }
    } catch (err) {
      log('diagnostics', '应用 bundle 顺序失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 一键移除启动清单中的失效 bundle 条目（防砖：declares no dsh.bundle fail-loud 自愈）。
  // 只改 dsh.profile.bundles；依赖包继续保留，兼容由市场挂载的纯客户端插件。
  ipcMain.handle('dsh:diag-remove-bundle', async (event, payload = {}) => {
    if (!pluginManagerIpcAllowed(event)) return { ok: false, error: 'unauthorized' };
    try {
      const names = payload && payload.names;
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      const profileDir = path.join(home, 'profiles', 'web');
      if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== 'string' || !n)) {
        return { ok: false, error: '移除名单格式错误' };
      }
      // 防御：官方内置包绝不允许被移除（体检本身已过滤，这里再兜一层）
      const filtered = names.filter((n) => !n.startsWith('@deepseek-ai/'));
      if (filtered.length === 0) return { ok: false, error: '官方基础组件不可移除' };
      if (diagMutationBusy) return { ok: false, error: '另有恢复/重排任务进行中，请稍候' };
      if (!(await confirmPluginAction(ensurePluginCenter().ipc.confirmMessages['remove-bundle']))) {
        return { ok: false, error: '用户取消', canceled: true };
      }
      diagMutationBusy = true;
      try {
        const removed = await removeBundlesFromProfile(profileDir, filtered);
        if (removed.length > 0) {
          log('diagnostics', '已从启动清单移除失效 bundle（备份于 package.json.bak-*）: ' + removed.join(', '));
        }
        return { ok: true, removed };
      } finally {
        diagMutationBusy = false;
      }
    } catch (err) {
      log('diagnostics', '移除失效 bundle 失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

/** IPC 鉴权（统一实现）：sender 必须是主窗 webContents，且 senderFrame.url.origin
 *  与当前 webUrl.origin 精确相等（历史 startsWith 前缀匹配可被
 *  http://127.0.0.1:<port>.evil.com 前缀撞名绕过）。实现收口到
 *  plugin-core/lib/capability.js 的 authorize（action='*' 通用口径），
 *  全部插件管理 IPC 共用这一条，杜绝散落判断。 */
function pluginManagerIpcAllowed(event) {
  try {
    return ensurePluginCenter().ipc.authorize(event, { mainWindow, getWebUrl: () => webUrl }, '*').ok;
  } catch {
    return false;
  }
}

let trayHintShown = false;
function trayHintOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: 'DSH Desktop JXZ 仍在运行',
      content: '窗口已隐藏到系统托盘，点击托盘图标可重新打开。',
      iconType: 'info',
    });
  } catch {}
}

function showMainWindow() {
  // 防御性恢复（用户反馈：关闭到托盘后托盘/桌面图标都无法重新打开）：
  // 1) 窗口被销毁或从未创建 → 重建主窗并加载 Web UI；
  // 2) 最小化 → 先 restore；隐藏 → show；最后置顶聚焦，确保回到前台。
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!webUrl) return;
    try {
      createWindow();
      initRendererRecovery();
      wireWindowRecovery();
      mainWindow.loadURL(webUrl).catch((err) => log('boot', '恢复窗口加载失败: ' + ((err && err.message) || err)));
      log('boot', '主窗不存在，已重建并加载 Web UI');
    } catch (err) {
      log('boot', '重建主窗失败: ' + ((err && err.message) || err));
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  try { mainWindow.setSkipTaskbar(false); } catch {}
  mainWindow.focus();
  try { mainWindow.moveTop(); } catch {}
}

function ensureTray() {
  if (!IS_WIN || quitting) return;
  if (tray && !tray.isDestroyed()) return;
  log('tray', '检测到托盘不可用，尝试重建');
  createTray();
}

function createTray() {
  if (!IS_WIN) return;
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('DSH Desktop JXZ' + (APP_VERSION ? ' v' + APP_VERSION : ''));
    const menu = Menu.buildFromTemplate([
      { label: '显示 DSH Desktop JXZ', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '检查 dsh 更新…', click: () => { showMainWindow(); runUpdateFlow(true); } },
      { label: '检查客户端更新…', click: () => { showMainWindow(); runClientUpdateFlow(true); } },
      {
        label: '会话完成通知',
        type: 'checkbox',
        checked: notifyOnTurnEnd,
        click: (item) => {
          notifyOnTurnEnd = item.checked;
          const s = updater.loadSettings(updCtx());
          s.notifyOnTurnEnd = item.checked;
          updater.saveSettings(updCtx(), s);
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => { forceQuit = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    // 左键/双击一律恢复窗口（用户反馈「托盘点不开」：去掉「可见则隐藏」的
    // 双态逻辑，避免隐藏态误判导致的点按无反应）。
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    log('boot', '系统托盘已就绪');
  } catch (err) {
    log('boot', '创建系统托盘失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// DeepSeek 余额（推送到 Web UI 的 dsh-balance 插件）
//
// 编排逻辑（节流 / 并发仲裁 / 指数退避重试 / 单一出口推送）全部收口在
// balance-scheduler.js（纯 Node 可单测）；本文件只做依赖注入与进程级接线。
// 数据契约与安全边界见 docs/balance-architecture.md。
// ---------------------------------------------------------------------------

function ensureBalanceScheduler() {
  if (balanceScheduler) return balanceScheduler;
  balanceScheduler = createBalanceScheduler({
    getHome: () => effectiveDshHome() || path.join(os.homedir(), '.dsh'),
    // 每次刷新只读取一次 settings（余额开关与 OpenCode Go 开关同源，避免双读）。
    getSettings: () => updater.loadSettings(updCtx()),
    queryBalance: balance.queryBalance,
    queryOpencodeUsage: balance.queryOpencodeUsage,
    readActiveModel: balance.readActiveModel,
    effectivePrice: balance.effectivePrice,
    priceTable: balance.priceTable,
    isPeakHour: balance.isPeakHour,
    // 数据唯一出口：写缓存（did-finish-load 补推用）+ 推送到渲染进程。
    // IPC 处理器只触发刷新不返回数据，客户端只消费事件（单一投递契约）。
    push: (result) => {
      balanceCache = result;
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('dsh:balance', result); } catch {}
      }
    },
    log,
  });
  return balanceScheduler;
}

// 直接刷新（菜单开关 / IPC 显式触发，绕过节流；并发由编排器仲裁）。
function refreshBalance() {
  return ensureBalanceScheduler().maybeRefresh(true);
}

// 节流刷新：会话完成 / 窗口显示 / 轮询共用，距上次不足 30s 跳过，
// 避免高频事件（流式多回合）触发过多 HTTP 请求。
function maybeRefreshBalance(force = false) {
  return ensureBalanceScheduler().maybeRefresh(force);
}

function startBalanceLoop() {
  // 启动即刷新；此后每 3 分钟轮询（原 15 分钟——用户反馈余额显示不同步/
  // 更新慢，缩短轮询并配合「窗口显示/会话完成」触发点）。失败后的加速
  // 重试（30s→1m→2m→5m 指数退避）由编排器内部负责。
  ensureBalanceScheduler().start();
}

// 原子写统一收口在 scripts/lib/patch-io.js 的 writeFileAtomic（临时文件 + rename）。
// 惰性加载 js-yaml（随内置 dsh 存在于 resources/app/node_modules，传递依赖）；
// 缺失时静默降级为仅做结构化修复（不阻断启动）。方言构造与
// scripts/lib/profile-reconcile.js 的 createEntryListYamlParser 共用同一实现。
let dshYamlDialect = null;
let dshYamlTried = false;
function loadDshYamlDialect() {
  if (dshYamlTried) return dshYamlDialect;
  dshYamlTried = true;
  const parse = createEntryListYamlParser();
  dshYamlDialect = parse ? { load: (content) => parse(content) } : null;
  return dshYamlDialect;
}

// ---------------------------------------------------------------------------
// 内置 Agent 预设保护（assets/agent-presets）：用户会直接改安装目录里的内置
// 预设，客户端更新（NSIS/portable 覆盖安装）会整体替换 resources/app 把这些
// 改动冲掉。基线按版本管理（userData/preset-guard/baseline.json）：
//   - 启动：版本未变 → 保持基线（悬挂恢复标记清理）；版本变了且有快照 →
//     恢复用户改动（官方改过同一文件以用户版为准），基线 = 恢复前官方指纹；
//     版本变了无快照 → 基线 = 当前内容（正常升级/首装）。
//   - 更新安装前（quitForClientUpdate）：把「用户改过」的文件快照到
//     userData/preset-guard/backup，settings 写 pendingPresetRestore。
// ---------------------------------------------------------------------------
function presetGuardRootDir() {
  return path.join(__dirname, 'assets', 'agent-presets');
}

function applyPresetGuard() {
  try {
    const s = updater.loadSettings(updCtx());
    const pending = s.pendingPresetRestore || null;
    const baseline = presetGuard.loadBaseline(userDataDir);
    if (baseline && baseline.version === APP_VERSION) {
      // 版本未变：正常重启。上次更新未实际发生（用户取消/安装被拦）→
      // 丢弃快照与标记，避免残留。
      if (pending && pending.version !== APP_VERSION) {
        presetGuard.discardBackup(userDataDir);
        s.pendingPresetRestore = null;
        updater.saveSettings(updCtx(), s);
        log('boot', '已丢弃未完成的预设保护快照（客户端未更新）');
      }
      return;
    }
    if (pending && pending.version === APP_VERSION) {
      // 更新后首启：恢复用户改动；新基线 = 恢复前的官方新版指纹，保证
      // 下一轮更新仍能区分「用户改动」与「官方改动」。
      const { restored, baselineFiles } = presetGuard.restoreUserModifiedFiles(
        presetGuardRootDir(),
        presetGuard.backupRoot(userDataDir),
        (rel, err) => log('boot', '恢复用户预设失败 ' + rel + ': ' + err.message),
      );
      presetGuard.saveBaseline(userDataDir, { version: APP_VERSION, files: baselineFiles });
      presetGuard.discardBackup(userDataDir);
      s.pendingPresetRestore = null;
      updater.saveSettings(updCtx(), s);
      if (restored.length) log('boot', '已恢复用户修改过的内置 Agent 预设: ' + restored.join(', '));
      return;
    }
    // 正常升级/首装（没有用户改动快照）：基线 = 当前内容。
    presetGuard.saveBaseline(userDataDir, { version: APP_VERSION, files: presetGuard.computeFingerprints(presetGuardRootDir()) });
  } catch (err) {
    log('boot', '内置 Agent 预设保护失败: ' + err.message);
  }
}

function stagePresetGuardBackup(nextVersion) {
  try {
    const s = updater.loadSettings(updCtx());
    const baseline = presetGuard.loadBaseline(userDataDir);
    const { count } = presetGuard.stageUserModifiedFiles(presetGuardRootDir(), baseline, presetGuard.backupRoot(userDataDir));
    if (count > 0) {
      s.pendingPresetRestore = { version: nextVersion, count, at: Date.now() };
      log('client-update', '已快照 ' + count + ' 个用户修改过的内置 Agent 预设，更新完成后自动恢复');
    } else {
      s.pendingPresetRestore = null;
      presetGuard.discardBackup(userDataDir);
    }
    updater.saveSettings(updCtx(), s);
  } catch (err) {
    log('client-update', '快照用户预设失败: ' + err.message);
  }
}

/** web profile 目录（与 profilePatchFile 同源，WSL 模式下走 UNC 写穿）。 */
function pluginManagerProfileDir() {
  const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'web');
}

/** 插件中心（plugin-center）：插件管理业务全部收口到 scripts/plugin-core。 */
// main.js 只保留接线：懒实例化 + 薄工具。懒创建依赖 userDataDir / dshHome /
// 后端模式解析就绪，首次调用发生在 IPC 阶段。
let pluginCenter = null;
function ensurePluginCenter() {
  if (!pluginCenter) {
    pluginCenter = createPluginCenter({
      getHome: () => effectiveDshHome() || path.join(os.homedir(), '.dsh'),
      getProfile: () => 'web',
      getUserDataDir: () => userDataDir,
      log,
      dialogs: {
        confirm: (message) => showBox({
          type: 'warning',
          title: '操作确认',
          message,
          buttons: ['确定', '取消'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => response === 0),
      },
    });
  }
  return pluginCenter;
}

/** 破坏性插件操作的主进程二次确认（测试通道视为受信操作员，自动放行）。 */
function confirmPluginAction(message) {
  if (process.env.DSH_DESKTOP_TEST === '1') return Promise.resolve(true);
  return showBox({
    type: 'warning',
    title: '操作确认',
    message,
    buttons: ['确定', '取消'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => response === 0);
}

/** 设置插件开关（IPC 与测试通道共用的唯一实现）。
 *  用户重新启用 = 解除自动隔离：清掉本会话的隔离条目去重，插件若仍坏，
 *  下一轮 loader 标记会再次触发自动隔离（闭环在会话内也可重复）。 */
function pluginSetEnabled(id, enabled) {
  return ensurePluginCenter().lifecycle.setEnabled(String(id), !!enabled).then((res) => {
    if (res && res.ok && enabled) isolatedEntryIds.delete(String(id));
    return res;
  });
}

/** 读插件包 package.json 的 description（profile node_modules → app assets 兜底）。 */
function pluginManagerPackageDescription(name) {
  if (!name) return '';
  const candidates = [
    path.join(pluginManagerProfileDir(), 'node_modules', ...name.split('/')),
    path.join(__dirname, 'assets', 'plugins', name.includes('/') ? name.slice(name.indexOf('/') + 1) : name),
  ];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && typeof pkg.description === 'string' && pkg.description) return pkg.description;
    } catch {}
  }
  return '';
}

// ---------------------------------------------------------------------------
// 内置 Agent 预设同步：local 模式的预设由 npm start / after-pack 直接写入
// Windows 侧内置 dsh 包的 config/agent-presets；WSL 托管模式的 dsh 是 WSL 内
// npm 安装的干净包，不包含壳自带的 8 个预设，因此模式列表比 local 少。
// 这里经 UNC 把 assets/agent-presets 幂等复制进 WSL agent 包，让两种后端
// 看到的模式一致（_preset 是共享模块目录，installBuiltinPresets 一并处理）。
// ---------------------------------------------------------------------------
function syncBuiltinAgentPresets() {
  if (!IS_WIN || !isWslMode()) return;
  try {
    const home = effectiveDshHome();
    if (!home) { log('boot', 'DSH_HOME 未解析，跳过内置 Agent 预设同步'); return; }
    const dshPkgDir = path.join(home, 'agent', 'node_modules', '@deepseek-ai', 'dsh');
    if (!fs.existsSync(path.join(dshPkgDir, 'package.json'))) {
      log('boot', 'WSL 内 dsh 包未就绪，跳过内置 Agent 预设同步');
      return;
    }
    const dests = installBuiltinPresets(dshPkgDir);
    log('boot', '已同步 ' + dests.length + ' 个内置 Agent 预设到 WSL dsh: ' + dests.map((d) => path.basename(d)).join(', '));
  } catch (err) {
    log('boot', '同步内置 Agent 预设到 WSL 失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 本地模式内置 Agent 预设同步（WSL 同族问题的 local 半边）：after-pack /
// npm start 只把 assets/agent-presets 写进「内置」dsh 包；用户把 agent 更新到
// overlay（userData/agent）后，overlay 是干净的 npm 包（updater.applyUpdate
// 全新安装），8 个壳内置预设会消失（模式列表比内置/WSL 少）。这里幂等地把
// 预设补进「当前生效」的 dsh 包：overlay 存在则 overlay，否则内置包（幂等，
// 写入失败只告警不中断）。与 syncBuiltinAgentPresets 一起保证三种布局
// （内置 / 更新 overlay / WSL）模式列表一致。
// ---------------------------------------------------------------------------
function syncLocalAgentPresets() {
  if (isWslMode()) return; // WSL 走 UNC 的 syncBuiltinAgentPresets
  try {
    const active = updater.overlayVersion(updCtx())
      ? path.join(userDataDir, 'agent', 'node_modules', '@deepseek-ai', 'dsh')
      : path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh');
    if (!fs.existsSync(path.join(active, 'package.json'))) {
      log('boot', '未找到生效的 dsh 包，跳过内置 Agent 预设同步');
      return;
    }
    const dests = installBuiltinPresets(active);
    log('boot', '已同步 ' + dests.length + ' 个内置 Agent 预设到 ' + (updater.overlayVersion(updCtx()) ? 'agent overlay' : '内置 dsh 包') + ': ' + dests.map((d) => path.basename(d)).join(', '));
  } catch (err) {
    log('boot', '同步内置 Agent 预设失败: ' + err.message);
  }
}

// 快捷方式维护：修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，
// 并让快捷方式图标跟随图标设计更新（.lnk 单独指定 icon.ico）。
// ---------------------------------------------------------------------------

// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
const SHORTCUT_ICON_VERSION = 'whale-2';

function shortcutIconPath() {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + err.message);
    return path.join(__dirname, 'assets', 'icon.ico');
  }
}

function maintainShortcuts() {
  if (!IS_WIN) return;
  // 集成测试（DSH_DESKTOP_TEST=1）用 dev electron 以「文件路径」方式启动，此时
  // app.isPackaged 也为 true；若不拦截，测试会把用户真实的开始菜单/桌面快捷方式
  // 改指向 node_modules 下的开发用 electron.exe（曾实测发生）。显式拦一道。
  if (process.env.DSH_DESKTOP_TEST === '1') return;
  // 仅对真正的打包产物维护快捷方式。本机 app.isPackaged 在 dev 下也恒为 true，
  // 故用 resources 下是否存在 app/app.asar 判别：dev 的 electron 只有
  // default_app.asar，从而避免把快捷方式改指向 node_modules 下的开发用 electron。
  const bundled =
    fs.existsSync(path.join(process.resourcesPath, 'app')) ||
    fs.existsSync(path.join(process.resourcesPath, 'app.asar'));
  if (!app.isPackaged || !bundled) return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const startMenu = path.join(linksDir, 'DSH Desktop.lnk');
    const desktopDir = app.getPath('desktop');
    const desktop = path.join(desktopDir, 'DSH Desktop.lnk');
    const ico = shortcutIconPath();
    const opts = {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    let changed = false;

    // 去重（用户反馈「每次启动自动生成多个快捷方式」）：清理规范名之外的
    // 同族快捷方式——Windows 自动重命名的副本（“DSH Desktop (1).lnk”）、
    // 手动“发送到桌面”的副本（“DSH Desktop - 快捷方式.lnk”）、旧版本残留等，
    // 只保留规范名一个。前缀匹配，不会误删用户其它快捷方式。
    const cleanupDir = (dir) => {
      let removed = 0;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of entries) {
        if (!e.isFile() || !/^DSH Desktop.*\.lnk$/i.test(e.name)) continue;
        if (e.name.toLowerCase() === 'dsh desktop.lnk') continue;
        try { fs.rmSync(path.join(dir, e.name), { force: true }); removed++; } catch {}
      }
      return removed;
    };
    const removedDesktop = cleanupDir(desktopDir);
    const removedStart = cleanupDir(linksDir);
    if (removedDesktop + removedStart > 0) {
      log('boot', '快捷方式去重: 清理桌面 ' + removedDesktop + ' 个、开始菜单 ' + removedStart + ' 个重复快捷方式');
    }

    // exe 被移动过，或图标设计更新过：替换现有快捷方式（修复“指向的文件消失”）。
    if ((settings.shortcutTarget && settings.shortcutTarget !== target) || settings.shortcutIcon !== SHORTCUT_ICON_VERSION) {
      for (const p of [startMenu, desktop]) {
        if (fs.existsSync(p)) {
          try { shell.writeShortcutLink(p, 'replace', opts); changed = true; } catch {}
        }
      }
    }
    // 开始菜单快捷方式是系统通知的前置条件：缺失则创建。
    if (!fs.existsSync(startMenu)) {
      try { shell.writeShortcutLink(startMenu, 'create', opts); changed = true; } catch {}
    }
    // 桌面快捷方式：缺失则补建（便携版与安装版一致）。去重逻辑在函数开头先行，
    // 保证桌面上至多保留一个规范名快捷方式，因此「缺失补建」不会复现旧版
    // 「每次启动生成多个快捷方式」的问题；同时自愈「更新后桌面图标消失」——
    // 安装版更新（NSIS 向导取消勾选创建 / 旧版卸载清理 / 手动覆盖安装目录）后
    // 桌面快捷方式可能缺失，此前安装版不再自动补建导致图标永久丢失。
    if (!fs.existsSync(desktop)) {
      try { shell.writeShortcutLink(desktop, 'create', opts); changed = true; } catch {}
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + err.message);
  }
}

function warnTempRun() {
  if (!app.isPackaged || !IS_WIN || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    showBox({
      type: 'warning',
      title: '正在从临时目录运行',
      message: '当前便携版位于系统临时目录。',
      detail: '临时目录中的文件可能被系统自动清理，导致快捷方式失效或程序“消失”。\n建议把 DSH Desktop exe 移动到固定位置（如桌面或 D 盘）后再运行。',
      buttons: ['知道了'],
    });
  }
}

// ---------------------------------------------------------------------------
// 客户端自更新流程（更新 DSH Desktop 封装本身）
// ---------------------------------------------------------------------------

// 退出应用并启动客户端更新脚本。把“写脚本 + 派发 + 退出”收敛到一处，
// 保证即使写脚本失败也一定退出应用，避免更新流程卡死导致“点安装没反应”。
function quitForClientUpdate(ctx, pending) {
  quitting = true;
  forceQuit = true;
  markCleanExit();
  // 保留 pendingClientUpdate / pendingClientVersion，只记录一次安装尝试。
  // 本次尝试可能失败（安装器被取消/拦截、文件被占用、目录只读），下次启动时
  // offerPendingClientUpdate 会依据「版本仍未升级 + clientUpdateAttempt」进入
  // 「客户端更新未完成」重试流程；更新成功后新版本启动时会因
  // pending.version <= APP_VERSION 自动清掉标记。
  try {
    const s = updater.loadSettings(ctx);
    s.clientUpdateSnoozeUntil = null;
    s.clientUpdateAttempt = {
      version: pending && pending.version ? pending.version : null,
      at: Date.now(),
      appVersion: APP_VERSION,
      path: pending && pending.path ? pending.path : null,
      source: pending && pending.source ? pending.source : null,
    };
    updater.saveSettings(ctx, s);
    // 回读校验：安装尝试必须真正落盘，否则更新失败后无法识别为「未完成」。
    const verify = updater.loadSettings(ctx);
    if (!verify.clientUpdateAttempt || verify.clientUpdateAttempt.at !== s.clientUpdateAttempt.at) {
      verify.clientUpdateAttempt = s.clientUpdateAttempt;
      verify.clientUpdateSnoozeUntil = null;
      updater.saveSettings(ctx, verify);
      log('client-update', '安装尝试记录第一次未落盘，已重试并回读确认');
    }
    log('client-update', '已记录安装尝试并保留待安装标记（更新失败后可在下次启动重试）');
  } catch (err) {
    log('client-update', '记录安装尝试失败: ' + err.message);
  }
  try {
    killTreeSync(serverProc);
  } catch (err) {
    log('client-update', '停止 dsh 服务失败: ' + err.message);
  }
  updater.abort();
  if (sessionWatcher) sessionWatcher.stop();
  if (balanceScheduler) balanceScheduler.stop();
  // 内置 Agent 预设保护：安装覆盖 resources/app 前，快照用户改过的
  // assets/agent-presets 文件到 userData（覆盖安装不触碰），新版本首启恢复。
  if (pending && pending.version) stagePresetGuardBackup(pending.version);
  let logFile = '';
  try {
    const applied = clientUpdater.applyUpdate(ctx, pending);
    if (applied && applied.logFile) logFile = applied.logFile;
  } catch (err) {
    log('client-update', '启动更新脚本失败: ' + err.message);
  }
  log('client-update', '退出应用以应用更新' + (logFile ? '，日志: ' + logFile : ''));
  setTimeout(() => app.exit(0), 400);
}

async function runClientUpdateFlow(manual) {
  if (quitting) return;
  // 客户端自更新支持 Windows（安装版/便携版）与 macOS（.app 替换）；
  // 其它平台（Linux 等）降级为提示手动下载，避免出现无法落地的更新流程。
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查客户端更新',
        message: '当前平台暂不支持自动更新。',
        detail: '请前往 GitHub Releases 页面下载新版安装包：\nhttps://github.com/myYangyunfan/dsh_desktop/releases',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (clientUpdateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '客户端更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  // 守卫同步置位（同 runUpdateFlow）：待安装包对话框、checkLatest 网络、发现新版本
  // 对话框都在旧置位之前，并发触发会双下载/双 spawn 安装互踩。全程 try/finally 复位。
  clientUpdateBusy = true;
  try {
    const ctx = updCtx();
    const settings = updater.loadSettings(ctx);
    // 手动检查时优先处理已下载的待安装包：用户主动点「检查客户端更新」即表明
    // 更新意图，不应被 24h 静默期（clientUpdateSnoozeUntil）挡住——否则会出现
    // 「包已下载却没有任何安装入口，看起来像更新坏了」的体验。
    if (manual && (process.platform === 'win32' || process.platform === 'darwin') && settings.pendingClientUpdate && settings.pendingClientUpdate.path) {
      const pend = settings.pendingClientUpdate;
      if (fs.existsSync(pend.path) && updater.compareVersions(pend.version, APP_VERSION) > 0) {
        const { response: rp } = await showBox({
          type: 'info',
          title: '有待安装的客户端更新',
          message: `已下载 DSH Desktop JXZ v${pend.version}，是否立即安装并重启？`,
          detail: '安装包保存在数据目录的 updates 文件夹中。',
          buttons: ['立即重启', '取消'],
          defaultId: 0,
          cancelId: 1,
        });
        if (rp === 0) {
          quitForClientUpdate(ctx, pend);
          return;
        }
      } else if (!fs.existsSync(pend.path)) {
        // 安装包已丢失：清理标记，避免每次手动检查都卡在这个分支。
        clientUpdater.cleanupPendingPackage(pend);
        settings.pendingClientUpdate = null;
        settings.pendingClientVersion = null;
        settings.clientUpdateAttempt = null;
        updater.saveSettings(ctx, settings);
      }
    }
    let release;
    try {
      release = await clientUpdater.checkLatest(ctx, APP_VERSION);
    } catch (err) {
      log('client-update', '检查失败: ' + err.message);
      if (manual) {
        await showBox({
          type: 'warning',
          title: '检查客户端更新失败',
          message: '无法连接上游发布源。',
          detail: err.message + '\n\n可通过环境变量 DSH_DESKTOP_RELEASE_API 指定镜像 API。',
          buttons: ['确定'],
        });
      }
      return;
    }
    if (!release.isNewer) {
      if (manual) {
        await showBox({
          type: 'info',
          title: '检查客户端更新',
          message: '当前已是最新版本。',
          detail: `DSH Desktop JXZ v${APP_VERSION}\n上游最新：${release.version}（${release.source}）`,
          buttons: ['确定'],
        });
      }
      return;
    }
    if (!manual && settings.skipClientVersion === release.version) return;
    // M7 修复：用户选过"稍后"的同版本不再每 12h 重复弹窗/重复下载。
    if (!manual && settings.pendingClientVersion === release.version) return;
    const notes = release.body ? '\n\n更新说明：\n' + release.body.slice(0, 800) : '';
    const { response } = await showBox({
      type: 'info',
      title: '发现新版本客户端',
      message: `DSH Desktop JXZ 发布了新版本：v${release.version}`,
      detail: `当前版本：v${APP_VERSION}\n发布来源：${release.source}${notes}\n\n是否立即更新？下载后自动替换并重启应用。`,
      buttons: ['立即更新', '跳过此版本', '稍后'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) {
      settings.skipClientVersion = release.version;
      updater.saveSettings(ctx, settings);
      log('client-update', '用户跳过版本 ' + release.version);
      return;
    }
    if (response === 2) {
      // M7 修复：记录"稍后"版本，周期检查不再重复打扰（新版本出现时仍会提示）。
      settings.pendingClientVersion = release.version;
      updater.saveSettings(ctx, settings);
      log('client-update', '用户稍后处理版本 ' + release.version);
      return;
    }

    const progressWin = showUpdateWindow(release.version, 'client');
    try {
      const { filePath, size } = await clientUpdater.downloadRelease(ctx, release, {
        onProgress: (received, total) => {
          const pct = total > 0 ? Math.round((received * 100) / total) : -1;
          if (progressWin && !progressWin.isDestroyed()) {
            progressWin.webContents
              .executeJavaScript(
                `window.__setProgress && window.__setProgress(${pct}, ${Math.round(received / 1048576)}, ${Math.round(total / 1048576)})`
              )
              .catch(() => {});
          }
        },
      });
      settings.pendingClientUpdate = { version: release.version, path: filePath, source: release.source };
      settings.skipClientVersion = null;
      settings.pendingClientVersion = null;
      updater.saveSettings(ctx, settings);
      // 先关进度窗再弹「下载完成」：避免窗口叠层，也保证对话框不被遮挡。
      closeUpdateWindow(progressWin);
      const { response: r2 } = await showBox({
        type: 'info',
        title: '下载完成',
        message: `已准备好 DSH Desktop JXZ v${release.version}（${Math.round(size / 1048576)} MB）。`,
        detail: '立即重启应用完成更新？\n· 重启后自动安装新版本并启动\n· 选择稍后重启：下次启动时再提示安装',
        buttons: ['立即重启', '稍后重启'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r2 === 0) {
        quitForClientUpdate(ctx, settings.pendingClientUpdate);
      }
    } catch (err) {
      closeUpdateWindow(progressWin);
      log('client-update', '更新失败: ' + err.message);
      await showBox({
        type: 'error',
        title: '更新失败',
        message: '未能完成客户端更新，仍使用当前版本。',
        detail: err.message,
        buttons: ['确定'],
      });
    } finally {
      if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
    }
  } finally {
    clientUpdateBusy = false;
  }
}

function offerPendingClientUpdate() {
  // 客户端自更新仅 Windows/macOS（见 runClientUpdateFlow），忽略其它平台的
  // 历史遗留待安装标记。
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const ctx = updCtx();
  const settings = updater.loadSettings(ctx);
  const pending = settings.pendingClientUpdate;
  if (!pending || !pending.path) return;
  if (!fs.existsSync(pending.path)) {
    // 安装包已被清理/删除：清掉标记与同目录分片残留，不再打扰用户。
    clientUpdater.cleanupPendingPackage(pending);
    settings.pendingClientUpdate = null;
    settings.pendingClientVersion = null;
    settings.clientUpdateAttempt = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  if (updater.compareVersions(pending.version, APP_VERSION) <= 0) {
    // 当前版本已不低于待安装版本（更新已通过其它方式生效，或版本被跳过）：
    // 删除残留的过时安装包（每包 120+MB），避免「下载了但不弹安装」的磁盘残留。
    clientUpdater.cleanupPendingPackage(pending);
    settings.pendingClientUpdate = null;
    settings.pendingClientVersion = null;
    settings.clientUpdateAttempt = null;
    settings.clientUpdateSnoozeUntil = null;
    updater.saveSettings(ctx, settings);
    return;
  }
  // 用户选过「稍后」后，24 小时内不再重复弹同一个待安装提示。
  const snoozeUntil = Number(settings.clientUpdateSnoozeUntil) || 0;
  if (snoozeUntil > Date.now()) return;
  // 上一轮已点过「立即重启」但当前仍是旧版本 → 更新没有安装成功。
  // 不再用「有待安装」的文案循环打扰，改为明确告知并允许重试/看日志/稍后。
  const attempt = settings.clientUpdateAttempt;
  const failedBefore = !!(attempt && attempt.version === pending.version && attempt.appVersion === APP_VERSION);
  if (failedBefore) {
    const applyLog = path.join(userDataDir, 'updates', 'apply-update.log');
    showBox({
      type: 'warning',
      title: '客户端更新未完成',
      message: `DSH Desktop JXZ v${pending.version} 尚未安装成功（当前仍为 v${APP_VERSION}）。`,
      detail: '已下载的安装包仍保留在数据目录的 updates 文件夹中，可以重试安装。\n\n安装脚本日志：' + applyLog,
      buttons: ['重试安装', '打开日志', '稍后'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 0) {
        const s = updater.loadSettings(ctx);
        s.clientUpdateSnoozeUntil = null;
        updater.saveSettings(ctx, s);
        quitForClientUpdate(ctx, pending);
        return;
      }
      if (response === 1) {
        shell.openPath(applyLog).catch((err) => log('client-update', '打开更新日志失败: ' + err.message));
        return;
      }
      const s = updater.loadSettings(ctx);
      s.clientUpdateSnoozeUntil = Date.now() + 24 * 60 * 60 * 1000;
      updater.saveSettings(ctx, s);
      log('client-update', '用户暂缓处理未完成的客户端更新 ' + pending.version + '（24h）');
    });
    return;
  }
  showBox({
    type: 'info',
    title: '有待安装的客户端更新',
    message: `已下载 DSH Desktop JXZ v${pending.version}，是否现在安装并重启？`,
    detail: '安装包保存在数据目录的 updates 文件夹中。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) {
      const s = updater.loadSettings(ctx);
      s.clientUpdateSnoozeUntil = Date.now() + 24 * 60 * 60 * 1000;
      updater.saveSettings(ctx, s);
      return;
    }
    quitForClientUpdate(ctx, pending);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 预览静态文件服务：独立端口的只读文件服务，供「站内 HTML 预览」的 iframe 使用。
// 为什么要独立端口：浏览器对同一主机 HTTP/1.1 并发连接上限 6，web UI 自身
// 长连接已占满；预览 iframe 及其相对资源若走 dsh 宿主会被排队。仅接受回环。
// ---------------------------------------------------------------------------

let previewStaticPort = 0;
// 预览端口就绪信号：listen 回调异步拿到端口，chrome:init 读 staticPort 存在
// 「主窗加载早于服务就绪」的竞态（消费方 dsh-client-file-changes 会把 0 当
// 「无预览服务」，预览链接整段失效）。chrome:init 等待本信号（有界）再返回。
let previewPortReadyResolve = null;
const previewPortReady = new Promise((resolve) => { previewPortReadyResolve = resolve; });

function startPreviewStaticServer() {
  const MIME = {
    ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
    ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
    ".json": "application/json", ".map": "application/json", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".xml": "application/xml"
  };
  const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;
  const server = http.createServer((req, res) => {
    const ra = req.socket && req.socket.remoteAddress;
    if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (!path.isAbsolute(p)) {
      res.writeHead(400);
      res.end();
      return;
    }
    // H2/H3 文件围栏：与 dsh:file-open / dsh:file-revert 一致，只允许读取
    // 「会话 cwd」之下的项目文件。否则本服务会成为任意本地文件读取通道：
    // 预览 iframe 与本服务同源（allow-same-origin），可读取并外传
    // settings / 凭据等敏感文件（实测 C:\Windows、userData 等均可读出）。
    if (!isUnderFileRoots(p)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mime = MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
        "content-length": String(st.size),
        "cache-control": "no-store"
      });
      if (req.method === "HEAD") { res.end(); return; }
      // 读流 error 监听：文件读取中途失败（权限/移除）时销毁响应而非
      // uncaughtException 崩主进程（issue #86）。
      const rs = fs.createReadStream(p);
      rs.on("error", () => { res.destroy(); });
      rs.pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const listenPreview = (retriesLeft) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      if (CHROMIUM_RESTRICTED_PORTS.has(port) && retriesLeft > 0) {
        log("boot", `预览服务端口 ${port} 受限，重试换端口（剩余 ${retriesLeft} 次）`);
        server.close(() => listenPreview(retriesLeft - 1));
        return;
      }
      previewStaticPort = port;
      if (previewPortReadyResolve) previewPortReadyResolve();
      log("boot", "预览静态服务已启动: http://127.0.0.1:" + previewStaticPort);
    });
  };
  listenPreview(4);
  server.on("error", (err) => {
    log("boot", "预览静态服务失败: " + err.message);
    // 服务起不来也要释放等待方，避免 chrome:init 被挂住到超时。
    if (previewPortReadyResolve) previewPortReadyResolve();
  });
}

function setupTestChannel() {
  const dir = process.env.DSH_DESKTOP_TEST_DIR;
  if (!process.env.DSH_DESKTOP_TEST || !dir) return;
  const ctrlFile = path.join(dir, 'test-control.json');
  const statFile = path.join(dir, 'test-status.json');
  const writeStatus = (id, ok, detail) => {
    try {
      fs.writeFileSync(statFile, JSON.stringify({ id, ok: !!ok, detail: detail === undefined ? null : detail, at: new Date().toISOString() }));
    } catch {}
  };
  const commands = {
    'crash-main': () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.forcefullyCrashRenderer();
      else throw new Error('no main window');
    },
    'kill-main': () => {
      const pid = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : 0;
      if (!pid) throw new Error('no renderer pid');
      process.kill(pid);
    },
    'hang-main': () => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('no main window');
      // 在 renderer 主线程注入 120s 忙循环制造挂起；恢复机制会强制终结该进程。
      mainWindow.webContents
        .executeJavaScript('(function(){var s=Date.now();while(Date.now()-s<120000){}})()')
        .catch(() => {});
    },
    'crash-float': () => {
      const sid = '__test_float__';
      const win = createFloatWindow(sid, { title: '测试浮窗' });
      if (!win) throw new Error('float creation failed');
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer();
        } catch {}
      }, 2500);
    },
    'kill-server-silent': () => {
      // 模拟插件市场式原地重启的前半程：退出处理器不弹窗。
      // 不置空 serverProc：让 isServerAlive() 依据真实退出状态，
      // 强杀完成（exit 事件）后自然变为 false。
      restartingServer = true;
      killTree(serverProc);
    },
    'restart-server': async () => {
      restartingServer = true;
      try {
        const url = await startAndShow();
        return { ok: true, url };
      } finally {
        restartingServer = false;
      }
    },
    // 插件生命周期直通（E2E 场景走真实 plugin-core 链路；IPC 鉴权由单测覆盖）。
    'plugin-uninstall': (args) => ensurePluginCenter().lifecycle.uninstall(String(args && args.id)),
    'plugin-restore': (args) => {
      // 与 dsh:plugin-restore IPC 同路径：恢复即解除隔离，清本会话去重（闭环可重复）。
      return ensurePluginCenter().lifecycle.restore(String(args && args.id)).then((res) => {
        if (res && res.ok) isolatedEntryIds.delete(String(args && args.id));
        return res;
      });
    },
    'plugin-set-enabled': (args) => pluginSetEnabled(args && args.id, !!args.enabled),
    // 存活探针强制失败钩子（E2E：进程存活但 HTTP 层故障 → 假活判定/配额上限）。
    'probe-fail-on': () => { testForceProbeFail = true; return true; },
    'probe-fail-off': () => { testForceProbeFail = false; return true; },
    // 与 chrome:restart-service IPC 完全一致的路径（供集成测试复现端口稳定性）。
    'restart-service': () => restartService(),
    'reload-main': () => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('no main window');
      mainWindow.reload();
    },
    'recovery-reload': () => {
      if (!recovery || !mainWindow || mainWindow.isDestroyed()) throw new Error('no window');
      recovery.retryNow(mainWindow);
    },
    state: () => {
      const url = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : null;
      return {
        url,
        webUrl,
        serverAlive: !!serverProc && serverProc.exitCode === null && !serverProc.killed,
        recovery: recovery ? recovery.stateOf(mainWindow) : null,
        backend: backendMode,
      };
    },
    quit: () => {
      forceQuit = true;
      setTimeout(() => app.quit(), 100);
    },
  };
  let lastId = null;
  const poll = setInterval(() => {
    let raw;
    try { raw = fs.readFileSync(ctrlFile, 'utf8'); } catch { return; }
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    if (!cmd || !cmd.id || cmd.id === lastId) return;
    lastId = cmd.id;
    try {
      const fn = commands[cmd.cmd];
      if (!fn) { writeStatus(cmd.id, false, 'unknown-command'); return; }
      const r = fn(cmd.args || {});
      if (r && typeof r.then === 'function') {
        r.then((v) => writeStatus(cmd.id, true, v))
          .catch((e) => writeStatus(cmd.id, false, String((e && e.message) || e)));
      } else {
        writeStatus(cmd.id, true, r === undefined ? null : r);
      }
    } catch (err) {
      writeStatus(cmd.id, false, String((err && err.stack) || err));
    }
  }, 150);
  poll.unref();
  log('test-event', 'test-channel-ready');
}

async function boot() {
  // userData 重定向（便携版 data/ 与 dev 测试 DSH_DESKTOP_USERDATA）已在
  // 模块加载期、单实例锁校验之前完成（见 App lifecycle 区块），此处直接读取。
  userDataDir = app.getPath('userData');
  logsDir = path.join(userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise let dsh use its own
  // default (~/.dsh), so the desktop app shares config/sessions with the CLI.
  dshHome = process.env.DSH_HOME || '';
  // 后端模式（local/wsl）：读取环境变量 / settings.json。wsl 模式在此
  // 解析发行版/安装目录并探活 node/npm（异步）；探测失败回落 local 模式
  // 继续启动（issue #54），不再抛错让应用无法启动。
  await resolveBackendConfig();
  fs.mkdirSync(logsDir, { recursive: true });
  if (dshHome) fs.mkdirSync(dshHome, { recursive: true });
  // 日志体积封顶：desktop.log / dsh-web.log 无界追加，长期运行会膨胀到数百 MB，
  // 还会让失败路径上的「整文件读尾部」变成线性开销。此时没有任何写者（上一
  // 个实例已退出、本实例尚未开流），封顶是安全的。
  capLogFile(path.join(logsDir, 'desktop.log'));
  capLogFile(path.join(logsDir, 'dsh-web.log'));
  capLogFile(path.join(logsDir, 'watchdog.log'));
  desktopLog = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });
  desktopLog.on('error', (e) => { try { console.error('desktop.log 写入失败', e); } catch {} });
  // 崩溃取证（Issue #9）：把 Crashpad minidump 固定到数据目录并保留，
  // 用于后续定位 0xC0000005 的底层来源（不联网上传）。
  crashDumpsDir = path.join(userDataDir, 'crash-dumps');
  try {
    fs.mkdirSync(crashDumpsDir, { recursive: true });
    app.setPath('crashDumps', crashDumpsDir);
    pruneOldCrashDumps();
    crashReporter.start({
      productName: 'DSH Desktop',
      companyName: 'DSH Desktop',
      submitURL: '',
      uploadToServer: false,
      compress: true,
    });
  } catch (err) {
    log('crash', 'crashReporter 初始化失败: ' + err.message);
  }
  log('boot', `DSH Desktop ${APP_VERSION}  userData=${userDataDir}  dshHome=${dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);
  if (isWslMode()) {
    log('boot', `WSL 托管模式已启用：发行版=${wslBackend.distroName()} 安装目录=${wslBackend.installDirLinux()}（UNC: ${wslBackend.uncHome()}）`);
  } else if (wslFallbackReason) {
    // 上面 resolveBackendConfig 阶段的回落日志此时尚未开流（desktop.log 未建），
    // 这里补记一条，保证用户日志里能看到回落原因（issue #54 排查入口）。
    log('boot', 'WSL 托管模式探测失败，已回落到本地模式，原因: ' + wslFallbackReason);
  }

  // 运行状态/看门狗：先读取上一次运行是否干净退出，再写入本次状态。
  const uncleanPrev = detectUncleanPreviousRun();
  writeRunState();
  startWatchdog();

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  Menu.setApplicationMenu(null);
  // 尽早弹出 loading 窗口（不依赖后续任何启动步骤），用户能第一时间看到
  // 「正在启动」反馈；同时立刻装配渲染进程自恢复与挂起心跳——loading 窗口
  // 阶段（首次同步/补丁可能耗时数十秒）崩溃/挂起也有兜底，而不是裸奔。
  // （PR #39 提速 + 本合入补齐恢复装配时机）
  createWindow();
  initRendererRecovery();
  wireWindowRecovery();
  startHeartbeatLoop();
  startPreviewStaticServer();
  registerChromeIpc();
  createTray();
  // 托盘图标被 explorer 重启等外部因素清掉后，周期性自愈。
  trayRecoveryTimer = setInterval(ensureTray, 30 * 1000);
  if (trayRecoveryTimer.unref) trayRecoveryTimer.unref(); // 不阻止退出（issue #89）
  if (uncleanPrev) notifyUncleanRestart(uncleanPrev);
  // 内置 Agent 预设保护：更新后首启恢复用户改过的预设（与后端模式无关，
  // assets/agent-presets 始终在 Windows 侧安装目录）。放在预设同步之前，
  // 恢复后的内容再由 syncLocalAgentPresets / syncBuiltinAgentPresets 以
  // 「源为尊」同步进 dsh 包。
  applyPresetGuard();
  const home = dshHome || process.env.DSH_HOME || require('node:path').join(require('node:os').homedir(), '.dsh');
  if (isWslMode()) {
    // WSL 托管模式：先建窗口显示加载页（首次 npm 安装可能耗时数分钟），
    // 确保 WSL 内 agent 安装完成后再同步配套插件/补丁（经 UNC 写入 WSL profile）。
    // 跳过 repairProfileFallback（WSL 内的 dsh 首次启动会自行 heal）与 koffi
    // 目录选择器 overlay（只作用于本地内置 dsh）。
    setupTestChannel();
    await wslBackend.ensureInstalled();
    ensurePluginIntegration().syncPlugins();
    syncBuiltinAgentPresets();
    notifyPatchFailures(ensurePluginIntegration().applyPatches());
    ensurePluginIntegration().preflightHealth();
  } else {
    // 先修复 profile fallback 联接再同步/补丁依赖文件：EPERM 环境下补丁写不进去。
    await repairProfileFallback(home);
    ensurePluginIntegration().syncPlugins();
    syncLocalAgentPresets();
    notifyPatchFailures(ensurePluginIntegration().applyPatches());
    ensurePluginIntegration().preflightHealth();
    setupTestChannel();
    if (runKoffiPreflight()) clearAutoPickerBrowseOverlay();
    else enablePickerBrowseOverlay();
  }
  bootFinished = true; // 窗口已建：此后异常走既有 fatal/错误弹窗，不再重复弹
  startAndShowGuarded()
    .then(() => {
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = effectiveDshHome() || path.join(os.homedir(), '.dsh');
      sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      sessionWatcher.start();
      maintainShortcuts();
      warnTempRun();
      startBalanceLoop();
      offerPendingClientUpdate();
      // 插件层残留清理（运行中删除失败的 .trash/.bak 残留，24h 前的清理）。
      try { ensurePluginCenter().bootCleanup(); } catch (err) { log('boot', '插件残留清理失败: ' + ((err && err.message) || err)); }
      // 服务存活探针（防「假活」）：进程存活但 HTTP 不响应 → 守护重启。
      supervision = ensurePluginCenter().supervision({
        getBaseUrl: () => webUrl,
        // 集成测试可压缩探活周期（生产环境恒为默认值：interval 30s / grace 120s /
        // cooldown 60s / 阈值 3 次）。
        intervalMs: Number(process.env.DSH_DESKTOP_TEST_SUPERVISION_INTERVAL || '30000'),
        graceMs: Number(process.env.DSH_DESKTOP_TEST_SUPERVISION_GRACE || '120000'),
        cooldownMs: Number(process.env.DSH_DESKTOP_TEST_SUPERVISION_COOLDOWN || '60000'),
        failThreshold: Number(process.env.DSH_DESKTOP_TEST_SUPERVISION_THRESHOLD || '3'),
        httpGet: (url, opts) => new Promise((resolve) => {
          if (testForceProbeFail) { resolve({ statusCode: 0 }); return; }
          const req = http.get(url, { timeout: opts && opts.timeout ? opts.timeout : 3000 }, (res) => {
            res.resume();
            resolve({ statusCode: res.statusCode || 0 });
          });
          req.on('error', () => resolve({ statusCode: 0 }));
          req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ statusCode: 0 }); });
        }),
        isBusy: () => restartingServer || crashLoopRecovering || diagMutationBusy || guardMutationBusy,
        onZombie: async () => {
          const now = Date.now();
          if (now - zombieWindowStart > ZOMBIE_WINDOW_MS) {
            zombieWindowStart = now;
            zombieRestartCount = 0;
            zombieGiveUpNotified = false;
          }
          if (zombieRestartCount >= ZOMBIE_RESTART_MAX) {
            if (!zombieGiveUpNotified) {
              zombieGiveUpNotified = true;
              log('supervision', '假活自动重启达到上限，停止自动重启');
              showBox({
                type: 'error',
                title: 'DSH 服务无响应',
                message: '检测到 Web 服务连续无响应且自动重启无效（可能有插件占死事件循环）。可在设置 → 插件 中排查最近安装或更新的插件。',
                buttons: ['知道了'],
                defaultId: 0,
                cancelId: 0,
              });
            }
            return;
          }
          zombieRestartCount += 1;
          log('supervision', `探活连续失败，判定服务假活，触发守护重启（第 ${zombieRestartCount}/${ZOMBIE_RESTART_MAX} 次）`);
          if (serverProc && !restartingServer && !crashLoopRecovering) {
            await restartService();
          }
        },
      });
      supervision.start();

      if (!process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) {
        // dsh agent 更新：启动 15 秒后 + 每 6 小时。
        setTimeout(() => runUpdateFlow(false), 15000).unref();
        setInterval(() => runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
      }
      if (!process.env.DSH_DESKTOP_SKIP_CLIENT_UPDATE && (process.platform === 'win32' || process.platform === 'darwin')) {
        // 客户端（封装）更新：启动 60 秒后 + 每 12 小时。
        // Windows（安装版/便携版）与 macOS（.app 替换）支持；其它平台不注册周期检查。
        setTimeout(() => runClientUpdateFlow(false), 60000).unref();
        setInterval(() => runClientUpdateFlow(false), 12 * 3600 * 1000).unref();
      }
      log('test-event', 'boot-ready');
    })
    .catch((err) => handleBootFailure(err));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// 便携版数据目录必须在校验单实例锁之前重定向：Electron 的实例锁以 userData
// 为键，旧代码在 boot() 里才 setPath —— 便携版与安装版（乃至两个便携版）会
// 共用 %APPDATA%\DSH Desktop 的锁；安装版正在运行时再双击便携版会因
// requestSingleInstanceLock() 失败而静默退出、无任何界面（issue #30「便携版
// 双击无反应 / 有进程无窗口」的候选根因）。重定向后各安装形态各持其锁，
// 便携版数据随 exe 走（data/），两版可同时运行互不干扰。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try { app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')); } catch {}
} else if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
  // 开发模式集成测试隔离（DSH_DESKTOP_USERDATA）：与便携版同理，必须在锁
  // 校验之前重定向，否则所有测试实例共用默认 userData 的实例锁 —— 真实
  // 桌面端（安装版）运行时测试实例会因锁冲突全部静默退出，反之亦然。
  // 只作用于 dev 模式且仅由测试环境显式设置，对安装版/便携版无任何影响。
  try { app.setPath('userData', process.env.DSH_DESKTOP_USERDATA); } catch {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  // 渲染进程权限收紧（修复审计发现：Electron 默认批准摄像头/麦克风等请求，
  // 页面内第三方插件可静默 getUserMedia）。白名单只放行界面必需项；媒体/
  // 定位/设备类一律拒绝并记日志。
  app.on('web-contents-created', (_event, wc) => {
    try {
      wc.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
        const allowed = ['fullscreen', 'pointerLock', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
        // origin 精确校验：仅放行当前 dsh web 页面的请求（第三方页面/恢复页/
        // 恶意重定向页面一律拒绝）——修复「白名单对所有 webContents 全放行」的
        // origin 盲区。
        let originOk = false;
        try {
          const reqUrl = details && typeof details.requestingUrl === 'string' ? details.requestingUrl : '';
          const currentWeb = webUrl || '';
          originOk = reqUrl !== '' && currentWeb !== '' && new URL(reqUrl).origin === new URL(currentWeb).origin;
        } catch { originOk = false; }
        const ok = allowed && originOk;
        if (!ok) log('perm', '拒绝渲染进程权限请求: ' + permission + (originOk ? '' : '（origin 不匹配: ' + (details && details.requestingUrl) + '）'));
        callback(ok);
      });
    } catch (err) {
      log('perm', '权限处理器注册失败: ' + ((err && err.message) || err));
    }
  });
  // 本区块在模块加载期执行（boot() 之前），userDataDir 尚未赋值；统一用
  // app.getPath('userData')（便携版已在上面重定向）构造 settings 上下文，
  // 避免读写到 cwd 下无关的 settings.json。
  const gpuSettingsCtx = () => ({ ...updCtx(), userDataDir: app.getPath('userData') });
  // GPU 进程崩溃是最常见的 Electron 静默退出原因（无日志、无弹窗）。
  // 默认启用硬件加速（issue #26：软件渲染导致 GPU 进程空转 ~60% 单核、
  // 设置页等整页重绘明显掉帧）。仅当 settings.json 标记
  // hardwareAcceleration === 'off'（用户手动关闭，或 GPU 连续崩溃自动降级
  // 写入）时才禁用硬件加速。
  if (updater.loadSettings(gpuSettingsCtx()).hardwareAcceleration === 'off') {
    app.disableHardwareAcceleration();
  }
  // GPU / 渲染进程崩溃日志 + 自动降级（issue #26）：GPU 进程短时间内连续
  // 崩溃达到阈值 → 判定显卡驱动不兼容 → 持久化 hardwareAcceleration:'off'
  // 并重启应用，而不是旧版那样一刀切全局禁用硬件加速。
  const gpuCrashGuard = createGpuCrashGuard();
  const recordGpuCrash = (extra) => {
    const ts = new Date().toISOString();
    try { const lp = path.join(app.getPath('userData'), 'logs', 'desktop.log'); fs.mkdirSync(path.dirname(lp), { recursive: true }); fs.appendFileSync(lp, `[${ts}] [crash] GPU 进程崩溃 ${extra}\n`); } catch {}
    if (!gpuCrashGuard.record()) return;
    try {
      const s = updater.loadSettings(gpuSettingsCtx());
      s.hardwareAcceleration = 'off';
      updater.saveSettings(gpuSettingsCtx(), s);
      log('boot', 'GPU 进程连续崩溃，已持久化关闭硬件加速，重启应用生效');
    } catch (err) {
      log('boot', 'GPU 降级标记写入失败: ' + ((err && err.message) || err));
    }
    try { quitting = true; markCleanExit(); killTreeSync(serverProc); } catch {}
    app.relaunch();
    app.exit(0);
  };
  app.on('gpu-process-crashed', (_e, killed) => recordGpuCrash(`(killed=${killed})`));
  app.on('render-process-gone', (_e, wc, details) => {
    const ts = new Date().toISOString();
    try { const lp = path.join(app.getPath('userData'), 'logs', 'desktop.log'); fs.mkdirSync(path.dirname(lp), { recursive: true }); fs.appendFileSync(lp, `[${ts}] [crash] 渲染进程崩溃: ${details.reason} (exitCode=${details.exitCode})\n`); } catch {}
  });
  app.on('child-process-gone', (_e, details) => {
    const ts = new Date().toISOString();
    try { const lp = path.join(app.getPath('userData'), 'logs', 'desktop.log'); fs.mkdirSync(path.dirname(lp), { recursive: true }); fs.appendFileSync(lp, `[${ts}] [crash] 子进程崩溃: type=${details.type} reason=${details.reason} (exitCode=${details.exitCode})\n`); } catch {}
    if (details.type === 'GPU') recordGpuCrash('(via child-process-gone)');
  });
  app.on('second-instance', () => {
    // 用户再次双击桌面/开始菜单图标：恢复（或重建）主窗口。
    log('boot', 'second-instance：恢复主窗口');
    showMainWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    forceQuit = true;
    markCleanExit();
    log('boot', '正在退出，销毁会话浮窗并停止 dsh web 进程树…');
    if (supervision) { try { supervision.stop(); } catch {} supervision = null; }
    closePetWindow(); // 宠物小窗随应用退出关闭（主窗「关闭到托盘」时保留）
    closeAllFloatWindows();
    killTreeSync(serverProc);
    updater.abort();
    if (recovery) recovery.dispose();
    if (sessionWatcher) sessionWatcher.stop();
    if (balanceScheduler) balanceScheduler.stop();
    if (trayRecoveryTimer) { clearInterval(trayRecoveryTimer); trayRecoveryTimer = null; }
    if (tray) { try { tray.destroy(); } catch {} tray = null; }
  });
  // 关闭窗口后常驻托盘；托盘不存在或已销毁时才随窗口退出。
  app.on('window-all-closed', () => {
    if (!IS_WIN || !tray || tray.isDestroyed()) app.quit();
  });
  app.whenReady().then(boot).catch((err) => fatal('应用初始化失败', err));
}
