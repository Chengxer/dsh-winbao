//! 桥 command 全量实现（contracts/ipc-commands.md §2.1-2.3 的 Tauri 侧）。
//!
//! 分三类：
//! 1. 壳内实现（窗口/恢复/剪贴板/外部打开/文件围栏/宠物窗/浮窗/赞助）；
//! 2. sidecar 转发（插件管理六通道 + 诊断备份族——`run_sidecar`）；
//! 3. 已裁撤（内核更新链 guard:action——不注册，垫片报错）。

use std::sync::atomic::Ordering;

use bridge::BridgeError;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::AppState;

/// tauri::Error → BridgeError（bridge crate 不依赖 tauri，转换放装配层）。
pub fn terr(e: tauri::Error) -> BridgeError {
    BridgeError::internal(e.to_string())
}

// ---------------------------------------------------------------------------
// sidecar 转发 helper
// ---------------------------------------------------------------------------

/// sidecar 全局串行锁：同一时刻只允许一个 CLI 进程（withPatchWrite 只在单进程内
/// 串行；跨进程并发会竞写 cordis.patch.yml——Review#2 修复）。
static SIDECAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 跑 sidecar CLI 子命令，解析 stdout 末行 JSON。
pub fn run_sidecar(app: &AppHandle, args: &[&str]) -> Result<serde_json::Value, BridgeError> {
    let _serial = SIDECAR_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let sv = sv.ok_or_else(|| BridgeError::internal("supervisor 未初始化"))?;
    let out = std::process::Command::new(&sv.node_exe)
        .arg(&sv.sidecar_cli)
        .args(args)
        .arg("--app-dir")
        .arg(&sv.app_dir)
        .env("DSH_TAURI_VERSION", env!("CARGO_PKG_VERSION"))
        // GUI 进程起 console 子进程必须抑制终端窗（每个桥命令都走这里，
        // 无旗则插件/诊断/备份每次闪终端窗——0.5.0 实测修复）。
        .creation_flags_no_window()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(BridgeError::from)?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.trim_end().lines().last().unwrap_or("");
    let parsed: serde_json::Value =
        serde_json::from_str(line).map_err(|e| BridgeError::internal(format!("sidecar 输出解析: {e}")))?;
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// Phase 1：核心生命周期
// ---------------------------------------------------------------------------

/// 更新源仓库（Electron client-updater DEFAULT_REPOS 同源；⋯ 菜单「更新源」展示+复制）。
pub const REPO_URLS: (&str, &str) = (
    "https://github.com/myYangyunfan/dsh_desktop",
    "https://gitee.com/my-yang-yunfan/dsh_desktop",
);

#[tauri::command]
pub fn app_init(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let (kernel_url, phase_note, kernel_version) = {
        let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match sv {
            Some(s) => (s.kernel_url(), format!("kernel={}", s.kernel_version), s.kernel_version.clone()),
            None => (None, "supervisor 未初始化".into(), "未知".into()),
        }
    };
    // ⋯ 菜单面板状态（对齐 Electron chrome:init 的消费字段）：agent 版本/来源、
    // 三个持久化开关现值（settings.json，缺省 true）、更新源 URL——
    // bridge-shim 的菜单 openMenu 经 getInfo 拉取渲染。
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    Ok(serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "shell": "tauri",
        "kernel": kernel_url.unwrap_or_else(|| "未就绪".into()),
        "phaseNote": phase_note,
        "platform": std::env::consts::OS,
        "agentVersion": kernel_version,
        "agentSource": "bundled", // Tauri 版内核随客户端分发（Electron 的「内置」对应物）
        "notifyOnTurnEnd": setting_bool(&store, "notifyOnTurnEnd"),
        "closeToTray": setting_bool(&store, "closeToTray"),
        "showBalanceDock": setting_bool(&store, "showBalanceDock"),
        "repoUrls": { "github": REPO_URLS.0, "gitee": REPO_URLS.1 },
    }))
}

#[tauri::command]
pub fn window_control(window: WebviewWindow, action: String) -> Result<serde_json::Value, BridgeError> {
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
        "close" => {
            // 0.5.0 语义：标题栏 ✕（bridge-shim windowControls.close）= 隐藏主窗
            // 留托盘（后台常驻，内核继续）；真退出走托盘「退出」。
            // 防御：非主窗误入本通道（浮窗有自己的 floatWindow.close）保持真关闭。
            if window.label() == "main" {
                crate::windows::hide_main_to_tray(&window);
            } else {
                window.close().map_err(terr)?;
            }
        }
        "is-maximized" => {
            return Ok(serde_json::json!(window.is_maximized().map_err(terr)?));
        }
        other => return Err(BridgeError::invalid_arg(format!("未知窗口动作：{other}"))),
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub async fn menu_action(action: String, payload: Option<serde_json::Value>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    match action.as_str() {
        "open-logs" => {
            let dir = shell_core::DshPaths::resolve().logs;
            let _ = std::fs::create_dir_all(&dir);
            open_in_explorer(&dir)
        }
        "open-browser" => {
            let url = payload
                .and_then(|p| p.get("url").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| {
                    app.state::<AppState>()
                        .supervisor
                        .lock().unwrap_or_else(|p| p.into_inner())
                        .clone()
                        .and_then(|s| s.kernel_url())
                        .unwrap_or_else(|| "http://127.0.0.1".into())
                });
            open_http_url(&url)
        }
        "check-agent-update" => {
            // 最简可行 agent 更新检查（sidecar 暂无 agent-check-update 子命令，
            // 且 sidecar/ 属他人域不动）：本地版本 = 内核目录 @deepseek-ai/dsh
            // package.json（supervisor.kernel_version），远端 = npm registry
            // latest（双源镜像）。完整下载/替换链后续接（Electron runUpdateFlow
            // 的对应物）；菜单侧只消费 {current,latest,hasUpdate} 就地展示。
            let current = {
                let state = app.state::<AppState>();
                let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
                sv.map(|s| s.kernel_version.clone()).unwrap_or_else(|| "unknown".into())
            };
            // PowerShell 子进程阻塞至多 ~16s（双源×8s），挪出 async 运行时线程。
            let latest = tauri::async_runtime::spawn_blocking(|| npm_latest_version("@deepseek-ai/dsh"))
                .await
                .map_err(|e| BridgeError::internal(format!("agent 更新检查: {e}")))??;
            Ok(serde_json::json!({
                "ok": true,
                "current": current,
                "latest": latest,
                // 语义化比较（非字符串不等）：防 registry 落后于内置包的降级误报
                //（实测 npmmirror latest 0.1.0-rc.7 < 内置 0.1.0-rc.8）。
                "hasUpdate": !latest.is_empty() && compare_versions(&latest, &current) == std::cmp::Ordering::Greater,
            }))
        }
        "reload" => {
            // Electron reloadMainWindow 语义：当前页软重载（内核 SPA 状态丢失可接受）。
            let win = main_window(&app)?;
            win.eval("try{location.reload()}catch(e){}").map_err(terr)?;
            Ok(serde_json::Value::Null)
        }
        "devtools" => {
            // open_devtools 仅 debug 构建可用（release 无 devtools feature）。
            #[cfg(debug_assertions)]
            {
                let win = main_window(&app)?;
                win.open_devtools();
                Ok(serde_json::json!({ "ok": true }))
            }
            #[cfg(not(debug_assertions))]
            {
                Ok(serde_json::json!({ "ok": false, "error": "开发者工具仅开发版可用" }))
            }
        }
        "fullscreen" => {
            let win = main_window(&app)?;
            let now = win.is_fullscreen().map_err(terr)?;
            win.set_fullscreen(!now).map_err(terr)?;
            Ok(serde_json::json!({ "fullscreen": !now }))
        }
        "about" => {
            let kernel = {
                let state = app.state::<AppState>();
                let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
                sv.map(|s| s.kernel_version.clone()).unwrap_or_else(|| "未装配".into())
            };
            Ok(serde_json::json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "kernelVersion": kernel,
            }))
        }
        "quit" => {
            // 托盘「退出」同语义（lib.rs setup_tray）：先同步杀内核树（shutdown，
            // Job Object），再 exit(0)——RunEvent::Exit 再做锁与收尾。
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sv) = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    sv.shutdown();
                }
            }
            app.exit(0);
            Ok(serde_json::Value::Null)
        }
        "toggle-notify" | "toggle-close-to-tray" | "toggle-balance" => {
            let key = toggle_key(&action);
            let state = app.state::<AppState>();
            let store = shell_core::SettingsStore::new(state.paths.settings.clone());
            let next = toggle_setting(&store, key).map_err(|e| BridgeError::internal(e.0))?;
            // 单键返回（垫片 merge 进菜单 state 后重渲染）。
            let mut out = serde_json::Map::new();
            out.insert(key.to_string(), serde_json::json!(next));
            Ok(serde_json::Value::Object(out))
        }
        "check-client-update" => {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| BridgeError::new("E_UPDATER_NETWORK", e.to_string()))?;
            if std::env::var("DSH_UPDATER_ENDPOINT").ok().is_none() {
                return Err(BridgeError::new("E_UPDATER_CONFIG", "更新通道未配置（DSH_UPDATER_ENDPOINT/DSH_UPDATER_PUBKEY），发版 CI 注入"));
            }
            let update = updater.check().await.map_err(|e| BridgeError::new("E_UPDATER_NETWORK", e.to_string()))?;
            match update {
                Some(u) => Ok(serde_json::json!({ "ok": true, "version": u.version, "notes": u.body, "downloadAndInstall": "经 dshDesktop.menu.action('install-client-update')" })),
                None => Ok(serde_json::json!({ "ok": true, "upToDate": true })),
            }
        }
        "install-client-update" => {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| BridgeError::new("E_UPDATER_NETWORK", e.to_string()))?;
            let update = updater.check().await.map_err(|e| BridgeError::new("E_UPDATER_NETWORK", e.to_string()))?
                .ok_or_else(|| BridgeError::not_found("已是最新版本"))?;
            update.download_and_install(|_, _| {}, || {}).await.map_err(|e| BridgeError::new("E_UPDATER_SIGNATURE", e.to_string()))?;
            Ok(serde_json::json!({ "ok": true, "installed": update.version }))
        }
        other => Err(BridgeError::invalid_arg(format!("未知菜单动作：{other}"))),
    }
}

