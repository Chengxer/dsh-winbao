//! ta14 — 「老用户升级到 v0.5.3」升级路径矩阵（shell-core 纯函数面）。
//!
//! 覆盖（与 dsh-desktop/scripts/test/ta14-upgrade-dirty-home.test.js 同一任务口径）：
//!   2) 便携 → 安装版语义：DSH_HOME / DSH_TAURI_USERDATA 覆盖 vs 默认两态的
//!      settings / logs 路径解析矩阵（`DshPaths::resolve_with` 注入式 + 生产
//!      覆盖通道 env 真读）；
//!   3) 降级容忍：0.5.3 数据（新版 settings 键）被旧版读者读取——未知键忽略、
//!      读-改-写保留、不损坏（`SettingsStore` 前向兼容契约）；
//!   f) 陈旧单实例锁：pid 已死 / pid 复用（活进程）/ 非法内容 → 启动不误判
//!      （`SingleInstanceGuard` 陈锁回收语义）。
//!
//! 环境变量用例集中在单个 #[test] 内串行执行（resolve / resolve_with 均读
//! 进程环境，避免并发互见——与 paths.rs 内 ENV_LOCK 同理）。

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use shell_core::{DshPaths, SettingsStore, SingleInstanceGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn temp_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("ta14-{}-{}-{}", tag, std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() % 1_000_000));
    fs::create_dir_all(&p).unwrap();
    p
}

/// 注入式解析助手（不触 env，测试向量纯净）。
fn paths(home: &str, appdata: &str, tmp: &str) -> DshPaths {
    let (h, a, t) = (home.to_string(), appdata.to_string(), tmp.to_string());
    DshPaths::resolve_with(
        |k| (k == "USERPROFILE").then(|| OsString::from(&h)),
        |k| (k == "APPDATA").then(|| OsString::from(&a)),
        |k| (k == "TEMP").then(|| OsString::from(&t)),
    )
}

// ---------------------------------------------------------------------------
// 2) 便携 → 安装版：路径解析矩阵
// ---------------------------------------------------------------------------

/// 默认态（安装版，无任何覆盖 env）：settings / logs 必须落在
/// %APPDATA%/dsh-desktop 下（与 Electron 版逐路径一致）。
#[test]
fn matrix_default_installed_layout() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = paths(
        r"C:\Users\legacy",
        r"C:\Users\legacy\AppData\Roaming",
        r"C:\Users\legacy\AppData\Local\Temp",
    );
    assert_eq!(p.dsh_home, PathBuf::from(r"C:\Users\legacy\.dsh"));
    assert_eq!(p.app_data, PathBuf::from(r"C:\Users\legacy\AppData\Roaming\dsh-desktop"));
    assert_eq!(p.settings, PathBuf::from(r"C:\Users\legacy\AppData\Roaming\dsh-desktop\settings.json"));
    assert_eq!(p.logs, PathBuf::from(r"C:\Users\legacy\AppData\Roaming\dsh-desktop\logs"));
    assert_eq!(p.quarantine, PathBuf::from(r"C:\Users\legacy\AppData\Roaming\dsh-desktop\plugin-quarantine"));
}

/// 覆盖态（便携版重定向，DSH_HOME / DSH_TAURI_USERDATA 生产通道）：
/// 根目录直接替换，不拼 .dsh / dsh-desktop —— 便携→安装版切换时两态
/// 的 settings / logs 落点互不串扰。
#[test]
fn matrix_portable_override_layout() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var("DSH_TEST_HOME");
    std::env::remove_var("DSH_TEST_APPDATA");
    std::env::remove_var("DSH_TEST_TMP");
    std::env::remove_var("DSH_HOME");
    std::env::remove_var("DSH_TAURI_USERDATA");

    // 只覆盖 DSH_HOME：app_data 仍走默认 %APPDATA%（半便携形态）。
    std::env::set_var("DSH_HOME", r"X:\portable\dsh-home");
    let p = DshPaths::resolve();
    assert_eq!(p.dsh_home, PathBuf::from(r"X:\portable\dsh-home"), "DSH_HOME 即 .dsh 根");
    // 真实断言：settings 仍由真实 %APPDATA% 推导（本机环境），不应被 DSH_HOME 影响。
    let real_appdata = std::env::var("APPDATA").unwrap_or_default();
    if !real_appdata.is_empty() {
        assert_eq!(p.app_data, PathBuf::from(&real_appdata).join("dsh-desktop"), "app_data 不受 DSH_HOME 影响");
        assert_eq!(p.logs, PathBuf::from(&real_appdata).join("dsh-desktop").join("logs"));
    }

    // 双覆盖（完整便携形态）：两根同时直接替换。
    std::env::set_var("DSH_TAURI_USERDATA", r"X:\portable\shell-ud");
    let p2 = DshPaths::resolve();
    assert_eq!(p2.dsh_home, PathBuf::from(r"X:\portable\dsh-home"));
    assert_eq!(p2.app_data, PathBuf::from(r"X:\portable\shell-ud"));
    assert_eq!(p2.settings, PathBuf::from(r"X:\portable\shell-ud\settings.json"));
    assert_eq!(p2.logs, PathBuf::from(r"X:\portable\shell-ud\logs"));

    // 清除覆盖后回到默认推导（升级用户拔掉便携 env 的回落）。
    std::env::remove_var("DSH_HOME");
    std::env::remove_var("DSH_TAURI_USERDATA");
    let p3 = DshPaths::resolve();
    assert!(p3.dsh_home.ends_with(".dsh"), "清除覆盖后 dsh_home 回落到 ~/.dsh");
    assert!(p3.app_data.ends_with("dsh-desktop"), "清除覆盖后 app_data 回落到 %APPDATA%/dsh-desktop");
}

