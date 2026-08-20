//! 多窗管理：主窗（loading→内核页）、浮窗（分屏）、宠物窗（透明）、赞助窗。
//!
//! 参数对齐 Electron 版（main.js createFloatWindow/createPetWindow/createSponsorWindow）：
//! - 浮窗 900×640（min 480×360），同会话复用、上限 4 个；
//! - 宠物窗 160×160 透明置顶、跳过任务栏、不可调尺寸、位置记忆；
//! - 赞助窗原生边框小窗内嵌静态 HTML（二维码 base64）。
//!
//! 所有窗都注入 bridge 垫片（initialization_script 对每次导航生效）；
//! 浮窗/宠物窗追加模式注入脚本（`__DSH_FLOAT__` / `__DSH_PET__`，契约 bridge-api.md §5）。

use std::sync::atomic::{AtomicU64, Ordering};

use bridge::{BridgeError, BRIDGE_SHIM_JS};
use tauri::{Emitter, Manager, WebviewUrl};

pub const FLOAT_MAX: usize = 4;
pub const PET_W: f64 = 160.0;
pub const PET_H: f64 = 160.0;

/// 浮窗会话注册表（label 前缀 float-）。
pub fn float_label(session_id: &str) -> String {
    format!("float-{}", sanitize_label(session_id))
}

/// label 只允许安全字符（防 label 注入）。
fn sanitize_label(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(64).collect()
}

/// 主窗：decorations:false + 导航围栏 + 垫片。初始加载 loading 页。
#[allow(clippy::too_many_arguments)]
pub fn create_main_window(
    app: &tauri::AppHandle,
    loading_url: &str,
    saved: Option<(i32, i32, f64, f64, bool)>,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    let mut b = tauri::webview::WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(loading_url.parse::<tauri::Url>().expect("loading url")),
    )
    .title("DSH Desktop")
    .min_inner_size(980.0, 600.0)
    .decorations(false)
    // 显式声明（用户实测「不能调整窗口大小」）：undecorated 窗口默认应可
    // 拖边缩放，显式置 true 防构建配置漂移；与 Electron frame:false +
    // resizable:true 行为对齐。
    .resizable(true)
    .initialization_script(BRIDGE_SHIM_JS)
    .on_navigation(|url| {
        // 导航围栏：仅 127.0.0.1（内核/内嵌页）与 tauri 内部协议。
        let s = url.as_str();
        s.starts_with("http://127.0.0.1") || s.starts_with("tauri://") || s.starts_with("http://tauri.localhost")
    });
    if let Some((x, y, w, h, maxed)) = saved {
        b = b.position(x as f64, y as f64).inner_size(w, h);
        if maxed {
            b = b.maximized(true);
        }
    } else {
        b = b.inner_size(1280.0, 820.0);
    }
    let win = b.build()?;
    let handle = app.clone();
    let _g = win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Resized(_)) {
            if let Some(w) = handle.get_webview_window("main") {
                if let Ok(max) = w.is_maximized() {
                    let _ = handle.emit("window-maximized", max);
                }
            }
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            // 0.5.0 语义：关窗（系统 Alt+F4 / 任务栏关闭 / WM_CLOSE）= 隐藏主窗
            // 留托盘，后台常驻、内核继续跑；真退出（杀树）走托盘「退出」。
            // prevent_close 必须显式调：不拦则窗口走默认销毁（0.1.0 为此曾
            // 在此直接退进程——Review#2 实测默认销毁会留无窗僵尸）。
            api.prevent_close();
            if let Some(w) = handle.get_webview_window("main") {
                hide_main_to_tray(&w);
            }
        }
    });
    Ok(win)
}

/// 关窗→托盘（0.5.0）：保存窗口状态后隐藏主窗。进程与内核继续运行，
/// 经托盘「显示主窗口」/ 双击图标（第二实例聚焦）唤回。
/// 唯一真退出入口 = 托盘「退出」（supervisor.shutdown + exit，Job Object 杀树）。
pub fn hide_main_to_tray(win: &tauri::WebviewWindow) {
    let app = win.app_handle();
    // 隐藏前保存窗口状态（settings.json windowState）——此后可能经强杀路径
    // 退出，CloseRequested 不再有触发机会。
    if let (Some(w), Some(state)) = (app.get_webview_window("main"), app.try_state::<crate::AppState>()) {
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            let maxed = w.is_maximized().unwrap_or(false);
            let _ = crate::save_window_state(&state, (pos.x, pos.y, size.width as f64, size.height as f64, maxed));
        }
    }
    let _ = win.hide();
}