/// 主窗句柄（⋯ 菜单动作多数作用于主窗）。
fn main_window(app: &AppHandle) -> Result<WebviewWindow, BridgeError> {
    app.get_webview_window("main").ok_or_else(|| BridgeError::not_found("主窗不存在"))
}

/// 菜单 toggle 动作 → settings.json 键（Electron updater.loadSettings 同键）。
fn toggle_key(action: &str) -> &'static str {
    match action {
        "toggle-notify" => "notifyOnTurnEnd",
        "toggle-close-to-tray" => "closeToTray",
        _ => "showBalanceDock",
    }
}

/// 读 settings.json 布尔键（Electron `s.x !== false` 缺省 true 同口径）。
fn setting_bool(store: &shell_core::SettingsStore, key: &str) -> bool {
    store.get(key).ok().flatten().and_then(|v| v.as_bool()).unwrap_or(true)
}

/// 读-改-写布尔开关（Electron toggle-* 语义）：取反写回，返回新值。
fn toggle_setting(store: &shell_core::SettingsStore, key: &str) -> Result<bool, shell_core::settings::SettingsError> {
    let next = !setting_bool(store, key);
    store.set(key, serde_json::json!(next))?;
    Ok(next)
}

/// npm registry latest 版本查询（无 HTTP 依赖：子进程拉取；npmmirror 优先、
/// npmjs 兜底——Electron 更新链双源同思路，国内网络优先镜像）。
fn npm_latest_version(pkg: &str) -> Result<String, BridgeError> {
    for host in ["registry.npmmirror.com", "registry.npmjs.org"] {
        let url = format!("https://{host}/{pkg}/latest");
        if let Some(v) = http_get_version(&url) {
            return Ok(v);
        }
    }
    Err(BridgeError::new("E_AGENT_UPDATE_NETWORK", "npm registry 查询失败（npmmirror/npmjs 均不可达）"))
}

/// 单源查询：Windows 走 PowerShell Invoke-RestMethod（壳内既定子进程模式，
/// copy_text/open_http_url 同口径），其余平台 curl + 首个 "version" 字段提取。
fn http_get_version(url: &str) -> Option<String> {
    if url.contains('\'') {
        return None; // 防御（URL 由本函数拼装，正常不含单引号）
    }
    #[cfg(windows)]
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("$ProgressPreference='SilentlyContinue';try{{(Invoke-RestMethod -Uri '{url}' -TimeoutSec 8).version}}catch{{exit 2}}"),
        ])
        .creation_flags_no_window()
        .output();
    #[cfg(not(windows))]
    let output = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "8", url])
        .output();
    let out = output.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    #[cfg(windows)]
    let version = text; // PS 已提取 .version 字符串
    #[cfg(not(windows))]
    let version = extract_json_version(&text);
    // 版本串形态约束：非空、无空白、长度 sane（PS 错误对象字符串/HTML 错误页防御）。
    if version.is_empty() || version.len() > 64 || version.chars().any(char::is_whitespace) {
        return None;
    }
    Some(version)
}

/// 从 npm packument 文本提取首个 "version" 字段值（首个即顶层版本；与
/// supervisor::read_kernel_version 同款文本手术，不引 JSON DOM 依赖）。
/// Windows 的 PS 路径不消费（Invoke-RestMethod 已提取 .version），仅
/// 非 Windows curl 路径与单测使用。
#[cfg_attr(windows, allow(dead_code))]
fn extract_json_version(doc: &str) -> String {
    let Some(pos) = doc.find("\"version\"") else { return String::new() };
    let Some(colon) = doc[pos..].find(':') else { return String::new() };
    let rest = &doc[pos + colon..];
    let Some(q1) = rest.find('"') else { return String::new() };
    let body = &rest[q1 + 1..];
    let Some(len) = body.find('"') else { return String::new() };
    body[..len].to_string()
}

/// 版本段解析：(数字前缀, 是否数字段, 是否带预发布后缀, 原始段)。
/// 缺失段（None）按数字 0 处理（1.0 == 1.0.0）；空串/非数字开头是文本段。
fn version_seg(s: Option<&str>) -> (f64, bool, bool, String) {
    match s {
        None => (0.0, true, false, String::new()),
        Some(s) => {
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                (f64::NAN, false, false, s.to_string())
            } else {
                let has_pre = s.len() > digits.len();
                (digits.parse().unwrap_or(f64::NAN), true, has_pre, s.to_string())
            }
        }
    }
}

