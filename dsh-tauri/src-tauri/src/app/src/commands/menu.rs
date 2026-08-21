//! ⋯ 菜单动作分发（`menu_action`，bridge-api.md §2.3 的 13 个 act 枚举）+
//! settings 单键开关 helper + npm latest 版本比对（check-agent-update 最简链）。

use bridge::BridgeError;
use tauri::{AppHandle, Manager};

use crate::AppState;

use super::common::{open_http_url, open_in_explorer, terr, NoWindow};

#[tauri::command]
pub async fn menu_action(action: String, payload: Option<serde_json::Value>, app: AppHandle) -> Result<serde_json::Value, BridgeError> {
    match action.as_str() {
        "open-logs" => {
            let dir = shell_core::DshPaths::resolve().logs;
            let _ = std::fs::create_dir_all(&dir);
            open_in_explorer(&dir)
        }
        "open-browser" => {
            let url = payload
                .and_then(|p| p.get("url").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| {
                    app.state::<AppState>()
                        .supervisor
                        .lock().unwrap_or_else(|p| p.into_inner())
                        .clone()
                        .and_then(|s| s.kernel_url())
                        .unwrap_or_else(|| "http://127.0.0.1".into())
                });
            open_http_url(&url)
        }
        "check-agent-update" => {
            // 最简可行 agent 更新检查（sidecar 暂无 agent-check-update 子命令，
            // 且 sidecar/ 属他人域不动）：本地版本 = 内核目录 @deepseek-ai/dsh
            // package.json（supervisor.kernel_version），远端 = npm registry
            // latest（双源镜像）。完整下载/替换链后续接（Electron runUpdateFlow
            // 的对应物）；菜单侧只消费 {current,latest,hasUpdate} 就地展示。
            let current = {
                let state = app.state::<AppState>();
                let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
                sv.map(|s| s.kernel_version.clone()).unwrap_or_else(|| "unknown".into())
            };
            // PowerShell 子进程阻塞至多 ~16s（双源×8s），挪出 async 运行时线程。
            let latest = tauri::async_runtime::spawn_blocking(|| npm_latest_version("@deepseek-ai/dsh"))
                .await
                .map_err(|e| BridgeError::internal(format!("agent 更新检查: {e}")))??;
            Ok(serde_json::json!({
                "ok": true,
                "current": current,
                "latest": latest,
                // 语义化比较（非字符串不等）：防 registry 落后于内置包的降级误报
                //（实测 npmmirror latest 0.1.0-rc.7 < 内置 0.1.0-rc.8）。
                "hasUpdate": !latest.is_empty() && compare_versions(&latest, &current) == std::cmp::Ordering::Greater,
            }))
        }
        "reload" => {
            // Electron reloadMainWindow 语义：当前页软重载（内核 SPA 状态丢失可接受）。
            let win = main_window(&app)?;
            win.eval("try{location.reload()}catch(e){}").map_err(terr)?;
            Ok(serde_json::Value::Null)
        }
        "devtools" => {
            // open_devtools 仅 debug 构建可用（release 无 devtools feature）。
            #[cfg(debug_assertions)]
            {
                let win = main_window(&app)?;
                win.open_devtools();
                Ok(serde_json::json!({ "ok": true }))
            }
            #[cfg(not(debug_assertions))]
            {
                Ok(serde_json::json!({ "ok": false, "error": "开发者工具仅开发版可用" }))
            }
        }
        "fullscreen" => {
            let win = main_window(&app)?;
            let now = win.is_fullscreen().map_err(terr)?;
            win.set_fullscreen(!now).map_err(terr)?;
            Ok(serde_json::json!({ "fullscreen": !now }))
        }
        "about" => {
            let kernel = {
                let state = app.state::<AppState>();
                let sv = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone();
                sv.map(|s| s.kernel_version.clone()).unwrap_or_else(|| "未装配".into())
            };
            Ok(serde_json::json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "kernelVersion": kernel,
            }))
        }
        "quit" => {
            // 托盘「退出」同语义（lib.rs setup_tray）：先同步杀内核树（shutdown，
            // Job Object），再 exit(0)——RunEvent::Exit 再做锁与收尾。
            if let Some(state) = app.try_state::<AppState>() {
                if let Some(sv) = state.supervisor.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    sv.shutdown();
                }
            }
            app.exit(0);
            Ok(serde_json::Value::Null)
        }
        "toggle-notify" | "toggle-close-to-tray" | "toggle-balance" => {
            let key = toggle_key(&action);
            let state = app.state::<AppState>();
            let store = shell_core::SettingsStore::new(state.paths.settings.clone());
            let next = toggle_setting(&store, key).map_err(|e| BridgeError::internal(e.0))?;
            // 单键返回（垫片 merge 进菜单 state 后重渲染）。
            let mut out = serde_json::Map::new();
            out.insert(key.to_string(), serde_json::json!(next));
            Ok(serde_json::Value::Object(out))
        }
        "check-client-update" => {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| BridgeError::updater_network(e.to_string()))?;
            if std::env::var("DSH_UPDATER_ENDPOINT").ok().is_none() {
                return Err(BridgeError::updater_config("更新通道未配置（DSH_UPDATER_ENDPOINT/DSH_UPDATER_PUBKEY），发版 CI 注入"));
            }
            let update = updater.check().await.map_err(|e| BridgeError::updater_network(e.to_string()))?;
            match update {
                Some(u) => Ok(serde_json::json!({ "ok": true, "version": u.version, "notes": u.body, "downloadAndInstall": "经 dshDesktop.menu.action('install-client-update')" })),
                None => Ok(serde_json::json!({ "ok": true, "upToDate": true })),
            }
        }
        "install-client-update" => {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| BridgeError::updater_network(e.to_string()))?;
            let update = updater.check().await.map_err(|e| BridgeError::updater_network(e.to_string()))?
                .ok_or_else(|| BridgeError::not_found("已是最新版本"))?;
            update.download_and_install(|_, _| {}, || {}).await.map_err(|e| BridgeError::updater_signature(e.to_string()))?;
            Ok(serde_json::json!({ "ok": true, "installed": update.version }))
        }
        other => Err(BridgeError::invalid_arg(format!("未知菜单动作：{other}"))),
    }
}

