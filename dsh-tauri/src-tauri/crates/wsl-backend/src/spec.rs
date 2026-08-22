//! WSL 命令串构造（纯函数，快照断言锁形态）——注入面防御层。
//!
//! 命令串会被拼进 `wsl.exe -d <distro> -e sh -lc <cmd>` 的 argv（`-e` 原样
//! execvp、`sh -lc` 登录 shell 解析），因此每个外部输入（installDir / 版本号）
//! 必须先过 [`dir_forbidden`] / [`version_valid`] 白名单才允许进入。
//! 形态逐参照 Electron `dsh-desktop/wsl-backend.js`（installAgent / spawnServer /
//! stop / rollback），契约 `contracts/wsl-backend.md` §4.3/§4.5/§4.6。

/// 内核包名（npm install 目标）。
pub const PKG: &str = "@deepseek-ai/dsh";

/// 安装目录 shell 元字符黑名单（契约 §1.3，与 JS `INSTALL_DIR_FORBIDDEN` 同集）：
/// 目录被拼进 `sh -lc '…'`（单引号内插），除空白外必须拒绝会破坏引号/命令
/// 结构的字符。
pub fn dir_forbidden(dir: &str) -> bool {
    dir.chars().any(|c| {
        c.is_whitespace()
            || matches!(c, '$' | '`' | ';' | '&' | '|' | '<' | '>' | '"' | '\'' | '(' | ')' | '\\')
            || c.is_control()
    })
}

