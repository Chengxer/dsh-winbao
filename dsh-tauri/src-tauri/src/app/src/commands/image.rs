//! 剪贴板粘贴图落盘（`image_paste_save`，ipc-commands.md §2.3 / bridge-api.md §2.5）。
//!
//! Electron imagePasteSave（main.js:2930）对齐：插件 client 已把粘贴图捕获为
//! dataUrl 字符串（真实场景测试 U2 确认），壳侧只需落盘——无需 clipboard 插件。

use bridge::BridgeError;

use super::common::b64_decode;

/// 错误码：图片粘贴域自用码，尚未登记 contracts/error-codes.md（见模块
/// 审查报告）——常量化但码值保持原样，防跨进程行为变更。
const E_IMAGE_PASTE: &str = "E_IMAGE_PASTE";

#[tauri::command]
pub fn image_paste_save(payload: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    image_paste_save_impl(&payload).map_err(|e| BridgeError::new(E_IMAGE_PASTE, &e))
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

#[cfg(test)]
mod image_paste_tests {
    use super::*;
    use crate::commands::b64;

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
