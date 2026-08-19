//! # dsh-tauri-app —— 装配根（Phase 0：PoC-A/B 载体）
//!
//! 只做接线（#121「main 仅接线」原则）：窗口壳 + 桥 command 注册 + PoC 页托管。
//! 业务逻辑全部在 crates/。
//!
//! 运行形态：
//! - 默认：preview-server 托管 PoC 页（http://127.0.0.1:<port>/poc.html），
//!   主窗 `decorations:false` + 注入 `bridge::BRIDGE_SHIM_JS`
//!   → **PoC-A（远程页桥注入）+ PoC-B（自绘标题栏）**；
//! - `DSH_KERNEL_URL=http://127.0.0.1:<port>`：主窗直连内核
//!   （配合 `cargo run -p poc-sidecar-spawn` 拉起的实例）。
//!
//! Phase 0 已注册的 command 见各函数文档；未注册的契约 command（插件管理/诊断/
//! 备份等）由垫片统一报「command not found」——阶段划分见 contracts/ipc-commands.md。

mod poc_page;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use bridge::{BridgeError, BRIDGE_SHIM_JS};
use tauri::{Emitter, Manager, WebviewUrl};

/// tauri::Error → BridgeError（bridge crate 不依赖 tauri，转换放装配层）。
fn terr(e: tauri::Error) -> BridgeError {
    BridgeError::internal(e.to_string())
}

/// 桥侧运行时状态（Phase 1 移入专门 crate；Phase 0 先做计数观测）。
#[derive(Default)]
struct BridgeState {
    heartbeats: AtomicU32,
    page_errors: AtomicU32,
    current_session: Mutex<Option<String>>,
}

pub fn run() {
    tauri::Builder::default()
        .manage(BridgeState::default())
        .setup(|app| {
            setup_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_init, window_control, menu_action, copy_text, open_external, page_error,
            renderer_heartbeat, current_session, restart_service, echo_json,
        ])
        .run(tauri::generate_context!())
        .expect("tauri 运行失败");
}

/// 创建主窗：自绘标题栏（decorations:false）+ 垫片注入（PoC-A + PoC-B）。
fn setup_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let url = resolve_page_url()?;
    println!("[app] 主窗加载：{url}");

    let win = tauri::webview::WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse::<tauri::Url>()?),
    )
    .title("DSH Desktop")
    .inner_size(1280.0, 820.0)
    .min_inner_size(980.0, 600.0)
    .decorations(false) // PoC-B：自绘标题栏（36px，页面内 data-tauri-drag-region）
    .initialization_script(BRIDGE_SHIM_JS) // PoC-A：远程页垫片注入
    .build()?;

    // 最大化变化 → 桥事件 window-maximized（bridge-api.md §2.2#17）。
    let handle = app.handle().clone();
    let _guard = win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Resized(_)) {
            if let Some(w) = handle.get_webview_window("main") {
                if let Ok(max) = w.is_maximized() {
                    let _ = handle.emit("window-maximized", max);
                }
            }
        }
    });
    Ok(())
}

/// 主窗 URL：`DSH_KERNEL_URL`（仅限 127.0.0.1 origin）优先；否则 PoC 页。
fn resolve_page_url() -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(u) = std::env::var("DSH_KERNEL_URL") {
        if u.starts_with("http://127.0.0.1") || u.starts_with("https://127.0.0.1") {
            return Ok(u);
        }
        return Err(format!("DSH_KERNEL_URL 仅允许 127.0.0.1 origin，得到 {u}").into());
    }
    // PoC 页写临时目录，preview-server 托管：远程 http 页，与内核 Web UI 同形态
    // （IPC 链路验证的逼真度即来自于此）。
    let dir = std::env::temp_dir().join(format!("dsh-tauri-poc-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("poc.html"), poc_page::POC_PAGE_HTML)?;
    let srv = preview_server::PreviewServer::start(&dir)?;
    let url = srv.url("poc.html");
    std::mem::forget(srv); // 进程生命周期托管（Phase 1 做优雅关停）
    Ok(url)
}

// ---------------------------------------------------------------------------
// 桥 command（Phase 0 子集；签名对齐 contracts/ipc-commands.md §2.1）
// ---------------------------------------------------------------------------

/// `chrome:init` → 应用信息（bridge-api.md #1/#2）。同时广播一次余额事件，
/// 供 PoC 页验证「主进程 → 远程页」事件链路（监听须先于本调用注册）。
#[tauri::command]
fn app_init(app: tauri::AppHandle) -> Result<serde_json::Value, BridgeError> {
    let info = serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "phase": 0,
        "shell": "tauri",
        "kernel": "未随 Phase 0 app 拉起（用 cargo run -p poc-sidecar-spawn 验证）",
        "platform": std::env::consts::OS,
    });
    let _ = app.emit("balance-changed", serde_json::json!({ "source": "poc", "ts": now_ms() }));
    Ok(info)
}

