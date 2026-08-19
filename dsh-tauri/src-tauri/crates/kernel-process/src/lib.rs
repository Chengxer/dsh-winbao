//! # kernel-process —— 内核进程保姆（纯逻辑）
//!
//! 对齐 Electron 版 `main.js` 的 startServer / watchServerProc / 崩溃环 / 端口稳定化。
//! 契约：`dsh-tauri/contracts/data-flow.md` §3（boot 时序步骤 [4][5][7]）。
//!
//! 不依赖 tauri；`spawn` 与 `kill_tree` 的 OS 绑定在 Phase 1 接入（Windows Job
//! Object），本 crate Phase 0 交付可单测的决策逻辑：
//!
//! - [`ready_line`]      —— `dsh web: https://...` 就绪行流式解析（跨 chunk 缓冲）
//! - [`crash_loop`]      —— 崩溃环判定（窗口 + 次数 + 冷却）
//! - [`port`]            —— 安全端口选择（绑 127.0.0.1:0 探测 + Chromium 不安全端口表）
//! - [`spawn_spec`]      —— spawn 参数构造（`--no-open` 按内核版本门控，rc.8 起必需）
//! - [`semver`]          —— 内核版本比较（比较 rc 前缀等 dsh 特有形态）

pub mod crash_loop;
pub mod job_object;
pub mod port;
pub mod ready_line;
pub mod semver;
pub mod spawn_spec;

pub use crash_loop::CrashLoopDetector;
pub use port::choose_stable_port;
pub use ready_line::ReadyLineParser;
pub use spawn_spec::SpawnSpec;
