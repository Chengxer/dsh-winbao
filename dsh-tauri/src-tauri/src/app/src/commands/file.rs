//! 文件域命令（fence 围栏，ipc-commands.md §2.3）：file_open / file_revert。
//!
//! 越界拒绝语义 = contracts/error-codes.md §4 的 E_FENCE_ROOT。

use bridge::BridgeError;
use tauri::AppHandle;

use super::common::atomic_write;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
