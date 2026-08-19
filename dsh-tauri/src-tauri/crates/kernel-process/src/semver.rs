//! dsh 内核版本比较（rc 前缀形态）。
//!
//! 形态：`0.1.0-rc.7` / `0.1.0-rc.8` / `0.2.0` / `0.1.0-rc.10`。
//! 规则（对齐 Electron 版 updater.compareVersions 的语义子集）：
//! - 主/次/修订数值比较；
//! - 无 pre > 有 pre（`0.1.0` > `0.1.0-rc.8`）；
//! - 同为 rc：rc 数字比较（rc.10 > rc.9，**不是**字典序）。

/// 比较两个版本串：`None` 表示某侧无法解析（调用方按「未知版本」保守处理）。
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    Some(parse(a)?.cmp(&parse(b)?))
}

#[derive(Debug, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// None = 正式版（大于任何 rc）；Some(n) = rc.n。
    pre: Option<u64>,
}

// 正式版 > rc：Option 的默认 Ord 会把 None 排在 Some 之前，方向恰好相反，手工实现。
impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
            .then_with(|| match (self.pre, other.pre) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => a.cmp(&b),
            })
    }
}
impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn parse(s: &str) -> Option<Version> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    let pre = match pre {
        None => None,
        Some(p) => {
            let n = p.trim_start_matches("rc.").trim();
            Some(n.parse().ok()?)
        }
    };
    Some(Version { major, minor, patch, pre })
}

/// 内核版本是否 >= 0.1.0-rc.8（`--no-open` 参数门控，Electron 版 main.js startServer
/// 的 compareVersions 门控语义；rc.7 的 commander 会拒绝未知选项，故必须门控）。
pub fn needs_no_open_flag(kernel_version: &str) -> bool {
    compare_versions(kernel_version, "0.1.0-rc.8").map(|o| o != std::cmp::Ordering::Less).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn rc_numbering_not_lexicographic() {
        assert_eq!(compare_versions("0.1.0-rc.10", "0.1.0-rc.9"), Some(Greater));
        assert_eq!(compare_versions("0.1.0-rc.8", "0.1.0-rc.7"), Some(Greater));
    }

    #[test]
    fn release_beats_rc() {
        assert_eq!(compare_versions("0.1.0", "0.1.0-rc.8"), Some(Greater));
        assert_eq!(compare_versions("0.2.0", "0.1.9"), Some(Greater));
    }

    #[test]
    fn equal_and_less() {
        assert_eq!(compare_versions("0.1.0-rc.7", "0.1.0-rc.7"), Some(Equal));
        assert_eq!(compare_versions("0.1.0-rc.7", "0.1.0-rc.8"), Some(Less));
    }

    #[test]
    fn no_open_gate() {
        assert!(!needs_no_open_flag("0.1.0-rc.7"), "rc.7 传 --no-open 会被 commander 拒绝");
        assert!(needs_no_open_flag("0.1.0-rc.8"));
        assert!(needs_no_open_flag("0.1.0-rc.10"));
        assert!(needs_no_open_flag("0.1.0"));
        assert!(needs_no_open_flag("garbage"), "未知版本保守加 flag（新版本更需要）");
    }

    #[test]
    fn unparsable_yields_none() {
        assert_eq!(compare_versions("x.y.z", "0.1.0"), None);
    }
}
