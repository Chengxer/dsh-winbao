//! WSL 配置三通道（ipc-commands.md §2.3 / bridge-api.md §2.4；语义契约
//! wsl-backend.md §2——Electron dsh:wsl-config 三 IPC 的 Tauri 等价物）。
//!
//! v0.5.3 起随 supervisor WSL 分支实装解锁（061a8ba 的拒绝话术移除）：
//! - `wsl_config_get`：运行态 status 快照（supervisor 实例）+ 已保存配置回显
//!   + fallbackReason（启动期回落原因，设置页展示）。
//! - `wsl_config_save`：`backend=wsl` 先全量预检（= configure 探测链，异步
//!   线程——D6：探测数十秒绝不阻塞 IPC）；失败 `{ok:false,code,error}`
//!   **不落盘**；成功落盘三键 + `restartRequired:true`。
//! - `wsl_recheck`：用已保存配置强制重探测（get 同形态；失败不落盘）。
//!
//! 探测/命令编排全部在 `crates/wsl-backend`（纯 std，WslInvoker 注桩可测）。

use std::sync::Arc;

use bridge::BridgeError;
use tauri::{AppHandle, Manager};

use crate::AppState;

/// wsl 三通道契约载荷组装（纯函数，可单测）：
/// `{backend, wslDistro, wslInstallDir, status:{configured, distro, installDir,
/// nodeVersion, npmVersion, agentVersion, lastError}, fallbackReason}`。
fn wsl_config_payload(
    backend: &str,
    distro: &str,
    install_dir: &str,
    status: serde_json::Value,
    fallback_reason: &str,
) -> serde_json::Value {
    serde_json::json!({
        "backend": backend,
        "wslDistro": distro,
        "wslInstallDir": install_dir,
        "status": status,
        "fallbackReason": fallback_reason,
    })
}

/// 未配置/未探测的空 status（local 模式契约形态：configured=false、lastError
/// 空——local 不探测，回落态的错误在 fallbackReason）。
fn empty_status() -> serde_json::Value {
    serde_json::json!({
        "configured": false,
        "distro": "",
        "installDir": "",
        "nodeVersion": "",
        "npmVersion": "",
        "agentVersion": "",
        "lastError": "",
    })
}

/// 探测失败的 status 形态（recheck 强制探测路径：configured=false +
/// lastError 带人话原因；回显保存的 distro/installDir）。
fn failed_status(distro: &str, install_dir: &str, error: &str) -> serde_json::Value {
    serde_json::json!({
        "configured": false,
        "distro": distro,
        "installDir": install_dir,
        "nodeVersion": "",
        "npmVersion": "",
        "agentVersion": "",
        "lastError": error,
    })
}

/// 读 WSL 配置三键（纯逻辑，可单测）。扁平键 `backend` / `wslDistro` /
/// `wslInstallDir` 与 Electron `updater.loadSettings` 同键同文件（用户目录
/// 互迁不丢）；兼容迁移 0.5.0 早期误写的嵌套 `wslBackend` 键（扁平键优先）。
fn wsl_settings_load_from(store: &shell_core::SettingsStore) -> (String, String, String) {
    let map = store.load().unwrap_or_default();
    let cfg = wsl_backend::detect_backend_mode(&|_| None, &map);
    (cfg.backend, cfg.distro, cfg.install_dir)
}

/// WSL 配置校验（契约 §1.3；shell 元字符黑名单经 wsl-backend::spec 统一实现）。
fn validate_wsl_cfg(backend: &str, install_dir: &str) -> Result<(), String> {
    if backend != "local" && backend != "wsl" {
        return Err(format!("后端模式必须是 local 或 wsl（收到 {backend:?}）"));
    }
    if install_dir.is_empty() {
        return Ok(());
    }
    if !install_dir.starts_with('/') && !install_dir.starts_with('~') {
        return Err("WSL 安装目录必须是 WSL 内绝对路径（以 / 或 ~ 开头）".into());
    }
    if wsl_backend::spec::dir_forbidden(install_dir) {
        return Err("WSL 安装目录不能包含空白或 shell 特殊字符（$ ` ; & | < > 引号 括号）".into());
    }
    Ok(())
}