/// 版本号白名单：版本字符串被拼进 `npm install <pkg>@<version>`，只允许
/// 字母/数字/点/下划线/连字符（覆盖 0.1.0-rc.8 与 latest 形态）。
pub fn version_valid(v: &str) -> bool {
    !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// agent 包内 bin.js 入口（WSL 内 Linux 绝对路径）。
pub fn agent_bin(install_dir: &str) -> String {
    format!("{install_dir}/agent/node_modules/{PKG}/lib/bin.js")
}

/// agent 包目录（package.json 所在）。
pub fn agent_pkg_dir(install_dir: &str) -> String {
    format!("{install_dir}/agent/node_modules/{PKG}")
}

/// 内核 spawn 命令串（契约 §4.3，与 Electron spawnServer 逐参一致）。
///
/// 要点：`cd <dir>` 定工作目录；`echo $$ > dsh.pid` 写登录 shell 自身 pid
/// （`exec` 后即内核 pid）；`env -u …` 净化宿主残留变量并设 `DSH_HOME=<dir>`
/// （Windows 环境块不传进 WSL，净化只能在命令串内完成）；`--port 0` 由 WSL 内
/// OS 分配，实际端口从就绪行解析。
pub fn server_cmd(install_dir: &str, no_open: bool) -> String {
    format!(
        "cd {install_dir} && rm -f dsh.pid && echo $$ > dsh.pid \
         && exec env -u DSH_WEB_URL -u DSH_SESSION_ID -u DSH_SESSION_JSONL -u DSH_SHELL -u NODE_OPTIONS \
         DSH_HOME={install_dir} node {} web{} --host 127.0.0.1 --port 0",
        agent_bin(install_dir),
        if no_open { " --no-open" } else { "" }
    )
}

/// 收割命令串（契约 §4.6）：pid 文件 kill + 删 pid 文件，幂等。
/// **绝不 `wsl --terminate`**（会终结整个发行版内用户的其他进程）。
pub fn stop_cmd(install_dir: &str) -> String {
    format!(
        "p={install_dir}/dsh.pid; if [ -f \"$p\" ]; then kill $(cat \"$p\") 2>/dev/null || true; fi; rm -f {install_dir}/dsh.pid"
    )
}

/// npm staging 安装 + 原子切换命令串（契约 §4.5，Electron installAgent 同式）。
/// 成功判定必须含 stdout `WSL_INSTALL_OK` 尾标记（exit 0 ≠ 成功，issue #87）。
pub fn install_cmd(install_dir: &str, version: &str) -> String {
    let staging_bin = format!("{install_dir}/agent-staging/node_modules/{PKG}/lib/bin.js");
    format!(
        "set -eu; rm -rf {install_dir}/agent-staging; mkdir -p {install_dir}/agent-staging; \
         cd {install_dir}/agent-staging; export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false; \
         npm install --save-exact --omit=dev --no-audit --no-fund --no-update-notifier {PKG}@{version}; \
         test -f {staging_bin}; cd {install_dir}; \
         if [ -d agent ]; then rm -rf agent-prev; mv agent agent-prev; fi; \
         mv agent-staging agent; echo WSL_INSTALL_OK"
    )
}

/// 安装失败后的 staging 清理命令（短超时跑，防 WSL 卡死拖长错误抛出）。
pub fn cleanup_staging_cmd(install_dir: &str) -> String {
    format!("rm -rf {install_dir}/agent-staging")
}

/// 回退命令串（agent-prev → agent；Electron rollback 同式，M2 恢复页动作用）。
pub fn rollback_cmd(install_dir: &str) -> String {
    format!(
        "cd {install_dir} && rm -rf agent-failed && mv agent agent-failed 2>/dev/null || true; \
         if [ -d agent-prev ]; then mv agent-prev agent; echo WSL_ROLLBACK_OK; else echo WSL_NO_PREV; fi"
    )
}

/// agent-prev 在场探测命令。
pub fn has_prev_cmd(install_dir: &str) -> String {
    format!("test -d {install_dir}/agent-prev && echo YES")
}

/// agent 就绪 + 版本预检命令（stdout 输出 package.json 原文，缺失时 exit 非零）。
pub fn agent_check_cmd(install_dir: &str) -> String {
    format!("test -f {} && cat {}/package.json", agent_bin(install_dir), agent_pkg_dir(install_dir))
}

/// mkdir 预检（ensure_installed 首步）。
pub fn mkdir_cmd(install_dir: &str) -> String {
    format!("mkdir -p {install_dir}")
}

/// UNC 目录构造：`\\<host>\<distro><installDir 的反斜杠形态>`（契约 §4.1）。
pub fn unc_dir(unc_host: &str, distro: &str, install_dir: &str) -> String {
    format!("\\\\{unc_host}\\{distro}{}", install_dir.replace('/', "\\"))
}

/// UNC 主机白名单（契约 §1.2/§4.1：wsl.localhost 或 wsl$）。
pub fn is_unc_host(host: &str) -> bool {
    host == "wsl.localhost" || host == "wsl$"
}

/// 反解 UNC 路径（`\\wsl.localhost\Ubuntu\home\u\.dsh` → host/distro/linux 路径）。
/// 主机大小写不敏感、正斜杠容忍（与 sidecar wsl-paths.js parseWslUnc 同口径）。
/// linux 路径带前导 `/`（UNC 路径段 → WSL 内绝对路径）。
pub fn parse_unc(path: &str) -> Option<(String, String, String)> {
    let trimmed = path.trim_start_matches(['\\', '/']);
    let rest = trimmed.replace('/', "\\");
    let rest = rest.as_str();
    let (host, tail) = rest.split_once('\\')?;
    let host_l = host.to_ascii_lowercase();
    if host_l != "wsl.localhost" && host_l != "wsl$" {
        return None;
    }
    let (distro, linux) = tail.split_once('\\')?;
    if distro.is_empty() || linux.is_empty() {
        return None;
    }
    Some((host_l, distro.to_string(), format!("/{}", linux.replace('\\', "/"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// server_cmd 与契约 §4.3 形态逐字符比对（--no-open 门控）。
    #[test]
    fn server_cmd_matches_contract_shape() {
        let cmd = server_cmd("/home/u/.dsh-desktop", true);
        let expected = concat!(
            "cd /home/u/.dsh-desktop && rm -f dsh.pid && echo $$ > dsh.pid ",
            "&& exec env -u DSH_WEB_URL -u DSH_SESSION_ID -u DSH_SESSION_JSONL -u DSH_SHELL -u NODE_OPTIONS ",
            "DSH_HOME=/home/u/.dsh-desktop node ",
            "/home/u/.dsh-desktop/agent/node_modules/@deepseek-ai/dsh/lib/bin.js ",
            "web --no-open --host 127.0.0.1 --port 0",
        );
        assert_eq!(cmd, expected);
        // rc.7（无 --no-open）形态：web 后直接 --host。
        assert!(server_cmd("/d", false).contains("web --host 127.0.0.1 --port 0"));
        // 关键序：cd → rm pid → echo pid → exec env -u → node。
        let positions = [
            cmd.find("cd /home/u/.dsh-desktop").unwrap(),
            cmd.find("rm -f dsh.pid").unwrap(),
            cmd.find("echo $$ > dsh.pid").unwrap(),
            cmd.find("exec env -u DSH_WEB_URL").unwrap(),
            cmd.find("DSH_HOME=/home/u/.dsh-desktop").unwrap(),
        ];
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "命令串要素顺序: {cmd}");
        // 五个 env -u 净化项全在场。
        for var in ["DSH_WEB_URL", "DSH_SESSION_ID", "DSH_SESSION_JSONL", "DSH_SHELL", "NODE_OPTIONS"] {
            assert!(cmd.contains(&format!("-u {var}")), "缺 env -u {var}");
        }
    }

    /// stop_cmd 幂等形态（kill 失败吞掉 + rm pid）。
    #[test]
    fn stop_cmd_idempotent_shape() {
        let cmd = stop_cmd("/home/u/.dsh-desktop");
        assert!(cmd.contains("kill $(cat \"$p\") 2>/dev/null || true"));
        assert!(cmd.contains("rm -f /home/u/.dsh-desktop/dsh.pid"));
        assert!(!cmd.contains("--terminate"), "绝不 wsl --terminate（契约 §4.6 红线）");
        assert!(!cmd.contains("--shutdown"), "绝不 wsl --shutdown");
    }

    /// install_cmd：staging → 入口校验 → prev 保留 → 原子 mv → OK 尾标记全在场。
    #[test]
    fn install_cmd_shape() {
        let cmd = install_cmd("/home/u/.dsh-desktop", "0.1.1-rc.1");
        for needle in [
            "set -eu",
            "rm -rf /home/u/.dsh-desktop/agent-staging",
            "npm install --save-exact --omit=dev --no-audit --no-fund --no-update-notifier @deepseek-ai/dsh@0.1.1-rc.1",
            "test -f /home/u/.dsh-desktop/agent-staging/node_modules/@deepseek-ai/dsh/lib/bin.js",
            "rm -rf agent-prev; mv agent agent-prev",
            "mv agent-staging agent",
            "echo WSL_INSTALL_OK",
        ] {
            assert!(cmd.contains(needle), "install_cmd 缺要素: {needle}\n{cmd}");
        }
    }

    /// dir_forbidden 表（契约 §1.3 黑名单）。
    #[test]
    fn dir_forbidden_table() {
        for bad in [
            "/opt/d sh", "/opt/d$sh", "/opt/d`sh", "/opt/d;sh", "/opt/d&sh", "/opt/d|sh",
            "/opt/d<sh", "/opt/d>sh", "/opt/d\"sh", "/opt/d'sh", "/opt/d(sh", "/opt/d)sh",
            "/opt/d\\sh", "/opt/d\rsh", "/opt/d\nsh", "/opt/d\tsh",
        ] {
            assert!(dir_forbidden(bad), "应拒绝: {bad:?}");
        }
        for good in ["/opt/dsh", "~/.dsh-desktop", "/home/u/.dsh-desktop", "/opt/中文目录"] {
            assert!(!dir_forbidden(good), "应放行: {good:?}");
        }
    }

    /// version_valid：合法版本过；命令注入形态拒。
    #[test]
    fn version_valid_table() {
        assert!(version_valid("0.1.0-rc.8"));
        assert!(version_valid("0.1.1-rc.1"));
        assert!(version_valid("latest"));
        assert!(!version_valid(""));
        assert!(!version_valid("1.0.0; rm -rf /"));
        assert!(!version_valid("1.0.0&&echo pwn"));
        assert!(!version_valid("1.0 0"));
    }

    /// unc_dir 构造与 parse_unc 反解互逆。
    #[test]
    fn unc_dir_roundtrip() {
        let unc = unc_dir("wsl.localhost", "Ubuntu", "/home/u/.dsh-desktop");
        assert_eq!(unc, "\\\\wsl.localhost\\Ubuntu\\home\\u\\.dsh-desktop");
        let (host, distro, linux) = parse_unc(&unc).unwrap();
        assert_eq!((host.as_str(), distro.as_str(), linux.as_str()), ("wsl.localhost", "Ubuntu", "/home/u/.dsh-desktop"));
        // 大小写不敏感主机 + 正斜杠容忍。
        assert_eq!(parse_unc("//WSL$/Debian/opt/d").unwrap().0, "wsl$");
        // 非法形态 → None。
        assert!(parse_unc("\\\\server\\share\\path").is_none());
        assert!(parse_unc("\\\\wsl.localhost\\onlydistro").is_none());
        assert!(parse_unc("/plain/path").is_none());
    }

    #[test]
    fn unc_host_whitelist() {
        assert!(is_unc_host("wsl.localhost"));
        assert!(is_unc_host("wsl$"));
        assert!(!is_unc_host("evil"));
        assert!(!is_unc_host(""));
    }
}
