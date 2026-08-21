//! 恢复页四件套（ipc-commands.md §2.1）：状态查询 / 重载 / 重启 / 打开日志。
//!
//! supervisor 缺位时「重启 / 重新加载」= 重新装配（data-flow.md §3.2）。

use bridge::BridgeError;
use tauri::{AppHandle, Manager};

use crate::AppState;

use super::common::{navigate_main, open_in_explorer};

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
