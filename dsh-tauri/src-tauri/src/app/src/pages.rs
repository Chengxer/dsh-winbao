//! 内嵌页面：loading（boot 进度）与 recovery（崩溃恢复）。
//!
//! 均经 preview-server 以 http://127.0.0.1 托管——与内核 Web UI 同 origin 形态，
//! 事件监听与桥调用链路完全一致。自绘标题栏 36px（对齐 Electron BAR_HEIGHT）。

/// 启动加载页：boot 步骤进度 + 内核拉起状态 + 错误展示。
///
/// 沉浸式双主题（对齐 Electron 玻璃标题栏观感）：壳页无内核主题可读，
/// 用 prefers-color-scheme 双档 CSS 变量（亮=内核 light 值 #fff/#0f1115/…，
/// 暗=Electron 同款 #0b1220/#e6ecff/…），色值与 bridge-shim 注入条一致；
/// 左上鲸鱼 = 内核 favicon.svg 同源矢量，fill:currentColor 随主题反色。
pub const LOADING_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>DSH Desktop — 启动中</title>
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  :root{--bg:#ffffff;--fg:#0f1115;--fg2:#61666b;--line:rgba(0,0,0,.10);--hover:rgba(0,0,0,.06);
    --err:#c0392b;--ring-track:#e2e6ec}
  @media (prefers-color-scheme: dark){
    :root{--bg:#0b1220;--fg:#d7dde4;--fg2:#9fb0c0;--line:#232b36;--hover:#2a3341;
      --err:#ff9d9d;--ring-track:#243046}
  }
  body{font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);
    display:flex;flex-direction:column;user-select:none;transition:background-color .25s ease,color .25s ease}
  #bar{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 6px 0 10px;
    color:var(--fg);background:color-mix(in srgb,var(--bg) 74%,transparent);
    backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);
    border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);
    transition:background-color .25s ease,color .25s ease,border-color .25s ease}
  #bar .logo{width:20px;height:20px;fill:currentColor;flex:none}
  #bar .t{font-size:12.5px;font-weight:600;line-height:16px;letter-spacing:.2px;pointer-events:none}
  #bar .sp{flex:1}
  #bar button{width:30px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;
    background:transparent;color:var(--fg);cursor:pointer;padding:0;transition:background .12s,color .12s}
  #bar button:hover{background:var(--hover)}
  #bar button.x:hover{background:#e81123;color:#fff}
  #bar button svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;
    stroke-width:1.1;stroke-linecap:round}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
  .ring{width:44px;height:44px;border-radius:50%;border:3px solid var(--ring-track);border-top-color:#4f7cff;
    animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:17px;font-weight:600}
  #steps{min-width:340px;max-width:520px;font:12.5px/1.9 Consolas,monospace;color:var(--fg2)}
  .ok::before{content:"✓ ";color:#4cc38a}
  .fail::before{content:"✗ ";color:#ff6b6b}
  .run::before{content:"… ";color:#f5c451}
  .err{max-width:520px;color:var(--err);font-size:13px;white-space:pre-wrap}
</style></head>
<body>
<div id="bar" data-tauri-drag-region>
  <svg class="logo" viewBox="0 0 50 50" aria-hidden="true"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"/></svg>
  <span class="t">DSH Desktop</span><span class="sp"></span>
  <button onclick="B&&B.windowControls.minimize()" title="最小化" aria-label="最小化"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7"/></svg></button>
  <button onclick="B&&B.windowControls.close()" class="x" title="关闭" aria-label="关闭"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg></button>
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
///
/// 同 LOADING_HTML 的沉浸式双主题（prefers-color-scheme 双档变量 + 玻璃
/// 标题栏 + 内核同源鲸鱼 logo）。
pub const RECOVERY_HTML: &str = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>DSH Desktop — 恢复</title>
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  :root{--bg:#ffffff;--fg:#0f1115;--fg2:#61666b;--line:rgba(0,0,0,.10);--hover:rgba(0,0,0,.06);
    --btn-bg:#f2f3f5;--btn-line:rgba(0,0,0,.10);--btn-hover:#e8eaee}
  @media (prefers-color-scheme: dark){
    :root{--bg:#0b1220;--fg:#d7dde4;--fg2:#9fb0c0;--line:#232b36;--hover:#2a3341;
      --btn-bg:#1a222c;--btn-line:#32405280;--btn-hover:#243040}
  }
  body{font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);
    display:flex;flex-direction:column;user-select:none;transition:background-color .25s ease,color .25s ease}
  #bar{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 6px 0 10px;
    color:var(--fg);background:color-mix(in srgb,var(--bg) 74%,transparent);
    backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);
    border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);
    transition:background-color .25s ease,color .25s ease,border-color .25s ease}
  #bar .logo{width:20px;height:20px;fill:currentColor;flex:none}
  #bar .t{font-size:12.5px;font-weight:600;line-height:16px;letter-spacing:.2px;pointer-events:none}
  #bar .sp{flex:1}
  #bar button{width:30px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;
    background:transparent;color:var(--fg);cursor:pointer;padding:0;transition:background .12s,color .12s}
  #bar button:hover{background:var(--hover)}
  #bar button.x:hover{background:#e81123;color:#fff}
  #bar button svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;
    stroke-width:1.1;stroke-linecap:round}
  main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
  h1{font-size:18px}
  #why{max-width:560px;color:var(--fg2);font-size:13px;white-space:pre-wrap;text-align:center}
  .btns{display:flex;gap:12px;margin-top:8px}
  .btns button{padding:9px 22px;border-radius:8px;border:1px solid var(--btn-line);background:var(--btn-bg);
    color:var(--fg);font-size:14px;cursor:pointer}
  .btns button:hover{background:var(--btn-hover)}
  .btns button.primary{background:#2b4a8f;border-color:#3a5fbf;color:#fff}
</style></head>
<body>
<div id="bar" data-tauri-drag-region>
  <svg class="logo" viewBox="0 0 50 50" aria-hidden="true"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"/></svg>
  <span class="t">DSH Desktop</span><span class="sp"></span>
  <button onclick="B&&B.windowControls.close()" class="x" title="关闭" aria-label="关闭"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg></button>
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_page_contract_markers() {
        assert!(LOADING_HTML.contains("data-tauri-drag-region"), "PoC-B 标题栏拖拽");
        assert!(LOADING_HTML.contains("'boot-step'"), "boot 步骤事件订阅");
        assert!(LOADING_HTML.contains("'kernel-fail'"), "失败事件订阅");
        assert!(LOADING_HTML.contains("windowControls.minimize"));
        assert!(LOADING_HTML.contains("dshDesktop"), "垫片可用前提下的降级引用");
        // 步骤名映射对齐 data-flow.md §3 boot 时序。
        for (key, label) in [("repair", "自愈"), ("sync", "同步"), ("patches", "补丁"), ("preflight", "预检")] {
            assert!(LOADING_HTML.contains(key), "缺少步骤 {key}");
            assert!(LOADING_HTML.contains(label), "缺少步骤中文标签 {label}");
        }
    }

    #[test]
    fn recovery_page_contract_markers() {
        assert!(RECOVERY_HTML.contains("data-tauri-drag-region"));
        for (btn, fn_name) in [("doRestart", "restart"), ("doReload", "reload"), ("doLogs", "openLogs")] {
            assert!(RECOVERY_HTML.contains(btn), "缺按钮 {btn}");
            assert!(RECOVERY_HTML.contains(&format!("recovery.{fn_name}")), "缺 recovery.{fn_name} 契约调用");
        }
        assert!(RECOVERY_HTML.contains("crashes"), "展示崩溃计数");
    }

    /// 沉浸式双主题：壳页无内核主题可读，用 prefers-color-scheme 双档 CSS
    /// 变量（亮=内核 light 值，暗=Electron 同款深色），玻璃标题栏观感对齐
    /// Electron CHROME_CSS（color-mix 半透明 + backdrop-filter）。
    #[test]
    fn shell_pages_immersive_theme() {
        for (name, page) in [("loading", LOADING_HTML), ("recovery", RECOVERY_HTML)] {
            assert!(page.contains("color-scheme"), "{name} 缺双主题声明");
            assert!(page.contains("prefers-color-scheme: dark"), "{name} 缺系统偏好切档");
            for marker in ["color-mix", "backdrop-filter", "--bg:", "--fg:", "transition:background-color"] {
                assert!(page.contains(marker), "{name} 主题化缺 {marker}");
            }
        }
    }

    /// 鲸鱼 logo：内核 favicon.svg 同源矢量（viewBox 0 0 50 50、path 首段
    /// M48.8354 是指纹），fill:currentColor 随主题反色；替换旧渐变方块。
    #[test]
    fn shell_pages_whale_logo() {
        for (name, page) in [("loading", LOADING_HTML), ("recovery", RECOVERY_HTML)] {
            assert!(page.contains("M48.8354"), "{name} 缺鲸鱼 path（内核 favicon 同源）");
            assert!(page.contains(r#"viewBox="0 0 50 50""#), "{name} 鲸鱼 viewBox 缺失");
            assert!(page.contains("fill:currentColor"), "{name} 鲸鱼须随主题反色");
            assert!(!page.contains("linear-gradient"), "{name} 渐变方块 logo 应被鲸鱼替换");
        }
    }
}