/// 浮窗（分屏）：同会话复用 + 上限 FLOAT_MAX。
pub fn open_float_window(app: &tauri::AppHandle, kernel_url: &str, session_id: &str) -> Result<serde_json::Value, BridgeError> {
    let label = float_label(session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "ok": true, "reused": true }));
    }
    let floats = app.webview_windows().keys().filter(|k| k.starts_with("float-")).count();
    if floats >= FLOAT_MAX {
        return Err(BridgeError::new("E_NOT_FOUND", format!("浮窗已达上限 {FLOAT_MAX}")));
    }
    let url = kernel_url.trim_end_matches('/').to_string();
    let mode_script = format!(
        r#"(function(){{ try{{ window.__DSH_FLOAT__ = Object.freeze({{ sessionId: {session_id_json} }}); }}catch(e){{}} }})();"#,
        session_id_json = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".into())
    );
    let preset_script = float_session_preset(session_id);
    let win = tauri::webview::WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(parse_url(&url)?),
    )
    .title("DSH 会话")
    .inner_size(900.0, 640.0)
    .min_inner_size(480.0, 360.0)
    .decorations(false)
    .initialization_script(BRIDGE_SHIM_JS)
    .initialization_script(&mode_script)
    .initialization_script(&preset_script)
    .initialization_script(FLOAT_BAR_SCRIPT)
    .on_navigation(|url| url.as_str().starts_with("http://127.0.0.1"))
    .build()
    .map_err(|e| BridgeError::internal(format!("浮窗创建: {e}")))?;
    let _ = win.show();
    Ok(serde_json::json!({ "ok": true }))
}

/// URL 解析 helper。
fn parse_url(s: &str) -> Result<tauri::Url, BridgeError> {
    s.parse::<tauri::Url>().map_err(|e| BridgeError::internal(format!("url: {e}")))
}

/// 浮窗 localStorage 预置（Electron preload 语义：比 sessions.open() 可靠）。
fn float_session_preset(session_id: &str) -> String {
    format!(
        r#"(function(){{
  try {{
    var sid = {sid};
    var key = 'dsh.sessions.current';
    var raw = localStorage.getItem(key);
    var parsed = raw ? JSON.parse(raw) : {{}};
    if (parsed && typeof parsed === 'object') {{
      parsed.sessionId = String(sid);
      delete parsed.subagentAddress;
      localStorage.setItem(key, JSON.stringify(parsed));
    }}
  }} catch (e) {{}}
}})();"#,
        sid = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".into())
    )
}

