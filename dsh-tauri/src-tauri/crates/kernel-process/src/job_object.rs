//! Windows Job Object：父进程死亡 → OS 收割内核进程树。
//!
//! **为什么必须**：taskkill /F 强杀壳进程时，任何用户态清理钩子
//! （RunEvent::Exit / Drop）都不会执行，内核成为孤儿（Review#2 实测抓到：
//! 63283 端口 LISTENING 残留）。Job Object + KILL_ON_JOB_CLOSE 是 OS 级保证：
//! 壳进程句柄表关闭（无论正常退出还是强杀）→ 内核树全部终结。
//!
//! handle 故意不 Drop（进程生命周期持有）；正常退出路径仍走显式
//! taskkill（kill_kernel），Job Object 只兜「来不及清理」的场景。

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 将子进程纳入杀树 Job。成功后调用方应 forget 返回值（句柄随进程关闭）。
    pub fn assign_child_to_kill_on_close_job(child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW 失败".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err("SetInformationJobObject(KILL_ON_JOB_CLOSE) 失败".into());
            }
            let proc = child.as_raw_handle() as HANDLE;
            if AssignProcessToJobObject(job, proc) == 0 {
                return Err("AssignProcessToJobObject 失败（杀树保护未生效）".into());
            }
            // 故意泄漏 job 句柄：随本进程句柄表关闭触发 OS 收割。
            Ok(())
        }
    }
}

#[cfg(windows)]
pub use imp::assign_child_to_kill_on_close_job;

#[cfg(not(windows))]
/// 非 Windows 空壳（保持现状，无 OS 句柄可建）。Unix 侧的进程树收割语义
/// 由**进程组**承担：spawn 时设内核为进程组长（`kill_tree::
/// set_process_group_leader`，子孙天然继承 PGID）+ 显式退出/重启路径
/// `killpg(-pgid, SIGKILL)`（`kill_tree::kill_tree`）。注意进程组与 Job
/// Object 的边界差异：Job Object 连「壳被第三方强杀」都能兜（句柄表关闭即
/// 收割）；进程组只覆盖显式 kill 路径——壳本身被 SIGKILL 时内核组不随父
/// 死，属 Unix 已知边界（本次修复目标是「退出应用杀不干净」，显式路径
/// 已全覆盖）。本函数恒成功（no-op）。
pub fn assign_child_to_kill_on_close_job(_child: &std::process::Child) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn child_can_be_assigned() {
        // ping 是长命子进程，赋 job 后立即杀——验证赋值路径不报错。
        let mut child = Command::new("cmd")
            .args(["/C", "pause"])
            .spawn()
            .expect("spawn");
        let r = assign_child_to_kill_on_close_job(&child);
        let _ = child.kill();
        let _ = child.wait();
        assert!(r.is_ok(), "Job Object 赋值应成功: {r:?}");
    }
}
