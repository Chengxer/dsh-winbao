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
// The dsh CLI is spawned with the bundled node.exe (vendor/node/node.exe in
// dev, resources/node/node.exe when packaged) so that prebuilt native
// modules (sharp, node-pty, koffi, ...) match the Node ABI they were
// installed for. We deliberately never rebuild them against Electron.

const { app, BrowserWindow, Menu, shell, dialog, Notification } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const updater = require('./updater');
const { SessionWatcher } = require('./session-watcher');

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
let sessionWatcher = null;
let userDataDir = '';
let logsDir = '';
let dshHome = '';
let desktopLog = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
  try { if (desktopLog) desktopLog.write(line); } catch {}
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line);
}

function nodeExe() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', 'node.exe');
  return path.resolve(__dirname, 'vendor', 'node', 'node.exe');
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

function dshVersion() { return updater.activeVersion(updCtx()) || '未知'; }

function dshVersionSource() {
  return updater.overlayVersion(updCtx()) ? '用户目录（已更新）' : '内置';
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    }
  } catch (err) {
    log('killTree', String(err));
  }
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
  return env;
}

function showBox(opts) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, opts);
  return dialog.showMessageBox(opts);
}

// ---------------------------------------------------------------------------
// dsh web server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
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
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port 0`);
    const proc = spawn(nodeBin, [bin, 'web', '--host', '127.0.0.1', '--port', '0'], {
      cwd: userDataDir,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const onData = (chunk) => {
      out.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (m) finish(resolve, m[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c) => out.write(c));
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code, signal) => {
      out.end();
      log('dsh', `进程退出 code=${code} signal=${signal}`);
      serverProc = null;
      finish(reject, new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${path.join(logsDir, 'dsh-web.log')}`));
      if (!quitting && webUrl && mainWindow && !mainWindow.isDestroyed()) {
        showBox({
          type: 'error',
          title: 'DSH 服务已停止',
          message: 'DeepSeek Harness 服务意外退出。',
          detail: `日志文件：${path.join(logsDir, 'dsh-web.log')}`,
          buttons: ['重新启动', '退出'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) startAndShow().catch((err) => handleBootFailure(err));
          else app.quit();
        });
      }
    });
    // Safety net in case the URL line never appears.
    setTimeout(() => finish(reject, new Error('等待 dsh web 启动超时（60 秒）')), 60000).unref();
  });
}

