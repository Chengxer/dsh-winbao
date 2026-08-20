//! # dsh-tauri-app —— 装配根
//!
//! 只做接线（#121「main 仅接线」原则）：
//! 状态装配 → 主窗（loading）→ supervisor 事件路由（就绪换页/崩溃恢复页/托盘通知）
//! → 桥 command 全量注册 → 托盘 → 退出清理（同步杀树）。
//!
//! 业务逻辑全部在 crates/ 与 sidecar/。
//!
//! 运行形态：
//! - 默认：loading 页 → sidecar boot → 内核拉起 → 就绪换页到内核 Web UI；
//! - `DSH_TAURI_POC=1`：PoC 回归模式（不拉内核，加载 PoC 页，Phase 0 验收复用）。

mod commands;
mod pages;
mod poc_page;
mod supervisor;
mod windows;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use supervisor::{Supervisor, SupervisorEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// supervisor 的共享句柄。
pub type SupervisorHandle = Arc<Supervisor>;

/// 桥侧运行时状态。
pub struct AppState {
    pub supervisor: Mutex<Option<SupervisorHandle>>,
    pub loading_url: Mutex<String>,
    pub recovery_url: Mutex<String>,
    pub heartbeats: AtomicU32,
    pub page_errors: AtomicU32,
    pub current_session: Mutex<Option<String>>,
    pub last_port: AtomicU32,
    pub paths: shell_core::DshPaths,
    /// supervisor 事件通道（restart_service 复用，保证换页/恢复页路由不断链）。
    pub supervisor_tx: Mutex<Option<std::sync::mpsc::Sender<SupervisorEvent>>>,
}

impl AppState {
    fn empty() -> Self {
        Self {
            supervisor: Mutex::new(None),
            loading_url: Mutex::new(String::new()),
            recovery_url: Mutex::new(String::new()),
            heartbeats: AtomicU32::new(0),
            page_errors: AtomicU32::new(0),
            current_session: Mutex::new(None),
            last_port: AtomicU32::new(0),
            paths: shell_core::DshPaths::resolve(),
            supervisor_tx: Mutex::new(None),
        }
    }
}

/// 测试用：环境变量互斥锁（DSH_TEST_HOME / DSH_HOME 变更期间串行化，
/// 防止并行测试读到中间态路径）。
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 进程级单实例锁（退出时 Drop 删锁文件；强杀残留由陈锁回收逻辑兜底）。
static INSTANCE_LOCK: std::sync::Mutex<Option<shell_core::SingleInstanceGuard>> = std::sync::Mutex::new(None);

/// 保存主窗状态——**window-state.json（Electron 同文件同 schema）**：
/// 升级用户窗口位置不丢，回退 Electron 也不丢（双向兼容，contracts 见
/// shell-core/src/upgrade.rs 数据契约表）。
pub fn save_window_state(state: &AppState, (x, y, w, h, maxed): (i32, i32, f64, f64, bool)) -> Result<(), bridge::BridgeError> {
    let ws = shell_core::WindowState { x, y, width: w, height: h, maximized: maxed };
    let file = window_state_file(state);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| bridge::BridgeError::internal(e.to_string()))?;
    }
    // 原子写（tmp+rename），与 Electron writeFileAtomic 同语义。
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, ws.to_legacy_json()).map_err(|e| bridge::BridgeError::internal(e.to_string()))?;
    std::fs::rename(&tmp, &file).map_err(|e| bridge::BridgeError::internal(e.to_string()))?;
    Ok(())
}

