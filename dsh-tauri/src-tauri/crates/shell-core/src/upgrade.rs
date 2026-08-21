//! Electron → Tauri 升级兼容（无痛升级：不丢任何用户数据）。
//!
//! ## 数据契约（与 Electron 版逐路径对齐）
//!
//! | 数据 | Electron 版 | Tauri 版处置 |
//! |------|-------------|--------------|
//! | `~/.dsh`（会话/密钥/profile/插件） | 内核直接读写 | **原样共用**（DSH_HOME 同源） |
//! | `%APPDATA%/dsh-desktop/settings.json` | updater.loadSettings | 同路径同 schema 读写；裁撤键**识别后忽略**（不删除——用户回退 Electron 不受损） |
//! | `%APPDATA%/dsh-desktop/window-state.json` | `{bounds:{x,y,width,height},maximized}` | **同文件同 schema 双向兼容**（Tauri 版保存也写此文件，回退 Electron 窗口位置不丢） |
//! | 便携版 `data/` | `PORTABLE_EXECUTABLE_DIR` → userData | 同语义重定向（便携版升级后数据随 exe 走） |
//! | logs / 隔离区 / self-heal-history | userData 下 | 同路径 |
//!
//! ## 便携版检测（对齐 main.js:5317，双通道命中任一）
//! 1. `PORTABLE_EXECUTABLE_DIR`（portable 启动器运行时注入）存在 → userData = `<该目录>/data`；
//! 2. exe 同级存在 `portable.marker` 标记文件（zip 便携版无启动器注入环境
//!    变量，分发 zip 内置该标记）→ userData = `<exe 目录>/data`。
//! 开发/冒烟重定向统一走 `DSH_TAURI_USERDATA`（data-flow.md §5.1 覆盖通道表；
//! Electron 线的 `DSH_DESKTOP_USERDATA` 不在本线消费，同名 helper 已随清偿移除）。

use std::path::PathBuf;

/// Electron 版 settings.json 中随「内核更新链删除 / 自研客户端更新链下线」
/// 而失效的键（contracts/ipc-commands.md §2.4）。识别后忽略，**绝不删除**。
pub const LEGACY_IGNORED_KEYS: &[&str] = &[
    "kernelUpdate",
    "agentUpdate",
    "pendingClientUpdate",
    "pendingClientVersion",
    "skipClientVersion",
    "clientUpdateAttempt",
    "clientUpdateSnoozeUntil",
    "clientUpdate",
];

/// 旧 settings 是否包含裁撤键（首启迁移报告用）。
pub fn legacy_keys_present(map: &serde_json::Map<String, serde_json::Value>) -> Vec<&'static str> {
    LEGACY_IGNORED_KEYS
        .iter()
        .copied()
        .filter(|k| map.contains_key(*k))
        .collect()
}

/// 便携版 userData 重定向（对齐 Electron main.js 语义）。
/// 返回 Some(portable_data_dir) 表示应把 userData 整体重定向到该目录。
///
/// 双通道检测：环境变量优先（启动器注入）；否则看 exe 同级 `portable.marker`
/// （zip 便携版：解压即用、无启动器，标记文件即便携身份）。
pub fn portable_user_data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("PORTABLE_EXECUTABLE_DIR") {
        return Some(PathBuf::from(d).join("data"));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    portable_marker_data_dir(dir)
}

/// 标记文件检测：`<dir>/portable.marker` 是文件 → 便携 data 目录。
/// 独立成函数便于单测（不依赖真实 exe 位置）。
fn portable_marker_data_dir(dir: &std::path::Path) -> Option<PathBuf> {
    if dir.join("portable.marker").is_file() {
        Some(dir.join("data"))
    } else {
        None
    }
}

/// Electron 版窗口状态文件（window-state.json，**不是** settings.json）。
#[derive(Debug, Clone, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

impl WindowState {
    /// 解析 Electron schema：`{bounds:{x,y,width,height}, maximized}`。
    /// 非法/越界值返回 None（对齐 Electron loadWindowState 的容错：首启/损坏 → 居中）。
    pub fn parse_legacy(raw: &str) -> Option<Self> {
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        let b = v.get("bounds")?;
        let (x, y, w, h) = (
            b.get("x")?.as_f64()?,
            b.get("y")?.as_f64()?,
            b.get("width")?.as_f64()?,
            b.get("height")?.as_f64()?,
        );
        // Electron 校验：Number.isFinite + 取整；另加尺寸钳制（防坏数据甩出屏幕）。
        if !(200.0..=16384.0).contains(&w) || !(120.0..=16384.0).contains(&h) || x.abs() > 32_000.0 || y.abs() > 32_000.0 {
            return None;
        }
        Some(Self {
            x: x.round() as i32,
            y: y.round() as i32,
            width: w,
            height: h,
            maximized: v.get("maximized").and_then(|m| m.as_bool()).unwrap_or(false),
        })
    }

