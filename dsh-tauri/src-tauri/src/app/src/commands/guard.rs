//! guard:action 交互面（ipc-commands.md §2.3 插件保护中心）。
//!
//! Electron `guard:action {action}` 单一通道迁移为 Tauri `guard_action` 分发命令
//!（对齐 `menu_action` 分发形态）。只暴露交互 UI 所需的**读面 + 轻量解**：
//!   - `status`          → supervisor guard_status（快照/事故/lastGood）
//!   - `check`           → supervisor guard_check（静态体检 findings）
//!   - `incident`        → supervisor guard_incident_read（读事故详情）
//!   - `resolve-incident`→ supervisor guard_resolve_incident（软解决）
//!
//! 写动作（snapshot / restore / repair）仍走守护瀑布自动面（supervisor
//! boot_waterfall），此处不暴露——手动回滚与运行中内核的文件锁/自动瀑布会竞态，
//! 故保留「写面」在自动面（见 supervisor.rs 交互面注记）。

use bridge::BridgeError;
use tauri::{AppHandle, Manager};

use crate::AppState;

/// guard:action 分发命令（Electron `ipcMain.handle('guard:action')` 等价物）。
#[tauri::command]
pub fn guard_action(action: String, id: Option<String>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<AppState>();
    let sv = state
        .supervisor
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| BridgeError::internal("supervisor 未初始化"))?;
    match action.as_str() {
        "status" => sv
            .guard_status()
            .ok_or_else(|| BridgeError::internal("guard status 查询失败（sidecar 不可用）")),
        "check" => sv
            .guard_check()
            .ok_or_else(|| BridgeError::internal("guard 体检失败（sidecar 不可用）")),
        "incident" => {
            let id = id.ok_or_else(|| BridgeError::invalid_arg("缺少事故 id"))?;
            sv.guard_incident_read(&id)
                .ok_or_else(|| BridgeError::internal("guard 事故读取失败（sidecar 不可用）"))
        }
        "resolve-incident" => {
            let id = id.ok_or_else(|| BridgeError::invalid_arg("缺少事故 id"))?;
            sv.guard_resolve_incident(&id)
                .ok_or_else(|| BridgeError::internal("guard 事故解决失败（sidecar 不可用）"))
        }
        other => Err(BridgeError::invalid_arg(&format!(
            "未知 guard 动作: {other}（可用：status/check/incident/resolve-incident）"
        ))),
    }
}

#[cfg(test)]
mod tests {
    /// guard:action 分发面锚点：四个动作分支（读面 + 轻量解）齐备，未知动作
    /// 兜底拒绝，写动作（snapshot/restore/repair）不得出现在分发面（仍走守护瀑布）。
    #[test]
    fn guard_action_routes_read_surface_shape() {
        let src = include_str!("guard.rs").replace("\r\n", "\n");
        let seg = src
            .split("pub fn guard_action")
            .nth(1)
            .and_then(|s| s.split("#[cfg(test)]").next())
            .expect("guard_action 函数体");
        for arm in ["\"status\"", "\"check\"", "\"incident\"", "\"resolve-incident\""] {
            assert!(seg.contains(arm), "guard_action 缺少动作分支 {arm}: {seg}");
        }
        // 未知动作兜底 + 只读面不含写动作。
        assert!(seg.contains("other =>"), "未知动作必须兜底拒绝: {seg}");
        for write in ["snapshot", "restore", "repair"] {
            assert!(!seg.contains(&format!("\"{write}\"")), "写动作 {write} 不得暴露在交互分发面（仍走守护瀑布）: {seg}");
        }
        // id 缺失必须回 invalid_arg（incident / resolve-incident 需要 id）。
        assert_eq!(seg.matches("缺少事故 id").count(), 2, "incident/resolve-incident 缺 id 都要回 invalid_arg: {seg}");
    }
}
