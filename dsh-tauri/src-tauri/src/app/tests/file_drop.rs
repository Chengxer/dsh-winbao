//! 文件拖放（F1，2026-08）回归测试。
//!
//! 四层断言：
//! 1. 纯函数：drop_ext / drop_kind / precheck_drop_paths（目录/缺失/超量
//!    剔除、分类与载荷形态）；
//! 2. 接线形态：lib.rs 主窗 DragDropEvent 监听 + route_drag_drop 分支
//!    （include_str 源码锚点，CRLF 归一）；
//! 3. 配置定论：windows.rs 不得关闭 drag_drop_enabled（原生拦截是本修复
//!    的前提——关掉则 Rust 收不到路径，回到「两端都坏」）；tauri.conf.json
//!    窗口表保持空（主窗由 Rust 建造，dragDrop 默认 true 生效路径）；
//! 4. 垫片一致性：bridge-shim.js 监听 `client-file-drop`、转发页面
//!    CustomEvent `dsh-desktop-file-drop`（与 dsh-file-drop 插件的消费名
//!    契约，F2 侧实现消费）；分类口径与插件 client.js 的 TEXT_EXT /
//!    IMAGE_EXT include_str 对照（插件源是 git 跟踪资产，可稳定对照；
//!    内核 @deepseek-ai/dsh-attachment-local 是构建期 vendor 产物，白名单
//!    以硬编码期望固化）。

use dsh_tauri_app::{precheck_drop_paths, drop_ext, drop_kind, CLIENT_FILE_DROP_EVENT, DROP_IMAGE_EXT, DROP_MAX_FILES, DROP_TEXT_EXT};

