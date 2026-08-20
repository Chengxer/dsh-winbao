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

  // 自初始化：回填 appVersion（失败静默——浏览器模式常见）。
  try { dshDesktop.getInfo().catch(function () {}); } catch (e) {}
})();
