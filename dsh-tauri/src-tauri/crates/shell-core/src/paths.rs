//! 持久化路径解析。
//!
//! 契约（data-flow.md §5）：与 Electron 版逐路径一致：
//!
//! | 数据 | 路径 |
//! |------|------|
//! | dsh home | `%USERPROFILE%/.dsh` |
//! | 用户设置 | `%APPDATA%/dsh-desktop/settings.json` |
//! | 日志 | `%APPDATA%/dsh-desktop/logs/desktop.log` |
//! | 隔离区 | `%APPDATA%/dsh-desktop/plugin-quarantine/` |
//! | 粘贴临时 | `%TEMP%/dsh-paste/` |
//!
//! 覆盖通道两套：
//! - **生产覆盖**（sidecar cli.js 的 resolveHome/resolveUserData 同口径，
//!   便携版 userData 重定向与安装布局冒烟共用）：
//!   `DSH_HOME`（dsh home 根，直接替换）、`DSH_TAURI_USERDATA`（壳 AppData
//!   根，直接替换）。两侧必须同时生效——只有 Node 侧生效时，便携重定向/
//!   冒烟隔离在 Rust 侧是「幽灵变量」（曾实测：隔离 ud 为空而 Rust 侧仍读
//!   到真实 %APPDATA% 的 window-state.json）。
//! - 测试覆盖：`DSH_TEST_HOME` / `DSH_TEST_APPDATA` / `DSH_TEST_TMP`
//!   （优先级最高）。

use std::env;
use std::path::PathBuf;

/// 全部持久化路径的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DshPaths {
    /// dsh 内核 home（`~/.dsh`）：profiles / cordis.patch.yml 所在。
    pub dsh_home: PathBuf,
    /// 桌面壳 AppData 根（`%APPDATA%/dsh-desktop`）。
    pub app_data: PathBuf,
    /// 设置文件。
    pub settings: PathBuf,
    /// 日志目录（含 desktop.log）。
    pub logs: PathBuf,
    /// 插件隔离区。
    pub quarantine: PathBuf,
    /// 图片粘贴临时目录。
    pub paste_tmp: PathBuf,
}

impl DshPaths {
    /// 从环境解析（生产路径）。Windows 之外的平台上按同结构推导（非目标平台，
    /// 仅保证单测可跑）。
    pub fn resolve() -> Self {
        Self::resolve_with(|k| env::var_os(k), |k| env::var_os(k), |k| env::var_os(k))
    }

    /// 注入式解析（测试用）：三个取值函数分别对应 home / appdata / tmp。
    pub fn resolve_with(
        home: impl Fn(&str) -> Option<std::ffi::OsString>,
        appdata: impl Fn(&str) -> Option<std::ffi::OsString>,
        tmp: impl Fn(&str) -> Option<std::ffi::OsString>,
    ) -> Self {
        let test_home = env::var_os("DSH_TEST_HOME");
        let test_appdata = env::var_os("DSH_TEST_APPDATA");
        let test_tmp = env::var_os("DSH_TEST_TMP");
        let home_dir = test_home
            .clone()
            .or_else(|| home("USERPROFILE").or_else(|| home("HOME")))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let appdata_dir = test_appdata
            .clone()
            .or_else(|| appdata("APPDATA"))
            .unwrap_or_else(|| home("USERPROFILE").unwrap_or_default());
        let tmp_dir = test_tmp
            .or_else(|| tmp("TEMP").or_else(|| tmp("TMP")))
            .unwrap_or_else(|| tmp("TEMP").unwrap_or_default());

        // 生产覆盖通道（sidecar resolveHome/resolveUserData 逐字对齐）：
        // DSH_HOME / DSH_TAURI_USERDATA 都是「根目录直接替换」——DSH_HOME 即
        // ~/.dsh 等价物（sidecar：home/profiles/web），DSH_TAURI_USERDATA 即
        // %APPDATA%/dsh-desktop 等价物；测试三件套优先级更高。
        let dsh_home = test_home
            .or_else(|| env::var_os("DSH_HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".dsh"));
        let app_data = test_appdata
            .or_else(|| env::var_os("DSH_TAURI_USERDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(appdata_dir).join("dsh-desktop"));
        Self {
            settings: app_data.join("settings.json"),
            logs: app_data.join("logs"),
            quarantine: app_data.join("plugin-quarantine"),
            paste_tmp: PathBuf::from(tmp_dir).join("dsh-paste"),
            dsh_home,
            app_data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    /// 环境变量互斥：resolve_with 读进程环境（DSH_HOME / DSH_TAURI_USERDATA
    /// 生产覆盖通道），注入式用例与 env 用例必须串行，否则并发互见（实测
    /// windows_layout 用例读到 env 用例设置的 X:\smoke\home）。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn paths(home: &str, appdata: &str, tmp: &str) -> DshPaths {
        let (h, a, t) = (home.to_string(), appdata.to_string(), tmp.to_string());
        DshPaths::resolve_with(
            |k| (k == "USERPROFILE").then(|| OsString::from(&h)),
            |k| (k == "APPDATA").then(|| OsString::from(&a)),
            |k| (k == "TEMP").then(|| OsString::from(&t)),
        )
    }

    #[test]
    fn windows_layout_matches_electron() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = paths(r"C:\Users\u", r"C:\Users\u\AppData\Roaming", r"C:\Users\u\AppData\Local\Temp");
        assert_eq!(p.dsh_home, PathBuf::from(r"C:\Users\u\.dsh"));
        assert_eq!(p.settings, PathBuf::from(r"C:\Users\u\AppData\Roaming\dsh-desktop\settings.json"));
        assert_eq!(p.logs, PathBuf::from(r"C:\Users\u\AppData\Roaming\dsh-desktop\logs"));
        assert_eq!(p.quarantine, PathBuf::from(r"C:\Users\u\AppData\Roaming\dsh-desktop\plugin-quarantine"));
        assert_eq!(p.paste_tmp, PathBuf::from(r"C:\Users\u\AppData\Local\Temp\dsh-paste"));
    }

    #[test]
    fn app_data_root_exposed() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let p = paths("/home/u", "/home/u/.config", "/tmp");
        assert_eq!(p.app_data, PathBuf::from("/home/u/.config/dsh-desktop"));
        assert!(p.settings.starts_with(&p.app_data));
    }

    /// 生产覆盖通道（DSH_HOME / DSH_TAURI_USERDATA）：直接替换根目录，
    /// 不再拼 .dsh / dsh-desktop——与 sidecar resolveHome/resolveUserData 同口径。
    /// 本 crate 测试二进制内仅此用例读写环境变量（其余用注入式），无并行互见。
    #[test]
    fn prod_override_channels_replace_roots_directly() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("DSH_TEST_HOME");
        std::env::remove_var("DSH_TEST_APPDATA");
        std::env::remove_var("DSH_TEST_TMP");
        std::env::set_var("DSH_HOME", r"X:\smoke\home");
        std::env::set_var("DSH_TAURI_USERDATA", r"X:\smoke\ud");
        let p = DshPaths::resolve();
        std::env::remove_var("DSH_HOME");
        std::env::remove_var("DSH_TAURI_USERDATA");
        assert_eq!(p.dsh_home, PathBuf::from(r"X:\smoke\home"), "DSH_HOME 即 .dsh 根（sidecar 同口径），不再拼 .dsh");
        assert_eq!(p.app_data, PathBuf::from(r"X:\smoke\ud"), "DSH_TAURI_USERDATA 即壳 AppData 根，不再拼 dsh-desktop");
        assert_eq!(p.settings, PathBuf::from(r"X:\smoke\ud\settings.json"));
    }
}