function waitUntilUp(url, timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url + '/', { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(url);
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('Web UI 未在预期时间内就绪'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

function startAndShow() {
  return startServer()
    .then(waitUntilUp)
    .then((url) => {
      webUrl = url;
      log('boot', 'Web UI 就绪: ' + url);
      if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow.loadURL(url).then(() => url);
      }
      return url;
    });
}

function handleBootFailure(err) {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: '更新后的 agent 无法启动。',
      detail: (err && err.message || String(err)) + '\n\n可回退到内置版本继续使用。',
      buttons: ['回退到内置版本并重试', '重试', '退出'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 0) {
        updater.rollback(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if (response === 1) {
        startAndShow().catch((e2) => handleBootFailure(e2));
      } else {
        app.quit();
      }
    });
  } else {
    fatal('DeepSeek Harness 启动失败', err);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DSH Desktop',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'assets', 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Keep the app brand in the OS title bar (the web UI sets its own <title>).
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('DSH Desktop');
  });

  // Open target=_blank / window.open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the window pinned to the local web UI; send external links out.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) return;
    if (webUrl && url.startsWith(webUrl)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function fatal(title, err) {
  log('fatal', title + ': ' + ((err && (err.stack || err.message)) || err));
  const detail = '错误：' + ((err && err.message) || err) + '\n\n日志目录：' + logsDir;
  if (!mainWindow || mainWindow.isDestroyed()) {
    dialog.showErrorBox(title, detail);
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

function showUpdateWindow(version) {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: true,
    title: '正在更新',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'assets', 'updating.html')).then(() => {
    win.webContents.executeJavaScript(
      `document.getElementById('title').textContent = '正在更新 @deepseek-ai/dsh → ${JSON.stringify(version)}';`
    ).catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

async function runUpdateFlow(manual) {
  if (quitting) return;
  if (updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
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
        message: '无法连接 npm registry。',
        detail: err.message + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。',
        buttons: ['确定'],
      });
    }
    return;
  }
  const current = updater.activeVersion(ctx);
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
    detail: `当前版本：${current}\n\n是否立即更新？\n· 从 npm 官方源下载新版本及其依赖（首次约 250MB）\n· 更新期间界面保持可用，完成后重启应用生效\n· 失败会自动保留当前版本`,
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

  updateBusy = true;
  const progressWin = showUpdateWindow(latest);
  try {
    await updater.applyUpdate(ctx, latest);
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
      killTree(serverProc);
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    log('update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    updateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// Session-completion notifications
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map(); // sessionId -> timestamp (rate-limit)

function onSessionTurnEnd(info) {
  if (!notifyOnTurnEnd || quitting) return;
  const now = Date.now();
  const last = lastNotifyAt.get(info.sessionId) || 0;
  if (now - last < 30000) return; // same session: at most one toast per 30s
  lastNotifyAt.set(info.sessionId, now);
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    const n = new Notification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    log('notify', '通知发送失败: ' + err.message);
  }
}

// Windows toast notifications require a Start Menu shortcut carrying our
// AppUserModelId. The NSIS installer already creates one; the portable build
// registers its own on first run (targeting the original exe).
function ensureStartMenuShortcut() {
  if (!app.isPackaged || !IS_WIN) return;
  try {
    const shortcutPath = path.join(
      app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH Desktop.lnk'
    );
    if (fs.existsSync(shortcutPath)) return;
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const created = shell.writeShortcutLink(shortcutPath, 'create', {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      appUserModelId: 'com.deepseek.dsh.desktop',
    });
    if (created) log('boot', '已创建开始菜单快捷方式（系统通知需要）: ' + shortcutPath);
  } catch (err) {
    log('boot', '创建开始菜单快捷方式失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ label: '退出', accelerator: 'Alt+F4', role: 'quit' }],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '在浏览器中打开', click: () => webUrl && shell.openExternal(webUrl) },
        { label: '打开日志目录', click: () => shell.openPath(logsDir) },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => runUpdateFlow(true) },
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
        {
          label: '关于 DSH Desktop',
          click: () => showBox({
            type: 'info',
            title: '关于 DSH Desktop',
            message: 'DSH Desktop ' + APP_VERSION,
            detail: 'DeepSeek Harness 桌面客户端\n\nagent 版本：' + dshVersion() + '（' + dshVersionSource() + '）\n数据目录：' + userDataDir + '\nDSH_HOME：' + (dshHome || '（dsh 默认）'),
            buttons: ['确定'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  // Portable builds keep all data next to the exe.
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
  }

  userDataDir = app.getPath('userData');
  logsDir = path.join(userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise let dsh use its own
  // default (~/.dsh), so the desktop app shares config/sessions with the CLI.
  dshHome = process.env.DSH_HOME || '';
  fs.mkdirSync(logsDir, { recursive: true });
  if (dshHome) fs.mkdirSync(dshHome, { recursive: true });
  desktopLog = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `DSH Desktop ${APP_VERSION}  userData=${userDataDir}  dshHome=${dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  buildMenu();
  createWindow();
  startAndShow()
    .then(() => {
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      sessionWatcher.start();
      ensureStartMenuShortcut();

      if (process.env.DSH_DESKTOP_SKIP_AUTO_UPDATE) return;
      // Background check shortly after boot, then every 6 hours.
      setTimeout(() => runUpdateFlow(false), 15000).unref();
      setInterval(() => runUpdateFlow(false), AUTO_UPDATE_INTERVAL_MS).unref();
    })
    .catch((err) => handleBootFailure(err));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('before-quit', () => {
    quitting = true;
    log('boot', '正在退出，停止 dsh web 进程树…');
    killTree(serverProc);
    updater.abort();
    if (sessionWatcher) sessionWatcher.stop();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(boot).catch((err) => fatal('应用初始化失败', err));
}
