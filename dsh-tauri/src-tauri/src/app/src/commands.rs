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

#[tauri::command]
pub fn app_init(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let (kernel_url, phase_note) = {
        let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
        match sv {
            Some(s) => (s.kernel_url(), format!("kernel={}", s.kernel_version)),
            None => (None, "supervisor 未初始化".into()),
        }
    };
    Ok(serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "shell": "tauri",
        "kernel": kernel_url.unwrap_or_else(|| "未就绪".into()),
        "phaseNote": phase_note,
        "platform": std::env::consts::OS,
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
        "close" => window.close().map_err(terr)?,
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
        "check-agent-update" => Err(BridgeError::cut("内核自动更新已在 Tauri 版移除（随客户端发版升级）")),
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
    let _ = payload;
    Err(BridgeError::new("E_NOT_IMPLEMENTED", "Phase 3 后续：剪贴板图片落盘（tauri-plugin-clipboard-manager 位图支持）"))
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

#[tauri::command]
pub fn wsl_config_get(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // WSL 托管：Phase 3 简版（配置存取 + recheck 探活）；完整 wsl-backend 复用随 Phase 3 后续。
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    let cfg = store.get("wslBackend").unwrap_or(None).unwrap_or(serde_json::json!({ "mode": "local" }));
    Ok(cfg)
}

#[tauri::command]
pub fn wsl_config_save(cfg: serde_json::Value, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    if !cfg.is_object() {
        return Err(BridgeError::invalid_arg("cfg 必须是对象"));
    }
    let state = app.state::<AppState>();
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    store.set("wslBackend", cfg).map_err(|e| BridgeError::internal(e.0))?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn wsl_recheck() -> Result<serde_json::Value, BridgeError> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("wsl").args(["--status"]).creation_flags_no_window().output();
        match out {
            Ok(o) => Ok(serde_json::json!({ "ok": o.status.success(), "available": o.status.success() })),
            Err(_) => Ok(serde_json::json!({ "ok": true, "available": false })),
        }
    }
    #[cfg(not(windows))]
    Ok(serde_json::json!({ "ok": true, "available": false }))
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
}
