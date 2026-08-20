/* eslint-disable */
'use strict';
/**
 * DSH Desktop（Tauri 版）—— window.dshDesktop 桥垫片
 * ==================================================
 *
 * contracts/bridge-api.md 的页面侧实现。经 Tauri `initialization_script` 注入
 * 每一个页面（含远程内核页 http://127.0.0.1:<port>）。
 *
 * 设计约束：
 *  1. 签名与 Electron 版 preload.js 逐字段一致（48 方法，硬契约）；
 *  2. 无 Tauri 内部件时降级为「浏览器模式」：方法返回 rejected Promise、
 *     getPathForFile 返回 ''（与 Electron 版浏览器降级同语义）；
 *  3. 错误统一 Error('[CODE] message')（contracts/error-codes.md）；
 *  4. 同步 send 语义的 4 个方法保持同步返回 void（内部 fire-and-forget）。
 */
(function () {
  if (window.dshDesktop) return; // 幂等（重复注入防御）
  // ---- WebView2 原生 dialog polyfill ---------------------------------
  // Tauri/wry (WebView2) 不弹原生 confirm/alert/prompt：confirm 恒 false、
  // alert/prompt 静默。dsh-session-manager 的删除确认走 window.confirm →
  // 永远被「取消」＝删不掉会话（用户实测 bug）。桌面壳内用户点击按钮即意图，
  // confirm 放行 true（服务端另有「运行中会话拒绝删除」保护）；alert 转桥
  // 上报（消息不丢）；prompt 返回 null（内核 UI 不依赖，防御性兜底）。
  try {
    if (!window.__dshDialogPolyfilled) {
      window.__dshDialogPolyfilled = true;
      window.confirm = function () { return true; };
      window.alert = function (msg) {
        try { window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('page_error', { message: '[alert] ' + msg }); } catch (e) {}
        if (window.console) console.warn('[dshDesktop alert]', msg);
      };
      window.prompt = function () { return null; };
    }
  } catch (e) { /* polyfill 失败不阻断桥 */ }


  var INTERNALS = window.__TAURI_INTERNALS__ || null;
  var INVOKE = INTERNALS && typeof INTERNALS.invoke === 'function' ? INTERNALS.invoke : null;
  var TRANSFORM = INTERNALS && typeof INTERNALS.transformCallback === 'function'
    ? INTERNALS.transformCallback : null;

  // ---- 错误归一：{code,message} → Error('[code] message')；字符串原样 ----
  function toError(raw) {
    if (raw instanceof Error) return raw;
    var code = raw && typeof raw === 'object' && typeof raw.code === 'string' ? raw.code : null;
    var msg = raw && typeof raw === 'object' && raw.message !== undefined ? String(raw.message)
      : typeof raw === 'string' ? raw : JSON.stringify(raw);
    return new Error(code ? '[' + code + '] ' + msg : (msg || 'unknown bridge error'));
  }
  function call(cmd, args) {
    if (!INVOKE) return Promise.reject(toError({ code: 'E_NO_HOST', message: '桌面桥不可用（浏览器模式）' }));
    try {
      return INVOKE(cmd, args || {}).then(null, function (raw) { throw toError(raw); });
    } catch (e) {
      return Promise.reject(toError(e));
    }
  }
  function send(cmd, args) { call(cmd, args).catch(function () { /* fire-and-forget：失败只静默 */ }); }

  // ---- 事件（主进程 → 页面）----
  var listeners = { maximize: [], jump: [], balance: [], pet: [] };
  function onEvent(name, queue, map) {
    if (!INVOKE || !TRANSFORM) return;
    try {
      INVOKE('plugin:event|listen', {
        event: name,
        target: { kind: 'Any' },
        handler: TRANSFORM(function (payload) {
          for (var i = 0; i < queue.length; i++) {
            try { queue[i](map ? map(payload) : payload); } catch (e) { /* 订阅方异常不外溢 */ }
          }
        })
      }).catch(function () { /* 事件系统不可用时静默（浏览器模式） */ });
    } catch (e) { /* 同上 */ }
  }
  onEvent('window-maximized', listeners.maximize, Boolean);
  onEvent('notification-jump', listeners.jump, function (p) {
    var id = p && typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
    return id && id.length <= 256 ? Object.freeze({ sessionId: id }) : null;
  });
  onEvent('balance-changed', listeners.balance, function (p) { return p; });
  onEvent('pet-state', listeners.pet, function (p) { return p || {}; });

  // ---- 余额 / 宠物状态 → window CustomEvent（契约 §3，dsh-balance / harness-pet 消费）----
  listeners.balance.push(function (data) {
    try { window.dispatchEvent(new CustomEvent('dsh-balance-changed', { detail: data })); } catch (e) {}
  });
  listeners.pet.push(function (data) {
    try { window.dispatchEvent(new CustomEvent('dsh-pet-state', { detail: data })); } catch (e) {}
  });

  // ---- 通知跳转补发（订阅前收到的最后一次保留）----
  var pendingJump = null;
  listeners.jump.push(function (jump) { if (jump) pendingJump = jump; });

  // ---- 心跳：5s + visibilitychange 补报（契约 §4）----
  send('renderer_heartbeat');
  setInterval(function () { send('renderer_heartbeat'); }, 5000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) send('renderer_heartbeat');
  });

  // ---- 页面异常上报（契约 §4）----
  window.addEventListener('error', function (e) {
    send('page_error', { message: 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown') });
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('page_error', { message: 'unhandledrejection: ' + String((e && e.reason && (e.reason.message || e.reason)) || e) });
  });

  // ---- 当前会话上报：3s 轮询 localStorage，变化才发（契约 §4）----
  (function () {
    var last = '';
    var tick = function () {
      try {
        var raw = localStorage.getItem('dsh.sessions.current');
        var parsed = raw ? JSON.parse(raw) : null;
        var id = parsed && typeof parsed === 'object' ? String(parsed.sessionId || '') : '';
        if (id && id !== last) { last = id; send('current_session', { sessionId: id }); }
      } catch (e) { /* 会话未就绪时无值 */ }
    };
    tick();
    setInterval(tick, 3000);
  })();

  // ---- 桥对象（48 方法，签名见 contracts/bridge-api.md）----
  var dshDesktop = {
    appVersion: '', // app_init 回填
    windowControls: {
      minimize: function () { return call('window_control', { action: 'minimize' }); },
      toggleMaximize: function () { return call('window_control', { action: 'toggle-maximize' }); },
      close: function () { return call('window_control', { action: 'close' }); },
      isMaximized: function () { return call('window_control', { action: 'is-maximized' }); },
      onMaximizeChange: function (cb) {
        if (typeof cb !== 'function') return function () {};
        listeners.maximize.push(cb);
        return function () {
          var i = listeners.maximize.indexOf(cb);
          if (i >= 0) listeners.maximize.splice(i, 1);
        };
      }
    },
    menu: {
      action: function (action, payload) {
        if (action === 'check-agent-update') {
          // 契约 ipc-commands.md §2.4：内核自动更新链已裁撤，方法位保留防 TypeError。
          return Promise.reject(toError({ code: 'E_CUT_FEATURE', message: '内核自动更新已在 Tauri 版移除（随客户端发版升级）' }));
        }
        return call('menu_action', { action: action, payload: payload || {} });
      }
    },
    getInfo: function () {
      return call('app_init').then(function (info) {
        if (info && typeof info.appVersion === 'string') dshDesktop.appVersion = info.appVersion;
        return info;
      });
    },
    refreshBalance: function () { return call('balance_refresh'); },
    onNotificationJump: function (cb) {
      if (typeof cb !== 'function') return function () {};
      var wrapped = function (jump) { if (jump) { try { cb(jump); } catch (e) {} } };
      listeners.jump.push(wrapped);
      if (pendingJump) { var p = pendingJump; pendingJump = null; wrapped(p); }
      return function () {
        var i = listeners.jump.indexOf(wrapped);
        if (i >= 0) listeners.jump.splice(i, 1);
      };
    },
    wsl: {
      getConfig: function () { return call('wsl_config_get'); },
      saveConfig: function (cfg) { return call('wsl_config_save', { cfg: cfg }); },
      recheck: function () { return call('wsl_recheck'); }
    },
    restartService: function () { return call('restart_service', { intent: 'restart-service' }); },
    revertFiles: function (changes) { return call('file_revert', { changes: changes || [] }); },
    openPath: function (path) { return call('file_open', { path: String(path || '') }); },
    openExternal: function (url) { return call('open_external', { url: String(url || '') }); },
    copyText: function (text) { return call('copy_text', { text: String(text == null ? '' : text) }); },
    // 浏览器 File → 磁盘路径：Tauri 无直接等价（bridge-api.md §6-R1）。
    // Phase 2 由 drag-drop 事件回填 file.path；过渡期返回 ''（插件已有降级）。
    getPathForFile: function (file) {
      try { return (file && typeof file.path === 'string') ? file.path : ''; } catch (e) { return ''; }
    },
    imagePaste: {
      save: function (payload) { return call('image_paste_save', payload || {}); }
    },
    sponsorQr: function () { return call('sponsor_qr'); },
    sponsorWindow: function () { return call('sponsor_window'); },
    floatWindow: {
      open: function (sessionId) { return call('float_window', { action: 'open', sessionId: sessionId }); },
      close: function () { send('float_close'); } // 同步语义（契约 §6）
    },
    pluginManager: {
      list: function () { return call('plugin_list'); },
      setEnabled: function (id, enabled) { return call('plugin_set_enabled', { id: id, enabled: !!enabled }); },
      uninstall: function (id) { return call('plugin_uninstall', { id: id }); },
      restore: function (id) { return call('plugin_restore', { id: id }); },
      checkUpdates: function () { return call('plugin_check_updates'); },
      update: function (id) { return call('plugin_update', { id: id }); }
    },
    diagBackup: {
      runDiagnostics: function () { return call('diag_run'); },
      exportBackup: function (label) { return call('backup_export', { label: label }); },
      previewRestore: function () { return call('backup_restore', { preview: true }); },
      restore: function (token) { return call('backup_restore', { preview: false, token: token }); },
      exportDiagnostics: function () { return call('diag_export'); },
      validatePlugins: function () { return call('diag_validate'); },
      removeBundle: function (names) { return call('diag_remove_bundle', { names: names || [] }); },
      analyzeOrder: function () { return call('diag_order'); },
      applyOrder: function (order) { return call('diag_order_apply', { order: order }); }
    },
    petWindow: {
      open: function () { return call('pet_window', { action: 'open' }); },
      toggle: function () { return call('pet_window', { action: 'toggle' }); },
      isOpen: function () { return call('pet_window', { action: 'state' }); },
      close: function () { send('pet_close'); },
      moveTo: function (x, y) { send('pet_move_to', { x: Number(x) || 0, y: Number(y) || 0 }); },
      setAutoOpen: function (enabled) { send('pet_set_auto_open', { enabled: !!enabled }); }
    },
    recovery: {
      getState: function () { return call('recovery_state'); },
      reload: function () { return call('recovery_reload'); },
      restart: function () { return call('recovery_restart'); },
      openLogs: function () { return call('recovery_open_logs'); }
    }
  };

  Object.defineProperty(window, 'dshDesktop', { value: dshDesktop, writable: false, configurable: false });

  // ---- 窗口控制条注入（内核页）----------------------------------------
  // 主窗 decorations:false：loading/recovery/poc 壳页自带标题栏，但内核
  // Web UI 只认识 Electron 的 -webkit-app-region（WebView2 不支持）→ 导航
  // 到内核页后既不能拖动也没有窗口按钮（用户实测 bug）。对齐 Electron
  // preload 的 injectChrome：注入全宽 36px 壳标题栏（拖拽 + — □ ×），body
  // 下推 36px，并声明 data-dsh-title-bar-height 供内核生态里 fixed 定位的
  // 侧边栏（dsh-better-sidebar）自行下移。
  //  - 拖拽/双击最大化交给 Tauri 内置 data-tauri-drag-region 脚本（mousedown
  //    → start_dragging；detail===2 → internal_toggle_maximize），垫片不另挂
  //    dblclick（会双重切换）；bare 属性只对「直接命中该元素」生效，故左侧
  //    每个装饰子元素都带属性，右侧按钮天然阻断。
  //  - 浮窗（__DSH_FLOAT__，自带浮窗条）/宠物窗（__DSH_PET__）/壳页
  //    （loading|recovery|poc.html 自带 #bar/#titlebar）跳过，防重复控制条。
  //  - 初始化脚本先于页面脚本运行，DOM 未建：MutationObserver 等 body 出现
  //    再注入；内核 SPA/插件可能移除 body 直接子元素 → 观察 body childList，
  //    被移除就重注（幂等：先查 #dsh-tauri-chrome）。
  //  - 样式走 <style> 元素（内核页 CSP 不放行内联属性）；全程 try/catch，
  //    注入失败绝不影响桥主流程。
  var CHROME_ID = 'dsh-tauri-chrome';
  var CHROME_H = 36;
  function injectChromeBar() {
    try {
      if (document.getElementById(CHROME_ID)) return; // 幂等（重复注入/重注防御）
      if (window.__DSH_FLOAT__ || window.__DSH_PET__) return; // 专属窗形态，各有各的条
      if (/(^|\/)(loading|recovery|poc)\.html$/.test(location.pathname)) return; // 壳页自带标题栏
      var shellBar = document.getElementById('bar');
      if ((shellBar && shellBar.hasAttribute('data-tauri-drag-region')) || document.getElementById('titlebar')) return;

      var head = document.head || document.documentElement;
      var css = document.createElement('style');
      css.setAttribute('data-for', CHROME_ID);
      css.textContent =
        '#' + CHROME_ID + '{position:fixed;top:0;left:0;right:0;height:' + CHROME_H + 'px;z-index:2147483000;' +
          'display:flex;align-items:center;padding:0 0 0 12px;user-select:none;box-sizing:border-box;' +
          'font:12.5px/16px "Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
          'background:rgba(24,30,38,.92);border-bottom:1px solid #232b36;color:#d7dde4}' +
        '#' + CHROME_ID + ' .dch-logo{width:18px;height:18px;border-radius:5px;margin-right:8px;flex:none;' +
          'background:linear-gradient(135deg,#4f7cff,#36d1dc)}' +
        '#' + CHROME_ID + ' .dch-title{font-weight:600;white-space:nowrap}' +
        '#' + CHROME_ID + ' .dch-badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;' +
          'margin-left:8px;white-space:nowrap;color:#93a5d8;border:1px solid rgba(255,255,255,.12);' +
          'font-family:Consolas,monospace}' +
        '#' + CHROME_ID + ' .dch-spacer{flex:1}' +
        '#' + CHROME_ID + ' .dch-btns{display:flex;align-items:center;align-self:stretch}' +
        '#' + CHROME_ID + ' button{width:44px;height:32px;border:0;background:transparent;color:#d7dde4;' +
          'font-size:15px;line-height:32px;padding:0;cursor:pointer}' +
        '#' + CHROME_ID + ' button:hover{background:#2a3341;color:#fff}' +
        '#' + CHROME_ID + ' button.dch-close:hover{background:#e81123;color:#fff}';
      head.appendChild(css);
      // 内容区整体下移（对齐 Electron：普通流走 padding，fixed 侧边栏走属性声明）。
      var layout = document.createElement('style');
      layout.setAttribute('data-for', CHROME_ID + '-layout');
      layout.textContent = 'body{box-sizing:border-box!important;padding-top:' + CHROME_H + 'px!important}';
      head.appendChild(layout);
      try { document.documentElement.setAttribute('data-dsh-title-bar-height', String(CHROME_H)); } catch (e2) {}

      function dragEl(el) { el.setAttribute('data-tauri-drag-region', ''); return el; }
      function mkBtn(cls, glyph, tip, fn) {
        var b = document.createElement('button');
        b.className = cls; b.textContent = glyph; b.title = tip; b.setAttribute('aria-label', tip);
        b.onclick = function () { try { fn(); } catch (e2) { /* 桥不可用时静默 */ } };
        return b;
      }
      var bar = dragEl(document.createElement('div'));
      bar.id = CHROME_ID;
      var logo = dragEl(document.createElement('span'));
      logo.className = 'dch-logo';
      var title = dragEl(document.createElement('span'));
      title.className = 'dch-title'; title.textContent = 'DSH Desktop';
      var badge = dragEl(document.createElement('span'));
      badge.className = 'dch-badge'; badge.style.display = 'none';
      var spacer = dragEl(document.createElement('span'));
      spacer.className = 'dch-spacer';
      var btns = document.createElement('div');
      btns.className = 'dch-btns';
      var maxBtn = mkBtn('dch-max', '\u25A1', '最大化', function () { dshDesktop.windowControls.toggleMaximize(); });
      btns.appendChild(mkBtn('dch-min', '\u2500', '最小化', function () { dshDesktop.windowControls.minimize(); }));
      btns.appendChild(maxBtn);
      btns.appendChild(mkBtn('dch-close', '\u2715', '关闭', function () { dshDesktop.windowControls.close(); }));
      bar.appendChild(logo); bar.appendChild(title); bar.appendChild(badge);
      bar.appendChild(spacer); bar.appendChild(btns);
      document.body.appendChild(bar);

      // 最大化/还原图标状态（失败静默——浏览器模式常见）。
      function setMaxGlyph(max) {
        try { maxBtn.textContent = max ? '\u2750' : '\u25A1'; maxBtn.title = max ? '还原' : '最大化'; } catch (e2) {}
      }
      try { dshDesktop.windowControls.isMaximized().then(setMaxGlyph).catch(function () {}); } catch (e2) {}
      try { dshDesktop.windowControls.onMaximizeChange(setMaxGlyph); } catch (e2) {}
      // 版本徽章回填（getInfo 失败仅无徽章，不影响条本身）。
      try {
        dshDesktop.getInfo().then(function (info) {
          if (info && typeof info.appVersion === 'string' && info.appVersion) {
            badge.textContent = 'v' + info.appVersion; badge.style.display = '';
          }
        }).catch(function () {});
      } catch (e2) {}
    } catch (e) { /* 注入失败不影响页面主流程 */ }
  }
  function onBodyReady(cb) {
    if (document.body) { cb(); return; }
    try {
      var mo = new MutationObserver(function () {
        if (document.body) { mo.disconnect(); cb(); }
      });
      mo.observe(document.documentElement, { childList: true });
    } catch (e) {
      // 观察器不可用的极端环境：退化到 DOMContentLoaded / 立即执行。
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { cb(); });
      else cb();
    }
  }
  onBodyReady(function () {
    injectChromeBar();
    try {
      // 内核 SPA/插件重挂载防御：控制条是 body 直接子元素，childList（无需
      // subtree）即可精确感知「被移除」→ 重注（injectChromeBar 自身幂等）。
      var watch = new MutationObserver(function () {
        if (!document.getElementById(CHROME_ID)) injectChromeBar();
      });
      watch.observe(document.body, { childList: true });
    } catch (e) { /* 同上：防御性兜底 */ }
  });

  // 自初始化：回填 appVersion（失败静默——浏览器模式常见）。
  try { dshDesktop.getInfo().catch(function () {}); } catch (e) {}
})();