/// 版本比较（Electron scripts/lib/versions.js compareVersions 的 Rust 移植，
/// 语义单一来源，逐条对齐）：
/// · 数值分段比较（0.12.2 > 0.2.1），段数不限；缺失段按 0（1.0 == 1.0.0）；
/// · 忽略前导 v（v0.2.3 == 0.2.3）；
/// · 段先按数字前缀比较（0.2.4-beta > 0.2.3）；
/// · 数字前缀相等时：无预发布后缀 > 有后缀（0.2.3 > 0.2.3-beta）；
/// · 两段都带后缀按字符串比较（alpha < beta < rc）；
/// · 数字段 > 纯文本段。
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn strip_v(s: &str) -> &str {
        s.strip_prefix('v').unwrap_or(s)
    }
    let pa: Vec<&str> = strip_v(a).split('.').collect();
    let pb: Vec<&str> = strip_v(b).split('.').collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = version_seg(pa.get(i).copied());
        let y = version_seg(pb.get(i).copied());
        match (x.1, y.1) {
            (true, true) => {
                if x.0 != y.0 {
                    return if x.0 < y.0 { Ordering::Less } else { Ordering::Greater };
                }
                if x.2 != y.2 {
                    return if x.2 { Ordering::Less } else { Ordering::Greater }; // 有后缀 < 无后缀
                }
                if x.2 && x.3 != y.3 {
                    return if x.3 < y.3 { Ordering::Less } else { Ordering::Greater };
                }
            }
            (true, false) => return Ordering::Greater, // 数字段 > 纯文本段
            (false, true) => return Ordering::Less,
            (false, false) => {
                if x.3 != y.3 {
                    return if x.3 < y.3 { Ordering::Less } else { Ordering::Greater };
                }
            }
        }
    }
    Ordering::Equal
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<serde_json::Value, BridgeError> {
    if text.len() > 1_000_000 {
        return Err(BridgeError::invalid_arg("文本过长"));
    }
    // PowerShell Set-Clipboard：单引号包裹 + 内部单引号翻倍（防注入）。
    let escaped = text.replace('\'', "''");
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Set-Clipboard -Value '{escaped}'")])
        .creation_flags_no_window()
        .output()
        .map_err(BridgeError::from)?;
    if !status.status.success() {
        return Err(BridgeError::internal("剪贴板写入失败"));
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn open_external(url: String) -> Result<serde_json::Value, BridgeError> {
    open_http_url(&url)
}

#[tauri::command]
pub fn file_open(path: String, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Review#2：shell 元字符拒绝（explorer 参数注入面；正常路径不含这些字符）。
    if path.contains('"') || path.contains('&') || path.contains('|') || path.contains('^') || path.contains('%') || path.contains(';') {
        return Err(BridgeError::invalid_arg("路径含非法字符"));
    }
    // 围栏：只允许 dsh home 下的路径（contracts/error-codes.md E_FENCE_ROOT）。
    let home = shell_core::DshPaths::resolve().dsh_home;
    let fence = fence::Fence::new([home]);
    let cleaned = fence.ensure(std::path::Path::new(&path)).map_err(|e| BridgeError::new("E_FENCE_ROOT", e.to_string()))?;
    let _ = &app;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(&cleaned).spawn().map_err(BridgeError::from)?;
    }
    #[cfg(not(windows))]
    {
        eprintln!("[open_path] {}", cleaned.display());
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn page_error(state: State<AppState>, message: String) -> Result<serde_json::Value, BridgeError> {
    let n = state.page_errors.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[page-error #{n}] {message}");
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn renderer_heartbeat(state: State<AppState>) -> Result<serde_json::Value, BridgeError> {
    state.heartbeats.fetch_add(1, Ordering::Relaxed);
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn current_session(state: State<AppState>, session_id: String) -> Result<serde_json::Value, BridgeError> {
    let id = session_id.trim().to_string();
    if id.is_empty() || id.len() > 256 {
        return Err(BridgeError::invalid_arg("sessionId 为空或超长"));
    }
    *state.current_session.lock().unwrap_or_else(|p| p.into_inner()) = Some(id);
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn restart_service(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let sv = sv.ok_or_else(|| BridgeError::internal("supervisor 未初始化"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let preferred = state.last_port.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            let _ = ev;
        }
    });
    sv.restart(tx, u16::try_from(preferred).ok());
    Ok(serde_json::json!({ "ok": true }))
}

// ---- recovery 四件套 ----

#[tauri::command]
pub fn recovery_state(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some(sv) = sv else {
        // 内核未装配（如安装产物缺 dsh-desktop）：客户端仍开着——
        // 展示装配失败原因与「重启内核」重试入口，而非空状态。
        let reason = state
            .boot_error
            .lock().unwrap_or_else(|p| p.into_inner())
            .clone()
            .unwrap_or_else(|| "内核未装配（supervisor 未初始化）".to_string());
        return Ok(serde_json::json!({ "state": "no-kernel", "reason": reason }));
    };
    Ok(serde_json::json!({
        "state": format!("{:?}", sv.state()),
        "kernelUrl": sv.kernel_url(),
        "crashes": sv.crash_count(),
        "reason": sv.last_error(),
    }))
}

#[tauri::command]
pub fn recovery_reload(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(sv) = sv {
        if let Some(url) = sv.kernel_url() {
            navigate_main(&app, &url)?;
            return Ok(serde_json::Value::Null);
        }
    } else {
        // 内核从未装配（装配失败转恢复页后的重试）：重新装配并回 loading 页。
        crate::start_supervisor(app.clone()).map_err(BridgeError::internal)?;
    }
    // 无 URL：回 loading 页。
    let loading = state.loading_url.lock().unwrap_or_else(|p| p.into_inner()).clone();
    navigate_main(&app, &loading).map(|_| serde_json::Value::Null)
}

#[tauri::command]
pub fn recovery_restart(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(sv) = sv {
        let (tx, _rx) = std::sync::mpsc::channel();
        sv.recovery_restart(tx);
    } else {
        // 内核从未装配：恢复页「重启内核」= 重新装配（如用户刚补齐安装产物）。
        crate::start_supervisor(app.clone()).map_err(BridgeError::internal)?;
    }
    let loading = state.loading_url.lock().unwrap_or_else(|p| p.into_inner()).clone();
    navigate_main(&app, &loading).map(|_| serde_json::Value::Null)
}

#[tauri::command]
pub fn recovery_open_logs() -> Result<serde_json::Value, BridgeError> {
    let dir = shell_core::DshPaths::resolve().logs;
    let _ = std::fs::create_dir_all(&dir);
    open_in_explorer(&dir)
}

// ---------------------------------------------------------------------------
// Phase 2：插件管理（sidecar 转发）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-list"])
}
#[tauri::command]
pub fn plugin_set_enabled(id: String, enabled: bool, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-set-enabled", &id, if enabled { "1" } else { "0" }])
}
#[tauri::command]
pub fn plugin_uninstall(id: String, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-uninstall", &id])
}
#[tauri::command]
pub fn plugin_restore(id: String, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-restore", &id])
}
#[tauri::command]
pub fn plugin_check_updates(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-check-updates"])
}
#[tauri::command]
pub fn plugin_update(id: String, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["plugin-update", &id])
}

// ---------------------------------------------------------------------------
// Phase 3：围栏 / 诊断 / 备份 / WSL / 宠物 / 浮窗 / 赞助
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn file_revert(changes: Vec<serde_json::Value>) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：changes=[{path, op, oldText, newText}] 逆序应用，内容精确匹配才动手。
    let fence = fence::Fence::new([shell_core::DshPaths::resolve().dsh_home]);
    let mut applied = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for change in changes.iter().rev() {
        let path = change.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let old_text = change.get("oldText").and_then(|v| v.as_str()).unwrap_or("");
        let new_text = change.get("newText").and_then(|v| v.as_str()).unwrap_or("");
        let cleaned = match fence.ensure(std::path::Path::new(path)).map_err(|e| e.to_string()) {
            Ok(p) => p,
            Err(e) => {
                errors.push(e.to_string());
                continue;
            }
        };
        let content = match std::fs::read_to_string(&cleaned) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("读取 {}: {e}", cleaned.display()));
                continue;
            }
        };
        if new_text.is_empty() || !content.contains(new_text) {
            continue; // 内容不匹配：跳过（幂等安全）
        }
        let reverted = content.replacen(new_text, old_text, 1);
        if let Err(e) = atomic_write(&cleaned, &reverted) {
            errors.push(format!("写入 {}: {e}", cleaned.display()));
            continue;
        }
        applied += 1;
    }
    Ok(serde_json::json!({ "ok": errors.is_empty(), "applied": applied, "errors": errors }))
}

