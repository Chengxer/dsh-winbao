//! # sidecar-orchestrator —— Node sidecar 编排
//!
//! 22 个文本手术补丁、插件同步、heal、guard 全部是**官方 JS 模块的消费者**，
//! Rust 复刻风险过高（rc.7→rc.8 迁移实测：锚点对内核代码形状极敏感）。
//! 因此 Tauri 版把这些能力全部保留在 Node sidecar 里——复用
//! `dsh-desktop/scripts/`（sync-companion-plugins --with-patches 等，零重写），
//! 本 crate 只做**编排**：
//!
//! - [`boot`]          —— boot 时序的状态序验证（data-flow.md §3 步骤 [1]-[3]）
//! - [`sidecar_cmd`]   —— sidecar 命令构造（node + 脚本 + 参数）
//!
//! 契约不变量（data-flow.md §2）：State→Patch→Manifest→Modules 的单一数据流，
//! sidecar 是 Patch 的唯一写入方；本 crate 不实现任何文件写入。

use std::path::PathBuf;

/// boot 序列步骤（data-flow.md §3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BootStep {
    Repair,
    Sync,
    Presets,
    Patches,
    Preflight,
}

impl BootStep {
    pub const ORDER: [BootStep; 5] =
        [BootStep::Repair, BootStep::Sync, BootStep::Presets, BootStep::Patches, BootStep::Preflight];

    /// 该步骤在 Electron 版的落点（溯源用；Phase 2 抽出独立 sidecar 入口时更新）。
    /// Presets 与 Preflight 目前在 main.js 内联 / kernel-process crate，
    /// 不对应脚本——返回占位说明。
    pub fn electron_entry(&self) -> &'static str {
        match self {
            BootStep::Repair => "scripts/repair-session-log.js + main.js 内联 manifest heal",
            BootStep::Sync => "scripts/sync-companion-plugins.js --with-patches",
            BootStep::Presets => "main.js 内联 presets 同步（Phase 2 抽出）",
            BootStep::Patches => "scripts/lib/patch-engine（patch-* 家族，main.js 引导）",
            BootStep::Preflight => "kernel-process::choose_stable_port（Rust）",
        }
    }
}

/// 校验 boot 计划的顺序合法性（缺步/乱序拒绝）。
pub fn validate_boot_plan(plan: &[BootStep]) -> Result<(), String> {
    let expect = BootStep::ORDER;
    if plan.len() != expect.len() {
        return Err(format!("boot 计划必须恰含 {} 步，得到 {}", expect.len(), plan.len()));
    }
    for (i, (got, want)) in plan.iter().zip(expect.iter()).enumerate() {
        if got != want {
            return Err(format!("boot 第 {i} 步应为 {want:?}，得到 {got:?}（data-flow.md §3 固定顺序）"));
        }
    }
    Ok(())
}

/// 一次 sidecar 调用的命令构造。
#[derive(Debug, Clone)]
pub struct SidecarCmd {
    pub node_exe: PathBuf,
    pub script: PathBuf,
    pub args: Vec<String>,
}

impl SidecarCmd {
    /// 同步伴随插件（含补丁）：`node sync-companion-plugins.js --with-patches`。
    pub fn sync_with_patches(node_exe: PathBuf, scripts_dir: PathBuf) -> Self {
        Self {
            node_exe,
            script: scripts_dir.join("sync-companion-plugins.js"),
            args: vec!["--with-patches".into()],
        }
    }

    pub fn display_cmd(&self) -> String {
        format!("{} {} {}", self.node_exe.display(), self.script.display(), self.args.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_plan_valid() {
        assert!(validate_boot_plan(&BootStep::ORDER).is_ok());
    }

    #[test]
    fn wrong_order_rejected() {
        let mut plan = BootStep::ORDER;
        plan.swap(0, 1);
        assert!(validate_boot_plan(&plan).is_err());
    }

    #[test]
    fn missing_step_rejected() {
        assert!(validate_boot_plan(&BootStep::ORDER[..4]).is_err());
    }

    #[test]
    fn sync_cmd_shape() {
        let c = SidecarCmd::sync_with_patches("node.exe".into(), "scripts".into());
        assert!(c.script.ends_with("sync-companion-plugins.js"));
        assert_eq!(c.args, vec!["--with-patches"]);
        assert!(c.display_cmd().contains("--with-patches"));
    }

    #[test]
    fn electron_entries_are_real() {
        // 与 dsh-desktop/scripts/ 实际文件对齐（2026-08-19 清点）。
        assert!(BootStep::Repair.electron_entry().contains("repair-session-log.js"));
        assert!(BootStep::Sync.electron_entry().contains("sync-companion-plugins.js"));
    }
}
