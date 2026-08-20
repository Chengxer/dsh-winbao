//! 单实例锁。
//!
//! Phase 0：锁文件实现（`app_data/single-instance.lock`，创建即持锁，进程退出
//! 由 Drop 删除）。语义与 Electron 版 `app.requestSingleInstanceLock()` 对齐：
//! 第二实例拿锁失败 → 激活已有窗口后退出。
//!
//! 生命周期语义（Review#2 实测定稿）：`AppHandle::exit(0)` 走 `std::process::exit`，
//! Drop 与 Exit 事件均不保证执行——**锁文件在任何退出路径下都可能残留**，这是
//! 设计内状态而非缺陷：下次启动经陈锁回收（pid 已死 → 删除重建）正常拿锁
//! （强弱杀两路径实测）。Phase 1 若换 `CreateMutexW` 则由 OS 自动回收，此歧义消失。

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
    /// - `Err(())`：已有实例在跑，**或锁文件为强杀残留**——残留判定：读文件内
    ///   pid，进程已不存在则视为陈锁，删除后重试一次（Windows 命名互斥体在
    ///   Phase 1 换上后此歧义彻底消失；锁文件实现保留为兜底与测试基线）。
    ///
    /// `Err(())`（而非自定义错误类型）是刻意的最小信号面：失败原因是二元的
    /// （拿到/没拿到），消费方（装配根 lib.rs）只做 `is_err` 分支——改签名属
    /// 跨 crate 破坏性变更，不值得。
    #[allow(clippy::result_unit_err)]
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
            Err(_) => {
                if stale_lock(&path) {
                    let _ = fs::remove_file(&path);
                    return Self::acquire(&path);
                }
                Err(())
            }
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

/// 陈锁判定：文件内 pid 不再存活（或内容不可读/非法——按陈锁处理，
/// 宁可误删锁也不把用户锁死在「永远已在运行」）。
fn stale_lock(path: &std::path::Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else { return true };
    let Ok(pid) = raw.trim().parse::<u32>() else { return true };
    !pid_alive(pid)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // tasklist 过滤 PID（无 wmic 依赖的现代 Windows 兜底）。
    // CREATE_NO_WINDOW：GUI 进程起 console 程序必须抑制终端窗（陈锁回收
    // 在启动路径触发，无旗则闪终端——0.5.0 修复）。
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(true) // 查询失败按存活处理（保守：不删活锁）
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new("/proc").join(pid.to_string()).exists()
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

    #[test]
    fn stale_lock_from_dead_pid_is_reclaimed() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-stale-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);
        // 写一个几乎不可能存活的 pid（Windows 冷启动 pid 区间之外的大值）。
        fs::write(&p, "3999999").unwrap();
        let mut g = SingleInstanceGuard::acquire(&p).expect("陈锁应被回收");
        g.release();
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn live_pid_lock_not_reclaimed() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-live-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);
        fs::write(&p, std::process::id().to_string()).unwrap();
        assert!(SingleInstanceGuard::acquire(&p).is_err(), "活进程的锁不得回收");
        let _ = fs::remove_file(&p);
    }
}
