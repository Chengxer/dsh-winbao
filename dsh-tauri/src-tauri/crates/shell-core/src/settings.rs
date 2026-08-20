//! 设置存储：JSON 文件，schema 兼容 Electron 版 `updater.loadSettings`。
//!
//! 兼容策略（data-flow.md §5）：沿用同一文件同一 JSON 对象；已裁撤字段
//! （如 `kernelUpdate.skipVersion`）读取时忽略——**不报错、不删除**，
//! 向前兼容旧用户目录。写入采用原子写（临时文件 + rename）。

use std::fs;
use std::path::PathBuf;

/// 设置存储。内部为扁平 JSON 对象（键 → 任意 JSON 值）。
pub struct SettingsStore {
    path: PathBuf,
}

/// 原子写失败的错误。
#[derive(Debug)]
pub struct SettingsError(pub String);

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "settings: {}", self.0)
    }
}
impl std::error::Error for SettingsError {}

/// 全局写互斥：同进程内多 Store 实例（supervisor 写 lastWebPort、窗口关闭写
/// 其他键等）的读-改-写串行化，防丢更新（升级 review 优化项）。
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl SettingsStore {
    /// 指向给定 settings.json 路径的存储。
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 读取全部设置；文件不存在返回空对象；损坏时返回 Err（调用方决定是否修复）。
    pub fn load(&self) -> Result<serde_json::Map<String, serde_json::Value>, SettingsError> {
        if !self.path.exists() {
            return Ok(serde_json::Map::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|e| SettingsError(format!("read {}: {e}", self.path.display())))?;
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| SettingsError(format!("parse {}: {e}", self.path.display())))?;
        match v {
            serde_json::Value::Object(m) => Ok(m),
            other => Err(SettingsError(format!(
                "{}: 顶层不是 JSON 对象（{}），拒绝加载",
                self.path.display(),
                type_name_of(&other)
            ))),
        }
    }

    /// 原子写：先写 `<path>.tmp` 再 rename 覆盖。
    pub fn save(&self, map: &serde_json::Map<String, serde_json::Value>) -> Result<(), SettingsError> {
        let tmp = self.path.with_extension("json.tmp");
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| SettingsError(format!("mkdir {}: {e}", parent.display())))?;
        }
        let body = serde_json::to_string_pretty(map)
            .map_err(|e| SettingsError(format!("serialize: {e}")))?;
        fs::write(&tmp, body).map_err(|e| SettingsError(format!("write {}: {e}", tmp.display())))?;
        fs::rename(&tmp, &self.path)
            .map_err(|e| SettingsError(format!("rename → {}: {e}", self.path.display())))?;
        Ok(())
    }

    /// 读单个键（裁撤字段的忽略逻辑在调用方按 key 判断）。
    pub fn get(&self, key: &str) -> Result<Option<serde_json::Value>, SettingsError> {
        Ok(self.load()?.remove(key))
    }

    /// 写单个键（读-改-写经全局写锁串行化，进程内防丢更新）。
    pub fn set(&self, key: &str, value: serde_json::Value) -> Result<(), SettingsError> {
        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = self.load()?;
        map.insert(key.to_string(), value);
        self.save(&map)
    }
}

fn type_name_of(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// 判断某键是否属于已裁撤的内核更新链残留（读取时忽略，写入时剔除）。
/// 对应 ipc-commands.md §2.4 裁撤表。
pub fn is_cut_key(key: &str) -> bool {
    matches!(key, "kernelUpdate" | "agentUpdate")
        || key.starts_with("kernelUpdate.")
        || key.starts_with("agentUpdate.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_path(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-shell-core-test-{}-{}.json", tag, std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn roundtrip_and_atomic_layout() {
        let p = temp_path("roundtrip");
        let store = SettingsStore::new(&p);
        assert!(store.load().unwrap().is_empty());
        store.set("pet", json!({"autoOpen": true})).unwrap();
        let mut loaded = store.load().unwrap();
        assert_eq!(loaded.remove("pet"), Some(json!({"autoOpen": true})));
        assert!(!p.with_extension("json.tmp").exists(), "临时文件应已被 rename 消费");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn corrupt_file_errors_instead_of_wiping() {
        let p = temp_path("corrupt");
        fs::write(&p, "{not json").unwrap();
        let store = SettingsStore::new(&p);
        let err = store.load().unwrap_err();
        assert!(err.0.contains("parse"), "损坏文件必须显式报错而不是清空: {err}");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn cut_keys_recognized() {
        assert!(is_cut_key("kernelUpdate"));
        assert!(is_cut_key("kernelUpdate.skipVersion"));
        assert!(!is_cut_key("pet"));
        assert!(!is_cut_key("clientUpdate"));
    }

    #[test]
    fn top_level_non_object_rejected() {
        let p = temp_path("nonobj");
        fs::write(&p, "[1,2]").unwrap();
        assert!(SettingsStore::new(&p).load().is_err());
        let _ = fs::remove_file(&p);
    }
}