/// 浮窗 24px 纯拖拽条 + 关闭按钮（DOMContentLoaded 注入，避免 head 未就绪）。
const FLOAT_BAR_SCRIPT: &str = r#"
(function(){
  function inject(){
    if (document.getElementById('__dsh_desktop_floatbar__')) return;
    var bar = document.createElement('div');
    bar.id = '__dsh_desktop_floatbar__';
    bar.setAttribute('data-tauri-drag-region', '');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:24px;z-index:2147483647;' +
      'display:flex;align-items:center;background:rgba(15,20,28,.92);border-bottom:1px solid #232b36;' +
      'font:12px "Segoe UI","Microsoft YaHei",sans-serif;color:#9fb0c0;user-select:none;pointer-events:auto';
    var t = document.createElement('span');
    t.textContent = 'DSH 会话'; t.style.cssText = 'padding:0 10px;pointer-events:none';
    var sp = document.createElement('span'); sp.style.flex = '1';
    var btn = document.createElement('button');
    btn.textContent = '\u2715';
    btn.style.cssText = 'width:36px;height:24px;border:0;background:transparent;color:#d7dde4;cursor:pointer;font-size:12px';
    btn.onmouseenter = function(){ btn.style.background = '#c0392b'; };
    btn.onmouseleave = function(){ btn.style.background = 'transparent'; };
    btn.onclick = function(){ try { window.dshDesktop.floatWindow.close(); } catch (e) {} };
    bar.appendChild(t); bar.appendChild(sp); bar.appendChild(btn);
    document.body.style.paddingTop = '24px';
    (document.body || document.documentElement).appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
"#;

static PET_SEQ: AtomicU64 = AtomicU64::new(0);

/// 宠物窗：透明置顶小窗。WebView2 透明窗为已知风险点（roadmap R2）——
/// 创建失败时返回错误（调用方降级提示），不拖垮主流程。
pub fn open_pet_window(app: &tauri::AppHandle, kernel_url: &str) -> Result<serde_json::Value, BridgeError> {
    if let Some(existing) = app.get_webview_window("pet") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "ok": true, "open": true, "reused": true }));
    }
    let url = kernel_url.trim_end_matches('/').to_string();
    let _seq = PET_SEQ.fetch_add(1, Ordering::Relaxed);
    let win = tauri::webview::WebviewWindowBuilder::new(
        app,
        "pet",
        WebviewUrl::External(parse_url(&url)?),
    )
    .title("DSH 宠物")
    .inner_size(PET_W, PET_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .shadow(false)
    .initialization_script(BRIDGE_SHIM_JS)
    .initialization_script(PET_MODE_SCRIPT)
    .on_navigation(|url| url.as_str().starts_with("http://127.0.0.1"))
    .build()
    .map_err(|e| BridgeError::internal(format!("宠物窗创建（WebView2 透明窗已知风险）: {e}")))?;
    let _ = win.show();
    let _ = app.emit("pet-state", serde_json::json!({ "open": true }));
    Ok(serde_json::json!({ "ok": true, "open": true }))
}

/// 宠物窗模式注入：__DSH_PET__ + 隐藏非宠物节点 + 透明背景（DOMContentLoaded）。
const PET_MODE_SCRIPT: &str = r#"
(function(){
  try { window.__DSH_PET__ = {}; } catch (e) {}
  function inject(){
    var s = document.createElement('style');
    s.textContent = 'html,body{background:transparent!important;overflow:hidden!important}body>:not(#harness-pet-root){display:none!important}';
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
"#;

/// 赞助小窗：原生边框 + 内嵌静态 HTML（两码 base64）。
pub fn open_sponsor_window(app: &tauri::AppHandle, qr_alipay: &str, qr_wechat: &str) -> Result<serde_json::Value, BridgeError> {
    if let Some(existing) = app.get_webview_window("sponsor") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "ok": true, "reused": true }));
    }
    let html = sponsor_html(qr_alipay, qr_wechat);
    let url = tauri::WebviewUrl::App("sponsor.html".into());
    // 写入 ui/（frontendDist）下供 App URL 加载；失败降级 data URL。
    let _ = url;
    let data_url = format!("data:text/html;charset=utf-8,{}", urlencode(&html));
    let win = tauri::webview::WebviewWindowBuilder::new(
        app,
        "sponsor",
        WebviewUrl::External(parse_url(&data_url)?),
    )
    .title("请作者喝咖啡")
    // 500x620：二维码 220px（Electron 基准 180px 放大 ~22%，扫码更易）+ 标题/留白。
    .inner_size(500.0, 620.0)
    .resizable(false)
    .maximizable(false)
    .build()
    .map_err(|e| BridgeError::internal(format!("赞助窗创建: {e}")))?;
    let _ = win.show();
    Ok(serde_json::json!({ "ok": true }))
}