/// 主窗句柄（⋯ 菜单动作多数作用于主窗）。
pub(super) fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, BridgeError> {
    app.get_webview_window("main").ok_or_else(|| BridgeError::not_found("主窗不存在"))
}

/// 菜单 toggle 动作 → settings.json 键（Electron updater.loadSettings 同键）。
fn toggle_key(action: &str) -> &'static str {
    match action {
        "toggle-notify" => "notifyOnTurnEnd",
        "toggle-close-to-tray" => "closeToTray",
        _ => "showBalanceDock",
    }
}

/// 读 settings.json 布尔键（Electron `s.x !== false` 缺省 true 同口径）。
pub(super) fn setting_bool(store: &shell_core::SettingsStore, key: &str) -> bool {
    store.get(key).ok().flatten().and_then(|v| v.as_bool()).unwrap_or(true)
}

/// 读-改-写布尔开关（Electron toggle-* 语义）：取反写回，返回新值。
fn toggle_setting(store: &shell_core::SettingsStore, key: &str) -> Result<bool, shell_core::settings::SettingsError> {
    let next = !setting_bool(store, key);
    store.set(key, serde_json::json!(next))?;
    Ok(next)
}

/// npm registry latest 版本查询（无 HTTP 依赖：子进程拉取；npmmirror 优先、
/// npmjs 兜底——Electron 更新链双源同思路，国内网络优先镜像）。
///
/// `E_AGENT_UPDATE_NETWORK`：agent 更新链自用码，尚未登记
/// contracts/error-codes.md（见模块审查报告）——码值保持原样防行为变更。
const E_AGENT_UPDATE_NETWORK: &str = "E_AGENT_UPDATE_NETWORK";

