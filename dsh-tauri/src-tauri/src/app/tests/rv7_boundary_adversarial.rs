//! RV7 边界对抗审查：**解析面 malformed input 对抗**（只读审查配套测试）。
//!
//! 覆盖今日新增解析面里从集成测试可达的 pub 契约：
//! - `precheck_drop_paths` / `drop_ext` / `drop_kind`（lib.rs 拖放载荷面）；
//! - `session_notify::valid_jump_session_id` / `restart_backoff_ms`（watcher
//!   行协议侧的会话 ID 校验——`parse_watcher_line`/`read_capped_line` 为
//!   `pub(crate)`，集成测试不可达，其对抗矩阵在 RV7 报告中以推演给出，
//!   仓内已有 line_protocol_tests 覆盖主体形态）。
//!
//! 注意：`commands::updater_client::cmp_semver` / `parse_release_doc` /
//! `resolve_outcome` 均在私有 `mod commands` 之后且非 lib 根 re-export，
//! 集成测试不可达——updater 对抗矩阵见 RV7 报告（结论：脏输入容错正确，
//! 巨数字段 u64 溢出按 0 计不 panic）。

use dsh_tauri_app::{drop_ext, drop_kind, precheck_drop_paths, session_notify, DROP_MAX_FILES};

// ---------------------------------------------------------------------------
// 1. drop_ext / drop_kind：文件名形态对抗
// ---------------------------------------------------------------------------

#[test]
fn rv7_drop_ext_adversarial_names() {
    // 大小写归一。
    assert_eq!(drop_ext("a.TXT"), ".txt");
    assert_eq!(drop_ext("Setup.EXE"), ".exe");
    // 多点取最后一段。
    assert_eq!(drop_ext("archive.tar.gz"), ".gz");
    assert_eq!(drop_ext("a.b.c"), ".c");
    // 隐藏文件（首点）→ 无扩展名（与插件 extOf dot<=0 同语义）。
    assert_eq!(drop_ext(".gitignore"), "");
    assert_eq!(drop_ext("."), "");
    // 非首点全点名：".." → rfind('.')==1 > 0 → ext "."（垃圾进垃圾出，不 panic）。
    assert_eq!(drop_ext(".."), ".");
    assert_eq!(drop_ext("a."), ".");
    // emoji / 中文 / 控制字符名：无 ascii 点 → 空；不 panic。
    assert_eq!(drop_ext("📦.zip"), ".zip");
    assert_eq!(drop_ext("汉字文件"), "");
    assert_eq!(drop_ext("a\u{1}b.txt"), ".txt");
    // 空串。
    assert_eq!(drop_ext(""), "");
}

#[test]
fn rv7_drop_kind_matrix_adversarial() {
    assert_eq!(drop_kind(".png"), "image");
    // 契约：drop_kind 吃 drop_ext 的小写化产物；直接喂 ".PNG" 按字典不命中
    // image 白名单 → binary（垃圾进垃圾出，真实调用面恒经 drop_ext）。
    assert_eq!(drop_kind(".PNG"), "binary");
    assert_eq!(drop_kind(""), "text"); // 无扩展名按文本
    assert_eq!(drop_kind(".exe"), "binary");
    assert_eq!(drop_kind("."), "binary"); // 垃圾 ext 不落 text 白名单
}

// ---------------------------------------------------------------------------
// 2. precheck_drop_paths：载荷洪水 / 缺失 / 目录 / name 形态
// ---------------------------------------------------------------------------

#[test]
fn rv7_precheck_flood_of_missing_paths_stays_bounded_and_honest() {
    // 2000 条不存在路径（含路径穿越形态、UNC 形态、控制字符——拖放源不可信
    // 时最坏输入）：全部 missing 进 skipped，files 空，不 panic。
    let mut paths = Vec::new();
    for i in 0..2000 {
        let hostile = match i % 5 {
            0 => format!(r"C:\nonexistent-{}\..\..\evil\..\x.txt", i),
            1 => format!(r"\\.\UNC\host\share\missing-{}.bin", i),
            2 => format!("C:\\tmp\\no\u{1}such\u{7}file-{}.md", i),
            3 => format!("C:\\tmp\\emoji-📦-{}.zip", i),
            _ => format!("C:\\tmp\\missing-{}", i),
        };
        paths.push(std::path::PathBuf::from(hostile));
    }
    let out = precheck_drop_paths(&paths);
    assert!(out.files.is_empty(), "全部不存在 → files 空");
    assert_eq!(out.skipped.len(), 2000);
    assert!(out.skipped.iter().all(|s| s["reason"] == "missing"));
}

