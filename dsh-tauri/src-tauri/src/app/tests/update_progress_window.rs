//! 客户端更新进度弹窗集成测试（下载时置顶小窗：进度条 + 百分比 + 关闭按钮）。
//!
//! mock runtime 下走与生产完全同款的 `build_update_progress_window` builder 路径：
//! 创建 → 属性验证（内嵌资产 URL / 非 file://）→ 关闭 → 销毁验证。
//! 内容层（进度条/百分比/阶段文案）由 windows.rs 单测
//! update_progress_inject_script_renders_progress_elements 产物直验。

use dsh_tauri_app::windows::{build_update_progress_window, open_update_progress_window, update_progress_inject_script};
use tauri::Manager;

#[test]
fn update_progress_window_create_verify_close_lifecycle() {
    let app = tauri::test::mock_app();
    let handle = app.handle().to_owned();

    let script = update_progress_inject_script("0.5.3");
    let win = build_update_progress_window(&handle, &script, None).expect("mock runtime 下建进度弹窗");

    assert_eq!(win.label(), "update-progress");

    // 内嵌资产（tauri.localhost），零 file://（安装版路径编码/AV 断裂面）。
    let url = win.url().expect("mock runtime 应能读回 URL").to_string();
    assert!(!url.starts_with("file://"), "弃 file://: {url}");
    assert!(!url.starts_with("data:"), "弃 data: 顶层导航: {url}");
    assert!(url.contains("localhost"), "应为 tauri 内嵌资产（tauri.localhost）: {url}");

    // 窗口已在管理器注册（复用路径可见）。
    assert!(handle.get_webview_window("update-progress").is_some(), "update-progress 窗应已注册");

    // 关闭语义：destroy 必须成功（无 CloseRequested 拦截 = 默认销毁，见
    // windows.rs 形态锚点 update_progress_window_shape_anchor）。
    win.destroy().expect("销毁进度弹窗（无拦截 = 默认行为）");
}

/// 复用语义：窗口存在时 open_update_progress_window 只 show 复用，不重复建窗。
#[test]
fn update_progress_window_reuses_existing() {
    let app = tauri::test::mock_app();
    let handle = app.handle().to_owned();
    let script = update_progress_inject_script("0.5.3");
    build_update_progress_window(&handle, &script, None).expect("首建");

    let out = open_update_progress_window(&handle, "0.5.3").expect("复用路径");
    assert_eq!(out["reused"], serde_json::json!(true), "第二次必须复用: {out}");

    handle.get_webview_window("update-progress").expect("复用不销毁").close().unwrap();
}