    /// 序列化为 Electron 同构 JSON（Tauri 版保存也写回此格式——双向兼容）。
    pub fn to_legacy_json(&self) -> String {
        serde_json::json!({
            "bounds": { "x": self.x, "y": self.y, "width": self.width, "height": self.height },
            "maximized": self.maximized,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_window_state_roundtrip() {
        let raw = r#"{"bounds":{"x":120,"y":60,"width":1280.5,"height":820.25},"maximized":true}"#;
        let ws = WindowState::parse_legacy(raw).expect("Electron 样本应可解析");
        assert_eq!(ws, WindowState { x: 120, y: 60, width: 1280.5, height: 820.25, maximized: true });
        // 序列化回同构 JSON，Electron 版可再读（双向兼容）。
        let back = WindowState::parse_legacy(&ws.to_legacy_json()).unwrap();
        assert_eq!(back, ws);
    }

    #[test]
    fn legacy_window_state_rejects_bad_shapes() {
        // Electron 版真实损坏场景：缺 bounds / NaN 形态（非数字）/ 巨值。
        assert!(WindowState::parse_legacy("{}").is_none());
        assert!(WindowState::parse_legacy(r#"{"bounds":{"x":"a","y":0,"width":10,"height":10}}"#).is_none());
        assert!(WindowState::parse_legacy(r#"{"bounds":{"x":0,"y":0,"width":2,"height":1},"maximized":false}"#).is_none());
        assert!(WindowState::parse_legacy("not json").is_none());
        // 最大化为 true 但尺寸坏：仍拒绝（钳制优先于 maximize）。
        assert!(WindowState::parse_legacy(r#"{"bounds":{"x":0,"y":0,"width":9e9,"height":100},"maximized":true}"#).is_none());
    }

    #[test]
    fn legacy_keys_detection() {
        let mut m = serde_json::Map::new();
        m.insert("kernelUpdate".into(), serde_json::json!({"skipVersion": "0.1.0"}));
        m.insert("pet".into(), serde_json::json!({"autoOpen": true}));
        let got = legacy_keys_present(&m);
        assert_eq!(got, vec!["kernelUpdate"], "只报存在的裁撤键");
        assert!(!got.contains(&"pet"), "保留键不误报");
    }

    #[test]
    fn portable_redirect_env_semantics() {
        // 环境存在性由测试进程控制；这里验证映射语义本身。
        // （真实环境场景由 app 集成测试覆盖。）
        // 注：zip 便携版通道（exe 同级 portable.marker）在测试二进制旁不存在
        // 标记文件，故环境变量未设时必须返回 None。
        let dir = portable_user_data_dir();
        if std::env::var_os("PORTABLE_EXECUTABLE_DIR").is_some() {
            assert!(dir.unwrap().ends_with("data"), "便携重定向必须指向 data/");
        } else {
            assert!(dir.is_none());
        }
    }

    #[test]
    fn portable_marker_file_triggers_redirect() {
        // zip 便携版通道：exe 同级存在 portable.marker → userData = <dir>/data。
        let base = std::env::temp_dir().join(format!("dsh-marker-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // 无标记 → 非便携
        assert!(portable_marker_data_dir(&base).is_none(), "无 marker 不能误判便携");
        // 有标记 → 重定向到 data/
        std::fs::write(base.join("portable.marker"), b"DSH Desktop portable").unwrap();
        let got = portable_marker_data_dir(&base).expect("marker 存在必须命中");
        assert_eq!(got, base.join("data"), "重定向必须指向 exe 同级 data/");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn portable_marker_directory_shape_rejected() {
        // 防误判：同名「目录」不算标记（必须是普通文件）。
        let base = std::env::temp_dir().join(format!("dsh-marker-dir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("portable.marker")).unwrap();
        assert!(portable_marker_data_dir(&base).is_none(), "目录形态的 marker 不算");
        let _ = std::fs::remove_dir_all(&base);
    }
}