#[tauri::command]
pub fn image_paste_save(payload: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    // Electron imagePasteSave（main.js:2930）对齐。原「Phase 3 剪贴板位图」
    // 占位是理解偏差：插件 client 已把粘贴图捕获为 dataUrl 字符串（真实
    // 场景测试 U2 确认），壳侧只需落盘——无需 clipboard 插件。
    image_paste_save_impl(&payload).map_err(|e| BridgeError::new("E_IMAGE_PASTE", &e))
}

fn image_paste_save_impl(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let data_url = payload.get("dataUrl").and_then(|v| v.as_str()).ok_or("缺 dataUrl")?;
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("粘贴图片");
    let (head, b64) = data_url.split_once(',').ok_or("不是合法的图片 data URL")?;
    let mime = head.strip_prefix("data:").unwrap_or(head).split(';').next().unwrap_or("").to_lowercase();
    let ext = match mime.as_str() {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/bmp" => ".bmp",
        "image/avif" => ".avif",
        "image/ico" => ".ico",
        _ => return Err(format!("不支持的图片类型: {mime}")),
    };
    let bytes = b64_decode(b64).ok_or("base64 解码失败")?;
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > 15 * 1024 * 1024 {
        return Err("图片超过 15MB 上限".into());
    }
    let dir = shell_core::DshPaths::resolve().paste_tmp;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 顺手治 Electron 版的小泄漏（U2 发现其从不清理、随系统 %TEMP%）：
    // 每次保存顺带清 7 天前的粘贴文件。
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if let Ok(age) = modified.elapsed() {
                    if age.as_secs() > 7 * 86400 {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
    // 文件名消毒（对齐 Electron：禁字符过滤、截 40、空回退），防路径注入。
    let forbidden = r#"\/:*?"<>|"#;
    let base: String = name
        .chars()
        .filter(|c| !forbidden.contains(*c) && (*c as u32) >= 0x20)
        .take(40)
        .collect::<String>()
        .trim()
        .to_string();
    let base = if base.is_empty() { "粘贴图片".to_string() } else { base };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file = dir.join(format!("{base}-{ts}{ext}"));
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "path": file.to_string_lossy(), "size": bytes.len() }))
}

/// 标准 base64 解码（无依赖实现，容错空白与缺省 padding）。
pub(crate) fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    let mut chunk = [0u8; 4];
    let mut n = 0usize;
    for &b in &cleaned {
        if b == b'=' {
            break;
        }
        chunk[n] = val(b)?;
        n += 1;
        if n == 4 {
            let v = (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12) | (u32::from(chunk[2]) << 6) | u32::from(chunk[3]);
            out.push((v >> 16) as u8);
            out.push((v >> 8) as u8);
            out.push(v as u8);
            n = 0;
        }
    }
    match n {
        0 => Some(out),
        1 => None, // 单字符不成组
        2 => {
            let v = (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12);
            out.push((v >> 16) as u8);
            Some(out)
        }
        3 => {
            let v = (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12) | (u32::from(chunk[2]) << 6);
            out.push((v >> 16) as u8);
            out.push((v >> 8) as u8);
            Some(out)
        }
        _ => None,
    }
}

#[tauri::command]
pub fn balance_refresh(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：触发式（数据经事件推送），不返回值。
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(sv) = sv {
        if let Some(url) = sv.kernel_url() {
            // 就绪探针式触发（真实余额由内核计算，经 balance-changed 事件下行；
            // 壳不解析内核鉴权接口——保持单一投递契约）。
            let base = url.trim_end_matches('/').to_string();
            std::thread::spawn(move || {
                let _ = reqwest_probe(&base);
            });
        }
    }
    Ok(serde_json::Value::Null)
}

fn reqwest_probe(base: &str) -> Result<(), String> {
    // 无 HTTP 依赖的轻探活：TCP connect（确认内核在线即可，余额数据由内核主动推）。
    let host_port = base.trim_start_matches("http://").trim_start_matches("https://");
    std::net::TcpStream::connect_timeout(&host_port.parse().map_err(|e| format!("{e}"))?, std::time::Duration::from_secs(2))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diag_run(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["diag-run"])
}

#[tauri::command]
pub fn diag_export(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：主进程选路径（对话框）。Tauri Phase 3 用固定日志目录 + 时间戳。
    let dir = shell_core::DshPaths::resolve().logs;
    let _ = std::fs::create_dir_all(&dir);
    let out = dir.join(format!("dsh-diagnostics-{}.json", chrono_now()));
    let out_str = out.to_string_lossy().into_owned();
    run_sidecar(&app, &["diag-export", "--out", &out_str])
}

#[tauri::command]
pub fn diag_validate(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["diag-validate"])
}

#[tauri::command]
pub fn diag_order(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    run_sidecar(&app, &["diag-order"])
}

#[tauri::command]
pub fn diag_order_apply(order: Vec<String>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let json = serde_json::to_string(&order).map_err(|e| BridgeError::internal(e.to_string()))?;
    run_sidecar(&app, &["diag-order-apply", &json])
}

#[tauri::command]
pub fn diag_remove_bundle(names: Vec<String>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let json = serde_json::to_string(&names).map_err(|e| BridgeError::internal(e.to_string()))?;
    run_sidecar(&app, &["diag-remove-bundle", &json])
}

#[tauri::command]
pub fn backup_export(label: Option<String>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：对话框选路径。Tauri：固定到「文档」目录 + 时间戳名。
    let docs = dirs_docs();
    let _ = std::fs::create_dir_all(&docs);
    let out = docs.join(format!("dsh-desktop-backup-{}.json", chrono_now()));
    let out_str = out.to_string_lossy().into_owned();
    run_sidecar(&app, &["backup-export", &label.unwrap_or_default(), &out_str])
}

#[tauri::command]
pub fn backup_restore(preview: bool, token: Option<String>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    if preview {
        // Electron 语义：主进程选文件。Tauri：读最近一次导出的备份文件（日志/文档目录）。
        let docs = dirs_docs();
        let latest = latest_backup(&docs);
        let Some(file) = latest else {
            return Err(BridgeError::not_found("未找到可恢复的备份文件（文档目录）"));
        };
        let file_str = file.to_string_lossy().into_owned();
        return run_sidecar(&app, &["backup-restore-preview", &file_str]);
    }
    let docs = dirs_docs();
    let latest = latest_backup(&docs);
    let Some(file) = latest else {
        return Err(BridgeError::not_found("未找到可恢复的备份文件"));
    };
    let token = token.ok_or_else(|| BridgeError::invalid_arg("缺少恢复令牌（先 preview）"))?;
    let file_str = file.to_string_lossy().into_owned();
    run_sidecar(&app, &["backup-restore-apply", &file_str, &token])
}

/// 读 WSL 配置三键（纯逻辑，可单测）。扁平键 `backend` / `wslDistro` /
/// `wslInstallDir` 与 Electron `updater.loadSettings` 同键同文件（用户目录
/// 互迁不丢）；兼容迁移 0.5.0 早期误写的嵌套 `wslBackend` 键（扁平键优先）。
fn wsl_settings_load_from(store: &shell_core::SettingsStore) -> (String, String, String) {
    let get_str = |k: &str| -> String {
        store
            .get(k)
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default()
    };
    let legacy = store.get("wslBackend").ok().flatten();
    let legacy_field = |k: &str| -> String {
        legacy
            .as_ref()
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default()
    };
    let mut backend = get_str("backend");
    if backend.is_empty() {
        // 旧嵌套键字段名两代：`backend`（Electron 形态）/ `mode`（0.5.0 早期）。
        backend = legacy_field("backend");
        if backend.is_empty() {
            backend = legacy_field("mode");
        }
    }
    let distro = {
        let d = get_str("wslDistro");
        if d.is_empty() { legacy_field("wslDistro") } else { d }
    };
    let install_dir = {
        let d = get_str("wslInstallDir");
        if d.is_empty() { legacy_field("wslInstallDir") } else { d }
    };
    (
        if backend == "wsl" { "wsl".into() } else { "local".into() },
        distro,
        install_dir,
    )
}

