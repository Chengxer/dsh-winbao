//! 内嵌页面：loading（boot 进度）与 recovery（崩溃恢复）。
//!
//! 均经 preview-server 以 http://127.0.0.1 托管——与内核 Web UI 同 origin 形态，
//! 事件监听与桥调用链路完全一致。自绘标题栏 36px（对齐 Electron BAR_HEIGHT）。

/// 启动加载页：boot 步骤进度 + 内核拉起状态 + 错误展示。
pub const LOADING_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>DSH Desktop — 启动中</title>
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:#0b1220;color:#d7dde4;
    display:flex;flex-direction:column;user-select:none}
  #bar{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;
    background:rgba(24,30,38,.92);border-bottom:1px solid #232b36}
  #bar .logo{width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#4f7cff,#36d1dc)}
  #bar .t{font-weight:600;pointer-events:none}
  #bar .sp{flex:1}
  #bar button{width:44px;height:36px;border:0;background:transparent;color:#d7dde4;font-size:15px;cursor:pointer}
  #bar button:hover{background:#2a3341}
  #bar button.x:hover{background:#c0392b;color:#fff}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
  .ring{width:44px;height:44px;border-radius:50%;border:3px solid #243046;border-top-color:#4f7cff;
    animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:17px;font-weight:600}
  #steps{min-width:340px;max-width:520px;font:12.5px/1.9 Consolas,monospace;color:#9fb0c0}
  .ok::before{content:"✓ ";color:#4cc38a}
  .fail::before{content:"✗ ";color:#ff6b6b}
  .run::before{content:"… ";color:#f5c451}
  .err{max-width:520px;color:#ff9d9d;font-size:13px;white-space:pre-wrap}
</style></head>
<body>
<div id="bar" data-tauri-drag-region>
  <span class="logo"></span><span class="t">DSH Desktop</span><span class="sp"></span>
  <button onclick="B&&B.windowControls.minimize()">&#x2500;</button>
  <button onclick="B&&B.windowControls.close()" class="x">&#x2715;</button>
</div>
<main>
  <div class="ring"></div>
  <h1 id="title">正在启动 DSH 内核…</h1>
  <div id="steps"></div>
  <div class="err" id="err"></div>
</main>
<script>
(function(){
  'use strict';
  var B = window.dshDesktop;
  window.B = B;
  var el = document.getElementById('steps');
  function addLine(cls, text){
    var d = document.createElement('div');
    d.className = cls; d.textContent = text;
    el.appendChild(d);
    while (el.children.length > 10) el.removeChild(el.firstChild);
  }
  function listen(name, cb){
    try {
      window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: name, target: { kind: 'Any' },
        handler: window.__TAURI_INTERNALS__.transformCallback(cb)
      }).catch(function(){});
    } catch (e) {}
  }
  var NAMES = { repair:'自愈检查', sync:'伴随插件同步', patches:'运行时补丁', preflight:'就绪预检',
                'sidecar-boot':'启动链', spawn:'内核拉起' };
  listen('boot-step', function(ev){
    addLine(ev.ok ? 'ok' : 'fail', (NAMES[ev.name] || ev.name) + ' ' + (ev.ms||0) + 'ms' + (ev.ok ? '' : '：' + (ev.error||'失败')));
    if (!ev.ok) document.getElementById('title').textContent = '启动受阻';
  });
  listen('kernel-fail', function(ev){
    document.getElementById('title').textContent = '启动失败';
    document.getElementById('err').textContent = String(ev.reason || '');
  });
  listen('pet-state', function(){});
})();
</script>
</body></html>
"#;

/// 恢复页：崩溃环 / 启动失败后的用户出口（重载 / 重启 / 日志）。
pub const RECOVERY_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>DSH Desktop — 恢复</title>
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;background:#0b1220;color:#d7dde4;
    display:flex;flex-direction:column;user-select:none}
  #bar{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;
    background:rgba(24,30,38,.92);border-bottom:1px solid #232b36}
  #bar .logo{width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#ff6b6b,#f5c451)}
  #bar .t{font-weight:600;pointer-events:none}
  #bar .sp{flex:1}
  #bar button{width:44px;height:36px;border:0;background:transparent;color:#d7dde4;font-size:15px;cursor:pointer}
  #bar button:hover{background:#2a3341}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
  h1{font-size:18px}
  #why{max-width:560px;color:#9fb0c0;font-size:13px;white-space:pre-wrap;text-align:center}
  .btns{display:flex;gap:12px;margin-top:8px}
  .btns button{padding:9px 22px;border-radius:8px;border:1px solid #32405280;background:#1a222c;
    color:#d7dde4;font-size:14px;cursor:pointer}
  .btns button:hover{background:#243040}
  .btns button.primary{background:#2b4a8f;border-color:#3a5fbf}
</style></head>
<body>
<div id="bar" data-tauri-drag-region>
  <span class="logo"></span><span class="t">DSH Desktop</span><span class="sp"></span>
  <button onclick="B&&B.windowControls.close()">&#x2715;</button>
</div>
<main>
  <h1>内核服务出现问题</h1>
  <div id="why">正在读取状态…</div>
  <div class="btns">
    <button class="primary" onclick="doRestart()">重启内核</button>
    <button onclick="doReload()">重新加载</button>
    <button onclick="doLogs()">打开日志</button>
  </div>
</main>
<script>
(function(){
  'use strict';
  var B = window.dshDesktop; window.B = B;
  function refresh(){
    B && B.recovery.getState().then(function(s){
      document.getElementById('why').textContent =
        (s && s.reason ? '原因：' + s.reason + '\n' : '') +
        (s && s.crashes ? '本次累计异常退出：' + s.crashes + ' 次\n' : '') +
        '可尝试重启内核；若反复失败请导出日志反馈。';
    }).catch(function(e){
      document.getElementById('why').textContent = '状态读取失败：' + String(e && e.message || e);
    });
  }
  window.doRestart = function(){ B && B.recovery.restart().then(refresh, refresh); };
  window.doReload  = function(){ B && B.recovery.reload(); };
  window.doLogs    = function(){ B && B.recovery.openLogs(); };
  refresh();
})();
</script>
</body></html>
"#;
