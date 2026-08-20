//! 内核 supervisor：boot 链 → spawn → 就绪换页 → 探活 → 崩溃环 → 原地重启。
//!
//! 数据流契约（contracts/data-flow.md §3）：
//! ```text
//! sidecar boot（repair→sync→patches→preflight）
//!   → choose_stable_port（优先上次端口）
//!   → spawn vendor-node（环境白名单 + DSH_DESKTOP_SUPERVISED=1）
//!   → ReadyLineParser → kernel-ready → 主窗换页
//!   → 探活（TCP + 进程 wait）→ 崩溃环 → 恢复页
//! ```
//! 杀树：taskkill /T /F（Electron 版实证：控制台进程优雅 kill 无效）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kernel_process::{choose_stable_port, CrashLoopDetector, ReadyLineParser, SpawnSpec};
use kernel_process::crash_loop::Verdict;
use shell_core::RunState;

/// supervisor 对外事件（发给装配层，转发给窗口/托盘/日志）。
#[derive(Debug, Clone)]
pub enum SupervisorEvent {
    /// boot 链某步完成。
    BootStep { name: String, ok: bool, ms: u64, error: Option<String> },
    /// 内核就绪，主窗应换页到该 URL。
    KernelReady { url: String, port: u16 },
    /// 内核退出（异常）。
    KernelExit { code: Option<i32>, crashed: bool },
    /// 崩溃环触发 → 切恢复页。
    CrashLoop { crashes: usize },
    /// 探活失败计数变化（诊断用）。
    ProbeFailed { consecutive: usize },
    /// 状态迁移。
    StateChanged(RunState),
}

pub struct Supervisor {
    pub app_dir: PathBuf,
    pub sidecar_cli: PathBuf,
    pub node_exe: PathBuf,
    pub bin_js: PathBuf,
    pub kernel_version: String,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    state: RunState,
    kernel: Option<Child>,
    kernel_url: Option<String>,
    port: Option<u16>,
    last_error: Option<String>,
    crash: CrashLoopDetector,
    crash_count: usize,
    /// 注入内核的 --patch overlay 列表（picker 降级 / safe-boot 禁用）。
    overlays: Vec<std::path::PathBuf>,
    /// restart_service 的代际号：旧世代的异步任务看到代际变了就自杀。
    generation: u64,
    stopping: bool,
}

impl Supervisor {
    pub fn new(repo_root: &std::path::Path) -> Self {
        let app_dir = repo_root.join("dsh-desktop");
        Self {
            sidecar_cli: repo_root.join("dsh-tauri").join("sidecar").join("cli.js"),
            node_exe: app_dir.join("vendor").join("node").join("node.exe"),
            bin_js: app_dir.join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js"),
            kernel_version: read_kernel_version(&app_dir),
            app_dir,
            inner: Arc::new(Mutex::new(Inner {
                state: RunState::Boot,
                kernel: None,
                kernel_url: None,
                port: None,
                last_error: None,
                crash: CrashLoopDetector::new(),
                crash_count: 0,
                overlays: Vec::new(),
                generation: 0,
                stopping: false,
            })),
        }
    }