#[test]
fn rv7_precheck_directory_and_real_files() {
    let tmp = std::env::temp_dir().join(format!("rv7-drop-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp);
    let file = tmp.join("rv7-note.md");
    std::fs::write(&file, b"x").unwrap();
    let out = precheck_drop_paths(&[tmp.clone(), file.clone(), tmp.join("gone.txt")]);
    assert_eq!(out.files.len(), 1);
    assert_eq!(out.files[0]["name"], "rv7-note.md");
    assert_eq!(out.files[0]["kind"], "text");
    assert_eq!(out.files[0]["size"], json_u64(1));
    // 目录 / 缺失各按原因进 skipped——name 用 file_name() 提取，穿越不可能
    //（Path::file_name 只取末段）。
    let reasons: Vec<&str> = out
        .skipped
        .iter()
        .map(|s| s["reason"].as_str().unwrap())
        .collect();
    assert!(reasons.contains(&"directory"));
    assert!(reasons.contains(&"missing"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn rv7_precheck_over_limit_goes_to_skipped_not_silent_drop() {
    // 超过 DROP_MAX_FILES 的部分必须显式 too-many，而非悄悄丢弃。
    let tmp = std::env::temp_dir().join(format!("rv7-drop-many-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp);
    let mut paths = Vec::new();
    for i in 0..DROP_MAX_FILES + 5 {
        let p = tmp.join(format!("f{i}.txt"));
        std::fs::write(&p, b"x").unwrap();
        paths.push(p);
    }
    let out = precheck_drop_paths(&paths);
    assert_eq!(out.files.len(), DROP_MAX_FILES);
    assert_eq!(out.skipped.len(), 5);
    assert!(out.skipped.iter().all(|s| s["reason"] == "too-many"));
    let _ = std::fs::remove_dir_all(&tmp);
}

fn json_u64(v: u64) -> serde_json::Value {
    serde_json::Value::Number(v.into())
}

// ---------------------------------------------------------------------------
// 3. valid_jump_session_id：字节长度语义 / 控制字符 / 路径分隔符
// ---------------------------------------------------------------------------

#[test]
fn rv7_jump_session_id_byte_length_semantics() {
    // 长度按字节计：64 个 emoji = 256B 恰好放行；65 个 = 260B 拒。
    assert!(session_notify::valid_jump_session_id(&"📦".repeat(64)));
    assert!(!session_notify::valid_jump_session_id(&"📦".repeat(65)));
    // CJK 3B/char：85×3=255 放；86×3=258 拒。
    assert!(session_notify::valid_jump_session_id(&"汉".repeat(85)));
    assert!(!session_notify::valid_jump_session_id(&"汉".repeat(86)));
}

#[test]
fn rv7_jump_session_id_control_and_separator_chars_pass_contract() {
    // 契约只查 trim 非空 + ≤256：控制字符（含 NUL）与路径分隔符**不被拒**。
    // 这是可接受的设计（下游仅用于日志/JSON emit/内核跳转查询，serde_json
    // 会转义 NUL 为 \u0000，无注入面），但记录为 RV7 审查发现（见报告 P2）。
    assert!(session_notify::valid_jump_session_id("a\u{0}b"));
    assert!(session_notify::valid_jump_session_id("a/b\\c:d"));
    // 引号与巨串边界。
    assert!(session_notify::valid_jump_session_id("\"'`"));
    assert!(!session_notify::valid_jump_session_id(&"x".repeat(257)));
    // 全空白 trim 后为空 → 拒（含 emoji 间空白）。
    assert!(!session_notify::valid_jump_session_id("  \t\n "));
}

#[test]
fn rv7_restart_backoff_huge_restarts_do_not_overflow() {
    // 对抗：退避计数被灌到 u32 极值不得移位溢出 panic。
    assert_eq!(session_notify::restart_backoff_ms(u32::MAX), 60_000);
    assert_eq!(session_notify::restart_backoff_ms(0), 1_000);
}