fn npm_latest_version(pkg: &str) -> Result<String, BridgeError> {
    for host in ["registry.npmmirror.com", "registry.npmjs.org"] {
        let url = format!("https://{host}/{pkg}/latest");
        if let Some(v) = http_get_version(&url) {
            return Ok(v);
        }
    }
    Err(BridgeError::new(E_AGENT_UPDATE_NETWORK, "npm registry 查询失败（npmmirror/npmjs 均不可达）"))
}

/// 单源查询：Windows 走 PowerShell Invoke-RestMethod（壳内既定子进程模式，
/// copy_text/open_http_url 同口径），其余平台 curl + 首个 "version" 字段提取。
fn http_get_version(url: &str) -> Option<String> {
    if url.contains('\'') {
        return None; // 防御（URL 由本函数拼装，正常不含单引号）
    }
    #[cfg(windows)]
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("$ProgressPreference='SilentlyContinue';try{{(Invoke-RestMethod -Uri '{url}' -TimeoutSec 8).version}}catch{{exit 2}}"),
        ])
        .creation_flags_no_window()
        .output();
    #[cfg(not(windows))]
    let output = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "8", url])
        .output();
    let out = output.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    #[cfg(windows)]
    let version = text; // PS 已提取 .version 字符串
    #[cfg(not(windows))]
    let version = extract_json_version(&text);
    // 版本串形态约束：非空、无空白、长度 sane（PS 错误对象字符串/HTML 错误页防御）。
    if version.is_empty() || version.len() > 64 || version.chars().any(char::is_whitespace) {
        return None;
    }
    Some(version)
}

/// 从 npm packument 文本提取首个 "version" 字段值（首个即顶层版本；与
/// supervisor::read_kernel_version 同款文本手术，不引 JSON DOM 依赖）。
/// Windows 的 PS 路径不消费（Invoke-RestMethod 已提取 .version），仅
/// 非 Windows curl 路径与单测使用。
#[cfg_attr(windows, allow(dead_code))]
fn extract_json_version(doc: &str) -> String {
    let Some(pos) = doc.find("\"version\"") else { return String::new() };
    let Some(colon) = doc[pos..].find(':') else { return String::new() };
    let rest = &doc[pos + colon..];
    let Some(q1) = rest.find('"') else { return String::new() };
    let body = &rest[q1 + 1..];
    let Some(len) = body.find('"') else { return String::new() };
    body[..len].to_string()
}

/// 版本段解析：(数字前缀, 是否数字段, 是否带预发布后缀, 原始段)。
/// 缺失段（None）按数字 0 处理（1.0 == 1.0.0）；空串/非数字开头是文本段。
fn version_seg(s: Option<&str>) -> (f64, bool, bool, String) {
    match s {
        None => (0.0, true, false, String::new()),
        Some(s) => {
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                (f64::NAN, false, false, s.to_string())
            } else {
                let has_pre = s.len() > digits.len();
                (digits.parse().unwrap_or(f64::NAN), true, has_pre, s.to_string())
            }
        }
    }
}

