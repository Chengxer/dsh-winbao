//! spawn 规格构造。
//!
//! 对齐 Electron 版 main.js startServer 的最终 spawn 命令：
//! ```text
//! <vendor-node> --use-system-ca [--require web-crash-shield.js]
//!   <bin.js> web [--patch <overlay>]... [--no-open] --host 127.0.0.1 --port <port>
//! ```
//! **参数位置契约**（rc.8 实证）：
//! - `--use-system-ca` / `--require` 是 **node 级**参数，必须位于 bin.js 之前；
//! - `web` 是子命令（`--profile web` 的别名）；`--patch` / `--no-open` / `--host` /
//!   `--port` 是 **web 子命令参数**，必须位于 `web` 之后——放前面会被父级解析器
//!   拒绝（"error: --profile <name> is required"）；
//! - `--patch` 必须位于 `--host` 之前（web 会把第一个应用参数后的内容透传，
//!   Electron 版 main.js 有同款注释）。
//!
//! 环境净化（Electron 版 shieldArgs 的等价物）：白名单透传，见 [`ENV_ALLOWLIST`]。
//! 本模块产出 `SpawnSpec`，真实 spawn 在 Phase 1 的 supervisor（Windows Job
//! Object 绑定）。

use crate::semver;

/// 一次内核 spawn 的完整参数。
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub node_exe: std::path::PathBuf,
    pub bin_js: std::path::PathBuf,
    /// node 级参数（bin.js 之前）。
    pub node_args: Vec<String>,
    /// web 子命令参数（bin.js 之后，含 `web` 本身）。
    pub web_args: Vec<String>,
    pub env_allow: Vec<String>,
}

/// 构造 web 子命令参数（`web` 开头）。
///
/// `kernel_version`：`@deepseek-ai/dsh` 的 package.json version。
/// `port`：已探测的安全端口。
/// `patch_yml`：overlay 补丁清单（Phase 2 起非空）。
pub fn web_args(kernel_version: &str, port: u16, patch_yml: &[std::path::PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = vec!["web".into()];
    for p in patch_yml {
        args.push("--patch".into());
        args.push(p.to_string_lossy().into_owned());
    }
    if semver::needs_no_open_flag(kernel_version) {
        args.push("--no-open".into());
    }
    args.push("--host".into());
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(port.to_string());
    args
}

/// node 级参数（对齐 Electron：证书修正 + 崩溃屏蔽 require）。
/// 崩溃屏蔽文件不存在时不注入（dev 检出兜底，Electron 同款）。
pub fn node_args(crash_shield: Option<&std::path::Path>) -> Vec<String> {
    let mut args = vec!["--use-system-ca".to_string()];
    if let Some(shield) = crash_shield {
        if shield.exists() {
            args.push("--require".into());
            args.push(shield.to_string_lossy().into_owned());
        }
    }
    args
}

/// 子进程环境白名单（Windows 必需集 + node 运行必需集）。
/// Electron 版 shieldArgs 的语义：**白名单**而非黑名单（防泄漏任意父进程变量）。
pub const ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "windir",
    "PATH",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOME",
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "DSH_HOME",
];

impl SpawnSpec {
    pub fn new(
        node_exe: impl Into<std::path::PathBuf>,
        bin_js: impl Into<std::path::PathBuf>,
        kernel_version: &str,
        port: u16,
        patch_yml: &[std::path::PathBuf],
    ) -> Self {
        Self {
            node_exe: node_exe.into(),
            bin_js: bin_js.into(),
            node_args: node_args(None),
            web_args: web_args(kernel_version, port, patch_yml),
            env_allow: ENV_ALLOWLIST.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 完整命令行（日志友好）。
    pub fn display_cmd(&self) -> String {
        format!(
            "{} {} {} {}",
            self.node_exe.display(),
            self.node_args.join(" "),
            self.bin_js.display(),
            self.web_args.join(" ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn rc7_has_no_flag_rc8_has() {
        assert!(!web_args("0.1.0-rc.7", 5000, &[]).contains(&"--no-open".to_string()));
        assert!(web_args("0.1.0-rc.8", 5000, &[]).contains(&"--no-open".to_string()));
    }

    #[test]
    fn arg_shape_matches_electron() {
        // Electron：node --use-system-ca bin.js web --patch X --no-open --host 127.0.0.1 --port N
        let args = web_args("0.1.0-rc.8", 51731, &[PathBuf::from("/ov/cordis.patch.yml")]);
        assert_eq!(
            args,
            vec![
                "web",
                "--patch", "/ov/cordis.patch.yml",
                "--no-open",
                "--host", "127.0.0.1",
                "--port", "51731",
            ]
        );
        // web 子命令必须排首位（--patch/--no-open 在 web 之后，父级才不会报 profile 缺失）。
        assert_eq!(args.first().map(String::as_str), Some("web"));
        let web_pos = args.iter().position(|a| a == "web").unwrap();
        let patch_pos = args.iter().position(|a| a == "--patch").unwrap();
        let host_pos = args.iter().position(|a| a == "--host").unwrap();
        assert!(web_pos < patch_pos && patch_pos < host_pos, "顺序：web < --patch < --host");
    }

    #[test]
    fn node_level_args_before_bin() {
        let spec = SpawnSpec::new("node.exe", "bin.js", "0.1.0-rc.8", 5000, &[]);
        assert_eq!(spec.node_args, vec!["--use-system-ca"]);
        assert_eq!(spec.web_args.first().map(String::as_str), Some("web"));
        let shield = PathBuf::from("/definitely/missing-shield.js");
        assert_eq!(node_args(Some(&shield)), vec!["--use-system-ca"], "屏蔽文件不存在时不注入");
    }

    #[test]
    fn env_allowlist_excludes_node_and_electron() {
        assert!(!ENV_ALLOWLIST.contains(&"NODE_OPTIONS"));
        assert!(!ENV_ALLOWLIST.contains(&"ELECTRON_RUN_AS_NODE"));
        assert!(ENV_ALLOWLIST.contains(&"SystemRoot"));
    }
}
