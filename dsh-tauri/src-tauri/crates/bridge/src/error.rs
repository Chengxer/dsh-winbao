//! 统一错误（contracts/error-codes.md 的代码载体）。
//!
//! 形态沿用 PR #121 的 PluginError：`{code, message, detail?}`。
//! Tauri command 的 Err 端必须是 Serialize 类型——这里序列化为
//! `{"code": "...", "message": "..."}`，垫片转成 `Error("[CODE] message")`。

use serde::{Serialize, Serializer};

/// 壳统一错误。code 是稳定契约（error-codes.md §6：只追加不复用）。
#[derive(Debug, Clone)]
pub struct BridgeError {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<serde_json_slim::Value>,
}

/// 避免给 bridge 拉 serde_json 依赖：detail 仅需透传形态，
/// 用极简 JSON 值枚举（app 层用 serde_json::Value 互转）。
pub mod serde_json_slim {
    /// 极简 JSON 值（只用于 detail 透传）。
    #[derive(Debug, Clone)]
    pub enum Value {
        Null,
        Bool(bool),
        Number(f64),
        String(String),
        Array(Vec<Value>),
        Object(Vec<(String, Value)>),
    }
}

impl BridgeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }

    /// 壳内部未分类错误。
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("E_INTERNAL", message)
    }

    /// 参数校验失败。
    pub fn invalid_arg(message: impl Into<String>) -> Self {
        Self::new("E_INVALID_ARG", message)
    }

    /// 目标不存在。
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new("E_NOT_FOUND", what)
    }

    /// 已裁撤能力（ipc-commands.md §2.4 裁撤表）。
    pub fn cut(what: impl Into<String>) -> Self {
        Self::new("E_CUT_FEATURE", what)
    }

    /// 下游超时。
    pub fn timeout(what: impl Into<String>) -> Self {
        Self::new("E_TIMEOUT", what)
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for BridgeError {}

impl Serialize for BridgeError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let n = if self.detail.is_some() { 3 } else { 2 };
        let mut map = s.serialize_map(Some(n))?;
        map.serialize_entry("code", self.code)?;
        map.serialize_entry("message", &self.message)?;
        if let Some(d) = &self.detail {
            // detail 只进日志/诊断，不承诺序列化形态（error-codes.md §6.2）。
            map.serialize_entry("detail", &format!("{d:?}"))?;
        }
        map.end()
    }
}

/// 便捷：把 io 错误包成 E_INTERNAL。
impl From<std::io::Error> for BridgeError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(format!("io: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_format() {
        let e = BridgeError::cut("内核自动更新链已删除");
        assert_eq!(e.to_string(), "[E_CUT_FEATURE] 内核自动更新链已删除");
    }

    #[test]
    fn codes_stable() {
        assert_eq!(BridgeError::internal("x").code, "E_INTERNAL");
        assert_eq!(BridgeError::invalid_arg("x").code, "E_INVALID_ARG");
        assert_eq!(BridgeError::not_found("x").code, "E_NOT_FOUND");
        assert_eq!(BridgeError::cut("x").code, "E_CUT_FEATURE");
        assert_eq!(BridgeError::timeout("x").code, "E_TIMEOUT");
    }
}