/// 仓库检出为 CRLF，锚点统一按 \n 书写。
fn norm(src: &str) -> String {
    src.replace("\r\n", "\n")
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/// 扩展名解析：大小写归一、无扩展名/隐藏文件首点 → 空串（与插件 extOf
/// 的 dot<=0 同语义——「.gitignore」按无扩展名计）。
#[test]
fn drop_ext_normalizes_cases() {
    assert_eq!(drop_ext("a.TXT"), ".txt");
    assert_eq!(drop_ext("photo.JPEG"), ".jpeg");
    assert_eq!(drop_ext("archive.tar.gz"), ".gz");
    assert_eq!(drop_ext("README"), "");
    assert_eq!(drop_ext(".gitignore"), "");
    assert_eq!(drop_ext(""), "");
}

/// 分类口径：image 白名单 = 内核附件 MEDIA_TYPES（dsh-attachment-local
/// lib/index.js：png/jpeg/webp/gif 四格式硬期望）；text = 插件 TEXT_EXT
/// 同集或无扩展名；其余 binary。判定序与插件 classifyFile 一致（image 优先）。
#[test]
fn drop_kind_matches_kernel_whitelist_and_plugin_order() {
    // 内核附件白名单硬期望（vendor 产物不入 include_str，契约在此固化）。
    assert_eq!(DROP_IMAGE_EXT, &[".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    for ext in DROP_IMAGE_EXT {
        assert_eq!(drop_kind(ext), "image", "内核白名单扩展名 {ext} 必须 image");
    }
    assert_eq!(drop_kind(".PNG"), "binary", "drop_kind 吃 drop_ext 归一后的扩展名（大写原串不命中白名单）");
    // 大小写经 drop_ext 归一后分类正确。
    assert_eq!(drop_kind(&drop_ext("b.PNG")), "image");
    assert_eq!(drop_kind(&drop_ext("note.Md")), "text");
    for ext in [".md", ".ts", ".py", ".log", ".vue"] {
        assert_eq!(drop_kind(ext), "text");
    }
    assert_eq!(drop_kind(""), "text", "无扩展名按插件语义归 text（extensionless）");
    for ext in [".zip", ".exe", ".gz", ".mp4"] {
        assert_eq!(drop_kind(ext), "binary");
    }
}

/// 预检：目录/缺失剔除进 skipped（带 reason），存活项载荷形态完整
/// {path,name,ext,size,kind}；多文件逐个进 files（插件批量语义）。
#[test]
fn precheck_filters_directories_and_missing_and_shapes_payload() {
    let dir = std::env::temp_dir().join(format!("dsh-f1-precheck-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("subdir")).unwrap();
    std::fs::write(dir.join("note.md"), b"hello").unwrap();
    std::fs::write(dir.join("pic.PNG"), b"\x89PNG").unwrap(); // 大小写归一 → image
    std::fs::write(dir.join("pack.zip"), b"PK").unwrap();

    let missing = dir.join("nope.txt");
    let mut paths = vec![
        dir.join("note.md"),
        dir.join("pic.PNG"),
        dir.join("pack.zip"),
        dir.join("subdir"), // 目录 → skipped(directory)
        missing.clone(),    // 不存在 → skipped(missing)
    ];
    let out = precheck_drop_paths(&paths);
    assert_eq!(out.files.len(), 3, "三个常规文件全部存活: {:?}", out.files);
    assert_eq!(out.skipped.len(), 2, "目录与缺失各进 skipped: {:?}", out.skipped);

    let md = &out.files[0];
    assert_eq!(md["name"], "note.md");
    assert_eq!(md["ext"], ".md");
    assert_eq!(md["kind"], "text");
    assert_eq!(md["size"], 5);
    assert!(md["path"].as_str().unwrap().ends_with("note.md"));
    let png = &out.files[1];
    assert_eq!(png["ext"], ".png", "大写扩展名必须归一小写");
    assert_eq!(png["kind"], "image");
    assert_eq!(out.files[2]["kind"], "binary");

    let reasons: Vec<&str> = out.skipped.iter().map(|s| s["reason"].as_str().unwrap()).collect();
    assert!(reasons.contains(&"directory"), "{reasons:?}");
    assert!(reasons.contains(&"missing"), "{reasons:?}");
    for s in &out.skipped {
        assert!(s["path"].is_string() && s["name"].is_string(), "skipped 载荷带 path+name: {s}");
    }

    paths.clear();
    let empty = precheck_drop_paths(&paths);
    assert!(empty.files.is_empty() && empty.skipped.is_empty(), "空拖放 → 空载荷（不 panic）");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 超量：DROP_MAX_FILES 之后的文件进 skipped(too-many)，不悄悄丢弃。
#[test]
fn precheck_caps_file_count_with_reason() {
    let dir = std::env::temp_dir().join(format!("dsh-f1-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut paths = Vec::new();
    for i in 0..(DROP_MAX_FILES + 3) {
        let p = dir.join(format!("f{i:03}.txt"));
        std::fs::write(&p, b"x").unwrap();
        paths.push(p);
    }
    let out = precheck_drop_paths(&paths);
    assert_eq!(out.files.len(), DROP_MAX_FILES, "恰好接受上限数");
    assert_eq!(out.skipped.len(), 3, "超出部分逐个进 skipped");
    assert!(out.skipped.iter().all(|s| s["reason"] == "too-many"));
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 接线形态（源码锚点）
// ---------------------------------------------------------------------------

fn lib_src() -> String {
    norm(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")))
}

fn windows_src() -> String {
    norm(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/windows.rs")))
}

fn conf_src() -> String {
    norm(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")))
}

fn plugin_src() -> String {
    norm(include_str!("../../../../../dsh-desktop/assets/plugins/dsh-file-drop/lib/client.js"))
}

/// 主窗 DragDrop 接线：on_window_event 追加式监听 → WindowEvent::DragDrop →
/// route_drag_drop；事件名走常量 CLIENT_FILE_DROP_EVENT（不散落字符串）。
#[test]
fn drag_drop_wiring_shape() {
    let src = lib_src();
    let wiring = src
        .split("let main_win = windows::create_main_window")
        .nth(1)
        .and_then(|s| s.split("// 诊断开关").next())
        .expect("主窗创建段");
    assert!(wiring.contains("main_win.on_window_event"), "主窗必须挂 DragDrop 监听: {wiring}");
    assert!(wiring.contains("WindowEvent::DragDrop"), "必须匹配 DragDrop 窗口事件: {wiring}");
    assert!(wiring.contains("route_drag_drop(&dd_handle"), "事件必须路由到 route_drag_drop: {wiring}");

    let route = src
        .split("fn route_drag_drop")
        .nth(1)
        .and_then(|s| s.split("\n}\n").next())
        .expect("route_drag_drop 函数体");
    assert!(route.contains("DragDropEvent::Drop { paths, .. }"), "Drop 分支带 paths: {route}");
    assert!(route.contains("DragDropEvent::Enter { paths, .. }"), "Enter 分支（悬停反馈）: {route}");
    assert!(route.contains("DragDropEvent::Leave"), "Leave 分支（悬停收尾）: {route}");
    assert!(route.contains("DragDropEvent::Over { .. } => {}"), "Over 高频噪声必须显式忽略: {route}");
    assert!(route.contains("CLIENT_FILE_DROP_EVENT"), "emit 必须用事件名常量: {route}");
    assert!(route.contains("precheck_drop_paths(paths)"), "Drop 必须先过预检: {route}");
    for key in ["\"type\"", "\"files\"", "\"skipped\"", "\"count\""] {
        assert!(route.contains(key), "载荷键 {key} 缺失: {route}");
    }
    // 事件名常量本体（垫片/插件消费方对照锚点）。
    assert_eq!(CLIENT_FILE_DROP_EVENT, "client-file-drop");
}

/// 原生拦截必须保持开启：windows.rs 不得出现 drag_drop_enabled(false)
///（关掉则 Rust 收不到 DragDropEvent，页面 HTML5 drop 在 WebView2 仍拿
/// 不到路径——两端全坏）；tauri.conf.json 窗口表保持空（主窗由 Rust
/// builder 建造，tauri-utils drag_drop_enabled 默认 true 的生效路径）。
#[test]
fn native_drag_interception_stays_enabled() {
    let w = windows_src();
    assert!(!w.contains("drag_drop_enabled(false)"), "windows.rs 不得关闭原生拖放拦截");
    let c = conf_src();
    assert!(c.contains("\"windows\": []"), "窗口表保持空（Rust 建窗，配置项不得漂移）: {c}");
    assert!(!c.contains("dragDropEnabled"), "配置层不得覆写 dragDrop（默认 true 即所需）: {c}");
}

// ---------------------------------------------------------------------------
// 垫片一致性 + 插件口径对照
// ---------------------------------------------------------------------------

/// 垫片转发：监听壳事件 `client-file-drop` → 页面级 window CustomEvent
/// 同名事件（与 dsh-balance-changed 同款派发面），enter/leave 驱动悬停
/// 提示层，drop 收尾；不得残留旧拟名 `dsh-desktop-file-drop`。
#[test]
fn shim_forwards_client_file_drop_to_page_custom_event() {
    let shim = bridge::BRIDGE_SHIM_JS;
    assert!(shim.contains("onEvent('client-file-drop'"), "垫片必须监听壳事件 client-file-drop");
    assert!(
        shim.contains("new CustomEvent('client-file-drop'"),
        "必须转发为页面级 window CustomEvent client-file-drop"
    );
    assert!(!shim.contains("dsh-desktop-file-drop"), "旧拟名不得残留（消费方吃 client-file-drop）");
    assert!(shim.contains("payload.type === 'enter'"), "enter 分支（悬停提示）");
    assert!(shim.contains("'leave' || payload.type === 'drop'"), "leave/drop 都要收尾提示层");
    assert!(shim.contains("__dsh_drop_hint__"), "悬停提示层标记");
    assert!(shim.contains("松开投喂"), "提示文案");
}

/// 分类口径与插件源码对照（include_str）：我们的 TEXT_EXT/IMAGE_EXT 逐项
/// 出现在插件 client.js 的扩展名集合里，判定序一致（image 优先于 text），
/// 扩展名解析语义一致（dot<=0 → 无扩展名归 text）。
#[test]
fn classification_sets_align_with_plugin_source() {
    let p = plugin_src();
    for ext in DROP_TEXT_EXT {
        assert!(p.contains(&format!("'{ext}'")), "插件 TEXT_EXT 缺 {ext}（口径漂移）");
    }
    for ext in DROP_IMAGE_EXT {
        assert!(p.contains(&format!("'{ext}'")), "插件 IMAGE_EXT 缺 {ext}（口径漂移）");
    }
    // 判定序：classifyFile 先查 IMAGE_EXT 再查 TEXT_EXT（image 优先）。
    let classify = p.split("function classifyFile").nth(1).and_then(|s| s.split("\n  }").next()).expect("classifyFile 函数体");
    let img_pos = classify.find("IMAGE_EXT").expect("classifyFile 必须查 IMAGE_EXT");
    let txt_pos = classify.find("TEXT_EXT").expect("classifyFile 必须查 TEXT_EXT");
    assert!(img_pos < txt_pos, "插件分类 image 优先——drop_kind 的判定序必须一致");
    // 扩展名解析语义：dot<=0 → ''（无扩展名），随后 classifyFile 归 text。
    assert!(p.contains("lastIndexOf('.')"), "插件 extOf 用 lastIndexOf");
    assert!(p.contains("dot <= 0"), "插件 dot<=0 归一语义");
    assert!(classify.contains("ext === ''"), "无扩展名归 text（extensionless）");
    // 消费契约对照（include_str）：插件必须监听页面级 window CustomEvent
    // `client-file-drop`（壳事件经垫片同名转发），且取 detail.files。
    assert!(
        p.contains("window.addEventListener('client-file-drop'"),
        "插件必须消费 window CustomEvent client-file-drop（与垫片转发名一致）"
    );
    assert!(p.contains("Array.isArray(detail.files)"), "插件取 detail.files（载荷形态契约）");
}