/// 测试三件套优先级高于生产覆盖（升级期冒烟隔离不被便携 env 击穿）。
#[test]
fn matrix_test_env_wins_over_prod_override() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("DSH_HOME", r"X:\prod\home");
    std::env::set_var("DSH_TAURI_USERDATA", r"X:\prod\ud");
    std::env::set_var("DSH_TEST_HOME", r"X:\test\home");
    std::env::set_var("DSH_TEST_APPDATA", r"X:\test\ad");
    let p = DshPaths::resolve();
    std::env::remove_var("DSH_HOME");
    std::env::remove_var("DSH_TAURI_USERDATA");
    std::env::remove_var("DSH_TEST_HOME");
    std::env::remove_var("DSH_TEST_APPDATA");
    assert_eq!(p.dsh_home, PathBuf::from(r"X:\test\home"));
    assert_eq!(p.app_data, PathBuf::from(r"X:\test\ad"));
    assert_eq!(p.logs, PathBuf::from(r"X:\test\ad\logs"));
}

// ---------------------------------------------------------------------------
// 3) 降级容忍：0.5.3 数据被旧版读（前向兼容）
// ---------------------------------------------------------------------------

/// 旧版读者读 0.5.3 写出的 settings.json：未知新键能读则读（Value 任意 JSON
/// 均可承载）、读-改-写不丢失、不损坏。
#[test]
fn downgrade_tolerates_future_settings_keys() {
    let dir = temp_dir("downgrade");
    let file = dir.join("settings.json");
    // 0.5.3 现场新版键（旧版 schema 不认识）：嵌套对象 / 数组 / null / 大整数。
    let future_json = r#"{
  "lastWebPort": 51731,
  "futureFeatureFlag": { "enabled": true, "mode": "experimental", "nested": [1, 2, {"x": null}] },
  "futureTheme": "dark-pro",
  "futureCount": 9007199254740993,
  "futureNull": null
}"#;
    fs::write(&file, future_json).unwrap();

    // 「旧版读者」：同一存储原语（键无关），未知键取得到（能读则读）。
    let store = SettingsStore::new(&file);
    let map = store.load().unwrap();
    assert_eq!(map.len(), 5, "全部 0.5.3 键都应可读: {:?}", map.keys().collect::<Vec<_>>());
    assert_eq!(map.get("futureTheme"), Some(&serde_json::json!("dark-pro")));

    // 旧版只写自己认识的键 → 未知键原样保留（不删除、不改写）。
    store.set("lastWebPort", serde_json::json!(51800)).unwrap();
    let map2 = SettingsStore::new(&file).load().unwrap();
    assert_eq!(map2.get("lastWebPort"), Some(&serde_json::json!(51800)));
    assert_eq!(map2.get("futureTheme"), Some(&serde_json::json!("dark-pro")), "降级写回不得丢新键");
    assert_eq!(map2.get("futureCount"), Some(&serde_json::json!(9007199254740993i64)), "大整数精度不得损坏");
    assert!(map2.contains_key("futureNull") && map2.contains_key("futureFeatureFlag"), "null / 嵌套键保留");
    // 文件仍是合法 JSON（旧版再读不炸）。
    let raw = fs::read_to_string(&file).unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&raw).is_ok(), "降级写回后文件不得损坏");
    let _ = fs::remove_dir_all(&dir);
}

