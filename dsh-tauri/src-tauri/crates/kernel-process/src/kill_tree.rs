//! 跨平台杀树（supervisor `kill_kernel` 的 OS 绑定）。
//!
//! - **Windows**：`taskkill /PID <pid> /T /F`——树枚举交给 taskkill，/F 立即
//!   强杀（Electron 版实证：控制台进程优雅 kill 无效）。从 supervisor 内联
//!   实现原样搬迁，逐参数一致（含 CREATE_NO_WINDOW），行为零变更。
//! - **Unix（mac/linux）**：内核 spawn 时被设为**进程组长**（PGID == pid，见
//!   [`set_process_group_leader`]），其全部子孙（工具进程/持久终端会话）天然
//!   继承同一 PGID → 对 `-pgid` 发 SIGKILL 一次收割整组。**为何不先 SIGTERM
//!   宽限**：对齐 Windows /F 的立即强杀语义（优雅 kill 已被 Electron 版实证
//!   无效）；内核侧无依赖 SIGTERM 的清理钩子；退出路径需要有时限上界（直接
//!   SIGKILL 恒 0s，满足 <3s 约束）。
//!
//! 「Unix 分支选择」（[`kill_branch_for`]/[`kill_branch`]）与「pid→-pgid 取负」
//! （[`unix_kill_target`]）为纯函数，全平台（含 Windows CI）可单测；真实
//! killpg 端到端见本文件 `unix_e2e`（cfg(unix)，待 mac/linux CI 验证）。

use std::process::Child;

/// 杀树分支（纯决策枚举，可全平台单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillBranch {
    /// Windows：`taskkill /T /F`（树枚举交给系统工具）。
    WindowsTaskkill,
    /// Unix：对 `-pgid` 发 SIGKILL（进程组语义整组收割）。
    UnixProcessGroup,
}

/// 平台分支表：`is_windows` → 杀树策略（纯映射，全平台可测）。
pub fn kill_branch_for(is_windows: bool) -> KillBranch {
    if is_windows {
        KillBranch::WindowsTaskkill
    } else {
        KillBranch::UnixProcessGroup
    }
}

/// 当前编译目标所属的杀树分支（`cfg!(windows)` 的运行时常量形式）。
pub fn kill_branch() -> KillBranch {
    kill_branch_for(cfg!(windows))
}

/// pid → killpg 目标：取负得 `-pgid`（组长 spawn 约定下 pgid == pid）。
///
/// 返回 `None` 表示 pid 非法、调用方须回退单杀：
/// - `pid == 0`：`kill(0, sig)` 会打向**调用方自己的进程组**（灾难性误杀）；
/// - `pid > i32::MAX`：无法表示为负 pgid（Linux/Mac 的 pid 上限远低于此，
///   纯防御）。
pub fn unix_kill_target(pid: u32) -> Option<i32> {
    if pid == 0 {
        return None;
    }
    i32::try_from(pid).ok().map(|p| -p)
}

