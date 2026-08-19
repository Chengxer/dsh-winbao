//! # bridge —— `window.dshDesktop` 桥
//!
//! contracts/bridge-api.md（48 方法硬契约）+ contracts/ipc-commands.md（41 通道映射）
//! + contracts/error-codes.md（统一错误码）的**代码载体**：
//!
//! - [`error`]    —— `BridgeError`（code/message/detail，serde 序列化给垫片）
//! - [`commands`] —— Electron 通道 → Tauri command 的映射表（纯函数 + 完整性测试）
//! - [`shim`]     —— 注入远程页的垫片 JS（`initialization_script` 内容本体）
//!
//! 本 crate 不依赖 tauri：command 注册（`#[tauri::command]`）在 app 装配层
//! （`src/app`）完成，bridge 只提供纯逻辑与常量。垫片 JS 位于 `dist/bridge-shim.js`，
//! 经 `include_str!` 编进二进制。

pub mod commands;
pub mod error;
pub mod shim;

pub use error::BridgeError;
pub use shim::BRIDGE_SHIM_JS;