/// 0.5.3 的「新预设」数据对旧版只是字符串 / 未消费键：读忽略、写不损。
#[test]
fn downgrade_tolerates_new_preset_data() {
    let dir = temp_dir("preset-data");
    let file = dir.join("settings.json");
    fs::write(&file, r#"{"agentPreset": "minimal-win", "agentPresetOverrides": {"minimal-win": {"theme": "legacy"}}}"#).unwrap();
    let store = SettingsStore::new(&file);
    // 旧版不认识这些键：get 能取（能读则读），不取即忽略（不报错不损坏）。
    assert_eq!(store.get("agentPreset").unwrap(), Some(serde_json::json!("minimal-win")));
    let _ = store.get("never-touched").unwrap();
    store.set("windowWidth", serde_json::json!(1280)).unwrap();
    let map = SettingsStore::new(&file).load().unwrap();
    assert_eq!(map.len(), 3, "旧键新键并存: {:?}", map.keys().collect::<Vec<_>>());
    let _ = fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// f) 陈旧单实例锁：pid 已死 / 复用 / 非法 → 启动不误判
// ---------------------------------------------------------------------------

/// pid 已死（强杀残留 + 真实退出过的子进程 pid）→ 陈锁回收，正常拿锁。
#[test]
fn stale_lock_dead_pid_reclaimed() {
    let dir = temp_dir("lock-dead");
    let lock = dir.join("single-instance.lock");

    // 1) 大值 pid（几乎不可能存活，与 crate 内既有单测同手法）。
    fs::write(&lock, "3999999").unwrap();
    let mut g = SingleInstanceGuard::acquire(&lock).expect("死 pid 陈锁必须被回收");
    g.release();

    // 2) 真实「已退出」的子进程 pid（升级现场：上个实例被强杀，pid 已死）。
    let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) { ["/C", "exit 0"] } else { ["-c", "exit 0"] })
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("子进程应可 spawn");
    let dead_pid = child.id();
    let _ = child.wait();
    fs::write(&lock, dead_pid.to_string()).unwrap();
    let mut g2 = SingleInstanceGuard::acquire(&lock)
        .expect("已退出子进程的 pid 应判陈锁并回收");
    g2.release();
    let _ = fs::remove_dir_all(&dir);
}

/// pid 复用（锁内 pid 被无关活进程占用，含自身 pid）→ 判活不回收（保守，
/// 启动不误判为陈锁去删活实例的锁——宁可提示「已在运行」也不双开）。
#[test]
fn stale_lock_reused_live_pid_not_misjudged() {
    let dir = temp_dir("lock-live");
    let lock = dir.join("single-instance.lock");
    // 自身 pid 一定存活：锁不得被回收（第二实例拿锁失败 = 正确不误判）。
    fs::write(&lock, std::process::id().to_string()).unwrap();
    assert!(SingleInstanceGuard::acquire(&lock).is_err(), "活 pid 的锁不得被当陈锁回收");
    // 长寿系统进程 pid（Windows 上 4=System，Unix 上 1=init）同样是「复用为活进程」。
    let immortal = if cfg!(windows) { "4" } else { "1" };
    fs::write(&lock, immortal).unwrap();
    assert!(SingleInstanceGuard::acquire(&lock).is_err(), "被复用为系统进程的 pid 应判活");
    let _ = fs::remove_dir_all(&dir);
}

/// 锁内容非法（半写 / 空 / 垃圾）→ 按陈锁处理（宁可误删不锁死用户）。
#[test]
fn stale_lock_garbage_content_reclaimed() {
    let dir = temp_dir("lock-garbage");
    let lock = dir.join("single-instance.lock");
    for content in ["", "   \r\n", "not-a-pid", "12.5", "-1"] {
        fs::write(&lock, content).unwrap();
        let mut g = SingleInstanceGuard::acquire(&lock)
            .unwrap_or_else(|_| panic!("非法锁内容 ({content:?}) 应按陈锁回收"));
        g.release();
    }
    let _ = fs::remove_dir_all(&dir);
}

/// 升级链端到端：陈锁回收 → 拿锁 → Drop 自动释放 → 重装后（再次）可拿锁。
#[test]
fn lock_lifecycle_across_reinstall() {
    let dir = temp_dir("lock-reinstall");
    let lock = dir.join("single-instance.lock");
    // 第一代实例留下的强杀残留。
    fs::write(&lock, "3999999").unwrap();
    {
        let _g = SingleInstanceGuard::acquire(&lock).expect("残留锁应可回收");
        // 持锁期间第二实例（安装器并发启动）失败。
        assert!(SingleInstanceGuard::acquire(&lock).is_err());
    } // Drop → 锁文件删除
    assert!(!lock.exists(), "Drop 后锁文件应被删除");
    // 「重装」后首启：直接拿锁。
    let mut g = SingleInstanceGuard::acquire(&lock).expect("重装后应可拿锁");
    g.release();
    let _ = fs::remove_dir_all(&dir);
}