/// Unix：把即将 spawn 的内核设为进程组长（杀树根基）。
///
/// `process_group(0)` = 以子进程自身 pid 为 PGID；std 在 fork 后、exec 前于
/// 父子两侧各 setpgid 一次（防竞态），exec 后子进程即组长，其后续全部子孙
/// 继承该组 → [`kill_tree`] 的 `killpg(-pgid)` 才能整组收割。非 Unix 平台
/// no-op（Windows 杀树走 Job Object + taskkill）。
#[cfg(unix)]
pub fn set_process_group_leader(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
pub fn set_process_group_leader(_cmd: &mut std::process::Command) {}

/// 杀掉内核进程及其全部子孙（supervisor `kill_kernel` 唯一杀树入口）。
///
/// 三段式（Windows 原语义）：整树强杀 → 主进程兜底杀 → `wait()` 收尸。
#[cfg(windows)]
pub fn kill_tree(child: &mut Child, pid: u32) {
    use std::os::windows::process::CommandExt;
    // 与 supervisor 旧内联实现逐参数一致（含 CREATE_NO_WINDOW 防控制台窗
    // 闪现）——Windows 行为零变更红线。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = child.kill();
    let _ = child.wait();
}

/// Unix 杀树：`killpg(-pgid, SIGKILL)` 整组收割。
///
/// 组杀失败（如 spawn 异常路径未设组长、或权限缺失）不阻断——后续
/// `child.kill()` 兜底单杀主进程，保证至少内核本体终结。
#[cfg(unix)]
pub fn kill_tree(child: &mut Child, pid: u32) {
    if let Some(target) = unix_kill_target(pid) {
        // ESRCH（组已空/已收割）不算失败，下方主进程兜底仍在。
        unsafe {
            libc::kill(target, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 其余 exotic 目标（本仓无此矩阵）：退化为单杀 + 收尸。
#[cfg(not(any(windows, unix)))]
pub fn kill_tree(child: &mut Child, _pid: u32) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 平台分支表（纯映射，Windows CI 上跑）：Windows → taskkill；其余 → 进程组。
    #[test]
    fn kill_branch_table() {
        assert_eq!(kill_branch_for(true), KillBranch::WindowsTaskkill);
        assert_eq!(kill_branch_for(false), KillBranch::UnixProcessGroup);
    }

    /// 当前编译目标分支与 cfg 一致（Windows 测试矩阵断言 Taskkill 臂；
    /// 未来 mac/linux CI 跑到此处自动断言 ProcessGroup 臂）。
    #[test]
    fn kill_branch_matches_host_cfg() {
        let expect = if cfg!(windows) { KillBranch::WindowsTaskkill } else { KillBranch::UnixProcessGroup };
        assert_eq!(kill_branch(), expect);
    }

    /// pid → -pgid 取负（Unix killpg 目标约定）：常规 pid 取负；0 与超
    /// i32::MAX 判非法（None → 调用方回退单杀）；合法结果恒负。
    /// pid=0 的 None 尤其关键：kill(0, sig) 会打向调用方自己的组。
    #[test]
    fn unix_kill_target_negates_pid() {
        assert_eq!(unix_kill_target(4242), Some(-4242));
        assert_eq!(unix_kill_target(1), Some(-1));
        assert_eq!(unix_kill_target(i32::MAX as u32), Some(i32::MIN + 1));
        assert_eq!(unix_kill_target(0), None, "pid=0 必须判非法：killpg(0) 会误杀自己的进程组");
        assert_eq!(unix_kill_target(i32::MAX as u32 + 1), None, "超 i32::MAX 的 pid 无法表示为 -pgid");
        for pid in 1..=4096u32 {
            assert!(unix_kill_target(pid).unwrap() < 0, "合法 pid 目标恒负（-pgid 约定）: {pid}");
        }
    }
}

/// 真实 killpg 端到端（仅 unix 编译执行）：组长 spawn → 组内落孙进程 →
/// kill_tree 整组收割。【待 mac/linux CI 验证——本仓测试矩阵仅 Windows，
/// 本模块纯逻辑测试已在 Windows 全绿】
#[cfg(all(test, unix))]
mod unix_e2e {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn kill_tree_reaps_whole_process_group() {
        let mut cmd = Command::new("sh");
        // 两个孙进程挂在 sh 组下；trap '' TERM 排除「恰好被优雅信号杀掉」的
        // 假阳性——只有 killpg 的 SIGKILL 能灭掉它们。
        cmd.args(["-c", "trap '' TERM; sleep 30 & sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        set_process_group_leader(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(300)); // 让孙进程落组
        kill_tree(&mut child, pid);
        let _ = child.wait(); // 主进程已终结（不 zombie）
        // 组内不应再有存活成员：killpg 探测（SIGKILL 再发一次，幂等）在 2s
        // 内应得 ESRCH（孤儿孙进程被 init/launchd 收尸后组彻底消亡）。
        let target = unix_kill_target(pid).unwrap();
        let mut reaped = false;
        for _ in 0..20 {
            let rc = unsafe { libc::kill(target, libc::SIGKILL) };
            if rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                reaped = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(reaped, "kill_tree 后进程组应在 2s 内全灭（killpg 探测 ESRCH）");
    }
}