/// window-state.json 路径（userData 根，与 Electron windowStateFile() 一致）。
fn window_state_file(state: &AppState) -> std::path::PathBuf {
    state.paths.app_data.join("window-state.json")
}
fn load_window_state(state: &AppState) -> Option<(i32, i32, f64, f64, bool)> {
    let file = window_state_file(state);
    let raw = std::fs::read_to_string(file).ok()?;
    let ws = shell_core::WindowState::parse_legacy(&raw)?;
    Some((ws.x, ws.y, ws.width, ws.height, ws.maximized))
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Phase 1
            commands::app_init,
            commands::window_control,
            commands::menu_action,
            commands::copy_text,
            commands::open_external,
            commands::file_open,
            commands::page_error,
            commands::renderer_heartbeat,
            commands::current_session,
            commands::restart_service,
            commands::recovery_state,
            commands::recovery_reload,
            commands::recovery_restart,
            commands::recovery_open_logs,
            commands::sponsor_window,
            commands::float_window,
            commands::float_close,
            // Phase 2
            commands::plugin_list,
            commands::plugin_set_enabled,
            commands::plugin_uninstall,
            commands::plugin_restore,
            commands::plugin_check_updates,
            commands::plugin_update,
            // Phase 3
            commands::file_revert,
            commands::image_paste_save,
            commands::balance_refresh,
            commands::diag_run,
            commands::diag_export,
            commands::diag_validate,
            commands::diag_order,
            commands::diag_order_apply,
            commands::diag_remove_bundle,
            commands::backup_export,
            commands::backup_restore,
            commands::wsl_config_get,
            commands::wsl_config_save,
            commands::wsl_recheck,
            commands::pet_window,
            commands::pet_close,
            commands::pet_move_to,
            commands::pet_set_auto_open,
            commands::sponsor_qr,
            // PoC 工具（非契约成员）
            commands::poc_echo_json,
        ])
        .build(tauri::generate_context!())
        .expect("tauri 构建")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Some(sv) = state.supervisor.lock().unwrap().clone() {
                            sv.shutdown();
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    // std::process::exit 不跑 Drop：锁与内核树在此显式收尾
                    //（Review#2：exit(0) 后锁残留实测）。
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Some(sv) = state.supervisor.lock().unwrap().clone() {
                            sv.shutdown();
                        }
                    }
                    if let Some(mut g) = INSTANCE_LOCK.lock().unwrap().take() {
                        g.release();
                    }
                }
                _ => {}
            }
        });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // ---- 升级适配：便携版 userData 重定向（Electron main.js:5317 同语义）----
    // 顺序必须在「读取任何 userData 路径」之前：paths/锁/日志全部随之落到 data/。
    if let Some(portable) = shell_core::upgrade::portable_user_data_dir() {
        // 重定向方式：环境变量注入（shell-core paths 的 dev 覆盖通道复用，
        // 语义 = Electron app.setPath('userData', portable)）。
        std::env::set_var("DSH_TAURI_USERDATA", &portable);
        eprintln!("[upgrade] 便携版运行：userData → {}", portable.display());
    }
    let state = AppState::empty();
    upgrade_first_run_report(&state);
    // ---- 静态页（loading / recovery / poc）经 preview-server 托管 ----
    let dir = std::env::temp_dir().join(format!("dsh-tauri-pages-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("loading.html"), pages::LOADING_HTML)?;
    std::fs::write(dir.join("recovery.html"), pages::RECOVERY_HTML)?;
    std::fs::write(dir.join("poc.html"), poc_page::POC_PAGE_HTML)?;
    let srv = preview_server::PreviewServer::start(&dir)?;
    let loading_url = srv.url("loading.html");
    let recovery_url = srv.url("recovery.html");
    *state.loading_url.lock().unwrap() = loading_url.clone();
    *state.recovery_url.lock().unwrap() = recovery_url.clone();
    std::mem::forget(srv);

    // ---- 单实例锁 ----
    let paths = shell_core::DshPaths::resolve();
    let guard = shell_core::SingleInstanceGuard::acquire(paths.app_data.join("single-instance.lock"))
        .map_err(|_| "DSH Desktop 已在运行")?;
    *INSTANCE_LOCK.lock().unwrap() = Some(guard);

    // ---- 主窗 ----
    let poc_mode = std::env::var("DSH_TAURI_POC").ok().as_deref() == Some("1");
    let saved = load_window_state(&state);
    let initial_url = if poc_mode {
        loading_url.replace("loading.html", "poc.html")
    } else {
        loading_url.clone()
    };
    windows::create_main_window(app.handle(), &initial_url, saved)?;

    // ---- supervisor（PoC 模式不起内核）----
    let supervisor = Arc::new(Supervisor::new(&find_repo_root()?));
    *state.supervisor.lock().unwrap() = Some(Arc::clone(&supervisor));
    app.manage(state);

    if !poc_mode {
        let preferred = load_preferred_port(app.handle());
        let (tx, rx) = std::sync::mpsc::channel::<SupervisorEvent>();
        if let Some(st) = app.try_state::<AppState>() {
            *st.supervisor_tx.lock().unwrap() = Some(tx.clone());
        }
        supervisor.spawn_boot(tx, preferred);
        let handle = app.handle().clone();
        std::thread::spawn(move || route_events(handle, rx));
    }

    setup_tray(app.handle())?;
    Ok(())
}

/// supervisor 事件路由：换页 / 恢复页 / 通知 / 端口记忆。
fn route_events(app: tauri::AppHandle, rx: std::sync::mpsc::Receiver<SupervisorEvent>) {
    while let Ok(ev) = rx.recv() {
        match ev {
            SupervisorEvent::BootStep { name, ok, ms, error } => {
                let _ = app.emit("boot-step", serde_json::json!({ "name": name, "ok": ok, "ms": ms, "error": error }));
            }
            SupervisorEvent::KernelReady { url, port } => {
                let _ = app.emit("kernel-ready", serde_json::json!({ "url": url }));
                if let Some(state) = app.try_state::<AppState>() {
                    state.last_port.store(port as u32, Ordering::Relaxed);
                    // 端口稳定化记忆（下次启动优先复用 → origin 稳定 → localStorage 偏好不丢）。
                    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
                    let _ = store.set("lastWebPort", serde_json::json!(port));
                }
                let _ = commands::navigate_main(&app, &url);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            SupervisorEvent::KernelExit { code, .. } => {
                eprintln!("[route] 内核退出 code={code:?}");
            }
            SupervisorEvent::CrashLoop { .. } => {
                let _ = app.emit("kernel-fail", serde_json::json!({ "reason": "内核反复异常退出" }));
                if let Some(state) = app.try_state::<AppState>() {
                    let recovery = state.recovery_url.lock().unwrap().clone();
                    let _ = commands::navigate_main(&app, &recovery);
                }
                let _ = app.notification().builder()
                    .title("DSH Desktop")
                    .body("内核服务反复异常退出，已进入恢复模式")
                    .show();
            }
            SupervisorEvent::ProbeFailed { consecutive } => {
                eprintln!("[route] 探活失败 ×{consecutive}");
            }
            SupervisorEvent::StateChanged(_) => {}
        }
    }
}

fn load_preferred_port(app: &tauri::AppHandle) -> Option<u16> {
    let state = app.try_state::<AppState>()?;
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    store.get("lastWebPort").ok()?.and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok())
}

fn find_repo_root() -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    // 开发态：manifest 向上找 dsh-desktop/vendor/node。
    let mut dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..6 {
        if dir.join("dsh-desktop").join("vendor").join("node").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    Err("未找到仓库根（dsh-desktop/vendor/node）".into())
}

/// 托盘：显示主窗 / 打开日志 / 退出（退出前同步杀树）。
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = tauri::menu::MenuBuilder::new(app)
        .text("show", "显示主窗口")
        .text("logs", "打开日志")
        .separator()
        .text("quit", "退出")
        .build()?;
    let tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().ok_or("无应用图标")?)
        .tooltip("DSH Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "logs" => {
                let dir = shell_core::DshPaths::resolve().logs;
                let _ = std::fs::create_dir_all(&dir);
                #[cfg(windows)]
                let _ = std::process::Command::new("explorer").arg(&dir).spawn();
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(sv) = state.supervisor.lock().unwrap().clone() {
                        sv.shutdown();
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    // 托盘生命周期：随进程退出回收；Drop 会摘图标，进程内需常驻 → forget。
    std::mem::forget(tray);
    Ok(())
}


// ---------------------------------------------------------------------------
// Review #1 固化：注册命令面 vs 契约映射表的机器核对（防漂移）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod contract_audit {
    use bridge::commands::CHANNELS;

    /// 从 lib.rs 源码提取 invoke_handler 注册的命令（`commands::name` 形态）。
    fn registered() -> Vec<&'static str> {
        let src = include_str!("lib.rs");
        let segment = src
            .split("generate_handler![")
            .nth(1)
            .and_then(|s| s.split(']').next())
            .expect("invoke_handler 段");
        segment
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter_map(|tok| tok.trim().strip_prefix("commands::"))
            .map(|name| name.trim())
            .filter(|n| !n.is_empty())
            .collect()
    }

    #[test]
    fn every_uncut_contract_command_is_registered() {
        let reg = registered();
        for c in CHANNELS.iter().filter(|c| !c.cut) {
            assert!(
                reg.contains(&c.tauri) || c.tauri == "guard_action",
                "契约命令未注册: {}（{}）",
                c.tauri,
                c.electron
            );
        }
    }

    #[test]
    fn no_extra_commands_beyond_contract_and_poc() {
        let known: Vec<&str> = CHANNELS.iter().map(|c| c.tauri).chain(["poc_echo_json"]).collect();
        for r in registered() {
            assert!(known.contains(&r), "注册了契约外命令: {r}（需入契约或移除）");
        }
    }

    #[test]
    fn cut_channel_not_registered() {
        let reg = registered();
        assert!(!reg.contains(&"guard_action"), "裁撤命令不得注册");
    }
}