    pub fn state(&self) -> RunState {
        self.inner.lock().unwrap().state
    }
    pub fn kernel_url(&self) -> Option<String> {
        self.inner.lock().unwrap().kernel_url.clone()
    }
    pub fn crash_count(&self) -> usize {
        self.inner.lock().unwrap().crash_count
    }
    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().unwrap().last_error.clone()
    }

    fn set_state(&self, next: RunState) {
        let mut g = self.inner.lock().unwrap();
        if g.state != next {
            let _ = g.state.can_transition_to(next);
            g.state = next;
        }
    }

    /// 完整启动链（后台线程跑；事件经 tx 推送）。
    pub fn spawn_boot(self: &Arc<Self>, tx: Sender<SupervisorEvent>, preferred_port: Option<u16>) {
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let gen = this.inner.lock().unwrap().generation;
            // ---- [1] sidecar boot ----
            this.set_state(RunState::Repair);
            let t0 = Instant::now();
            match this.run_sidecar_boot(&tx, gen) {
                Ok(()) => {}
                Err(e) => {
                    let mut g = this.inner.lock().unwrap();
                    g.last_error = Some(e.clone());
                    let _ = tx.send(SupervisorEvent::BootStep { name: "sidecar-boot".into(), ok: false, ms: t0.elapsed().as_millis() as u64, error: Some(e) });
                    this.enter_recovery(&tx, "boot 链失败");
                    return;
                }
            }
            if this.inner.lock().unwrap().generation != gen || this.inner.lock().unwrap().stopping {
                return;
            }
            // ---- [1.5] koffi 预检 → 目录选择器降级 overlay（Electron 对齐，升级适配）----
            this.run_koffi_preflight();
            // ---- [2] 端口 ----
            let port = match choose_stable_port(preferred_port) {
                Some(p) => p,
                None => {
                    this.enter_recovery(&tx, "无可用安全端口");
                    return;
                }
            };
            this.inner.lock().unwrap().port = Some(port);
            // ---- [3] spawn 内核 ----
            this.set_state(RunState::Spawn);
            if let Err(e) = Arc::clone(&this).spawn_kernel(port, &tx) {
                this.enter_recovery(&tx, &format!("内核启动失败: {e}"));
                return;
            }
            // ---- [4] 探活循环 ----
            this.probe_loop(port, tx, gen);
        });
    }

    /// sidecar boot（node cli.js boot），逐步从 stderr 解析 [sidecar] 行转发。
    fn run_sidecar_boot(&self, tx: &Sender<SupervisorEvent>, _gen: u64) -> Result<(), String> {
        let out = Command::new(&self.node_exe)
            .arg(&self.sidecar_cli)
            .arg("boot")
            .arg("--app-dir")
            .arg(&self.app_dir)
            .env("DSH_TAURI_VERSION", env!("CARGO_PKG_VERSION"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("sidecar spawn: {e}"))?;
        if !out.status.success() {
            return Err(format!("sidecar boot 退出码 {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr).lines().take(6).collect::<Vec<_>>().join(" | ")));
        }
        // stdout：末行 JSON {ok,totalMs,steps[]}
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout.trim_end().lines().last().unwrap_or("");
        let parsed: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("sidecar 输出解析: {e}"))?;
        for step in parsed.get("steps").and_then(|s| s.as_array()).unwrap_or(&vec![]) {
            let name = step.get("name").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let ok = step.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let ms = step.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let error = step.get("error").and_then(|v| v.as_str()).map(String::from);
            let _ = tx.send(SupervisorEvent::BootStep { name, ok, ms, error });
        }
        if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err("boot 链存在失败步骤".into());
        }
        Ok(())
    }

    /// koffi 预检：失败时启用 picker-browse 降级 overlay（Electron runKoffiPreflight
    /// + enablePickerBrowseOverlay 的合并语义；缓存简化为 settings 布尔——每次
    /// 冒烟 ~100ms 级，签名级缓存随出包验证再评估）。
    fn run_koffi_preflight(&self) {
        let settings = shell_core::SettingsStore::new(shell_core::DshPaths::resolve().settings);
        let cached = settings.get("koffiPreflightOk").ok().flatten().and_then(|v| v.as_bool());
        let ok = match cached {
            Some(true) => true,
            _ => {
                let out = std::process::Command::new(&self.node_exe)
                    .arg(&self.sidecar_cli)
                    .arg("koffi-preflight")
                    .arg("--app-dir")
                    .arg(&self.app_dir)
                    .creation_flags_win()
                    .output();
                let ok = matches!(out, Ok(o) if o.status.success()
                    && String::from_utf8_lossy(&o.stdout).trim_end().ends_with("{\"ok\":true}"));
                if ok {
                    let _ = settings.set("koffiPreflightOk", serde_json::json!(true));
                }
                ok
            }
        };
        if !ok {
            let out = std::process::Command::new(&self.node_exe)
                .arg(&self.sidecar_cli)
                .arg("picker-overlay")
                .arg("--app-dir")
                .arg(&self.app_dir)
                .creation_flags_win()
                .output();
            if let Ok(o) = out {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Some(line) = stdout.trim_end().lines().last() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
                            log_line("koffi 预检未过，启用目录选择器降级 overlay");
                            let mut g = self.inner.lock().unwrap();
                            let path = std::path::PathBuf::from(p);
                            if !g.overlays.contains(&path) {
                                g.overlays.push(path);
                            }
                        }
                    }
                }
            }
        } else {
            log_line("koffi 预检通过");
        }
    }

    /// 刷新 safe-boot overlay（崩溃自动重启前）：解析 dsh-web.log 失败插件 → 禁用。
    fn refresh_safe_overlay(&self) -> bool {
        let out = std::process::Command::new(&self.node_exe)
            .arg(&self.sidecar_cli)
            .arg("safe-overlay")
            .arg("--app-dir")
            .arg(&self.app_dir)
            .creation_flags_win()
            .output();
        let Ok(o) = out else { return false };
        let stdout = String::from_utf8_lossy(&o.stdout);
        let Some(line) = stdout.trim_end().lines().last() else { return false };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
        let ids = v.get("ids").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0);
        if ids == 0 {
            return false;
        }
        if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
            log_line(&format!("安全启动 overlay：禁用 {ids} 个失败插件"));
            let mut g = self.inner.lock().unwrap();
            let path = std::path::PathBuf::from(p);
            if !g.overlays.contains(&path) {
                g.overlays.push(path);
            }
        }
        true
    }

    /// spawn 内核进程 + 就绪行监视线程。
    fn spawn_kernel(self: Arc<Self>, port: u16, tx: &Sender<SupervisorEvent>) -> Result<(), String> {
        let overlays = self.inner.lock().unwrap().overlays.clone();
        let spec = SpawnSpec::new(&self.node_exe, &self.bin_js, &self.kernel_version, port, &overlays);
        let mut cmd = Command::new(&spec.node_exe);
        cmd.args(&spec.node_args).arg(&spec.bin_js).args(&spec.web_args);
        // 环境白名单 + 监管标识（main.js childEnv 语义）。
        for (k, v) in std::env::vars() {
            if spec.env_allow.iter().any(|a| a.eq_ignore_ascii_case(&k)) {
                cmd.env(k, v);
            }
        }
        cmd.env("DSH_DESKTOP_SUPERVISED", "1").env("NO_COLOR", "1");
        cmd.current_dir(&self.app_dir).stdin(Stdio::null())
            .stdout(Stdio::piped()).stderr(Stdio::piped())
            .creation_flags_win();
        let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
        let pid = child.id();
        log_line(&format!("内核 pid={pid} spawn: {}", spec.display_cmd()));

        // Review#2 根治：Job Object 杀树保护（父进程被强杀时 OS 收割内核树）。
        if let Err(e) = kernel_process::job_object::assign_child_to_kill_on_close_job(&child) {
            log_line(&format!("Job Object 赋值失败（杀树保护降级为显式 taskkill）: {e}"));
        }
        let stdout = child.stdout.take().ok_or("stdout piped 失败")?;
        let stderr = child.stderr.take();
        self.inner.lock().unwrap().kernel = Some(child);

        // 就绪行监视（独占读 stdout；读 EOF 时若进程仍在则继续探活兜底）。
        let this = Arc::clone(&self);
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            let mut parser = ReadyLineParser::new();
            let mut url: Option<String> = None;
            for chunk in BufReader::new(stdout).split(b'\n') {
                let chunk = match chunk { Ok(c) => c, Err(_) => break };
                let text = String::from_utf8_lossy(&chunk).into_owned();
                if !text.trim().is_empty() {
                    log_line(&format!("web| {text}"));
                }
                if url.is_none() {
                    if let Some(u) = parser.feed(&format!("{text}\n")) {
                        url = Some(u.clone());
                        let mut g = this.inner.lock().unwrap();
                        g.kernel_url = Some(u.clone());
                        drop(g);
                        this.set_state(RunState::Ready);
                        let _ = tx2.send(SupervisorEvent::KernelReady { url: u, port });
                    }
                }
            }
            // stdout EOF = 进程退出。
            let (code, exited) = {
                let mut g = this.inner.lock().unwrap();
                match g.kernel.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(st)) => (st.code(), true),
                        Ok(None) => (None, true), // stdout 关了但进程在：罕见，按退出处理
                        Err(_) => (None, true),
                    },
                    None => (None, false),
                }
            };
            if exited {
                this.on_kernel_exit(code, &tx2);
            }
        });
        // stderr 收尾线程（防管道满阻塞内核）。
        if let Some(err) = stderr {
            std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 4096];
                let mut e = err;
                while let Ok(n) = e.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    log_line(&format!("web-err| {}", String::from_utf8_lossy(&buf[..n]).trim_end()));
                }
            });
        }
        Ok(())
    }

    /// 内核退出处理：崩溃环判定。
    fn on_kernel_exit(self: &Arc<Self>, code: Option<i32>, tx: &Sender<SupervisorEvent>) {
        let now = now_ms();
        let (verdict, crashes) = {
            let mut g = self.inner.lock().unwrap();
            if g.stopping {
                return;
            }
            g.kernel = None;
            g.crash_count += 1;
            let v = g.crash.record_crash(now);
            (v, g.crash_count)
        };
        log_line(&format!("内核退出 code={code:?} 第 {crashes} 次"));
        let _ = tx.send(SupervisorEvent::KernelExit { code, crashed: true });
        match verdict {
            Verdict::Tripped => self.enter_recovery_tx(tx, "崩溃环触发"),
            _ => {
                // 未成环：自动重启一次（Electron watchServerProc 语义：异常退出自动拉起）。
                let port = self.inner.lock().unwrap().port;
                let gen = self.inner.lock().unwrap().generation;
                let this = Arc::clone(self);
                let tx2 = tx.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let g = this.inner.lock().unwrap();
                    if g.stopping || g.generation != gen || g.kernel.is_some() {
                        return;
                    }
                    drop(g);
                    this.refresh_safe_overlay();
                    if let Some(p) = port {
                        if Arc::clone(&this).spawn_kernel(p, &tx2).is_err() {
                            this.enter_recovery_tx(&tx2, "自动重启失败");
                        }
                    }
                });
            }
        }
    }

    /// 探活循环：TCP connect + 就绪超时。
    fn probe_loop(self: &Arc<Self>, port: u16, tx: Sender<SupervisorEvent>, gen: u64) {
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(180);
            let mut ready_seen = false;
            let mut consecutive = 0usize;
            loop {
                std::thread::sleep(Duration::from_secs(3));
                {
                    let g = this.inner.lock().unwrap();
                    if g.stopping || g.generation != gen {
                        return;
                    }
                    if g.state == RunState::Recovery {
                        return;
                    }
                }
                let ok = std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(2)).is_ok();
                if ok {
                    ready_seen = true;
                    consecutive = 0;
                    continue;
                }
                if !ready_seen {
                    if Instant::now() > deadline {
                        this.kill_kernel();
                        this.enter_recovery_tx(&tx, "就绪超时（180s 无监听）");
                        return;
                    }
                    continue;
                }
                consecutive += 1;
                let _ = tx.send(SupervisorEvent::ProbeFailed { consecutive });
                if consecutive >= 3 {
                    // 端口连续失联但进程可能还活着：杀掉按退出处理。
                    this.kill_kernel();
                    this.on_kernel_exit(None, &tx);
                    return;
                }
            }
        });
    }

    /// 原地重启（restart_service）：杀树 → 重跑 boot 链 → 换页。
    pub fn restart(self: &Arc<Self>, tx: Sender<SupervisorEvent>, preferred_port: Option<u16>) {
        {
            let mut g = self.inner.lock().unwrap();
            g.generation += 1;
            g.stopping = false;
            g.kernel_url = None;
            g.crash.record_graceful_restart();
        }
        self.kill_kernel();
        self.spawn_boot(tx, preferred_port);
    }

    /// 进入恢复页。
    fn enter_recovery(&self, tx: &Sender<SupervisorEvent>, reason: &str) {
        self.enter_recovery_tx(tx, reason);
    }
    fn enter_recovery_tx(&self, tx: &Sender<SupervisorEvent>, reason: &str) {
        self.kill_kernel();
        self.set_state(RunState::CrashLoop);
        {
            let mut g = self.inner.lock().unwrap();
            g.last_error = Some(reason.to_string());
        }
        let crashes = self.inner.lock().unwrap().crash_count;
        let _ = tx.send(SupervisorEvent::CrashLoop { crashes });
    }

    /// 恢复页「重启」：手动复位崩溃环。
    pub fn recovery_restart(self: &Arc<Self>, tx: Sender<SupervisorEvent>) {
        {
            let mut g = self.inner.lock().unwrap();
            g.crash.record_recovery();
            g.crash_count = 0;
            g.last_error = None;
        }
        self.set_state(RunState::Recovery);
        self.restart(tx, None);
    }

    pub fn kill_kernel(&self) {
        let mut g = self.inner.lock().unwrap();
        if let Some(mut c) = g.kernel.take() {
            let pid = c.id();
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags_win().output();
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// 应用退出路径：同步终结（不依赖事件循环）。
    pub fn shutdown(&self) {
        self.inner.lock().unwrap().stopping = true;
        self.kill_kernel();
    }
}

fn read_kernel_version(app_dir: &std::path::Path) -> String {
    let pkg = app_dir.join("node_modules").join("@deepseek-ai").join("dsh").join("package.json");
    let Ok(raw) = std::fs::read_to_string(pkg) else { return "unknown".into() };
    if let Some(pos) = raw.find("\"version\"") {
        if let Some(colon) = raw[pos..].find(':') {
            let rest = &raw[pos + colon..];
            if let Some(q1) = rest.find('"') {
                if let Some(len) = rest[q1 + 1..].find('"') {
                    return rest[q1 + 1..q1 + 1 + len].to_string();
                }
            }
        }
    }
    "unknown".into()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn log_line(msg: &str) {
    println!("[supervisor] {msg}");
}

#[cfg(windows)]
trait WinFlags {
    fn creation_flags_win(&mut self) -> &mut Self;
}
#[cfg(windows)]
impl WinFlags for Command {
    fn creation_flags_win(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}
#[cfg(not(windows))]
trait WinFlags {
    fn creation_flags_win(&mut self) -> &mut Self;
}
#[cfg(not(windows))]
impl WinFlags for Command {
    fn creation_flags_win(&mut self) -> &mut Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// 仓库根定位（与装配层 find_repo_root 同规则）。
    fn repo_root() -> Option<std::path::PathBuf> {
        let mut dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for _ in 0..6 {
            if dir.join("dsh-desktop").join("vendor").join("node").exists() {
                return Some(dir);
            }
            if !dir.pop() {
                break;
            }
        }
        None
    }

    /// 干净临时 home + userData（测试沙箱）。
    fn sandbox(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-tauri-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn kernel_version_from_package_json() {
        let dir = sandbox("ver");
        let pkg_dir = dir.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("package.json"), r#"{"name":"x","version":"0.1.0-rc.8"}"#).unwrap();
        assert_eq!(read_kernel_version(&dir), "0.1.0-rc.8");
        // 缺文件 / 坏 JSON → unknown（不 panic）。
        assert_eq!(read_kernel_version(&sandbox("ver2")), "unknown");
        let bad = sandbox("ver3");
        std::fs::write(bad.join("package.json"), "not json at all").unwrap();
        assert_eq!(read_kernel_version(&bad), "unknown");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&bad);
    }

    /// 功能集成：真机 boot 链（sidecar 四步）在沙箱 home 上执行。
    /// 覆盖：Supervisor::run_sidecar_boot（步骤解析 + ok 判定 + 事件转发）。
    #[test]
    fn sidecar_boot_sandbox_integration() {
        let Some(root) = repo_root() else { eprintln!("[skip] 仓库检出不含 dsh-desktop（CI 无依赖环境）"); return; };
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox("boot");
        std::env::set_var("DSH_HOME", &home);
        std::env::set_var("DSH_TAURI_USERDATA", home.join("ud"));
        let sv = Supervisor::new(&root);
        let (tx, rx) = std::sync::mpsc::channel();
        let result = sv.run_sidecar_boot(&tx, 0);
        std::env::remove_var("DSH_HOME");
        std::env::remove_var("DSH_TAURI_USERDATA");
        assert!(result.is_ok(), "sidecar boot 应成功: {result:?}");
        // 步骤事件按固定顺序全部转发（data-flow.md §3）。
        let names: Vec<String> = rx.iter().map(|e| match e { SupervisorEvent::BootStep { name, .. } => name, _ => String::new() }).take(4).collect();
        assert_eq!(names, vec!["repair", "sync", "patches", "preflight"], "boot 步骤顺序契约");
        // 沙箱 home 上 profile 结构确已建立（同步器落盘）。
        assert!(home.join("profiles").join("web").join("cordis.patch.yml").exists(), "profile patch 应已建立");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 功能集成（真机全链）：boot → 内核 spawn → 就绪行 → TCP 可达 → 关停。
    /// 覆盖：spawn_boot / spawn_kernel / ReadyLineParser 接线 / kill_tree / Job Object。
    #[test]
    fn full_boot_to_kernel_ready_integration() {
        let Some(root) = repo_root() else { eprintln!("[skip] 仓库检出不含 dsh-desktop"); return; };
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox("full");
        std::env::set_var("DSH_HOME", &home);
        std::env::set_var("DSH_TAURI_USERDATA", home.join("ud"));
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        assert!(sv.kernel_version.starts_with("0.1.0-rc."), "内核版本应可读: {}", sv.kernel_version);
        let (tx, rx) = std::sync::mpsc::channel();
        sv.spawn_boot(tx, None);
        // boot（~4s）+ 内核就绪（~6s），150s 兜底；先到的 BootStep 逐条核对。
        let deadline = Instant::now() + Duration::from_secs(150);
        let mut boot_steps: Vec<String> = Vec::new();
        let url = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left.max(Duration::from_millis(1))) {
                Ok(SupervisorEvent::BootStep { name, ok, .. }) => {
                    assert!(ok, "boot 步骤 {name} 不应失败");
                    boot_steps.push(name);
                }
                Ok(SupervisorEvent::KernelReady { url, port }) => {
                    let ok = std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(3)).is_ok();
                    assert!(ok, "就绪端口应可连: {port}");
                    break url;
                }
                Ok(other) => panic!("非预期事件: {other:?}"),
                Err(_) => panic!("150s 内未就绪（boot_steps={boot_steps:?}）"),
            }
        };
        assert_eq!(boot_steps, vec!["repair", "sync", "patches", "preflight"]);
        assert!(url.starts_with("http://127.0.0.1:"), "就绪 URL 形态: {url}");
        assert_eq!(sv.state(), RunState::Ready);
        assert!(sv.kernel_url().is_some());
        // 关停（杀树；Job Object 兜强杀场景由专测覆盖）。
        sv.shutdown();
        std::env::remove_var("DSH_HOME");
        std::env::remove_var("DSH_TAURI_USERDATA");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn generation_increments_on_restart_and_state_transitions() {
        let Some(root) = repo_root() else { eprintln!("[skip]"); return; };
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        let g0 = sv.inner.lock().unwrap().generation;
        sv.set_state_for_test(RunState::Ready);
        assert_eq!(sv.state(), RunState::Ready);
        let (tx, _rx) = std::sync::mpsc::channel();
        sv.restart(tx, None);
        assert_eq!(sv.inner.lock().unwrap().generation, g0 + 1, "restart 应递增代际号");
        sv.shutdown();
        assert!(sv.inner.lock().unwrap().stopping);
        let _ = Ordering::Relaxed;
    }
}

#[cfg(test)]
impl Supervisor {
    /// 测试辅助：直接设置状态（绕过迁移表）。
    fn set_state_for_test(&self, s: RunState) {
        self.inner.lock().unwrap().state = s;
    }
}
