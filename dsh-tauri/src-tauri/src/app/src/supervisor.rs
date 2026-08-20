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
/// 稳定落定窗口（Electron SERVICE_STABLE_MS 同语义：就绪后稳定存活此时长，
/// 启动快照才成为「最后良好」回滚锚点）。
const SERVICE_STABLE_SECS: u64 = 45;

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
    /// 守护瀑布的就绪等待通道（spawn_boot 同步段持有 rx；stdout 线程/退出路径发 tx）。
    ready_tx: Option<std::sync::mpsc::Sender<Result<String, String>>>,
    /// 待落定良好快照 id（就绪稳定 SERVICE_STABLE_SECS 后 markGood）。
    pending_good: Option<String>,
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
                ready_tx: None,
                pending_good: None,
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
    ///
    /// **守护瀑布**（对齐 Electron plugin-guard guardedBoot——「坏插件也永远能打开 dsh」）：
    /// ```text
    /// guard-snapshot → 首次拉起(120s) ─成功→ 换页 + 稳定落定
    ///        └失败→ 体检修复(repair) + safe-overlay 禁用坏插件 → 二次拉起(90s)
    ///                └失败→ 回滚最后良好快照(restore) → 三次拉起(90s)
    ///                        └失败→ 事故报告 + 恢复页（restart_service/恢复页重启全链重走瀑布）
    /// ```
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
            // ---- [1.6] 启动前快照（plugin-guard；GUARD_FILES 四文件）----
            let boot_snap = this.guard_cli_json(&["guard-snapshot", "boot"])
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from));
            if let Some(id) = &boot_snap {
                log_line(&format!("守护瀑布：启动快照 {id}"));
            }
            // ---- [2] 端口 ----
            let port = match choose_stable_port(preferred_port) {
                Some(p) => p,
                None => {
                    this.enter_recovery(&tx, "无可用安全端口");
                    return;
                }
            };
            this.inner.lock().unwrap().port = Some(port);
            this.set_state(RunState::Spawn);

            // ---- [3] 首次拉起（有界等待 120s，对齐 Electron waitUntilUp）----
            match Arc::clone(&this).spawn_and_wait_ready(port, &tx, Duration::from_secs(120)) {
                Ok(url) => return this.on_boot_success(&tx, url, port, gen, boot_snap),
                Err(first) => {
                    log_line(&format!("守护瀑布：首次拉起失败（{first}），进入体检修复"));
                }
            }
            if this.cancelled(gen) { return; }

            // ---- [4] 二层：重跑 boot 链（sync 重新同步伴随插件，修复 node_modules 损坏
            // ——自愈主力；guard 快照只含 4 个配置文件，坏文件靠 sync 覆盖）+ 体检修复
            // + safe overlay 禁用坏插件 → 二次拉起 ----
            if let Err(e) = this.run_sidecar_boot(&tx, gen) {
                log_line(&format!("守护瀑布：二层重跑 boot 链失败：{e}"));
            }
            let repaired = this.guard_cli_json(&["guard-repair"]);
            let applied: Vec<String> = repaired
                .and_then(|v| v.get("applied").and_then(|a| a.as_array()).map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
                .unwrap_or_default();
            let safe_applied = this.refresh_safe_overlay();
            log_line(&format!("守护瀑布：体检修复 applied={applied:?} safeOverlay禁用={safe_applied}"));
            if !safe_applied && applied.is_empty() {
                log_line("守护瀑布：无可修复项也无失败插件名单，直接进入回滚层");
            }
            let port2 = this.reuse_or_new_port(port);
            match Arc::clone(&this).spawn_and_wait_ready(port2, &tx, Duration::from_secs(90)) {
                Ok(url) => {
                    this.guard_incident("boot-recovered", &format!("首次启动失败，体检修复后恢复。修复项：{applied:?}"));
                    return this.on_boot_success(&tx, url, port2, gen, boot_snap);
                }
                Err(second) => log_line(&format!("守护瀑布：修复后仍失败（{second}），进入回滚")),
            }
            if this.cancelled(gen) { return; }

            // ---- [5] 三层：回滚最后良好快照 → 三次拉起 ----
            let lastgood = this.guard_cli_json(&["guard-lastgood"])
                .and_then(|v| if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
                    v.get("id").and_then(|i| i.as_str()).map(|id| (id.to_string(), v.get("reason").and_then(|r| r.as_str()).unwrap_or("").to_string()))
                } else { None });
            let rollback_target = lastgood.filter(|(id, _)| boot_snap.as_deref() != Some(id.as_str()));
            match rollback_target {
                Some((id, reason)) => {
                    log_line(&format!("守护瀑布：回滚到最后良好快照 {id}（{reason}）"));
                    let _ = this.guard_cli_json(&["guard-restore", &id]);
                    let _ = this.guard_cli_json(&["guard-repair"]); // 回滚后再清一次遮蔽
                    let port3 = this.reuse_or_new_port(port);
                    match Arc::clone(&this).spawn_and_wait_ready(port3, &tx, Duration::from_secs(90)) {
                        Ok(url) => {
                            this.guard_incident("rollback-recovered", &format!("回滚到快照 {id} 后恢复启动"));
                            return this.on_boot_success(&tx, url, port3, gen, None);
                        }
                        Err(final_err) => {
                            this.guard_incident("boot-failed", &format!("回滚到 {id} 后仍无法启动：{final_err}"));
                            this.enter_recovery(&tx, &format!("回滚后仍失败：{final_err}"));
                        }
                    }
                }
                None => {
                    this.guard_incident("boot-failed", &format!("启动失败且无可回滚快照（首次运行或快照耗尽）"));
                    this.enter_recovery(&tx, "启动失败且无可回滚快照（可在恢复页重试）");
                }
            }
        });
    }

    /// 就绪成功路径：换页事件 + 待落定快照 + 稳定落定线程（45s 后 markGood，
    /// Electron armStabilityWatch 语义：稳定存活即成为「最后良好」回滚锚点）。
    fn on_boot_success(self: &Arc<Self>, tx: &Sender<SupervisorEvent>, url: String, port: u16, gen: u64, snap: Option<String>) {
        {
            let mut g = self.inner.lock().unwrap();
            g.pending_good = snap;
        }
        self.set_state(RunState::Ready);
        let _ = tx.send(SupervisorEvent::KernelReady { url, port });
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(SERVICE_STABLE_SECS));
            let g = this.inner.lock().unwrap();
            if g.generation != gen || g.stopping { return; }
            if let Some(id) = g.pending_good.clone() {
                drop(g);
                let _ = this.guard_cli_json(&["guard-mark-good", &id]);
                let mut g2 = this.inner.lock().unwrap();
                g2.pending_good = None;
                g2.crash_count = 0; // 稳定落地 → 崩溃计数复位（Electron 同款）
                this.inner_crash_reset();
                log_line(&format!("守护瀑布：服务稳定存活，快照 {id} 落定为最后良好"));
            }
        });
        self.probe_loop(port, tx.clone(), gen);
    }

    fn cancelled(&self, gen: u64) -> bool {
        let g = self.inner.lock().unwrap();
        g.generation != gen || g.stopping
    }

    /// 端口复用（同端口重试保 origin 稳定）；占用则换新端口。
    fn reuse_or_new_port(&self, preferred: u16) -> u16 {
        choose_stable_port(Some(preferred)).unwrap_or(preferred)
    }

    /// 拉起内核并同步等待就绪（瀑布核心原语）。
    fn spawn_and_wait_ready(self: Arc<Self>, port: u16, tx: &Sender<SupervisorEvent>, timeout: Duration) -> Result<String, String> {
        let (rtx, rrx) = std::sync::mpsc::channel::<Result<String, String>>();
        self.inner.lock().unwrap().ready_tx = Some(rtx);
        if let Err(e) = self.clone().spawn_kernel(port, tx) {
            self.inner.lock().unwrap().ready_tx = None;
            return Err(e);
        }
        let deadline = Instant::now() + timeout;
        match rrx.recv_timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1))) {
            Ok(Ok(url)) => Ok(url),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // 超时：杀掉半死进程，按失败处理。
                self.kill_kernel();
                self.inner.lock().unwrap().ready_tx = None;
                Err(format!("{timeout:?} 内未就绪"))
            }
        }
    }

    /// guard 子命令薄跑（stdout 末行 JSON 解析；失败返回 None——瀑布降级而非崩）。
    fn guard_cli_json(&self, args: &[&str]) -> Option<serde_json::Value> {
        let out = Command::new(&self.node_exe)
            .arg(&self.sidecar_cli)
            .args(args)
            .arg("--app-dir")
            .arg(&self.app_dir)
            .creation_flags_win()
            .output()
            .ok()?;
        if !out.status.success() { return None; }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout.trim_end().lines().last()?;
        serde_json::from_str(line).ok()
    }

    /// 事故报告落盘（guard/incidents/）。
    fn guard_incident(&self, kind: &str, detail: &str) {
        let _ = self.guard_cli_json(&["guard-incident", kind, detail]);
    }

    fn inner_crash_reset(&self) { /* 兼容占位：crash_count 复位已直写 */ }
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
                        let rtx = { let mut g = this.inner.lock().unwrap(); g.kernel_url = Some(u.clone()); g.ready_tx.take() };
                        if let Some(rtx) = rtx { let _ = rtx.send(Ok(u.clone())); }
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
            // 瀑布等待者唤醒：启动期退出 = 本次拉起失败。
            if let Some(rtx) = g.ready_tx.take() {
                let _ = rtx.send(Err(format!("内核启动期退出 code={code:?}")));
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
            // 瀑布已同步等到就绪，这里只管「就绪后失联」（连续 3 次 TCP 失联 → 按退出处理）。
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
                    consecutive = 0;
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

#[cfg(test)]
mod stability_tests {
    use super::*;

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

    fn sandbox(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-tauri-wf-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 伴随插件入口文件被写坏（用户磁盘坏块/更新中断的真实形态）：
    /// boot 链 sync 重新同步应覆盖修复 → 瀑布首层即应就绪。
    #[test]
    fn broken_companion_file_is_healed_by_sync() {
        let Some(root) = repo_root() else { eprintln!("[skip] 无依赖环境"); return; };
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox("broken");
        std::env::set_var("DSH_HOME", &home);
        std::env::set_var("DSH_TAURI_USERDATA", home.join("ud"));
        // 1) 建档。
        let sv0: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        let (tx0, rx0) = std::sync::mpsc::channel();
        sv0.run_sidecar_boot(&tx0, 0).expect("基线 boot");
        drop(rx0);
        // 2) 破坏一个伴随插件入口（写语法垃圾）。
        let victim = home.join("profiles").join("web").join("node_modules").join("dsh-auto-compact");
        assert!(victim.exists(), "伴随插件应已同步：{}", victim.display());
        let entry = victim.join("lib").join("index.js");
        if !entry.exists() {
            for cand in ["index.js", "main.js"] {
                if victim.join(cand).exists() {
                    drop(entry);
                    let _ = std::fs::write(victim.join(cand), "this is ( not valid javascript !!!");
                    break;
                }
            }
        } else {
            std::fs::write(&entry, "this is ( not valid javascript !!!").unwrap();
        }
        // 3) 完整守护瀑布：期望依然 KernelReady（sync 修复坏文件）。
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        let (tx, rx) = std::sync::mpsc::channel();
        sv.spawn_boot(tx, None);
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            match rx.recv_timeout(left) {
                Ok(SupervisorEvent::BootStep { ok, name, .. }) => assert!(ok, "boot 步骤 {name} 失败"),
                Ok(SupervisorEvent::KernelReady { url, .. }) => {
                    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
                    sv.shutdown();
                    std::env::remove_var("DSH_HOME");
                    std::env::remove_var("DSH_TAURI_USERDATA");
                    let _ = std::fs::remove_dir_all(&home);
                    return; // PASS：坏插件被自愈，dsh 照常打开
                }
                Ok(other) => panic!("非预期事件: {other:?}"),
                Err(_) => panic!("180s 内未就绪（坏插件未被自愈）"),
            }
        }
    }

    /// 配置类破坏（patch 非法内容 + 可回滚快照在场）：瀑布应回滚后救回。
    #[test]
    fn corrupted_patch_is_rolled_back_to_lastgood() {
        let Some(root) = repo_root() else { eprintln!("[skip]"); return; };
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox("rollback");
        std::env::set_var("DSH_HOME", &home);
        std::env::set_var("DSH_TAURI_USERDATA", home.join("ud"));
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        // 1) 建档 + 落定 lastgood 快照。
        let (tx0, rx0) = std::sync::mpsc::channel();
        sv.run_sidecar_boot(&tx0, 0).expect("基线 boot");
        drop(rx0);
        let snap = sv.guard_cli_json(&["guard-snapshot", "baseline"])
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
            .expect("快照");
        let _ = sv.guard_cli_json(&["guard-mark-good", &snap]);
        // 2) 破坏 package.json（bundles 数组换成非法形态——repair 修不了、restore 能回滚）。
        let pkg = home.join("profiles").join("web").join("package.json");
        std::fs::write(&pkg, "{ this is not json !!!").unwrap();
        // 3) 完整瀑布：boot 链 repair 先修 package.json（integration heal 有 manifest 修复），
        //    即便修复失败也有 restore 层兜底——两路最终都应 KernelReady。
        let (tx, rx) = std::sync::mpsc::channel();
        sv.spawn_boot(tx, None);
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            match rx.recv_timeout(left) {
                Ok(SupervisorEvent::BootStep { name, ok, .. }) => {
                    let _ = (name, ok); // boot 步骤在自愈中可能告警，最终以就绪判
                }
                Ok(SupervisorEvent::KernelReady { url, .. }) => {
                    assert!(url.starts_with("http://127.0.0.1:"));
                    sv.shutdown();
                    std::env::remove_var("DSH_HOME");
                    std::env::remove_var("DSH_TAURI_USERDATA");
                    let _ = std::fs::remove_dir_all(&home);
                    return; // PASS：配置破坏被自愈，dsh 照常打开
                }
                Ok(SupervisorEvent::CrashLoop { .. }) => panic!("瀑布未能救回配置破坏"),
                Ok(other) => { let _ = other; }
                Err(_) => panic!("240s 内未就绪（配置破坏未被自愈）"),
            }
        }
    }
}