pub(crate) fn sponsor_html(alipay: &str, wechat: &str) -> String {
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请作者喝咖啡</title>
<style>*{{box-sizing:border-box;margin:0}}body{{background:#0b1220;color:#e6ecff;
font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;height:100vh;user-select:none}}
.sub{{font-size:12px;color:#8b9ac4;line-height:18px;padding:10px 14px}}
.codes{{flex:1;display:flex;gap:16px;justify-content:center;align-items:center}}
.codes img{{width:220px;height:220px;border-radius:10px;background:#fff;padding:6px}}
.cap{{text-align:center;font-size:12px;color:#8b9ac4;padding-bottom:6px}}</style></head>
<body><div class="sub">如果这个工具帮到了你，可以请作者喝杯咖啡 ☕ 支持持续更新。</div>
<div class="codes">
<div><img src="{alipay}" alt="支付宝"><div class="cap">支付宝</div></div>
<div><img src="{wechat}" alt="微信"><div class="cap">微信</div></div>
</div></body></html>"#
    )
}

/// 最小 URL 编码（data URL 用）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_label_sanitizes_hostile_input() {
        assert_eq!(float_label("abc123"), "float-abc123");
        // 注入字符被白名单替换。
        assert_eq!(float_label("a\" onclick=x"), "float-a__onclick_x");
        // 超长截断到 64。
        let long = "x".repeat(200);
        assert_eq!(float_label(&long).len(), "float-".len() + 64);
        // 中文 → 下划线（label 安全字符集）。
        assert_eq!(float_label("会话"), "float-__");
    }

    #[test]
    fn float_preset_embeds_session_and_clears_subagent() {
        let js = float_session_preset("sess-42");
        assert!(js.contains("\"sess-42\""), "sessionId 应以 JSON 字符串嵌入: {js}");
        assert!(js.contains("dsh.sessions.current"));
        assert!(js.contains("delete parsed.subagentAddress"), "对齐 Electron 语义（清 subagentAddress）");
        // 引号安全：恶意 id 不逃逸字符串（serde_json 会转义双引号）。
        let evil = float_session_preset("a\";alert(1);//");
        assert!(evil.contains("a\\\";alert(1);//"), "应 JSON 转义: {evil}");
    }

    #[test]
    fn pet_and_float_mode_scripts_present() {
        assert!(PET_MODE_SCRIPT.contains("__DSH_PET__"));
        assert!(PET_MODE_SCRIPT.contains("harness-pet-root"), "对齐 Electron：只保留宠物根节点");
        assert!(PET_MODE_SCRIPT.contains("background:transparent"));
        assert!(FLOAT_BAR_SCRIPT.contains("__dsh_desktop_floatbar__"));
        assert!(FLOAT_BAR_SCRIPT.contains("floatWindow.close"));
    }

    #[test]
    fn urlencode_keeps_safe_and_escapes_rest() {
        assert_eq!(urlencode("AZaz09-_.~"), "AZaz09-_.~");
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
        assert_eq!(urlencode("中"), "%E4%B8%AD");
    }

    #[test]
    fn parse_url_accepts_local_rejects_junk() {
        assert!(parse_url("http://127.0.0.1:51731/").is_ok());
        assert!(parse_url("not a url").is_err());
        // scheme 不设限（围栏在 on_navigation 层）；只测形态拒绝。
    }

    /// 主窗 CloseRequested 语义（0.5.0）：拦截默认销毁 → 隐藏留托盘。
    /// 源码形态断言（WebviewWindow 无法在单测构造），防回退到 exit(0)
    /// （0.1.0 语义：关窗即退）或漏 prevent_close（无窗僵尸进程）。
    #[test]
    fn close_requested_hides_instead_of_exit_shape() {
        let src = include_str!("windows.rs");
        let seg = src
            .split("CloseRequested")
            .nth(1)
            .and_then(|s| s.split("/// 浮窗").next())
            .expect("CloseRequested 处理段");
        assert!(seg.contains("prevent_close"), "必须拦截默认窗口销毁: {seg}");
        assert!(seg.contains("hide_main_to_tray"), "关窗 = 隐藏留托盘（非退出）: {seg}");
        assert!(!seg.contains("exit(0)"), "关窗不得直接退出进程（真退出走托盘）: {seg}");
    }

    /// hide_main_to_tray 先存状态再隐藏（隐藏后可能经强杀路径退出，
    /// CloseRequested 不再有触发机会）。
    #[test]
    fn hide_main_to_tray_saves_state_before_hide_shape() {
        let src = include_str!("windows.rs");
        let seg = src
            .split("pub fn hide_main_to_tray")
            .nth(1)
            .and_then(|s| s.split("// 浮窗").next())
            .expect("hide_main_to_tray 函数体");
        let save_pos = seg.find("save_window_state").expect("必须保存窗口状态");
        let hide_pos = seg.find("win.hide()").expect("必须隐藏窗口");
        assert!(save_pos < hide_pos, "先存状态后隐藏（强杀路径兜底）: {seg}");
    }
}