/// `backend=wsl` 保存预检（契约 §2.2：= configure 探测链）。invoker 参数化
/// 供注桩测试；生产恒 RealWslInvoker。
fn wsl_save_precheck(
    invoker: Arc<dyn wsl_backend::WslInvoker>,
    distro: &str,
    install_dir: &str,
) -> Result<serde_json::Value, wsl_backend::WslError> {
    let backend = wsl_backend::WslBackend::new(invoker);
    backend.configure(&wsl_backend::ConfigureOpts::from_env(distro, install_dir))?;
    Ok(backend.status_json())
}

#[tauri::command]
pub async fn wsl_config_get(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // supervisor 实例快照先取（State 不能跨 await；探测含 spawn wsl.exe 走
    // 异步线程——契约 §2.1「异步实现，不得阻塞 IPC 线程」）。
    let state = app.state::<AppState>();
    let settings_path = state.paths.settings.clone();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let store = shell_core::SettingsStore::new(settings_path);
        let (_saved_backend, distro, install_dir) = wsl_settings_load_from(&store);
        match &sv {
            Some(s) => wsl_config_payload(
                s.backend_effective(),
                &distro,
                &install_dir,
                s.wsl_status_json(),
                &s.fallback_reason(),
            ),
            // supervisor 未建立（PoC 模式/装配失败）：local 形态 + 空快照。
            None => wsl_config_payload("local", &distro, &install_dir, empty_status(), ""),
        }
    })
    .await
    .map_err(|e| BridgeError::internal(e.to_string()))?;
    Ok(payload)
}

/// 保存预检（后台线程跑真探测；失败 `{ok:false,code,error}` 不落盘）。
#[tauri::command]
pub async fn wsl_config_save(cfg: serde_json::Value, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    let backend = cfg.get("backend").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    let distro = cfg.get("wslDistro").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let install_dir = cfg.get("wslInstallDir").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if let Err(e) = validate_wsl_cfg(&backend, &install_dir) {
        // Electron 语义：配置错误以 {ok:false,error} 返回（设置页显示 error 文案）。
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }
    let state = app.state::<AppState>();
    let settings_path = state.paths.settings.clone();
    if backend == "wsl" {
        // 全量预检（契约 §2.2：= configure 探测链，异步上限见 §4.1 各步）。
        // 失败 {ok:false,code,error}，**不落盘**（不变量 §7.4）。
        let (d, i) = (distro.clone(), install_dir.clone());
        let precheck = tauri::async_runtime::spawn_blocking(move || {
            wsl_save_precheck(Arc::new(wsl_backend::RealWslInvoker), &d, &i)
        })
        .await
        .map_err(|e| BridgeError::internal(e.to_string()))?;
        if let Err(e) = precheck {
            return Ok(serde_json::json!({ "ok": false, "code": e.code, "error": e.message }));
        }
    }
    let store = shell_core::SettingsStore::new(settings_path);
    // 扁平键存储（与 Electron 同键；空值存空串，读取端 default 兜底）。
    // 旧嵌套 wslBackend 键不清理：读取端扁平键优先，自然废弃（清理需
    // SettingsStore 增加 remove API，收益不值契约面扩张）。
    for (k, v) in [("backend", serde_json::json!(backend)), ("wslDistro", serde_json::json!(distro)), ("wslInstallDir", serde_json::json!(install_dir))] {
        store.set(k, v).map_err(|e| BridgeError::internal(e.0))?;
    }
    Ok(serde_json::json!({ "ok": true, "restartRequired": true }))
}

