//! # shell-core —— 壳核心域
//!
//! 对齐 Electron 版 `main.js` 的基础域（路径 / 设置 / run-state / 单实例）。
//! 契约：`dsh-tauri/contracts/data-flow.md` §5（持久化位置必须与 Electron 版
//! 完全一致，保证用户数据兼容）。
//!
//! 本 crate 不依赖 tauri 运行时（#121「纯逻辑模块不依赖宿主」原则的 Rust 版），
//! 可独立单测。
//!
//! ## 模块
//! - [`paths`]    —— 全部持久化路径（支持 `DSH_TEST_*` 环境变量注入以便测试）
//! - [`settings`] —— 设置存储（JSON，schema 兼容 Electron 版 updater.loadSettings）
//! - [`run_state`] —— 应用运行态状态机
//! - [`single_instance`] —— 单实例锁（Phase 0 为锁文件占位，Phase 1 换 OS 命名互斥体）

pub mod paths;
pub mod run_state;
pub mod settings;
pub mod single_instance;

pub use paths::DshPaths;
pub use run_state::RunState;
pub use settings::SettingsStore;
pub use single_instance::SingleInstanceGuard;
