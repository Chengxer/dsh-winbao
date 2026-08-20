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

    /// 读取全部设置；文件不存在返回空对象。
    ///
    /// **损坏自愈**（兼容性不报错契约）：坏 JSON / 顶层非对象 → 原文件隔离为
    /// `<name>.json.broken`（保留现场供排查）后从空配置继续——否则 set() 的
    /// 读-改-写会永远失败（lastWebPort 等壳层偏好持续静默丢失），且调用方
    /// 只能一路 `.ok()` 降级。壳层偏好可重建，绝不因坏配置卡死读写。
    pub fn load(&self) -> Result<serde_json::Map<String, serde_json::Value>, SettingsError> {
        if !self.path.exists() {
            return Ok(serde_json::Map::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|e| SettingsError(format!("read {}: {e}", self.path.display())))?;
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(self.quarantine_broken()),
        };
        match v {
            serde_json::Value::Object(m) => Ok(m),
            _other => Ok(self.quarantine_broken()),
        }
    }

    /// 隔离损坏的 settings 文件并返回空配置（隔离失败也回空——读写必须能继续）。
    fn quarantine_broken(&self) -> serde_json::Map<String, serde_json::Value> {
        let backup = self.path.with_extension("json.broken");
        eprintln!(
            "[settings] {} 损坏，隔离为 {} 后从空配置继续",
            self.path.display(),
            backup.display()
        );
        let _ = fs::rename(&self.path, &backup);
        serde_json::Map::new()
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
    fn corrupt_file_quarantined_and_self_heals() {
        let p = temp_path("corrupt");
        fs::write(&p, "{not json").unwrap();
        let store = SettingsStore::new(&p);
        // 损坏自愈契约：不报错、不卡死——隔离 .broken 后从空配置继续，后续读写正常。
        assert!(store.load().unwrap().is_empty(), "损坏文件应自愈为空配置");
        let backup = p.with_extension("json.broken");
        assert!(backup.exists(), "损坏现场应隔离为 {backup:?}");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{not json", "隔离文件保留原始现场");
        store.set("lastWebPort", json!(51731)).unwrap();
        assert_eq!(
            SettingsStore::new(&p).get("lastWebPort").unwrap(),
            Some(json!(51731)),
            "自愈后 set/get 应完全恢复"
        );
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(&backup);
    }

    #[test]
    fn cut_keys_recognized() {
        assert!(is_cut_key("kernelUpdate"));
        assert!(is_cut_key("kernelUpdate.skipVersion"));
        assert!(!is_cut_key("pet"));
        assert!(!is_cut_key("clientUpdate"));
    }

    #[test]
    fn top_level_non_object_quarantined() {
        let p = temp_path("nonobj");
        fs::write(&p, "[1,2]").unwrap();
        assert!(SettingsStore::new(&p).load().unwrap().is_empty(), "顶层非对象同样自愈");
        assert!(p.with_extension("json.broken").exists());
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("json.broken"));
    }
}
