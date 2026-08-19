//! 单实例锁。
//!
//! Phase 0：锁文件实现（`app_data/single-instance.lock`，创建即持锁，进程退出
//! 由 Drop 删除）。语义与 Electron 版 `app.requestSingleInstanceLock()` 对齐：
//! 第二实例拿锁失败 → 激活已有窗口后退出。
//!
//! Phase 1 计划：换 Windows 命名互斥体（`CreateMutexW`，进程崩溃 OS 自动回收，
//! 无残留锁文件问题）。锁文件实现保留为跨平台兜底与测试基线。

use std::fs;
use std::path::PathBuf;

/// 持锁守卫；Drop 时释放（删除锁文件）。
#[derive(Debug)]
pub struct SingleInstanceGuard {
    path: PathBuf,
    released: bool,
}

impl SingleInstanceGuard {
    /// 尝试以独占方式创建锁文件。
    /// - `Ok(guard)`：拿到单实例权
    /// - `Err(())`：已有实例在跑（或锁文件残留——Phase 1 用互斥体后此歧义消失；
    ///   当前实现按「视为已运行」保守处理，与 Electron 语义一致）
    pub fn acquire(path: impl Into<PathBuf>) -> Result<Self, ()> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                let _ = writeln!(f, "{}", std::process::id());
                Ok(Self { path, released: false })
            }
            Err(_) => Err(()),
        }
    }

    /// 显式释放（幂等）。
    pub fn release(&mut self) {
        if !self.released {
            self.released = true;
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_and_release_allows_again() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);

        let mut first = SingleInstanceGuard::acquire(&p).expect("首个实例应拿到锁");
        assert!(SingleInstanceGuard::acquire(&p).is_err(), "第二实例必须失败");

        first.release();
        drop(first);
        assert!(SingleInstanceGuard::acquire(&p).is_ok(), "释放后可重新获取");
        let _ = fs::remove_file(&p);
    }
}