#[cfg(test)]
mod window_state_tests {
    use super::*;

    fn sandbox_env(tag: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("dsh-tauri-ws-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DSH_TEST_HOME", &home);
        std::env::set_var("DSH_TEST_APPDATA", home.join("appdata"));
        std::env::set_var("DSH_TEST_TMP", home.join("tmp"));
        home
    }

    fn clear_env() {
        std::env::remove_var("DSH_TEST_HOME");
        std::env::remove_var("DSH_TEST_APPDATA");
        std::env::remove_var("DSH_TEST_TMP");
    }

    /// 窗口状态 save→load roundtrip（window-state.json，Electron 同构）。
    #[test]
    fn window_state_roundtrip_and_clamps() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox_env("rt");
        let state = AppState::empty();
        save_window_state(&state, (120, 60, 1280.0, 820.0, true)).unwrap();
        assert_eq!(load_window_state(&state), Some((120, 60, 1280.0, 820.0, true)));
        // 文件名/schema 双断言（升级兼容硬契约）。
        let file = state.paths.app_data.join("window-state.json");
        assert!(file.exists(), "必须落在 window-state.json（Electron 同名）");
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"bounds\"") && raw.contains("\"maximized\""), "Electron schema：{raw}");
        // 坏尺寸（窗口被甩出屏幕的防护）→ None 回退默认。
        save_window_state(&state, (5, 5, 2.0, 1.0, false)).unwrap();
        assert_eq!(load_window_state(&state), None, "非法尺寸应拒绝恢复");
        clear_env();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 升级场景：Electron 版用户已有 window-state.json → Tauri 版原样恢复。
    #[test]
    fn electron_window_state_upgrades_verbatim() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox_env("upg");
        let state = AppState::empty();
        // Electron 版真实样本（main.js loadWindowState 消费的同 schema）。
        std::fs::create_dir_all(&state.paths.app_data).unwrap();
        std::fs::write(
            state.paths.app_data.join("window-state.json"),
            r#"{"bounds":{"x":331,"y":211,"width":1188,"height":761},"maximized":false}"#,
        )
        .unwrap();
        assert_eq!(load_window_state(&state), Some((331, 211, 1188.0, 761.0, false)), "旧版窗口状态应原样恢复");
        // Tauri 版保存后 Electron 版仍可读（双向）。
        save_window_state(&state, (10, 20, 1024.0, 768.0, true)).unwrap();
        let raw = std::fs::read_to_string(state.paths.app_data.join("window-state.json")).unwrap();
        let ws = shell_core::WindowState::parse_legacy(&raw).expect("回写后 Electron 语义可解析");
        assert_eq!((ws.x, ws.y, ws.width, ws.height, ws.maximized), (10, 20, 1024.0, 768.0, true));
        clear_env();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 升级场景：旧 settings.json 含裁撤键 → 加载不炸、识别（不删除，可回退）。
    #[test]
    fn legacy_settings_keys_ignored_not_deleted() {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox_env("legacy");
        let state = AppState::empty();
        std::fs::create_dir_all(&state.paths.app_data).unwrap();
        let raw = r#"{
  "kernelUpdate": { "skipVersion": "0.1.0-rc.7" },
  "pendingClientUpdate": { "path": "C:\\x.exe", "version": "0.4.1" },
  "skipClientVersion": "0.4.0",
  "lastWebPort": 51731,
  "pet": { "autoOpen": true }
}"#;
        std::fs::write(state.paths.settings.clone(), raw).unwrap();
        let store = shell_core::SettingsStore::new(state.paths.settings.clone());
        let map = store.load().unwrap();
        // 首启报告：识别裁撤键。
        let legacy = shell_core::upgrade::legacy_keys_present(&map);
        assert!(legacy.contains(&"kernelUpdate") && legacy.contains(&"pendingClientUpdate"), "{legacy:?}");
        // 保留键照常消费。
        assert_eq!(map.get("lastWebPort"), Some(&serde_json::json!(51731)));
        assert_eq!(map.get("pet").and_then(|p| p.get("autoOpen")), Some(&serde_json::json!(true)));
        // 不删除：Tauri 写入新键后裁撤键仍在（可安全回退 Electron）。
        store.set("lastWebPort", serde_json::json!(60000)).unwrap();
        let after = store.load().unwrap();
        assert!(after.contains_key("kernelUpdate"), "裁撤键必须原样保留（回退兼容）");
        assert_eq!(after.get("lastWebPort"), Some(&serde_json::json!(60000)));
        clear_env();
        let _ = std::fs::remove_dir_all(&home);
    }
}

/// 升级首启报告（只读，绝不改写用户数据）：识别 Electron 版遗留物并落日志。
/// - settings.json 中的裁撤键（内核更新链/自研客户端更新链）→ 列出并忽略；
/// - window-state.json 存在 → 窗口位置将按 Electron schema 恢复；
/// - ~/.dsh 与 userData 全程不动（升级零迁移：同路径同 schema 直读）。
fn upgrade_first_run_report(state: &AppState) {
    let store = shell_core::SettingsStore::new(state.paths.settings.clone());
    if let Ok(map) = store.load() {
        let legacy = shell_core::upgrade::legacy_keys_present(&map);
        if !legacy.is_empty() {
            eprintln!("[upgrade] 识别到 Electron 版遗留设置键（已忽略，不删除，可安全回退）：{legacy:?}");
        }
    }
    if state.paths.app_data.join("window-state.json").exists() {
        eprintln!("[upgrade] 检测到 Electron 版 window-state.json：窗口位置将原样恢复");
    }
}
