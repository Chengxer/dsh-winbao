//! # fence —— 文件围栏
//!
//! 对齐 Electron 版 main.js 的 fileRoots 语义：「文件」/「全部文件」视图的
//! 打开与还原操作只允许落在项目根（dsh home 下的会话工作区）内，
//! 拒绝路径穿越与越界绝对路径。
//!
//! Phase 0 交付纯逻辑（roots 判定）；zstd 首帧 cwd 解析与 file-revert 的
//! 逆序应用在 Phase 3（契约 error-codes.md §4 的 E_FENCE_* 全集届时启用）。

use std::path::{Path, PathBuf};

/// 围栏：允许访问的根集合。
#[derive(Debug, Clone)]
pub struct Fence {
    roots: Vec<PathBuf>,
}

impl Fence {
    /// 构造围栏（roots 会被规范化：组件级清洗，不做文件系统 canonicalize——
    /// 目标可能不存在）。
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            roots: roots.into_iter().map(|p| clean(&p)).collect(),
        }
    }

    /// 路径是否在任一 root 内（含 root 本身）。
    /// - `..` 组件先被清洗（拒绝穿越）；
    /// - Windows 分隔符差异（`\` vs `/`）统一处理；
    /// - 不同盘符直接拒绝。
    pub fn contains(&self, target: &Path) -> bool {
        let t = clean(target);
        self.roots.iter().any(|r| t.starts_with(r))
    }

    /// 断言式访问：越界返回 `E_FENCE_ROOT` 错误（error-codes.md §4）。
    pub fn ensure(&self, target: &Path) -> Result<PathBuf, FenceError> {
        let t = clean(target);
        if self.contains(&t) {
            Ok(t)
        } else {
            Err(FenceError(format!("[E_FENCE_ROOT] 路径越界: {}", target.display())))
        }
    }
}

/// 围栏错误（Display 内嵌错误码，与 bridge::BridgeError 的 `[CODE]` 口径一致）。
#[derive(Debug)]
pub struct FenceError(pub String);
impl std::fmt::Display for FenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for FenceError {}

/// 组件级路径清洗：统一分隔符、消解 `.`/`..`（不触碰文件系统）。
fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            Prefix(_) | RootDir => out.push(comp.as_os_str()),
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            Normal(c) => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fence() -> Fence {
        Fence::new([PathBuf::from(r"C:\Users\u\.dsh\sessions\work")])
    }

    #[test]
    fn inside_ok_including_root() {
        let f = fence();
        assert!(f.contains(Path::new(r"C:\Users\u\.dsh\sessions\work")));
        assert!(f.contains(Path::new(r"C:\Users\u\.dsh\sessions\work\a\b.txt")));
        // 分隔符混用
        assert!(f.contains(Path::new(r"C:/Users/u/.dsh/sessions/work/x.md")));
    }

    #[test]
    fn traversal_rejected() {
        let f = fence();
        assert!(!f.contains(Path::new(r"C:\Users\u\.dsh\sessions\work\..\..\secret")));
        assert!(!f.contains(Path::new(r"C:\Users\u\.dsh\other")));
        assert!(!f.contains(Path::new(r"C:\Windows\System32")));
        assert!(!f.contains(Path::new(r"D:\anywhere")));
    }

    #[test]
    fn ensure_error_carries_code() {
        let err = fence().ensure(Path::new(r"C:\Windows\System32\cmd.exe")).unwrap_err();
        assert!(err.to_string().starts_with("[E_FENCE_ROOT]"), "{}", err);
        assert!(fence().ensure(Path::new(r"C:\Users\u\.dsh\sessions\work\notes.md")).is_ok());
    }
}

#[cfg(test)]
mod edge_tests {
    use super::*;

    #[test]
    fn multi_root_fence() {
        let f = Fence::new([PathBuf::from(r"C:\a"), PathBuf::from(r"D:\b")]);
        assert!(f.contains(Path::new(r"C:\a\x")));
        assert!(f.contains(Path::new(r"D:\b\y\z")));
        assert!(!f.contains(Path::new(r"C:\c")));
        assert!(!f.contains(Path::new(r"D:\d")));
    }

    #[test]
    fn ensure_returns_cleaned_path() {
        let f = Fence::new([PathBuf::from(r"C:\root")]);
        let cleaned = f.ensure(Path::new(r"C:\root\sub\..\x.md")).unwrap();
        assert_eq!(cleaned, PathBuf::from(r"C:\root\x.md"), "应返回消解 .. 后的清洗路径");
    }

    #[test]
    fn empty_fence_rejects_everything() {
        let f = Fence::new(Vec::<PathBuf>::new());
        assert!(!f.contains(Path::new(r"C:\any")));
        assert!(f.ensure(Path::new("relative.txt")).is_err());
    }
}
