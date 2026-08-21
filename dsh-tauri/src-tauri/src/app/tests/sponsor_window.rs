//! 赞助窗集成测试（v0.5.0「打开卡死 + 无图 + 关不掉」第五轮终修回归）。
//!
//! mock runtime 下走与生产完全同款的 `build_sponsor_window` builder 路径：
//! 创建 → 属性验证（三零依赖 URL / 原生标题栏 / 可关闭）→ 关闭 → 销毁验证。
//! 「截图验证图片」无法在无渲染的 mock runtime 自动化，等价拆解为：
//! 1. 窗口层属性断言（本文件）；
//! 2. 内容层产物断言（sponsor_inject_script 的 data URI 双图内嵌——
//!    windows.rs 单测 sponsor_inject_script_embeds_qrs_and_replaces_document）。

use dsh_tauri_app::windows::{build_sponsor_window, open_sponsor_window, sponsor_inject_script};
use tauri::Manager;

const QR: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

#[test]
fn sponsor_window_create_verify_close_lifecycle() {
    let app = tauri::test::mock_app();
    let handle = app.handle().to_owned();

    // 生产同款产物注入脚本。
    let script = sponsor_inject_script(QR, QR);
    let win = build_sponsor_window(&handle, &script).expect("mock runtime 下建赞助窗");

    assert_eq!(win.label(), "sponsor");

    // 三零依赖：不得 file://（路径编码/AV 断裂面）、不得 data: 顶层导航
    // （WebView2 禁）、不得 127.0.0.1（preview-server 端口存活依赖）。
    let url = win.url().expect("mock runtime 应能读回 URL").to_string();
    assert!(!url.starts_with("file://"), "弃 file://: {url}");
    assert!(!url.starts_with("data:"), "弃 data: 顶层导航: {url}");
    assert!(!url.contains("127.0.0.1"), "弃本地端口依赖: {url}");
    assert!(url.contains("localhost"), "应为 tauri 内嵌资产（tauri.localhost）: {url}");

    // 注：decorations/closable/resizable 断言在 mock runtime 下不可靠
    //（mock 不跟踪这些 builder 设置，查询返回默认值），由 windows.rs 源码
    // 形态锚点测试 sponsor_window_embedded_assets_threaded_closable_shape
    // 覆盖（decorations(true) / closable(true) / resizable(false)）。

    // 窗口已在管理器注册（复用路径可见）。
    assert!(handle.get_webview_window("sponsor").is_some(), "sponsor 窗应已注册");

    // 关闭语义：destroy/close 必须成功（生产端原生 X = 默认销毁——窗口
    // 无 CloseRequested 拦截、无 hide-to-tray，见 windows.rs 形态锚点
    // sponsor_window_embedded_assets_threaded_closable_shape）。
    // 注：mock runtime 的 destroy 只清内部窗口表，manager 层注册的清理
    // 依赖事件循环派发 Destroyed——mock 下 get_webview_window 不会变
    // None，故「关闭后不残留」由源码锚点保证（不注册 on_window_event）。
    win.destroy().expect("销毁赞助窗（无拦截 = 默认行为）");
}

/// 复用语义：窗口存在时 open_sponsor_window 只 show+focus，不重复建窗、
/// 返回 reused（防双击多窗）。
#[test]
fn sponsor_window_reuses_existing() {
    let app = tauri::test::mock_app();
    let handle = app.handle().to_owned();
    let script = sponsor_inject_script(QR, QR);
    build_sponsor_window(&handle, &script).expect("首建");

    // 第二次 open：已存在 → 立即返回 reused（不走建窗线程）。
    let out = open_sponsor_window(&handle, QR, QR).expect("复用路径");
    assert_eq!(out["reused"], serde_json::json!(true), "第二次必须复用: {out}");

    handle.get_webview_window("sponsor").expect("复用不销毁").close().unwrap();
}
