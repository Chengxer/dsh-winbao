//! Phase 1 核心生命周期命令：app_init / 剪贴板 / 外部打开 / 页面心跳 /
//! 当前会话 / 服务重启 / 余额触发 / PoC 回显（ipc-commands.md §2.1）。

use std::sync::atomic::Ordering;

use bridge::BridgeError;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

use super::common::{open_http_url, NoWindow};
use super::menu::setting_bool;

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

/// PoC 专用：JSON 回显（验证参数序列化双向通路）。非契约成员。
#[tauri::command]
pub fn poc_echo_json(payload: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    Ok(payload)
}