/// WSL 配置校验（Electron dsh:wsl-config-save 同规则）。
fn validate_wsl_cfg(backend: &str, install_dir: &str) -> Result<(), String> {
    if backend != "local" && backend != "wsl" {
        return Err(format!("后端模式必须是 local 或 wsl（收到 {backend:?}）"));
    }
    if !install_dir.is_empty() && !install_dir.starts_with('/') && !install_dir.starts_with('~') {
        return Err("WSL 安装目录必须是 WSL 内绝对路径（以 / 或 ~ 开头）".into());
    }
    if install_dir.chars().any(|c| c.is_whitespace()) {
        return Err("WSL 安装目录不能包含空白字符".into());
    }
    Ok(())
}

/// WSL 探活：`wsl --status` 退出码（输出 UTF-16 无需解码，只看可用性）。
fn wsl_available() -> Result<bool, String> {
    #[cfg(windows)]
    {
        match std::process::Command::new("wsl")
            .args(["--status"])
            .creation_flags_no_window()
            .output()
        {
            Ok(o) => Ok(o.status.success()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// 契约形态（bridge-api.md §2.4，溯源 Electron `dsh:wsl-config`）：
/// `{backend, wslDistro, wslInstallDir, status:{configured, distro, installDir,
/// nodeVersion, npmVersion, agentVersion, lastError}, fallbackReason}`。
/// node/npm/agent 版本属 WSL 完整托管链（migration-roadmap Phase 3 后续），
/// 简版如实留空（页面 kvRow 显示「—」），不假装探测成功。
fn wsl_config_payload(backend: &str, distro: &str, install_dir: &str) -> serde_json::Value {
    let last_error = if backend == "wsl" {
        match wsl_available() {
            Ok(true) => String::new(),
            Ok(false) => "wsl --status 退出非零（WSL 未安装或无发行版）".to_string(),
            Err(e) => format!("无法启动 wsl 命令：{e}"),
        }
    } else {
        String::new()
    };
    serde_json::json!({
        "backend": backend,
        "wslDistro": distro,
        "wslInstallDir": install_dir,
        "status": {
            "configured": backend == "wsl",
            "distro": distro,
            "installDir": install_dir,
            "nodeVersion": "",
            "npmVersion": "",
            "agentVersion": "",
            "lastError": last_error,
        },
        "fallbackReason": "",
    })
}

#[tauri::command]
pub fn wsl_config_get(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // WSL 托管：Phase 3 简版（配置存取 + recheck 探活）；完整 wsl-backend 复用
    // 随 Phase 3 后续（migration-roadmap）。形态必须与 Electron 一致——此前
    // 返回 `{mode:"local"}` 致设置页 backend/status 全空、dirty 恒真（实测 bug）。
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    let (backend, distro, install_dir) = wsl_settings_load_from(&store);
    Ok(wsl_config_payload(&backend, &distro, &install_dir))
}

#[tauri::command]
pub fn wsl_config_save(cfg: serde_json::Value, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let backend = cfg.get("backend").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    let distro = cfg.get("wslDistro").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let install_dir = cfg.get("wslInstallDir").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if let Err(e) = validate_wsl_cfg(&backend, &install_dir) {
        // Electron 语义：配置错误以 {ok:false,error} 返回（设置页显示 error 文案）。
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }
    // 目标为 wsl 时预检 WSL 可用性——用户在重启前就能发现配置问题
    // （Electron configureAsync 预检的简版等价：只探 wsl --status，
    // node/npm 安装链属完整托管，Phase 3 后续）。
    if backend == "wsl" {
        match wsl_available() {
            Ok(true) => {}
            Ok(false) => {
                return Ok(serde_json::json!({
                    "ok": false,
                    "error": "WSL 不可用（wsl --status 失败）：请确认已安装 WSL 与至少一个发行版"
                }));
            }
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": format!("WSL 检测失败：{e}") })),
        }
    }
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    // 扁平键存储（与 Electron 同键；空值存空串，读取端 default 兜底）。
    // 旧嵌套 wslBackend 键不清理：读取端扁平键优先，自然废弃（清理需
    // SettingsStore 增加 remove API，收益不值契约面扩张）。
    for (k, v) in [("backend", serde_json::json!(backend)), ("wslDistro", serde_json::json!(distro)), ("wslInstallDir", serde_json::json!(install_dir))] {
        store.set(k, v).map_err(|e| BridgeError::internal(e.0))?;
    }
    Ok(serde_json::json!({ "ok": true, "restartRequired": true }))
}

#[tauri::command]
pub fn wsl_recheck(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：recheck 返回与 getConfig 同形态（status 强制重探测）。
    // 此前返回 `{ok,available}` 与契约不符——设置页「重新检测」把表单状态
    // 打回空（实测「WSL 行空」根因之一）。
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    let (backend, distro, install_dir) = wsl_settings_load_from(&store);
    Ok(wsl_config_payload(&backend, &distro, &install_dir))
}

// ---- 浮窗 / 宠物窗 / 赞助 ----

#[tauri::command]
pub fn float_window(action: String, session_id: Option<String>, app: AppHandle, window: WebviewWindow) -> Result<serde_json::Value, BridgeError> {
    if window.label() != "main" {
        return Err(BridgeError::new("E_NOT_FOUND", "仅主窗可开浮窗"));
    }
    match action.as_str() {
        "open" => {
            let sid = session_id.filter(|s| !s.is_empty()).ok_or_else(|| BridgeError::invalid_arg("bad-session"))?;
            let state = app.state::<AppState>();
            let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let sv = sv.ok_or_else(|| BridgeError::new("E_KERNEL_NOT_READY", "内核未就绪"))?;
            let url = sv.kernel_url().ok_or_else(|| BridgeError::new("E_KERNEL_NOT_READY", "内核未就绪"))?;
            crate::windows::open_float_window(&app, &url, &sid)
        }
        other => Err(BridgeError::invalid_arg(format!("bad-action: {other}"))),
    }
}

#[tauri::command]
pub fn float_close(window: WebviewWindow) -> Result<serde_json::Value, BridgeError> {
    if window.label().starts_with("float-") {
        let _ = window.close();
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn pet_window(action: String, app: AppHandle, window: WebviewWindow) -> Result<serde_json::Value, BridgeError> {
    if window.label() != "main" {
        return Err(BridgeError::new("E_NOT_FOUND", "仅主窗可控制宠物窗"));
    }
    match action.as_str() {
        "state" => Ok(serde_json::json!({ "ok": true, "open": app.get_webview_window("pet").is_some() })),
        "open" | "toggle" => {
            let existing = app.get_webview_window("pet");
            if let Some(p) = existing {
                if action == "toggle" {
                    let _ = p.close();
                    let _ = app.emit("pet-state", serde_json::json!({ "open": false }));
                    return Ok(serde_json::json!({ "ok": true, "open": false }));
                }
                let _ = p.show();
                let _ = p.set_focus();
                return Ok(serde_json::json!({ "ok": true, "open": true, "reused": true }));
            }
            let state = app.state::<AppState>();
            let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let sv = sv.ok_or_else(|| BridgeError::new("E_KERNEL_NOT_READY", "内核未就绪"))?;
            let url = sv.kernel_url().ok_or_else(|| BridgeError::new("E_KERNEL_NOT_READY", "内核未就绪"))?;
            crate::windows::open_pet_window(&app, &url)
        }
        other => Err(BridgeError::invalid_arg(format!("bad-action: {other}"))),
    }
}

#[tauri::command]
pub fn pet_close(window: WebviewWindow) -> Result<serde_json::Value, BridgeError> {
    if window.label() == "pet" {
        let _ = window.close();
        let _ = window.app_handle().emit("pet-state", serde_json::json!({ "open": false }));
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn pet_move_to(x: f64, y: f64, window: WebviewWindow) -> Result<serde_json::Value, BridgeError> {
    if window.label() != "pet" {
        return Ok(serde_json::Value::Null);
    }
    // 钳制屏幕可视区（至少露 80px）——Electron 版语义。
    if let Ok(mut mon) = window.current_monitor() {
        if let Some(m) = mon.take() {
            let sz = m.size();
            let scale = m.scale_factor();
            let w = (crate::windows::PET_W * scale).max(1.0);
            let x = x.clamp(-w + 80.0, sz.width as f64 - 80.0);
            let y = y.clamp(0.0, sz.height as f64 - 80.0);
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32)));
            return Ok(serde_json::Value::Null);
        }
    }
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn pet_set_auto_open(enabled: bool, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    store.set("pet.autoOpen", serde_json::json!(enabled)).map_err(|e| BridgeError::internal(e.0))?;
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub fn sponsor_qr(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some(sv) = sv else { return Ok(serde_json::json!({ "ok": false })) };
    let read = |name: &str| -> String {
        let p = sv.app_dir.join("assets").join("sponsor").join(name);
        std::fs::read(p).map(|b| format!("data:image/{};base64,{}", if name.ends_with(".png") { "png" } else { "jpeg" }, b64(&b))).unwrap_or_default()
    };
    Ok(serde_json::json!({ "ok": true, "alipay": read("sponsor-alipay.jpg"), "wechat": read("sponsor-wechat.png") }))
}

#[tauri::command]
pub fn sponsor_window(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some(sv) = sv else { return Err(BridgeError::internal("supervisor 未初始化")) };
    let read = |name: &str| -> String {
        let p = sv.app_dir.join("assets").join("sponsor").join(name);
        std::fs::read(p).map(|b| format!("data:image/{};base64,{}", if name.ends_with(".png") { "png" } else { "jpeg" }, b64(&b))).unwrap_or_default()
    };
    crate::windows::open_sponsor_window(&app, &read("sponsor-alipay.jpg"), &read("sponsor-wechat.png"))
}

// ---------------------------------------------------------------------------
/// PoC 专用：JSON 回显（验证参数序列化双向通路）。非契约成员。
#[tauri::command]
pub fn poc_echo_json(payload: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    Ok(payload)
}

// OS 小工具
// ---------------------------------------------------------------------------

pub fn open_http_url(url: &str) -> Result<serde_json::Value, BridgeError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(BridgeError::invalid_arg(format!("仅允许 http/https：{url}")));
    }
    #[cfg(windows)]
    {
        // Review#2：不用 cmd /C start（& | ^ " 注入面）——PowerShell 单引号包裹，
        // 内部单引号翻倍（与 copy_text 同口径）。
        let escaped = url.replace(char::from(0x27), "''");
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("Start-Process '{escaped}'")])
            .creation_flags_no_window()
            .spawn()
            .map_err(BridgeError::from)?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn().map_err(BridgeError::from)?;
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
        eprintln!("[open logs] {}", dir.display());
    }
    Ok(serde_json::Value::Null)
}

/// 主窗导航（evaluate_script location.href——万金油且可靠）。
pub fn navigate_main(app: &AppHandle, url: &str) -> Result<(), BridgeError> {
    let win = app.get_webview_window("main").ok_or_else(|| BridgeError::not_found("主窗不存在"))?;
    let js = format!("try{{location.href={}}}catch(e){{}}", serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into()));
    win.eval(&js).map_err(terr)
}

/// 原子写：tmp + rename。
fn atomic_write(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("revert-tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}

fn dirs_docs() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .map(std::path::PathBuf::from)
        .map(|h| h.join("Documents"))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn latest_backup(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("dsh-desktop-backup-") && name.ends_with(".json") {
            if let Ok(meta) = entry.metadata() {
                if let Ok(t) = meta.modified() {
                    if best.as_ref().map(|(_, bt)| t > *bt).unwrap_or(true) {
                        best = Some((entry.path(), t));
                    }
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    // YYYYMMDD-HHMMSS（本地时区经 PowerShell 太重；UTC 稳定可排序，命名用途足够）。
    let days = secs / 86400;
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}{mo:02}{d:02}-{:02}{:02}{:02}", (secs % 86400) / 3600, (secs % 3600) / 60, secs % 60)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 标准 base64（无依赖实现）。
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(windows)]
pub trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
#[cfg(windows)]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}
#[cfg(not(windows))]
pub trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
#[cfg(not(windows))]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}


#[cfg(test)]
mod image_paste_tests {
    use super::*;

    #[test]
    fn b64_decode_roundtrip_and_padding() {
        // 与既有 b64 编码器互逆（含 1/2/3 字节尾组与无 padding 形态）。
        for data in [b"" as &[u8], b"a", b"ab", b"abc", b"abcd", b"foobarbaz!"] {
            let enc = b64(data);
            assert_eq!(b64_decode(&enc).as_deref(), Some(data), "roundtrip {data:?}");
        }
        assert_eq!(b64_decode("aGVsbG8=").as_deref(), Some(b"hello".as_slice()));
        assert_eq!(b64_decode("aGVsbG8").as_deref(), Some(b"hello".as_slice())); // 缺省 padding
        // 空白容错：base64 文本内嵌空白/换行应被忽略（"YWJj" → 字节 "abc"）。
        assert_eq!(b64_decode("YW J j\n").as_deref(), Some(b"abc".as_slice()));
        assert!(b64_decode("!!!").is_none());
        assert!(b64_decode("A").is_none()); // 单字符不成组
    }

    #[test]
    fn image_paste_save_impl_contract() {
        // Electron 契约形态：合法 png 落盘返回 {ok,path,size}；坏输入带可读错误。
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = std::env::temp_dir().join(format!("dsh-paste-test-{}", std::process::id()));
        std::env::set_var("DSH_TEST_TMP", &tmp);
        // 1x1 PNG（70B 真实字节）
        let png: Vec<u8> = vec![
            0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,0x0D,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1,
            0x08,0x06,0,0,0,0x1F,0x15,0xC4,0x89,0,0,0,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0,1,
            0,0,5,0,0x02,0x0A,0x2B,0xB5,0x38,0xFD,0,0,0,0,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82,
        ];
        let payload = serde_json::json!({
            "dataUrl": format!("data:image/png;base64,{}", b64(&png)),
            "name": "screens\\hot/粘贴:图?"
        });
        let r = image_paste_save_impl(&payload).unwrap();
        assert_eq!(r["ok"], serde_json::json!(true));
        assert_eq!(r["size"], serde_json::json!(png.len()));
        let path = std::path::PathBuf::from(r["path"].as_str().unwrap());
        // 注意 Path::ends_with 是整组件匹配，后缀断言用字符串形态。
        assert!(path.exists() && path.to_string_lossy().ends_with(".png"));
        assert_eq!(std::fs::read(&path).unwrap(), png);
        let fname = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(!fname.contains('\\') && !fname.contains('/') && !fname.contains(':') && !fname.contains('?'), "消毒后文件名 {fname}");
        std::fs::remove_file(&path).ok();
        // 坏输入
        let bad = image_paste_save_impl(&serde_json::json!({ "dataUrl": "data:image/tiff;base64,QUJD", "name": "x" }));
        assert!(bad.unwrap_err().contains("不支持的图片类型"));
        let bad2 = image_paste_save_impl(&serde_json::json!({ "name": "x" }));
        assert!(bad2.unwrap_err().contains("dataUrl"));
        std::env::remove_var("DSH_TEST_TMP");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_known_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        // 二进制安全（RFC 4648：3 字节无填充）。
        assert_eq!(b64(&[0xffu8; 2]), "//8=");
        assert_eq!(b64(&[0xffu8; 3]), "////");
    }

    #[test]
    fn civil_from_days_epoch_and_known_dates() {
        // 1970-01-01 = day 0。
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-07-19 = day 20653（node: new Date(20653*86400e3) 校准）。
        assert_eq!(civil_from_days(20653), (2026, 7, 19));
    }

    #[test]
    fn chrono_now_shape() {
        let s = chrono_now();
        assert_eq!(s.len(), 15, "YYYYMMDD-HHMMSS：{s}");
        assert_eq!(s.as_bytes()[8], b'-');
        assert!(s.starts_with("20"), "{s}");
    }

    #[test]
    fn atomic_write_replaces_and_cleans_tmp() {
        let dir = std::env::temp_dir().join(format!("dsh-cmd-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        atomic_write(&f, "v1").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "v1");
        atomic_write(&f, "中文 v2").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "中文 v2");
        assert!(!f.with_extension("revert-tmp").exists(), "临时文件应被 rename 消费");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_backup_picks_newest_matching_prefix() {
        let dir = std::env::temp_dir().join(format!("dsh-cmd-bak-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(latest_backup(&dir), None, "空目录无备份");
        std::fs::write(dir.join("dsh-desktop-backup-old.json"), b"1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(dir.join("dsh-desktop-backup-new.json"), b"2").unwrap();
        std::fs::write(dir.join("unrelated.json"), b"3").unwrap();
        let got = latest_backup(&dir).unwrap();
        assert!(got.ends_with("dsh-desktop-backup-new.json"), "{}", got.display());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// file_revert 功能：围栏内替换（逆序）+ 越界拒绝 + 内容不匹配跳过。
    #[test]
    fn file_revert_fence_and_idempotency() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!("dsh-cmd-revert-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // dsh_home = <home>/.dsh（paths 契约）——围栏内文件须在其下。
        let work = home.join(".dsh").join("sessions").join("w1");
        std::fs::create_dir_all(&work).unwrap();
        std::env::set_var("DSH_TEST_HOME", &home);
        std::fs::write(work.join("a.md"), "after-change").unwrap();
        std::fs::write(work.join("b.md"), "unrelated-content").unwrap();

        let changes = vec![
            serde_json::json!({ "path": work.join("a.md").to_string_lossy(), "op": "edit", "oldText": "before-change", "newText": "after-change" }),
            serde_json::json!({ "path": work.join("b.md").to_string_lossy(), "op": "edit", "oldText": "x", "newText": "keep-me" }),
        ];
        let out = file_revert(changes).unwrap();
        assert_eq!(out["ok"], serde_json::json!(true), "{out}");
        assert_eq!(out["applied"], serde_json::json!(1), "b.md 内容不匹配应跳过: {out}");
        assert_eq!(std::fs::read_to_string(work.join("a.md")).unwrap(), "before-change", "应还原为写前文本");
        assert_eq!(std::fs::read_to_string(work.join("b.md")).unwrap(), "unrelated-content", "不匹配的文件必须原样保留");

        // 越界：home 外路径拒绝（E_FENCE_ROOT 语义：errors 记录、不写）。
        let outside = std::env::temp_dir().join(format!("dsh-cmd-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();
        let out = file_revert(vec![serde_json::json!({ "path": outside.to_string_lossy(), "op": "e", "oldText": "a", "newText": "secret" })]).unwrap();
        assert_eq!(out["ok"], serde_json::json!(false));
        assert!(out["errors"].as_array().unwrap()[0].as_str().unwrap().contains("E_FENCE_ROOT"), "{out}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret", "越界文件不得被改");

        std::env::remove_var("DSH_TEST_HOME");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn sponsor_and_qr_helpers() {
        let html = crate::windows::sponsor_html("data:image/jpeg;base64,AAA", "data:image/png;base64,BBB");
        assert!(html.contains("data:image/jpeg;base64,AAA"));
        assert!(html.contains("data:image/png;base64,BBB"));
        assert!(html.contains("请作者喝咖啡"));
    }

    /// wsl 三通道契约形态（bridge-api.md §2.4 / Electron dsh:wsl-config）：
    /// getConfig/recheck 必须返回 {backend, wslDistro, wslInstallDir, status,
    /// fallbackReason}——此前 `{mode:"local"}` / `{ok,available}` 形态不符是
    /// 设置页「WSL 后端」行空的根因（回归锚点）。
    #[test]
    fn wsl_config_payload_contract_shape() {
        let p = wsl_config_payload("local", "", "");
        assert_eq!(p["backend"], serde_json::json!("local"));
        assert_eq!(p["wslDistro"], serde_json::json!(""));
        assert_eq!(p["wslInstallDir"], serde_json::json!(""));
        assert_eq!(p["fallbackReason"], serde_json::json!(""));
        // status 全字段在场（dsh-wsl-settings kvRow 逐字段消费；缺键=行不渲染）。
        let st = &p["status"];
        for k in ["configured", "distro", "installDir", "nodeVersion", "npmVersion", "agentVersion", "lastError"] {
            assert!(st.get(k).is_some(), "status.{k} 缺失：{st}");
        }
        assert_eq!(st["configured"], serde_json::json!(false), "local 模式 configured=false");
        assert_eq!(st["lastError"], serde_json::json!(""), "local 模式不探测，lastError 必空");
        // wsl 模式：configured=true，回显 distro/installDir。
        let p2 = wsl_config_payload("wsl", "Ubuntu-24.04", "~/.dsh-desktop");
        assert_eq!(p2["status"]["configured"], serde_json::json!(true));
        assert_eq!(p2["status"]["distro"], serde_json::json!("Ubuntu-24.04"));
        assert_eq!(p2["status"]["installDir"], serde_json::json!("~/.dsh-desktop"));
    }

    /// wsl 配置读取：空 store 默认 local；扁平键优先；0.5.0 旧嵌套键
    /// （wslBackend: {mode|backend, wslDistro, wslInstallDir}）迁移读取。
    #[test]
    fn wsl_settings_load_flat_and_legacy_migration() {
        let mut path = std::env::temp_dir();
        path.push(format!("dsh-cmd-wsl-{}-{}.json", std::process::id(), line!()));
        let _ = std::fs::remove_file(&path);
        let store = shell_core::SettingsStore::new(&path);
        // 空 store：默认 local，无 distro/dir。
        assert_eq!(wsl_settings_load_from(&store), ("local".into(), String::new(), String::new()));
        // 旧嵌套键（mode 字段形态）。
        store.set("wslBackend", serde_json::json!({"mode": "wsl", "wslDistro": "Ubuntu", "wslInstallDir": "~/d"})).unwrap();
        assert_eq!(
            wsl_settings_load_from(&store),
            ("wsl".into(), "Ubuntu".into(), "~/d".into()),
            "旧嵌套键（mode 字段）应迁移读取"
        );
        // 扁平键（Electron 同键）优先于旧嵌套键。
        store.set("backend", serde_json::json!("local")).unwrap();
        store.set("wslDistro", serde_json::json!("Debian")).unwrap();
        assert_eq!(
            wsl_settings_load_from(&store),
            ("local".into(), "Debian".into(), "~/d".into()),
            "扁平键优先；未覆盖的字段回落旧键"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// wsl 配置校验：Electron dsh:wsl-config-save 同规则。
    #[test]
    fn wsl_config_validate_rules() {
        assert!(validate_wsl_cfg("local", "").is_ok());
        assert!(validate_wsl_cfg("wsl", "").is_ok());
        assert!(validate_wsl_cfg("wsl", "~/.dsh-desktop").is_ok());
        assert!(validate_wsl_cfg("wsl", "/opt/dsh").is_ok());
        assert!(validate_wsl_cfg("remote", "").is_err(), "backend 枚举外拒绝");
        assert!(validate_wsl_cfg("wsl", "C:\\dsh").is_err(), "非 WSL 绝对路径拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d sh").is_err(), "含空白拒绝");
    }

    /// ⋯ 菜单 toggle：读-改-写 settings 往返（缺省 true → false → true），
    /// 读-改-写不破坏同文件其他键，损坏形态（非布尔值）回落缺省 true。
    #[test]
    fn menu_toggle_setting_roundtrip() {
        let mut path = std::env::temp_dir();
        path.push(format!("dsh-cmd-toggle-{}-{}.json", std::process::id(), line!()));
        let _ = std::fs::remove_file(&path);
        let store = shell_core::SettingsStore::new(&path);
        // 缺省 true（Electron `s.x !== false` 同口径）。
        assert_eq!(setting_bool(&store, "notifyOnTurnEnd"), true);
        // 翻转并持久化：true → false。
        assert_eq!(toggle_setting(&store, "notifyOnTurnEnd").unwrap(), false);
        assert_eq!(store.get("notifyOnTurnEnd").unwrap(), Some(serde_json::json!(false)));
        // 显式 false 再翻：false → true（读文件真值，非内存态）。
        assert_eq!(toggle_setting(&store, "notifyOnTurnEnd").unwrap(), true);
        assert_eq!(store.get("notifyOnTurnEnd").unwrap(), Some(serde_json::json!(true)));
        // 读-改-写不破坏同文件其他键。
        store.set("lastWebPort", serde_json::json!(51731)).unwrap();
        toggle_setting(&store, "closeToTray").unwrap();
        assert_eq!(store.get("lastWebPort").unwrap(), Some(serde_json::json!(51731)));
        // 非布尔值（损坏形态）回落缺省 true，toggle 后写回正常布尔。
        store.set("showBalanceDock", serde_json::json!("oops")).unwrap();
        assert_eq!(setting_bool(&store, "showBalanceDock"), true);
        assert_eq!(toggle_setting(&store, "showBalanceDock").unwrap(), false);
        let _ = std::fs::remove_file(&path);
    }

    /// 菜单 toggle 动作 → settings.json 键映射（Electron 同键）。
    #[test]
    fn menu_toggle_key_mapping() {
        assert_eq!(toggle_key("toggle-notify"), "notifyOnTurnEnd");
        assert_eq!(toggle_key("toggle-close-to-tray"), "closeToTray");
        assert_eq!(toggle_key("toggle-balance"), "showBalanceDock");
    }

    /// npm packument 版本提取（首个 "version" 字段即顶层版本）。
    #[test]
    fn extract_json_version_npm_doc() {
        let doc = r#"{"_id":"@deepseek-ai/dsh","name":"@deepseek-ai/dsh","version":"0.1.0-rc.9","dist":{"tarball":"https://x/y.tgz"}}"#;
        assert_eq!(extract_json_version(doc), "0.1.0-rc.9");
        assert_eq!(extract_json_version("{\"error\":\"not found\"}"), "");
        assert_eq!(extract_json_version(""), "");
    }

    /// 版本比较（Electron scripts/lib/versions.js 同语义，注释里的规则逐条锚定）
    /// + 真实回归案例：npmmirror latest 0.1.0-rc.7 < 内置 0.1.0-rc.8 → 无更新。
    #[test]
    fn compare_versions_semantics() {
        use std::cmp::Ordering::*;
        // 数值分段比较。
        assert_eq!(compare_versions("0.12.2", "0.2.1"), Greater);
        assert_eq!(compare_versions("0.2.1", "0.12.2"), Less);
        // 缺失段按 0。
        assert_eq!(compare_versions("1.0", "1.0.0"), Equal);
        // 忽略前导 v。
        assert_eq!(compare_versions("v0.2.3", "0.2.3"), Equal);
        // 数字前缀优先：预发布的高段仍大于低段正式版。
        assert_eq!(compare_versions("0.2.4-beta", "0.2.3"), Greater);
        // 无后缀 > 有后缀。
        assert_eq!(compare_versions("0.2.3", "0.2.3-beta"), Greater);
        // 后缀按字符串比较：alpha < beta < rc。
        assert_eq!(compare_versions("0.2.3-alpha", "0.2.3-beta"), Less);
        assert_eq!(compare_versions("0.2.3-beta", "0.2.3-rc"), Less);
        // rc.N 序号比较（rc.8 > rc.7）。
        assert_eq!(compare_versions("0.1.0-rc.8", "0.1.0-rc.7"), Greater);
        // 数字段 > 纯文本段。
        assert_eq!(compare_versions("1.2.3", "1.2.x"), Greater);
        // 真实回归：registry 落后于内置包 → 不得报「可更新」。
        assert_eq!(compare_versions("0.1.0-rc.7", "0.1.0-rc.8"), Less, "降级误报防护");
        // 真实正向：registry 更新 → 报「可更新」。
        assert_eq!(compare_versions("0.1.0", "0.1.0-rc.8"), Greater);
    }

    /// 菜单 quit 语义 = 托盘退出（lib.rs setup_tray 同款）：先 supervisor
    /// .shutdown（同步杀树）再 exit(0)。源码形态断言（WebviewWindow/AppHandle
    /// 无法在单测构造），防「顺手改成直接 exit」回退——那会留内核孤儿进程。
    #[test]
    fn menu_quit_shutdown_before_exit_shape() {
        let src = include_str!("commands.rs");
        let seg = src
            .split("\"quit\" =>")
            .nth(1)
            .and_then(|s| s.split("\"toggle-notify\"").next())
            .expect("quit 分支");
        let sh = seg.find("sv.shutdown()").expect("必须先同步杀内核树");
        let ex = seg.find("app.exit(0)").expect("必须退出进程");
        assert!(sh < ex, "先 shutdown 后 exit（Job Object 杀树语义）: {seg}");
    }

    /// check-agent-update 需求变更锚点：不再裁撤（菜单保留「检查 dsh 更新…」），
    /// 走 npm latest 对比返回 {current,latest,hasUpdate}。
    #[test]
    fn check_agent_update_uses_npm_latest_not_cut() {
        let src = include_str!("commands.rs");
        let seg = src
            .split("\"check-agent-update\" =>")
            .nth(1)
            .and_then(|s| s.split("\"reload\" =>").next())
            .expect("check-agent-update 分支");
        assert!(seg.contains("npm_latest_version"), "最简可行链：npm latest 对比");
        assert!(!seg.contains("BridgeError::cut"), "不得再返回 E_CUT_FEATURE");
        assert!(seg.contains("\"hasUpdate\""), "返回契约必须带 hasUpdate");
    }

    /// window_control close 语义（0.5.0）：主窗 ✕ = 隐藏留托盘，非真退出。
    /// 单测无法构造 WebviewWindow，按 contract_audit 同法做源码形态断言
    /// （防「顺手改回 close()」回退——那会让 ✕ 直接杀进程，托盘保活失效）。
    #[test]
    fn window_control_close_hides_main_window_shape() {
        let src = include_str!("commands.rs");
        let seg = src
            .split("\"close\" =>")
            .nth(1)
            .and_then(|s| s.split("other =>").next())
            .expect("close 分支");
        assert!(seg.contains("window.label() == \"main\""), "主窗判定缺失: {seg}");
        assert!(seg.contains("hide_main_to_tray"), "主窗 close 必须走隐藏留托盘: {seg}");
        assert!(seg.contains("window.close()"), "非主窗误入应保持真关闭: {seg}");
        // close 分支整体不得出现进程退出语义。
        assert!(!seg.contains("exit("), "close 分支不得退出进程: {seg}");
    }

    /// run_sidecar 子进程必须带 CREATE_NO_WINDOW（GUI 起 console 程序闪终端
    /// 的回归锚点——每个桥命令都经此通道）。
    #[test]
    fn run_sidecar_suppresses_console_window_shape() {
        let src = include_str!("commands.rs");
        let seg = src
            .split("pub fn run_sidecar")
            .nth(1)
            .and_then(|s| s.split("// ---").next())
            .expect("run_sidecar 函数体");
        assert!(seg.contains("Command::new(&sv.node_exe)"), "锚点漂移（改了 spawn 写法需同步测试）: {seg}");
        assert!(seg.contains(".creation_flags_no_window()"), "sidecar spawn 必须抑制终端窗: {seg}");
    }
}