#[tauri::command]
pub async fn wsl_recheck(app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    // Electron 语义：recheck 返回与 getConfig 同形态（status 强制重探测，
    // 预检失败不改变已保存配置，错误进 status.lastError）。
    let state = app.state::<AppState>();
    let settings_path = state.paths.settings.clone();
    let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        let store = shell_core::SettingsStore::new(settings_path);
        let (saved_backend, distro, install_dir) = wsl_settings_load_from(&store);
        let effective = match &sv {
            Some(s) => s.backend_effective(),
            None => "local",
        };
        if saved_backend != "wsl" {
            // local 不探测（契约 §2.1：local 模式 configured=false、lastError 空）。
            return wsl_config_payload(effective, &distro, &install_dir, empty_status(), "");
        }
        // 已保存配置强制重探测（fresh 实例，不动 supervisor 运行态）。
        let backend = wsl_backend::WslBackend::new(Arc::new(wsl_backend::RealWslInvoker));
        match backend.configure(&wsl_backend::ConfigureOpts::from_env(&distro, &install_dir)) {
            Ok(()) => wsl_config_payload(effective, &distro, &install_dir, backend.status_json(), ""),
            Err(e) => wsl_config_payload(effective, &distro, &install_dir, failed_status(&distro, &install_dir, &e.to_string()), ""),
        }
    })
    .await
    .map_err(|e| BridgeError::internal(e.to_string()))?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// wsl 三通道契约形态（bridge-api.md §2.4 / Electron dsh:wsl-config）：
    /// getConfig/recheck 必须返回 {backend, wslDistro, wslInstallDir, status,
    /// fallbackReason}——此前 `{mode:"local"}` / `{ok,available}` 形态不符是
    /// 设置页「WSL 后端」行空的根因（回归锚点）。
    #[test]
    fn wsl_config_payload_contract_shape() {
        let p = wsl_config_payload("local", "", "", empty_status(), "");
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
        // wsl 运行态：backend=wsl + 回落原因透出（#54 语义，设置页展示）。
        let p2 = wsl_config_payload(
            "wsl",
            "Ubuntu-24.04",
            "~/.dsh-desktop",
            serde_json::json!({
                "configured": true, "distro": "Ubuntu-24.04", "installDir": "/home/u/.dsh-desktop",
                "nodeVersion": "v20.11.0", "npmVersion": "10.2.4", "agentVersion": "", "lastError": "",
            }),
            "",
        );
        assert_eq!(p2["backend"], serde_json::json!("wsl"));
        assert_eq!(p2["status"]["configured"], serde_json::json!(true));
        let p3 = wsl_config_payload("local", "Ubuntu-24.04", "~/.dsh-desktop", failed_status("Ubuntu-24.04", "~/.dsh-desktop", "未检测到 WSL 发行版（E_WSL_UNAVAILABLE）"), "未检测到 WSL 发行版（E_WSL_UNAVAILABLE）");
        assert_eq!(p3["backend"], serde_json::json!("local"), "回落态 backend=local（运行态）");
        assert_eq!(p3["wslDistro"], serde_json::json!("Ubuntu-24.04"), "配置原样保留回显");
        assert_eq!(p3["status"]["lastError"], serde_json::json!("未检测到 WSL 发行版（E_WSL_UNAVAILABLE）"));
        assert!(p3["fallbackReason"].as_str().unwrap().contains("E_WSL_UNAVAILABLE"), "回落原因进 fallbackReason");
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

    /// wsl 配置校验：契约 §1.3 全表（shell 元字符黑名单经 wsl-backend spec）。
    #[test]
    fn wsl_config_validate_rules() {
        assert!(validate_wsl_cfg("local", "").is_ok());
        assert!(validate_wsl_cfg("wsl", "").is_ok());
        assert!(validate_wsl_cfg("wsl", "~/.dsh-desktop").is_ok());
        assert!(validate_wsl_cfg("wsl", "/opt/dsh").is_ok());
        assert!(validate_wsl_cfg("wsl", "/opt/中文目录").is_ok());
        assert!(validate_wsl_cfg("remote", "").is_err(), "backend 枚举外拒绝");
        assert!(validate_wsl_cfg("wsl", "C:\\dsh").is_err(), "非 WSL 绝对路径拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d sh").is_err(), "含空白拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d;sh").is_err(), "分号（命令拼接面）拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d$sh").is_err(), "美元符拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d`sh").is_err(), "反引号拒绝");
        assert!(validate_wsl_cfg("wsl", "/opt/d\"sh").is_err(), "双引号拒绝");
    }

    /// 保存预检分支表（注桩 invoker；生产 wsl_config_save 同链）：
    /// 预检失败 → WslError（code+人话，不落盘由调用方保证）；成功 → status。
    #[test]
    fn wsl_save_precheck_branches_with_stub() {
        use std::time::Duration;
        // 桩：无发行版。
        struct NoDistro;
        impl wsl_backend::WslInvoker for NoDistro {
            fn run_with_lines(
                &self,
                _d: &str,
                _c: &str,
                _t: Duration,
                _o: &mut (dyn FnMut(&str) + Send),
            ) -> wsl_backend::WslRunResult {
                wsl_backend::WslRunResult { ok: false, code: 1, timed_out: false, stdout: String::new(), stderr: String::new() }
            }
            fn list_distros(&self) -> Vec<String> {
                Vec::new()
            }
            fn spawn_server(&self, _d: &str, _c: &str) -> std::io::Result<std::process::Child> {
                Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "桩不 spawn"))
            }
        }
        let e = wsl_save_precheck(Arc::new(NoDistro), "", "").unwrap_err();
        assert_eq!(e.code, wsl_backend::E_WSL_UNAVAILABLE);
        assert!(!e.message.is_empty(), "人话错误信息（设置页展示）");
        // 全绿桩：configure 成功 → status 快照。
        struct AllGreen;
        impl wsl_backend::WslInvoker for AllGreen {
            fn run_with_lines(
                &self,
                _d: &str,
                cmd: &str,
                _t: Duration,
                _o: &mut (dyn FnMut(&str) + Send),
            ) -> wsl_backend::WslRunResult {
                let (stdout, code) = if cmd.contains("printf") {
                    ("/home/u\n".to_string(), 0)
                } else if cmd.contains("node --version") {
                    ("v20.11.0\n".to_string(), 0)
                } else if cmd.contains("npm --version") {
                    ("10.2.4\n".to_string(), 0)
                } else {
                    (String::new(), 1)
                };
                wsl_backend::WslRunResult { ok: code == 0, code, timed_out: false, stdout, stderr: String::new() }
            }
            fn list_distros(&self) -> Vec<String> {
                vec!["Ubuntu".into()]
            }
            fn spawn_server(&self, _d: &str, _c: &str) -> std::io::Result<std::process::Child> {
                Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "桩不 spawn"))
            }
        }
        let status = wsl_save_precheck(Arc::new(AllGreen), "", "").unwrap();
        assert_eq!(status["configured"], serde_json::json!(true));
        assert_eq!(status["distro"], serde_json::json!("Ubuntu"));
        // 显式 distro 不在名单 → 配置错误（#126 防御延伸）。
        let e = wsl_save_precheck(Arc::new(AllGreen), "Debian", "").unwrap_err();
        assert_eq!(e.code, wsl_backend::E_WSL_UNAVAILABLE);
        assert!(e.message.contains("Debian"));
    }

    /// 保存路径形态锚点：`backend=wsl` 必须**先预检后落盘**（不变量 §7.4：
    /// `{"ok":false}` 载荷错误不落盘）；预检在 spawn_blocking 后台线程（D6：
    /// 不得阻塞 IPC）。061a8ba 的拒绝话术与 status 通道假阳性探测已废
    ///（拼接构串避免测试字面量自匹配 include_str! 文本）。
    #[test]
    fn wsl_save_precheck_before_persist_shape() {
        let src = include_str!("wsl.rs").replace("\r\n", "\n");
        let seg = src
            .split("pub async fn wsl_config_save")
            .nth(1)
            .and_then(|s| s.split("pub async fn wsl_recheck").next())
            .expect("wsl_config_save 段");
        let precheck_pos = seg.find("wsl_save_precheck(").expect("预检调用");
        let persist_pos = seg.find("store.set(k, v)").expect("落盘");
        assert!(precheck_pos < persist_pos, "预检必须先于落盘（失败不落盘）");
        assert!(seg.contains("spawn_blocking"), "预检必须走后台线程（D6）");
        assert!(seg.contains("\"code\": e.code"), "失败载荷带 E_WSL_* code");
        // 061a8ba 的拒绝话术已移除。
        let refuse = ["暂未", "支持"].concat();
        assert!(!src.contains(&refuse), "拒绝话术随实装移除");
        // status 通道假阳性探测（061a8ba 实证：VM 起不来时 exit 0）不得回归。
        let status_probe = ["wsl", " --stat", "us"].concat();
        assert!(!src.contains(&status_probe), "不得用 status 通道判可用性（exit 0 假阳性）");
    }
}
