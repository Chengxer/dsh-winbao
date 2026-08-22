//! 多窗管理：主窗（loading→内核页）、浮窗（分屏）、宠物窗（透明）、赞助窗。
//!
//! 参数对齐 Electron 版（main.js createFloatWindow/createPetWindow/createSponsorWindow）：
//! - 浮窗 900×640（min 480×360），同会话复用、上限 4 个；
//! - 宠物窗 160×160 透明置顶、跳过任务栏、不可调尺寸、位置记忆；
//! - 赞助窗原生边框小窗：内嵌资产占位页 + initialization_script 注入
//!   （零 file://、零本地端口、零磁盘写入——v0.5.0 安装版三联症终修）。
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
        // url 解析失败走既有 Result 通道（上层 setup `?`），不在主窗创建
        // 路径留 panic——「客户端必须能打开」原则。
        WebviewUrl::External(
            loading_url
                .parse::<tauri::Url>()
                .map_err(tauri::Error::InvalidUrl)?,
        ),
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
    win.on_window_event(move |e| {
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
        return Err(BridgeError::not_found(format!("浮窗已达上限 {FLOAT_MAX}")));
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
    let b = tauri::webview::WebviewWindowBuilder::new(
        app,
        "pet",
        WebviewUrl::External(parse_url(&url)?),
    )
    .title("DSH 宠物")
    .inner_size(PET_W, PET_H)
    .decorations(false);
    // 透明窗口需要平台特定支持：Windows 直接开透明；macOS 上 transparent()
    // 方法仅 macos-private-api feature 才存在（未启用，调用即编译失败），
    // Linux 虽有该方法但需 webkit 特定配置——非 Windows 统一不调用，
    // 默认即不透明（宠物窗有实底色，视觉降级可接受）。
    #[cfg(target_os = "windows")]
    let b = b.transparent(true);
    let b = b
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
    let _ = b.show();
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

/// 赞助小窗（v0.5.0 用户实测「打开卡死 + 无图 + 关不掉」第五轮终修）。
///
/// 【为什么前四轮全挂】旧链路逐条依赖「等待型/路径型」外部条件，在 NSIS
/// 安装版真实环境（AV/SmartScreen 扫描新 WebView2 renderer、用户名含
/// 中文/空格、%TEMP% 被实时扫描）逐条断裂：
/// 1. preview-server 前缀推导：端口存活 + URL 拼接，降级 data: 时直接产坏 URL；
/// 2. data: 顶层导航：WebView2（Chromium 内核）禁止顶层导航到 data: URL——白窗；
/// 3. file:// 直载 %TEMP%：路径编码（非 ASCII 用户名）+ AV 对 %TEMP% 新写入
///    html 的实时扫描锁定 → 导航失败白窗（用户感知「无图」）；
/// 4. 白窗后用户点 X，而 command 在 IPC 上下文同步 build() 等 event loop、
///    event loop 又被新窗口创建（被 AV 拖慢数十秒）占住 → 全应用无响应。
///
/// 【终修】三零依赖：零 file://、零本地端口、零磁盘写入——
/// - URL 用 `WebviewUrl::App`（Windows 实际 `http://tauri.localhost/index.html`，
///   Tauri 内嵌资产，编译期打进 exe，与安装路径/编码/杀软全解耦）；
/// - 页面内容经 `initialization_script` 注入（WebView2 官方
///   AddScriptToExecuteOnDocumentCreated 通道，每次导航必执行、无 eval 时序
///   竞争），图片以 data URI 内嵌——img data URI 在 http 上下文是 Chromium
///   最成熟路径（此前误诊「不稳定」的实为顶层 data: 导航被禁）；
/// - 窗口创建挪到独立线程：IPC 线程零窗口 API 调用，event loop 即使被
///   AV 拖慢也只是延迟弹窗，绝不反卡整个应用；
/// - 不注册任何 on_window_event：原生标题栏 X = 默认 destroy（无回调死锁面）。
pub fn open_sponsor_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>, qr_alipay: &str, qr_wechat: &str) -> Result<serde_json::Value, BridgeError> {
    if let Some(existing) = app.get_webview_window("sponsor") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "ok": true, "reused": true }));
    }
    // 纯字符串组装（无窗口 API、无 IO）——IPC 线程只做这件事。
    let script = sponsor_inject_script(qr_alipay, qr_wechat);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("sponsor-window".into())
        .spawn(move || {
            // 双击竞态复检：两个线程同时过了外层检查时，后来者只聚焦。
            if let Some(existing) = handle.get_webview_window("sponsor") {
                let _ = existing.show();
                let _ = existing.set_focus();
                return;
            }
            match build_sponsor_window(&handle, &script) {
                Ok(win) => {
                    let _ = win.show();
                }
                Err(e) => eprintln!("[sponsor] 赞助窗创建失败（不影响主窗）: {e}"),
            }
        })
        .map_err(|e| BridgeError::internal(format!("赞助窗线程启动: {e}")))?;
    Ok(serde_json::json!({ "ok": true, "async": true }))
}