/// `chrome:window` → 窗口控制（bridge-api.md §2.2）。
#[tauri::command]
fn window_control(window: tauri::WebviewWindow, action: String) -> Result<serde_json::Value, BridgeError> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(terr)?,
        "toggle-maximize" => {
            let maxed = window.is_maximized().map_err(terr)?;
            if maxed {
                window.unmaximize().map_err(terr)?;
            } else {
                window.maximize().map_err(terr)?;
            }
        }
        "close" => window.close().map_err(terr)?,
        "is-maximized" => {
            return Ok(serde_json::json!(window.is_maximized().map_err(terr)?));
        }
        other => return Err(BridgeError::invalid_arg(format!("未知窗口动作：{other}"))),
    }
    Ok(serde_json::Value::Null)
}

/// `chrome:menu` → 菜单动作（bridge-api.md §2.3）。
/// `check-agent-update` 已裁撤（垫片层拦截 E_CUT_FEATURE；此处兜底）。
#[tauri::command]
fn menu_action(action: String, payload: Option<serde_json::Value>) -> Result<serde_json::Value, BridgeError> {
    match action.as_str() {
        "open-logs" => {
            let dir = shell_core::DshPaths::resolve().logs;
            let _ = std::fs::create_dir_all(&dir);
            open_in_explorer(&dir)?;
            Ok(serde_json::Value::Null)
        }
        "open-browser" => {
            let url = payload
                .and_then(|p| p.get("url").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| "http://127.0.0.1".into());
            open_http_url(&url)
        }
        "check-agent-update" => Err(BridgeError::cut("内核自动更新已在 Tauri 版移除（随客户端发版升级）")),
        "check-client-update" => Err(BridgeError::internal("Phase 4：接 tauri-plugin-updater（minisign 签名校验）")),
        other => Err(BridgeError::invalid_arg(format!("未知菜单动作：{other}"))),
    }
}

/// `dsh:copy-text` → Phase 1 接 tauri-plugin-clipboard-manager。
#[tauri::command]
fn copy_text(text: String) -> Result<serde_json::Value, BridgeError> {
    let _ = text;
    Err(BridgeError::internal("Phase 1：接 tauri-plugin-clipboard-manager 后启用"))
}

/// `dsh:open-external` → 系统默认浏览器（仅 http/https）。
#[tauri::command]
fn open_external(url: String) -> Result<serde_json::Value, BridgeError> {
    open_http_url(&url)
}

/// `dsh:page-error`（fire-and-forget）→ 计数 + 日志。
#[tauri::command]
fn page_error(state: tauri::State<BridgeState>, message: String) -> Result<serde_json::Value, BridgeError> {
    let n = state.page_errors.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[page-error #{n}] {message}");
    Ok(serde_json::Value::Null)
}

/// `dsh:renderer-heartbeat`（fire-and-forget）→ 计数。
#[tauri::command]
fn renderer_heartbeat(state: tauri::State<BridgeState>) -> Result<serde_json::Value, BridgeError> {
    state.heartbeats.fetch_add(1, Ordering::Relaxed);
    Ok(serde_json::Value::Null)
}

/// `dsh:current-session`（fire-and-forget）→ 当前会话跟踪（session-watcher 语义）。
#[tauri::command]
fn current_session(state: tauri::State<BridgeState>, session_id: String) -> Result<serde_json::Value, BridgeError> {
    let id = session_id.trim().to_string();
    if id.is_empty() || id.len() > 256 {
        return Err(BridgeError::invalid_arg("sessionId 为空或超长"));
    }
    *state.current_session.lock().unwrap() = Some(id);
    Ok(serde_json::Value::Null)
}

/// `chrome:restart-service` → Phase 1（kernel-process supervisor 接入后启用）。
#[tauri::command]
fn restart_service() -> Result<serde_json::Value, BridgeError> {
    Err(BridgeError::internal("Phase 1：kernel-process supervisor 接入后启用"))
}

/// PoC 专用：JSON 回显（验证参数序列化双向通路）。非契约成员。
#[tauri::command]
fn echo_json(payload: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    Ok(payload)
}

// ---------------------------------------------------------------------------
// OS 小工具（不引插件依赖的最小实现）
// ---------------------------------------------------------------------------

fn open_http_url(url: &str) -> Result<serde_json::Value, BridgeError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(BridgeError::invalid_arg(format!("仅允许 http/https：{url}")));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(BridgeError::from)?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(terr)?;
    }
    Ok(serde_json::Value::Null)
}

fn open_in_explorer(dir: &std::path::Path) -> Result<serde_json::Value, BridgeError> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(dir).spawn().map_err(BridgeError::from)?;
    }
    #[cfg(not(windows))]
    {
        eprintln!("[app] open logs dir: {}", dir.display());
    }
    Ok(serde_json::Value::Null)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