/// 版本比较（Electron scripts/lib/versions.js compareVersions 的 Rust 移植，
/// 语义单一来源，逐条对齐）：
/// · 数值分段比较（0.12.2 > 0.2.1），段数不限；缺失段按 0（1.0 == 1.0.0）；
/// · 忽略前导 v（v0.2.3 == 0.2.3）；
/// · 段先按数字前缀比较（0.2.4-beta > 0.2.3）；
/// · 数字前缀相等时：无预发布后缀 > 有后缀（0.2.3 > 0.2.3-beta）；
/// · 两段都带后缀按字符串比较（alpha < beta < rc）；
/// · 数字段 > 纯文本段。
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn strip_v(s: &str) -> &str {
        s.strip_prefix('v').unwrap_or(s)
    }
    let pa: Vec<&str> = strip_v(a).split('.').collect();
    let pb: Vec<&str> = strip_v(b).split('.').collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = version_seg(pa.get(i).copied());
        let y = version_seg(pb.get(i).copied());
        match (x.1, y.1) {
            (true, true) => {
                if x.0 != y.0 {
                    return if x.0 < y.0 { Ordering::Less } else { Ordering::Greater };
                }
                if x.2 != y.2 {
                    return if x.2 { Ordering::Less } else { Ordering::Greater }; // 有后缀 < 无后缀
                }
                if x.2 && x.3 != y.3 {
                    return if x.3 < y.3 { Ordering::Less } else { Ordering::Greater };
                }
            }
            (true, false) => return Ordering::Greater, // 数字段 > 纯文本段
            (false, true) => return Ordering::Less,
            (false, false) => {
                if x.3 != y.3 {
                    return if x.3 < y.3 { Ordering::Less } else { Ordering::Greater };
                }
            }
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⋯ 菜单 toggle：读-改-写 settings 往返（缺省 true → false → true），
    /// 读-改-写不破坏同文件其他键，损坏形态（非布尔值）回落缺省 true。
    #[test]
    fn menu_toggle_setting_roundtrip() {
        let mut path = std::env::temp_dir();
        path.push(format!("dsh-cmd-toggle-{}-{}.json", std::process::id(), line!()));
        let _ = std::fs::remove_file(&path);
        let store = shell_core::SettingsStore::new(&path);
        // 缺省 true（Electron `s.x !== false` 同口径）。
        assert_eq!(setting_bool(&store, "notifyOnTurnEnd"), true);
        // 翻转并持久化：true → false。
        assert_eq!(toggle_setting(&store, "notifyOnTurnEnd").unwrap(), false);
        assert_eq!(store.get("notifyOnTurnEnd").unwrap(), Some(serde_json::json!(false)));
        // 显式 false 再翻：false → true（读文件真值，非内存态）。
        assert_eq!(toggle_setting(&store, "notifyOnTurnEnd").unwrap(), true);
        assert_eq!(store.get("notifyOnTurnEnd").unwrap(), Some(serde_json::json!(true)));
        // 读-改-写不破坏同文件其他键。
        store.set("lastWebPort", serde_json::json!(51731)).unwrap();
        toggle_setting(&store, "closeToTray").unwrap();
        assert_eq!(store.get("lastWebPort").unwrap(), Some(serde_json::json!(51731)));
        // 非布尔值（损坏形态）回落缺省 true，toggle 后写回正常布尔。
        store.set("showBalanceDock", serde_json::json!("oops")).unwrap();
        assert_eq!(setting_bool(&store, "showBalanceDock"), true);
        assert_eq!(toggle_setting(&store, "showBalanceDock").unwrap(), false);
        let _ = std::fs::remove_file(&path);
    }

    /// 菜单 toggle 动作 → settings.json 键映射（Electron 同键）。
    #[test]
    fn menu_toggle_key_mapping() {
        assert_eq!(toggle_key("toggle-notify"), "notifyOnTurnEnd");
        assert_eq!(toggle_key("toggle-close-to-tray"), "closeToTray");
        assert_eq!(toggle_key("toggle-balance"), "showBalanceDock");
    }

    /// npm packument 版本提取（首个 "version" 字段即顶层版本）。
    #[test]
    fn extract_json_version_npm_doc() {
        let doc = r#"{"_id":"@deepseek-ai/dsh","name":"@deepseek-ai/dsh","version":"0.1.0-rc.9","dist":{"tarball":"https://x/y.tgz"}}"#;
        assert_eq!(extract_json_version(doc), "0.1.0-rc.9");
        assert_eq!(extract_json_version("{\"error\":\"not found\"}"), "");
        assert_eq!(extract_json_version(""), "");
    }

    /// 版本比较（Electron scripts/lib/versions.js 同语义，注释里的规则逐条锚定）
    /// + 真实回归案例：npmmirror latest 0.1.0-rc.7 < 内置 0.1.0-rc.8 → 无更新。
    #[test]
    fn compare_versions_semantics() {
        use std::cmp::Ordering::*;
        // 数值分段比较。
        assert_eq!(compare_versions("0.12.2", "0.2.1"), Greater);
        assert_eq!(compare_versions("0.2.1", "0.12.2"), Less);
        // 缺失段按 0。
        assert_eq!(compare_versions("1.0", "1.0.0"), Equal);
        // 忽略前导 v。
        assert_eq!(compare_versions("v0.2.3", "0.2.3"), Equal);
        // 数字前缀优先：预发布的高段仍大于低段正式版。
        assert_eq!(compare_versions("0.2.4-beta", "0.2.3"), Greater);
        // 无后缀 > 有后缀。
        assert_eq!(compare_versions("0.2.3", "0.2.3-beta"), Greater);
        // 后缀按字符串比较：alpha < beta < rc。
        assert_eq!(compare_versions("0.2.3-alpha", "0.2.3-beta"), Less);
        assert_eq!(compare_versions("0.2.3-beta", "0.2.3-rc"), Less);
        // rc.N 序号比较（rc.8 > rc.7）。
        assert_eq!(compare_versions("0.1.0-rc.8", "0.1.0-rc.7"), Greater);
        // 数字段 > 纯文本段。
        assert_eq!(compare_versions("1.2.3", "1.2.x"), Greater);
        // 真实回归：registry 落后于内置包 → 不得报「可更新」。
        assert_eq!(compare_versions("0.1.0-rc.7", "0.1.0-rc.8"), Less, "降级误报防护");
        // 真实正向：registry 更新 → 报「可更新」。
        assert_eq!(compare_versions("0.1.0", "0.1.0-rc.8"), Greater);
    }

    /// 菜单 quit 语义 = 托盘退出（lib.rs setup_tray 同款）：先 supervisor
    /// .shutdown（同步杀树）再 exit(0)。源码形态断言（WebviewWindow/AppHandle
    /// 无法在单测构造），防「顺手改成直接 exit」回退——那会留内核孤儿进程。
    #[test]
    fn menu_quit_shutdown_before_exit_shape() {
        let src = include_str!("menu.rs");
        let seg = src
            .split("\"quit\" =>")
            .nth(1)
            .and_then(|s| s.split("\"toggle-notify\"").next())
            .expect("quit 分支");
        let sh = seg.find("sv.shutdown()").expect("必须先同步杀内核树");
        let ex = seg.find("app.exit(0)").expect("必须退出进程");
        assert!(sh < ex, "先 shutdown 后 exit（Job Object 杀树语义）: {seg}");
    }

    /// check-agent-update 需求变更锚点：不再裁撤（菜单保留「检查 dsh 更新…」），
    /// 走 npm latest 对比返回 {current,latest,hasUpdate}。
    #[test]
    fn check_agent_update_uses_npm_latest_not_cut() {
        let src = include_str!("menu.rs");
        let seg = src
            .split("\"check-agent-update\" =>")
            .nth(1)
            .and_then(|s| s.split("\"reload\" =>").next())
            .expect("check-agent-update 分支");
        assert!(seg.contains("npm_latest_version"), "最简可行链：npm latest 对比");
        assert!(!seg.contains("BridgeError::cut"), "不得再返回 E_CUT_FEATURE");
        assert!(seg.contains("\"hasUpdate\""), "返回契约必须带 hasUpdate");
    }

    /// 版本比较器边界补强（「打开后各种 bug」防御轮）：
    /// · rc(高段) > release(低段)：0.1.0 → 0.1.1-rc.1 的真实升级路径不得漏报；
    /// · 完全相等（含同 rc 串）；
    /// · 坏格式（空串/纯文本 unknown/空段）不 panic、语义稳定——
    ///   read_kernel_version 失败回 "unknown"、网络提取失败回 "" 都真实存在。
    #[test]
    fn compare_versions_edges_rc_release_equal_and_malformed() {
        use std::cmp::Ordering::*;
        // rc(更高段) > release(更低段)：内置 0.1.0 → npm latest 0.1.1-rc.1 必须报可更新。
        assert_eq!(compare_versions("0.1.1-rc.1", "0.1.0"), Greater, "高段 rc 不得被漏报为无更新");
        assert_eq!(compare_versions("0.1.0", "0.1.1-rc.1"), Less);
        // 同号对照（既有语义）：release > rc。
        assert_eq!(compare_versions("0.1.1", "0.1.1-rc.1"), Greater);
        // 完全相等：同串、同 rc 串、v 前缀。
        assert_eq!(compare_versions("0.5.1", "0.5.1"), Equal);
        assert_eq!(compare_versions("0.1.1-rc.1", "0.1.1-rc.1"), Equal);
        assert_eq!(compare_versions("v0.5.1", "0.5.1"), Equal);
        // 坏格式：空串 vs 空串 / unknown vs unknown → 相等（无更新，不误报）。
        assert_eq!(compare_versions("", ""), Equal);
        assert_eq!(compare_versions("unknown", "unknown"), Equal);
        // 数字段 vs 坏格式：真实版本永远大于 "unknown"/""（不会把垃圾判成可更新）。
        assert_eq!(compare_versions("unknown", "0.1.0"), Less);
        assert_eq!(compare_versions("", "0.1.0"), Less);
        assert_eq!(compare_versions("0.1.0", "unknown"), Greater);
        // 空段（"0..1"）按文本段处理：文本段 < 数字段（既有语义锚定，不 panic）。
        assert_eq!(compare_versions("0..1", "0.0.1"), Less);
    }

    /// check/install-client-update 源码形态锚点（Tauri updater 命令依赖
    /// AppHandle，无法在单测构造——沿用 include_str! 形态断言法）：
    /// · check-client-update：未配置 DSH_UPDATER_ENDPOINT 必须先拒绝
    ///   （updater_config），防发版前点了菜单走默认通道拿不可预期更新；
    /// · install-client-update：必须 check() 到 Some 才 download_and_install
    ///   （不得跳过校验直装），下载/签名失败归一 updater_signature。
    #[test]
    fn client_update_commands_shape_guards() {
        let src = include_str!("menu.rs");
        let check = src
            .split("\"check-client-update\" =>")
            .nth(1)
            .and_then(|s| s.split("\"install-client-update\" =>").next())
            .expect("check-client-update 分支");
        let cfg = check.find("updater_config").expect("未配置通道必须 updater_config 拒绝");
        let net = check.find("updater.check()").expect("必须联网 check");
        assert!(cfg < net, "先查配置再联网（省一次无效网络往返）");
        assert!(check.contains("DSH_UPDATER_ENDPOINT"), "通道环境变量锚点");
        assert!(check.contains("\"upToDate\": true"), "无更新返回 upToDate:true");
        let install = src
            .split("\"install-client-update\" =>")
            .nth(1)
            .and_then(|s| s.split("other =>").next())
            .expect("install-client-update 分支");
        let chk = install.find("updater.check()").expect("必须先 check");
        let dl = install.find("download_and_install").expect("必须走 download_and_install");
        assert!(chk < dl, "先 check 后下载安装（不得跳过更新检测直装）");
        assert!(install.contains("ok_or_else(|| BridgeError::not_found(\"已是最新版本\"))"), "无更新时明确报错而非空装");
        assert!(install.contains("updater_signature"), "下载/签名失败归一 updater_signature");
    }
}