/// 赞助窗构造（独立函数供集成测试复用——mock runtime 下走与生产完全
/// 同款的 builder 路径，验证窗口属性与销毁）。泛型 R 兼容 Wry/MockRuntime。
pub fn build_sponsor_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    inject_script: &str,
) -> Result<tauri::WebviewWindow<R>, tauri::Error> {
    tauri::webview::WebviewWindowBuilder::new(
        app,
        "sponsor",
        WebviewUrl::App("index.html".into()), // 内嵌资产占位页（ui/index.html，纯静态无脚本）
    )
    .title("请作者喝咖啡")
    .inner_size(500.0, 620.0)
    .resizable(false)
    .maximizable(false)
    .closable(true)
    .decorations(true) // 原生标题栏（含 X 关闭钮），默认关闭 = destroy
    .initialization_script(inject_script)
    .build()
}

/// 赞助页注入脚本：initialization_script 通道执行，DOM 就绪后整体替换
/// head（样式）与 body（内容）。脚本在导航前文档（about:blank）也会执行
/// 一次，改了即弃；真实导航后再次注入并应用——天然幂等。
/// pub 供集成测试（tests/sponsor_window.rs）以生产同款产物验证。
pub fn sponsor_inject_script(alipay_uri: &str, wechat_uri: &str) -> String {
    // 空 URI = 安装包 assets 缺失/被安全软件拦截（commands 层已打日志）：
    // 不开无图窗——占位诊断块自证缺什么，窗口仍可正常关闭。
    let qr = |uri: &str, alt: &str| {
        if uri.is_empty() {
            format!(r#"<div class="missing">【{alt}】收款码缺失<br>安装包 assets/sponsor/ 不完整<br>或被安全软件拦截，详见应用日志</div>"#)
        } else {
            format!(r#"<img src="{uri}" alt="{alt}">"#)
        }
    };
    let css = r#"*{box-sizing:border-box;margin:0}body{background:#0b1220;color:#e6ecff;font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;height:100vh;user-select:none}
.sub{font-size:12px;color:#8b9ac4;line-height:18px;padding:10px 14px}
.codes{flex:1;display:flex;gap:16px;justify-content:center;align-items:center}
.codes img{width:220px;height:220px;border-radius:10px;background:#fff;padding:6px}
.cap{text-align:center;font-size:12px;color:#8b9ac4;padding-bottom:6px}
.missing{width:220px;height:220px;border-radius:10px;border:1px dashed #3a4656;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;color:#8b9ac4;line-height:20px;padding:12px}"#;
    let body = format!(
        r#"<div class="sub">如果这个工具帮到了你，可以请作者喝杯咖啡 ☕ 支持持续更新。</div>
<div class="codes">
<div>{alipay}<div class="cap">支付宝</div></div>
<div>{wechat}<div class="cap">微信</div></div>
</div>"#,
        alipay = qr(alipay_uri, "支付宝"),
        wechat = qr(wechat_uri, "微信"),
    );
    // serde_json 字符串字面量转义（项目既有模式，见 float_session_preset）。
    format!(
        r#"(function(){{
  var CSS = {css};
  var BODY = {body};
  function apply(){{
    try {{
      // CSS 文本必须包 <style> 再入 head——裸文本只是文本节点，永远不成
      // 样式表（R2 实测：零样式渲染，二维码按 1260px 原图挤进 501×620 窗）。
      if (document.head) document.head.innerHTML = '<style>' + CSS + '</style>';
      if (document.body) document.body.innerHTML = BODY;
      document.title = '请作者喝咖啡';
    }} catch (e) {{}}
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
}})();"#,
        css = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".into()),
        body = serde_json::to_string(&body).unwrap_or_else(|_| "\"\"".into()),
    )
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

    /// 赞助窗第五轮终修的形态锚点（v0.5.0「卡死 + 无图 + 关不掉」根治）：
    /// - 必须加载 Tauri 内嵌资产（WebviewUrl::App），源码不得再出现 file:///
    ///   与 %TEMP% 落盘（安装版 AV/路径编码断裂面）；
    /// - 窗口创建必须在独立线程（IPC 线程零窗口 API——反卡整个应用的根因）；
    /// - 不得注册 on_window_event / CloseRequested（回调内 destroy 死锁面）。
    #[test]
    fn sponsor_window_embedded_assets_threaded_closable_shape() {
        let src = include_str!("windows.rs");
        let seg = src
            .split("pub fn open_sponsor_window")
            .nth(1)
            .and_then(|s| s.split("pub fn build_sponsor_window").next())
            .expect("open_sponsor_window 函数体");
        assert!(!seg.contains("file:///"), "不得再依赖 file://（安装版断裂面）: {seg}");
        assert!(!seg.contains("dsh-sponsor"), "不得再落盘 %TEMP%: {seg}");
        assert!(seg.contains("std::thread::Builder"), "窗口创建必须移出 IPC 线程: {seg}");
        assert!(!seg.contains("on_window_event"), "赞助窗不得挂窗口事件回调（死锁面）: {seg}");
        assert!(!seg.contains("CloseRequested"), "赞助窗不走 CloseRequested 拦截: {seg}");
        let build_seg = src
            .split("pub fn build_sponsor_window")
            .nth(1)
            .and_then(|s| s.split("pub fn sponsor_inject_script").next())
            .expect("build_sponsor_window 函数体");
        assert!(build_seg.contains("WebviewUrl::App"), "必须加载内嵌资产（tauri://localhost，与安装路径解耦）: {build_seg}");
        assert!(build_seg.contains("decorations(true)"), "原生标题栏（X 关闭钮）: {build_seg}");
        assert!(build_seg.contains("closable(true)"), "窗口必须可关闭: {build_seg}");
        assert!(build_seg.contains("initialization_script"), "内容必须经 initialization_script 注入: {build_seg}");
        assert!(!build_seg.contains("WebviewUrl::External"), "不得用 External URL: {build_seg}");
    }

    /// 注入脚本产物直验：data URI 双图内嵌、head/body 整体替换 + DOMContentLoaded
    /// 兜底、标题设置；零 file://、零 127.0.0.1 请求、零 fetch/XHR（三零依赖）。
    #[test]
    fn sponsor_inject_script_embeds_qrs_and_replaces_document() {
        let s = sponsor_inject_script(
            "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==",
            "data:image/png;base64,iVBORw0KGgo=",
        );
        assert!(s.contains(r#"src=\"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==\"#)
            || s.contains(r#"src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="#),
            "支付宝 data URI 必须内嵌: {s}");
        assert!(s.contains("data:image/png;base64,iVBORw0KGgo="), "微信 data URI 必须内嵌: {s}");
        assert!(s.contains("document.head.innerHTML"), "样式经 head 整体替换: {s}");
        // R2 实测回归锚点：CSS 必须包 <style> 入 head，裸文本永远不生效。
        assert!(s.contains("'<' + 'style'") || s.contains("'<style>'") || s.contains("\\u003cstyle"),
            "CSS 须经 <style> 包裹注入（裸文本只是文本节点，零样式渲染实锄）: {s}");
        assert!(s.contains("document.body.innerHTML"), "内容经 body 整体替换: {s}");
        assert!(s.contains("DOMContentLoaded"), "loading 态必须等 DOM 就绪: {s}");
        assert!(s.contains("document.title"), "必须设置窗口标题: {s}");
        assert!(!s.contains("file://"), "注入内容不得引用 file://: {s}");
        assert!(!s.contains("127.0.0.1"), "注入内容不得依赖本地端口: {s}");
        assert!(!s.to_ascii_lowercase().contains("fetch("), "不得发网络请求: {s}");
        assert!(!s.to_ascii_lowercase().contains("xmlhttprequest"), "不得用 XHR: {s}");
        // CSS/HTML 以 JSON 字符串字面量嵌入（引号已转义，JS 语法有效）。
        assert!(s.contains("var CSS = \""), "CSS 必须是转义后的 JS 字符串: {s}");
        assert!(s.contains("var BODY = \""), "BODY 必须是转义后的 JS 字符串: {s}");
        assert!(s.contains(".codes img{width:220px"), "图片 220px 对齐 Electron 版: {s}");
    }

    /// 空收款码（安装包 assets 缺失/被拦截）→ 诊断占位块，绝不开「无图空窗」。
    #[test]
    fn sponsor_inject_script_missing_qr_shows_diagnostic() {
        let s = sponsor_inject_script("", "data:image/png;base64,iVBORw0KGgo=");
        assert!(s.contains("missing"), "缺失占位块: {s}");
        assert!(s.contains("收款码缺失"), "诊断文案必须自证缺什么: {s}");
        assert!(!s.contains("src=\\\"\\\""), "不得出现空 src（破图图标）: {s}");
        // 单侧缺失也适用：另一侧正常图仍渲染。
        assert!(s.contains("data:image/png;base64,iVBORw0KGgo="), "存在的码仍内嵌: {s}");
        let both = sponsor_inject_script("", "");
        assert!(both.contains("支付宝") && both.contains("微信"), "标题文字仍在: {both}");
    }
}
