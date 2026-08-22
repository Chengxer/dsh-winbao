//! TA9 混沌测试 —— 磁盘/IO 故障 × `logging::append_capped`（静默铁律）。
//!
//! 只读编入实现源（字节一致 = 测的就是生产实现，session_notify_boundary.rs
//! 同手法）。故障全部沙箱内模拟：目录不可建/不可开（父路径被文件占用 =
//! create_dir_all 失败形态；目标被目录占用 = open 失败 / Windows 上访问被拒
//! 形态）、封顶轮转正常路径对照。
//!
//! 铁律（logging.rs 模块头）：一切 `Result` 吞掉，**绝不 panic**——
//! early_log 可能运行在 panic hook 内，hook 内再 panic = 无限递归崩进程。

#![allow(dead_code)]

#[path = "../src/logging.rs"]
mod logging_live;

use logging_live::{append_capped, scrub_secrets, LOG_CAP_BYTES};
use std::path::PathBuf;

/// logging.rs 内 `crate::supervisor::panic_payload_str` 的最小垫片
/// （真实现见 supervisor.rs；此处同语义复制仅为满足编入编译）。
pub mod supervisor {
    pub fn panic_payload_str(payload: &(dyn std::any::Any + Send)) -> &str {
        if let Some(s) = payload.downcast_ref::<&str>() {
            s
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s
        } else {
            "未知 panic 载荷"
        }
    }
}

fn sandbox(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ta9-log-{prefix}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 日志目录本身不存在且无法创建（父路径被普通文件占用）→ 静默，绝不 panic。
#[test]
fn append_capped_parent_is_file_silent() {
    let dir = sandbox("parent-file");
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, b"i am a file where a directory should be").unwrap();
    let target = blocker.join("sub").join("boot-early.log"); // create_dir_all 必败
    append_capped(&target, "line-1", LOG_CAP_BYTES);
    append_capped(&target, "line-2", LOG_CAP_BYTES);
    // 静默：无文件产生、无 panic（走到这里即通过）。
    assert!(!target.exists(), "不可建目录不得产出日志文件");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 日志文件位置被目录占用（文件被锁/形态错误的等价沙箱模拟）→ 静默。
#[test]
fn append_capped_target_is_directory_silent() {
    let dir = sandbox("target-dir");
    let target = dir.join("logs").join("boot-early.log");
    std::fs::create_dir_all(&target).unwrap(); // 文件位置被目录占用：open 必败
    append_capped(&target, "line", LOG_CAP_BYTES);
    for _ in 0..100 {
        append_capped(&target, "spam", LOG_CAP_BYTES);
    }
    assert!(target.is_dir(), "目标形态不被破坏");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 封顶轮转正常路径（对照实验）：超限 → 重命名 .old → 重开追加。
#[test]
fn append_capped_rotation对照组() {
    let dir = sandbox("rotate");
    let target = dir.join("boot-early.log");
    append_capped(&target, &"x".repeat(64), 64);
    append_capped(&target, &"y".repeat(64), 64); // 触发轮转
    let old = dir.join("boot-early.old");
    assert!(old.exists(), "上一代保留为 .old");
    assert!(std::fs::read_to_string(&old).unwrap().starts_with('x'), ".old 是旧内容");
    assert!(std::fs::read_to_string(&target).unwrap().starts_with('y'), "新文件重开追加");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 连续高压追加（前缀混凭据）在可写路径不丢不炸：脱敏仍生效（RV8 P1-4 红线）。
#[test]
fn append_capped_burst_with_secrets_scrubbed() {
    let dir = sandbox("burst");
    let target = dir.join("web.log");
    for i in 0..500 {
        append_capped(&target, &format!("line-{i} key=sk-abcdefghij0123456789012345 tail"), LOG_CAP_BYTES);
    }
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(!text.contains("sk-abcdefghij"), "凭据形态必须被擦除");
    assert!(text.contains("sk-***"), "擦除后留掩码");
    assert_eq!(scrub_secrets("plain"), "plain", "普通日志不误伤");
    let _ = std::fs::remove_dir_all(&dir);
}
