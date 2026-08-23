//! 内核 supervisor：boot 链 → spawn → 就绪换页 → 探活 → 崩溃环 → 原地重启。
//!
//! 数据流契约（contracts/data-flow.md §3）：
//! ```text
//! sidecar boot（repair→sync→presets→patches→preflight）
//!   → choose_stable_port（优先上次端口）
//!   → spawn vendor-node（环境白名单 + DSH_DESKTOP_SUPERVISED=1）
//!   → ReadyLineParser → kernel-ready → 主窗换页
//!   → 探活（TCP + 进程 wait）→ 崩溃环 → 恢复页
//! ```
//! 杀树：Windows taskkill /T /F（Electron 版实证：控制台进程优雅 kill 无效）；
//! Unix killpg(-pgid, SIGKILL)——spawn 时设内核为进程组长，整组一次收割
//! （kernel_process::kill_tree）。
//!
//! WSL 托管模式（契约 wsl-backend.md，两模式共用瀑布/崩溃环/看门狗，零变更）：
//! boot 线程首步 configure（失败回落 local——issue #54，不阻塞不恢复页）→
//! ensure_installed（先于插件/补丁链）→ sidecar boot `--home <UNC>` →
//! spawn `wsl.exe -d <distro> -e sh -lc`（--port 0，实际端口从就绪行解析）→
//! 收割三层（WSL 内 pid 文件 kill + 杀 wsl.exe 包装 + 300ms 缓冲；
//! wsl 的发行版级 terminate/shutdown 全局终结命令**绝不调用**——见契约
//! §4.6 红线）。local 模式全链行为零变更（不变量 §7.1）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kernel_process::{choose_stable_port, kill_tree, CrashLoopDetector, ReadyLineParser, SpawnSpec};
use kernel_process::crash_loop::Verdict;
/// 稳定落定窗口（Electron SERVICE_STABLE_MS 同语义：就绪后稳定存活此时长，
/// 启动快照才成为「最后良好」回滚锚点）。
const SERVICE_STABLE_SECS: u64 = 45;
/// boot 看门狗上限（D2「永挂形态」根治）：boot 全链有界 5 分钟。
const BOOT_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(300);
/// WSL 分支看门狗上限（契约 §4.2）：npm 首装 30 分钟超时 + boot 链余量。
const BOOT_WATCHDOG_TIMEOUT_WSL: Duration = Duration::from_secs(35 * 60);

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
    /// 内核假死可疑：TCP 可连但 HTTP 连续无响应（#122/#129——crash-shield
    /// 吞异常保进程活着，纯 TCP 探测恒过，事件循环卡死不可见）。
    ZombieSuspect { consecutive: usize },
    /// 状态迁移。
    StateChanged(RunState),
}

pub struct Supervisor {
    pub app_dir: PathBuf,
    pub sidecar_cli: PathBuf,
    pub node_exe: PathBuf,
    /// Node 三级解析链结果（v0.5.4：系统 PATH ≥22 → 内置 vendor → None）。
    /// `None` = 两级全缺——boot 瀑布首步发清晰 BootStep 错误转恢复页
    /// （替代旧「sidecar spawn os error 2」不可读形态）；`node_exe` 此时为
    /// vendor 主名占位（终防线，正常流程到不了 spawn）。
    pub node_resolved: Option<kernel_process::node_resolve::ResolvedNode>,
    pub bin_js: PathBuf,
    pub kernel_version: String,
    inner: Arc<Mutex<Inner>>,
    /// WSL 后端运行态（boot 线程 configure 成功后 Some；未配置/回落 local 为
    /// None——所有 WSL 分支以 `wsl_active().is_some()` 守卫，local 零变更）。
    wsl: Arc<Mutex<Option<Arc<wsl_backend::WslBackend>>>>,
    /// 启动期 WSL 探测失败回落 local 的原因（#54；本次运行期有效，设置页展示）。
    fallback_reason: Arc<Mutex<String>>,
    /// 后端模式意图（settings 三键 + env 覆盖，`new` 时定死：watchdog 时长与
    /// boot 线程 configure 的输入；探测本身延迟到 boot 线程——setup 零 wsl.exe）。
    wsl_cfg: Option<wsl_backend::BackendCfg>,
    /// wsl.exe 原语（生产 RealWslInvoker；测试注入桩——design D7）。
    wsl_invoker: Arc<dyn wsl_backend::WslInvoker>,
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
    /// 探活环令牌：每次就绪布防递增，旧探活环看到令牌不符自行退出
    /// （同代际下崩溃自动重启换内核后，旧环不得继续探活/误杀新内核）。
    probe_gen: u64,
    stopping: bool,
}


/// vendor node 路径解析已迁移 `kernel_process::node_resolve`（v0.5.4 三级
/// 解析链：系统 PATH ≥22 → 内置 vendor → None；vendor 平台主名/备名选择、
/// 版本解析的单测见该 crate）。此处仅保留语义注记：
/// - vendor 可执行名 Windows node.exe、其余平台 node（vendor 目录按平台
///   分发双二进制——mac 检出内 node 为 Mach-O）；
/// - vendor 调用在用户机上可能被 AV/SmartScreen 拦到半死——`--version`
///   探测自带 5s 超时（node_resolve::VERSION_PROBE_TIMEOUT），永挂防线
///   另有 boot 看门狗兜底。

impl Supervisor {
    pub fn new(repo_root: &std::path::Path) -> Self {
        Self::new_with_wsl_invoker(
            repo_root,
            Arc::new(wsl_backend::RealWslInvoker) as Arc<dyn wsl_backend::WslInvoker>,
        )
    }

    /// 测试构造（wsl.exe 原语注桩——design D7；生产恒 `new` + RealWslInvoker）。
    fn new_with_wsl_invoker(repo_root: &std::path::Path, invoker: Arc<dyn wsl_backend::WslInvoker>) -> Self {
        Self::new_with_probes(
            repo_root,
            invoker,
            Arc::new(kernel_process::RealNodeProbe) as Arc<dyn kernel_process::NodeProbe>,
        )
    }

    /// 全注桩构造（wsl.exe + node 探测双缝——D7 同手法；Node 解析优先级与
    /// 缺失路径的确定性测试用，生产恒 `new`）。
    fn new_with_probes(
        repo_root: &std::path::Path,
        invoker: Arc<dyn wsl_backend::WslInvoker>,
        node_probe: Arc<dyn kernel_process::NodeProbe>,
    ) -> Self {
        let app_dir = repo_root.join("dsh-desktop");
        // sidecar cli 双布局解析：开发检出在 <repo>/dsh-tauri/sidecar/，
        // 安装产物在 <安装根>/resources/sidecar/（repo_root 即 resources）。
        // 曾实测：只认开发布局时安装包首启 node 秒退「Cannot find module」，
        // 瀑布终态恢复页且全程零 stderr——最难排查的一类静默故障。
        let sidecar_cli = {
            let dev = repo_root.join("dsh-tauri").join("sidecar").join("cli.js");
            if dev.exists() {
                dev
            } else {
                repo_root.join("sidecar").join("cli.js")
            }
        };
        // 后端模式意图（env > settings 三键；与 sidecar wsl-mode.js detectWslBackend
        // 同口径，含 DSH_WSL_MODE 模拟缝）。只解析不探测——wsl.exe 冷启动可达
        // 数十秒，setup 线程零调用（design 5.3），探测延迟到 boot 线程。
        let wsl_cfg = {
            let store = shell_core::SettingsStore::new(shell_core::DshPaths::resolve().settings);
            let map = store.load().unwrap_or_default();
            let cfg = wsl_backend::detect_backend_mode_from_map(&map);
            (cfg.backend == "wsl").then_some(cfg)
        };
        // ---- Node 三级解析链（v0.5.4 便携版修复/瘦身基础，构造期一次性）：
        //      系统 PATH 中 ≥22 的 node → 内置 vendor/node → None。便携版在
        //      无内置 node 的机器上经第一级起死回生；系统有 node 的机器不再
        //      依赖 91MB 内置二进制（杀软拦截面同步收窄）。----
        let node_resolved = kernel_process::node_resolve::resolve_node_with(
            node_probe.as_ref(),
            kernel_process::node_resolve::existing_vendor_node(&app_dir),
        );
        let node_exe = node_resolved
            .as_ref()
            .map(|r| r.exe().to_path_buf())
            // 全缺占位：保持「spawn 报错 → 恢复页」旧错误路径存活（boot 首步
            // 的清晰错误正常先一步拦截，此处仅终防线）。
            .unwrap_or_else(|| kernel_process::node_resolve::vendor_node_exe(&app_dir));
        Self {
            sidecar_cli,
            node_exe,
            node_resolved,
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
                probe_gen: 0,
                stopping: false,
            })),
            wsl: Arc::new(Mutex::new(None)),
            fallback_reason: Arc::new(Mutex::new(String::new())),
            wsl_cfg,
            wsl_invoker: invoker,
        }
    }

    pub fn state(&self) -> RunState {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).state
    }
    pub fn kernel_url(&self) -> Option<String> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).kernel_url.clone()
    }
    pub fn crash_count(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).crash_count
    }
    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).last_error.clone()
    }

    // ---- WSL 托管模式访问面（commands 层消费；local 模式零开销）----

    /// WSL 后端是否生效（configure 成功且未回落）。
    pub fn wsl_active(&self) -> Option<Arc<wsl_backend::WslBackend>> {
        self.wsl.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// 实际生效后端（运行态；供 `wsl_config_get` 的 backend 字段）。
    pub fn backend_effective(&self) -> &'static str {
        if self.wsl_active().is_some() { "wsl" } else { "local" }
    }
    /// 启动期 WSL 探测失败回落 local 的原因（空 = 无回落）。
    pub fn fallback_reason(&self) -> String {
        self.fallback_reason.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// WSL 状态快照（契约 §2.1 status 对象；未配置/回落 = configured:false 全空）。
    pub fn wsl_status_json(&self) -> serde_json::Value {
        match self.wsl_active() {
            Some(b) => b.status_json(),
            None => serde_json::json!({
                "configured": false, "distro": "", "installDir": "",
                "nodeVersion": "", "npmVersion": "", "agentVersion": "", "lastError": "",
            }),
        }
    }
    /// Windows 侧数据落点统一出口（契约 §6：local → DshPaths::dsh_home；
    /// wsl → UNC 等价路径）。
    pub fn effective_home(&self) -> PathBuf {
        match self.wsl_active() {
            Some(b) => b.unc_home(),
            None => shell_core::DshPaths::resolve().dsh_home,
        }
    }

    fn set_state(&self, next: RunState) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
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
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            // 看门狗（D2 永挂形态根治）：boot 全链有界，超时进恢复页——防
            // vendor node 被 AV 拦到半死导致 loading 永挂。WSL 分支放宽到 35
            // 分钟（npm 首装 30 分钟上限 + boot 链余量，契约 §4.2）。
            let wd_timeout = if this.wsl_cfg.as_ref().is_some_and(|c| c.backend == "wsl") {
                BOOT_WATCHDOG_TIMEOUT_WSL
            } else {
                BOOT_WATCHDOG_TIMEOUT
            };
            Self::spawn_boot_watchdog(&this, tx.clone(), wd_timeout);
            // panic 隔离：瀑布任何一环意外 panic（兼容性场景的兜底）→ 落恢复页，
            // 客户端继续运行（全局 panic hook 已另行落盘 panics.log）。
            let this2 = Arc::clone(&this);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                Self::boot_waterfall(this, tx, preferred_port)
            }));
            if let Err(p) = r {
                let msg = panic_payload_str(&*p);
                this2.enter_recovery_tx(&tx2, &format!("boot 线程异常（已捕获，客户端继续运行）: {msg}"));
            }
        });
    }

    /// boot 看门狗线程：`timeout` 后仍在「未完成」态 → 转恢复页。
    /// 超时参数化：测试注入短超时 + WSL 分支 35 分钟（生产两值），对外行为
    /// 零变更。代际感知（v0.5.1 频繁重启回归修复）：restart 每次
    /// 都会再挂一个看门狗，旧看门狗若不校验代际，会在新一次 boot 进行中
    /// 超时开火，把正在启动的内核打入恢复页（慢机上表现为反复重启）。
    fn spawn_boot_watchdog(this: &Arc<Self>, tx: Sender<SupervisorEvent>, timeout: Duration) {
        let wd_tx = tx;
        let this_wd = Arc::clone(this);
        let gen = this.inner.lock().unwrap_or_else(|p| p.into_inner()).generation;
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            let g = this_wd.inner.lock().unwrap_or_else(|p| p.into_inner());
            if g.generation != gen {
                return; // 旧世代的看门狗：新 boot 已接手，本犬退休。
            }
            if Self::watchdog_should_fire(g.stopping, g.state) {
                drop(g);
                eprintln!("[supervisor] 看门狗：boot 链超时（{:?}），转恢复页", timeout);
                this_wd.enter_recovery_tx(&wd_tx, &format!("boot 链超时（{timeout:?} 看门狗）"));
            }
        });
    }

    /// 看门狗触发判定（纯函数，可单测）：超时时刻未在退出、且尚未到达
    /// Ready（正常就绪，哪怕迟到）或 Recovery（瀑布已自愈转恢复页）才触发。
    fn watchdog_should_fire(stopping: bool, state: RunState) -> bool {
        !stopping && state != RunState::Ready && state != RunState::Recovery
    }

    /// 守护瀑布主体（boot 线程内执行；panic 由 spawn_boot 捕获兜底）。
    fn boot_waterfall(this: Arc<Self>, tx: Sender<SupervisorEvent>, preferred_port: Option<u16>) {
        {
            let gen = this.inner.lock().unwrap_or_else(|p| p.into_inner()).generation;
            // ---- [-2] Node 三级解析预检（v0.5.4）：系统 PATH ≥22 → 内置
            //      vendor → 全缺。全缺时清晰报错直接恢复页——旧形态是后续
            //      sidecar spawn 报「os error 2」，用户无从知道缺的是 Node。
            //      WSL 模式同样需要 Windows 侧 node 跑 sidecar boot，故本步
            //      先于 WSL configure。----
            match &this.node_resolved {
                Some(r) => log_line(&format!("Node 解析命中：{}", r.label())),
                None => {
                    let msg = "未找到可用的 Node.js：既未检测到系统 Node（版本 ≥ 22），安装目录也缺少内置 node（vendor/node/node.exe）。请安装 Node.js 22 或更高版本（https://nodejs.org），或重新下载完整的安装包/便携版。".to_string();
                    eprintln!("[boot] {msg}");
                    // last_error 写入必须独立作用域：enter_recovery 内部的
                    // kill_kernel/state/set_state 都会再取 inner 锁（同下方
                    // sidecar 失败分支的自死锁教训）。
                    {
                        let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                        g.last_error = Some(msg.clone());
                    }
                    let _ = tx.send(SupervisorEvent::BootStep { name: "node-resolve".into(), ok: false, ms: 0, error: Some(msg) });
                    this.enter_recovery(&tx, "Node 缺失（系统与内置均无）");
                    return;
                }
            }
            // ---- [-1] WSL 后端解析（契约 §4.2 顺序红线：loading 窗已开 →
            //      configure 探测）。失败回落 local 继续启动（issue #54：不
            //      阻塞、不恢复页、配置保留），原因进 fallback_reason。----
            let mut wsl = Self::wsl_configure_or_fallback(&this);
            // ---- [0w] ensure_installed（**必须先于插件/补丁链**：补丁目标含
            //      <UNC>/agent/node_modules，agent 未就位则锚点全空——Electron
            //      main.js 4957 ensureInstalled 先于 syncPlugins 同序）。首装/
            //      版本漂移 → WSL 内 npm staging 安装（进度经 BootStep 事件）；
            //      失败同样回落 local（#54）。----
            if wsl.is_some() {
                if let Err(e) = this.run_wsl_ensure_installed(&tx) {
                    log_line(&format!("WSL agent 安装失败，回落本地模式继续启动（issue #54）: {e}"));
                    this.wsl_fallback(&e);
                    wsl = None;
                }
            }
            // ---- [0.5] farm 实体目录去材料化（Electron repairProfileFallback
            // 等价物，H/V2 实测定论的残余风险）：farm 条目被云同步/复制还原成
            // 实体目录时内核 heal 直接放弃（"exists and is not a symlink"），
            // 原生依赖链断裂 → 预设挂载失败。挪开让 heal 重建 junction。
            // 尽力而为：失败仅日志，绝不阻断 boot 链。
            // WSL 模式跳过（契约 §4.2：junction 是 Windows 本地概念，WSL 内
            // profile fallback 由内核自行 heal；sidecar farm-repair.js 亦自跳）。----
            if wsl.is_none() {
                this.run_farm_repair();
            }
            // ---- [1] sidecar boot（WSL 模式 home=UNC，Windows 侧经 UNC 写穿：
            //      sync/presets/patches/preflight 契约 §4.2）----
            this.set_state(RunState::Repair);
            let t0 = Instant::now();
            match this.run_sidecar_boot(&tx, gen) {
                Ok(()) => {}
                Err(e) => {
                    // last_error 写入必须独立作用域：enter_recovery_tx 内部的
                    // kill_kernel/state/set_state 都会再取 inner 锁，同线程持锁
                    // 重入 = 自死锁（v0.5.2 便携版 node.exe 缺失实测：boot 线程
                    // 冻死在 kill_kernel 的 lock()，CrashLoop 永不发出，加载页
                    // 永挂、恢复页永不出现——正是「便携版一直在加载」的主链）。
                    {
                        let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                        g.last_error = Some(e.clone());
                    }
                    let _ = tx.send(SupervisorEvent::BootStep { name: "sidecar-boot".into(), ok: false, ms: t0.elapsed().as_millis() as u64, error: Some(e) });
                    this.enter_recovery(&tx, "boot 链失败");
                    return;
                }
            }
            if this.inner.lock().unwrap_or_else(|p| p.into_inner()).generation != gen || this.inner.lock().unwrap_or_else(|p| p.into_inner()).stopping {
                return;
            }
            // ---- [1.5] koffi 预检 → 目录选择器降级 overlay（Electron 对齐，升级适配）。
            // WSL 模式跳过（契约 §4.2：win32 预编译探测与 Linux 内核无关，
            // 原生模块由 WSL 内 npm 安装的 linux 变体提供；sidecar 同款跳过）。----
            if wsl.is_none() {
                this.run_koffi_preflight();
            } else {
                log_line("koffi 预检：WSL 托管模式跳过（原生模块为 WSL 内 linux 变体）");
            }
            // ---- [1.6] 启动前快照（plugin-guard；GUARD_FILES 四文件）----
            let boot_snap = this.guard_cli_json(&["guard-snapshot", "boot"])
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from));
            if let Some(id) = &boot_snap {
                log_line(&format!("守护瀑布：启动快照 {id}"));
            }
            // ---- [2] 端口 ----
            // WSL 模式 `--port 0`（WSL 内 OS 分配；Windows 侧 bind 探测对 WSL
            // 内监听无意义——design D3），实际端口从就绪行解析。
            let port = if wsl.is_some() {
                0u16
            } else {
                match choose_stable_port(preferred_port) {
                    Some(p) => p,
                    None => {
                        this.enter_recovery(&tx, "无可用安全端口");
                        return;
                    }
                }
            };
            this.inner.lock().unwrap_or_else(|p| p.into_inner()).port = Some(port);
            this.set_state(RunState::Spawn);

            // ---- [3] 首次拉起（有界等待 120s，对齐 Electron waitUntilUp）----
            match Arc::clone(&this).spawn_and_wait_ready(port, &tx, Duration::from_secs(120)) {
                Ok(url) => return this.on_boot_success(url, port, gen, boot_snap),
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
            let port2 = if wsl.is_some() { 0 } else { this.reuse_or_new_port(port) };
            match Arc::clone(&this).spawn_and_wait_ready(port2, &tx, Duration::from_secs(90)) {
                Ok(url) => {
                    this.guard_incident("boot-recovered", &format!("首次启动失败，体检修复后恢复。修复项：{applied:?}"));
                    return this.on_boot_success(url, port2, gen, boot_snap);
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
                    let port3 = if wsl.is_some() { 0 } else { this.reuse_or_new_port(port) };
                    match Arc::clone(&this).spawn_and_wait_ready(port3, &tx, Duration::from_secs(90)) {
                        Ok(url) => {
                            this.guard_incident("rollback-recovered", &format!("回滚到快照 {id} 后恢复启动"));
                            this.on_boot_success(url, port3, gen, None)
                        }
                        Err(final_err) => {
                            this.guard_incident("boot-failed", &format!("回滚到 {id} 后仍无法启动：{final_err}"));
                            this.enter_recovery(&tx, &format!("回滚后仍失败：{final_err}"));
                        }
                    }
                }
                None => {
                    this.guard_incident("boot-failed", "启动失败且无可回滚快照（首次运行或快照耗尽）");
                    this.enter_recovery(&tx, "启动失败且无可回滚快照（可在恢复页重试）");
                }
            }
        }
    }

    /// 就绪成功路径：待落定快照 + 稳定落定线程（45s 后 markGood，
    /// Electron armStabilityWatch 语义：稳定存活即成为「最后良好」回滚锚点）。
    ///
    /// 换页（KernelReady）与探活布防不在此处：就绪行线程是唯一换页源
    ///（含 HTTP 热探），瀑布/自动重启两条路径统一走它——此前这里再发一次
    /// KernelReady 构成双发（双 navigate / 双心跳监测 / 双诊断探针，M1 审计
    /// 遗留；真机日志可见 t0/probe 输出全双份）。
    fn on_boot_success(self: &Arc<Self>, url: String, port: u16, gen: u64, snap: Option<String>) {
        let _ = (url, port);
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            g.pending_good = snap;
        }
        self.set_state(RunState::Ready);
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(SERVICE_STABLE_SECS));
            let g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
            if g.generation != gen || g.stopping { return; }
            if let Some(id) = g.pending_good.clone() {
                drop(g);
                let _ = this.guard_cli_json(&["guard-mark-good", &id]);
                let mut g2 = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                g2.pending_good = None;
                g2.crash_count = 0; // 稳定落地 → 崩溃计数复位（Electron 同款）
                this.inner_crash_reset();
                log_line(&format!("守护瀑布：服务稳定存活，快照 {id} 落定为最后良好"));
            }
        });
    }

    fn cancelled(&self, gen: u64) -> bool {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.generation != gen || g.stopping
    }

    /// 端口复用（同端口重试保 origin 稳定）；占用则换新端口。
    fn reuse_or_new_port(&self, preferred: u16) -> u16 {
        choose_stable_port(Some(preferred)).unwrap_or(preferred)
    }

    /// 拉起内核并同步等待就绪（瀑布核心原语）。
    fn spawn_and_wait_ready(self: Arc<Self>, port: u16, tx: &Sender<SupervisorEvent>, timeout: Duration) -> Result<String, String> {
        let (rtx, rrx) = std::sync::mpsc::channel::<Result<String, String>>();
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).ready_tx = Some(rtx);
        if let Err(e) = self.clone().spawn_kernel(port, tx) {
            self.inner.lock().unwrap_or_else(|p| p.into_inner()).ready_tx = None;
            return Err(e);
        }
        let deadline = Instant::now() + timeout;
        match rrx.recv_timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1))) {
            Ok(Ok(url)) => Ok(url),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // 超时：杀掉半死进程，按失败处理。
                self.kill_kernel();
                self.inner.lock().unwrap_or_else(|p| p.into_inner()).ready_tx = None;
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
            .args(self.sidecar_home_args())
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

    // ---- WSL 托管模式（契约 wsl-backend.md §4；local 模式零变更）----

    /// boot 线程首步：configure 探测链（wsl -l -q → distro → $HOME →
    /// installDir → node/npm → UNC）。成功设运行态；失败回落 local（#54：
    /// 配置保留、原因进 fallback_reason、绝不恢复页）。
    fn wsl_configure_or_fallback(this: &Arc<Self>) -> Option<Arc<wsl_backend::WslBackend>> {
        let cfg = this.wsl_cfg.clone()?;
        if cfg.backend != "wsl" {
            return None;
        }
        let backend = Arc::new(wsl_backend::WslBackend::new(Arc::clone(&this.wsl_invoker)));
        let opts = wsl_backend::ConfigureOpts::from_env(&cfg.distro, &cfg.install_dir);
        match backend.configure(&opts) {
            Ok(()) => {
                *this.wsl.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&backend));
                let st = backend.status_json();
                log_line(&format!(
                    "WSL 托管后端就绪: distro={} installDir={} UNC={} node={} npm={}{}",
                    backend.distro(),
                    backend.install_dir(),
                    backend.unc_home().display(),
                    st["nodeVersion"].as_str().unwrap_or(""),
                    st["npmVersion"].as_str().unwrap_or(""),
                    if cfg.simulated { "（DSH_WSL_MODE 模拟缝）" } else { "" },
                ));
                Some(backend)
            }
            Err(e) => {
                log_line(&format!("WSL 探测失败，回落本地模式继续启动（issue #54）: {e}"));
                this.wsl_fallback(&e.to_string());
                None
            }
        }
    }

    /// 回落 local：清运行态 + 记原因（#54；本次运行期有效）。
    fn wsl_fallback(&self, reason: &str) {
        *self.wsl.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.fallback_reason.lock().unwrap_or_else(|p| p.into_inner()) = reason.to_string();
    }

    /// ensure_installed（契约 §4.5）：agent 预检（入口存在 + 版本 == payload
    /// 版本——D5 版本锚）→ 首装/漂移重装（WSL 内 npm staging + 原子切换）。
    /// npm 进度行经 BootStep 事件 + 日志透出（首装数分钟必须有用户可见反馈）。
    fn run_wsl_ensure_installed(&self, tx: &Sender<SupervisorEvent>) -> Result<(), String> {
        let Some(backend) = self.wsl_active() else { return Ok(()) };
        let t0 = Instant::now();
        let target = self.kernel_version.clone();
        let tx2 = tx.clone();
        let mut install_started = false;
        let res = backend.ensure_installed(&target, &mut |line| {
            // 首条 npm 行 = 安装实际开始（预检通过前不发事件，loading 页步骤
            // 列表不掺入常态路径）。
            if !std::mem::replace(&mut install_started, true) {
                let _ = tx2.send(SupervisorEvent::BootStep { name: "wsl-install".into(), ok: true, ms: 0, error: None });
            }
            log_line(&format!("wsl-install| {line}"));
        });
        match res {
            Ok(false) => {
                log_line("WSL agent 已就位且版本与 payload 一致（零安装）");
                Ok(())
            }
            Ok(true) => {
                let _ = tx.send(SupervisorEvent::BootStep {
                    name: "wsl-install".into(),
                    ok: true,
                    ms: t0.elapsed().as_millis() as u64,
                    error: None,
                });
                log_line(&format!("WSL agent 安装完成（{}ms）", t0.elapsed().as_millis()));
                Ok(())
            }
            Err(e) => {
                let _ = tx.send(SupervisorEvent::BootStep {
                    name: "wsl-install".into(),
                    ok: false,
                    ms: t0.elapsed().as_millis() as u64,
                    error: Some(e.to_string()),
                });
                Err(e.to_string())
            }
        }
    }

    /// sidecar 子命令的 `--home` 追加参数：WSL 生效时 home = UNC（guard-*/
    /// safe-overlay 等以 ctx.home 为数据根的子命令不自检 WSL，必须显式切；
    /// boot 子命令自检 WSL 后自取 UNC home，--home 仅作其回落 local 时的
    /// 显式值——两侧一致）。local 模式返回空（现行为零变更）。
    fn sidecar_home_args(&self) -> Vec<String> {
        match self.wsl_active() {
            Some(b) => vec!["--home".into(), b.unc_home().to_string_lossy().into_owned()],
            None => Vec::new(),
        }
    }

    /// sidecar boot（node cli.js boot），逐步从 stderr 解析 [sidecar] 行转发。
    /// farm 实体目录去材料化（sidecar/farm-repair.js，node 侧 fs 操作）。
    /// 失败仅日志（log_line + stderr），绝不影响 boot 链。
    fn run_farm_repair(&self) {
        // 双布局：安装形态 app_dir=<install>/resources/dsh-desktop →
        // ../sidecar（resources/sidecar）；repo 检出 → ../dsh-tauri/sidecar。
        let installed = self.app_dir.join("..").join("sidecar").join("farm-repair.js");
        let script = if installed.exists() {
            installed
        } else {
            self.app_dir.join("..").join("dsh-tauri").join("sidecar").join("farm-repair.js")
        };
        if !script.exists() {
            eprintln!("[farm-repair] 脚本缺失（{:?}），跳过", script);
            return;
        }
        let out = Command::new(&self.node_exe)
            .arg(&script)
            .arg(&self.app_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_win()
            .output();
        match out {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                for line in stderr.lines().filter(|l| l.contains("[farm-repair]")) {
                    log_line(line);
                }
            }
            Err(e) => eprintln!("[farm-repair] 执行失败（不阻断）：{e}"),
        }
    }

    fn run_sidecar_boot(&self, tx: &Sender<SupervisorEvent>, _gen: u64) -> Result<(), String> {
        let out = Command::new(&self.node_exe)
            .arg(&self.sidecar_cli)
            .arg("boot")
            .arg("--app-dir")
            .arg(&self.app_dir)
            .args(self.sidecar_home_args())
            .env("DSH_TAURI_VERSION", env!("CARGO_PKG_VERSION"))
            // GUI 进程起 console 子进程抑制终端窗（boot 是「启动后弹终端」主源，
            // 与本文件其余 node spawn 同口径——0.5.0 实测修复）。
            .creation_flags_win()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| {
                let msg = format!("sidecar spawn 失败（node: {} cli: {}）: {e}", self.node_exe.display(), self.sidecar_cli.display());
                eprintln!("[boot] {msg}");
                msg
            })?;
        if !out.status.success() {
            let msg = format!("sidecar boot 退出码 {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr).lines().take(6).collect::<Vec<_>>().join(" | "));
            eprintln!("[boot] {msg}");
            return Err(msg);
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
    /// 与 enablePickerBrowseOverlay 的合并语义；缓存简化为 settings 布尔——每次
    /// 冒烟 ~100ms 级，签名级缓存随出包验证再评估）。
    #[cfg(windows)]
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
                        && koffi_preflight_passed(&String::from_utf8_lossy(&o.stdout)));
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
                            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
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

    /// 非 Windows：koffi 预检跳过。预检的故障模式是 win32-x64 预编译二进制
    /// 在 koffi.load() 处访问违例（koffi-preflight.cjs 探测的正是 kernel32.dll）
    /// ——非 Windows 无此故障面；若照跑只会恒失败，导致目录选择器被永久
    /// 降级到 browse 后端（静默功能损失）。
    #[cfg(not(windows))]
    fn run_koffi_preflight(&self) {
        log_line("koffi 预检仅 Windows 需要（本平台跳过）");
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
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let path = std::path::PathBuf::from(p);
            if !g.overlays.contains(&path) {
                g.overlays.push(path);
            }
        }
        true
    }

    /// spawn 内核进程 + 就绪行监视线程。
    ///
    /// WSL 模式（契约 §4.3）：spawn `wsl.exe -d <distro> -e sh -lc <cmd>` 包装
    /// ——不设工作目录（cd 在命令串内）、不设环境（Windows 环境块不传进 WSL，
    /// 净化在命令串 `env -u` 完成）、不设 PGID（WSL 内进程不在 Windows 进程
    /// 树）。Job Object 照常绑 wsl.exe（强杀壳时至少收割包装进程）。local
    /// 路径逐字节不变（不变量 §7.1）。
    fn spawn_kernel(self: Arc<Self>, port: u16, tx: &Sender<SupervisorEvent>) -> Result<(), String> {
        let overlays = self.inner.lock().unwrap_or_else(|p| p.into_inner()).overlays.clone();
        let wsl_backend_active = self.wsl_active();
        let wsl_mode = wsl_backend_active.is_some();
        let mut child = if let Some(backend) = &wsl_backend_active {
            let no_open = kernel_process::semver::needs_no_open_flag(&self.kernel_version);
            let cmd = backend.server_cmd(no_open);
            log_line(&format!(
                "内核(WSL) spawn: wsl.exe -d {} -e sh -lc {}（--port 0，实际端口待就绪行）",
                backend.distro(),
                cmd
            ));
            backend.spawn_server(no_open).map_err(|e| format!("spawn wsl.exe: {e}"))?
        } else {
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
            // Unix 杀树根基：内核设为进程组长（PGID == pid），后续全部子孙（工具
            // 进程/持久终端会话）天然继承同组——kill_kernel 的 killpg(-pgid) 才能
            // 整组收割（mac 退出后内核残留的根因）。Windows no-op（杀树走 Job
            // Object + taskkill）。
            kernel_process::kill_tree::set_process_group_leader(&mut cmd);
            let child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
            log_line(&format!("内核 pid={} spawn: {}", child.id(), spec.display_cmd()));
            child
        };

        // Review#2 根治：Job Object 杀树保护（父进程被强杀时 OS 收割内核树）。
        // WSL 模式绑定的 wsl.exe 包装进程（WSL 内进程收割见 kill_kernel 三层；
        // 强杀壳时 WSL 内可能残留——契约 §4.6 残余风险，spawn 前 rm -f dsh.pid
        // + 下次启动兜底）。
        if let Err(e) = kernel_process::job_object::assign_child_to_kill_on_close_job(&child) {
            log_line(&format!("Job Object 赋值失败（杀树保护降级为显式 taskkill）: {e}"));
        }
        let stdout = child.stdout.take().ok_or("stdout piped 失败")?;
        let stderr = child.stderr.take();
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).kernel = Some(child);

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
                    // C3（B2 配方）：内核 stdout 持久化 dsh-web.log（4MB 轮转）——
                    // 此前 println/log_line 在 GUI 进程全丢弃，safe-overlay 崩溃
                    // 自愈层无日志可解析、诊断无附件。IO 失败静默（不阻断启动）。
                    crate::logging::append_capped(
                        &shell_core::DshPaths::resolve().logs.join("dsh-web.log"),
                        &format!("web| {text}"),
                        crate::logging::LOG_CAP_BYTES,
                    );
                }
                if url.is_none() {
                    if let Some(u) = parser.feed(&format!("{text}\n")) {
                        url = Some(u.clone());
                        // WSL 模式实际端口 = 就绪行 URL 的端口（--port 0 由 WSL 内
                        // OS 分配；spawn 传入值仅日志参考——契约 §4.3/D3）。
                        // 端口落在 Chromium 受限端口表 → 按本次拉起失败收链
                        //（杀掉重试，瀑布二/三层承接；Electron restrictedPortOf
                        // 两模式共用语义）。
                        let port = if wsl_mode {
                            match url_port(&u) {
                                Some(p) if kernel_process::port::is_safe_port(p) => p,
                                bad => {
                                    let reason = match bad {
                                        Some(p) => format!("就绪行端口 {p} 在 Chromium 受限端口表"),
                                        None => format!("就绪行 URL 缺端口: {u}"),
                                    };
                                    log_line(&format!("{reason}，按本次拉起失败收链"));
                                    let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                                    g.kernel_url = None;
                                    if let Some(rtx) = g.ready_tx.take() {
                                        let _ = rtx.send(Err(reason));
                                    }
                                    drop(g);
                                    this.kill_kernel();
                                    return;
                                }
                            }
                        } else {
                            port
                        };
                        {
                            let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                            g.kernel_url = Some(u.clone());
                            if wsl_mode {
                                g.port = Some(port);
                            }
                        }
                        let rtx = this.inner.lock().unwrap_or_else(|p| p.into_inner()).ready_tx.take();
                        if let Some(rtx) = rtx { let _ = rtx.send(Ok(u.clone())); }
                        this.set_state(RunState::Ready);
                        // HTTP 热探（用户实测「Failed to fetch 闪现」根治）：ready 行
                        // 只表示内核进程打出就绪日志，HTTP 监听可能有 ~100ms 窗口
                        // 尚未接受请求。本线程是 KernelReady 的唯一发送源（瀑布
                        // on_boot_success 与崩溃自动重启两条路径统一在此换页）——
                        // 此前自动重启路径无热探，就绪行早于 bind 时换页 → WebView2
                        // 错误页（白屏形态之一；且错误页上垫片照常发心跳，渲染层
                        // 心跳监测判定「页面健康」永不自愈）。
                        for i in 0..50 {
                            if Self::http_alive(port) { break; }
                            if i == 49 { log_line("HTTP 热探超时（5s），换页继续（可能首次闪败）"); }
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        let _ = tx2.send(SupervisorEvent::KernelReady { url: u, port });
                        // 探活布防（唯一位置）：就绪行线程对每次内核就绪都布防——
                        // 覆盖瀑布路径与崩溃自动重启路径（此前只在 on_boot_success
                        // 布防，自动重启后的内核处于无探活状态）。probe_gen 令牌
                        // 递增令上一代探活环自行退出（同代际换内核不得双探活）。
                        let (probe_gen, live_gen) = {
                            let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                            g.probe_gen += 1;
                            (g.probe_gen, g.generation)
                        };
                        this.probe_loop(port, tx2.clone(), live_gen, probe_gen);
                    }
                }
            }
            // stdout EOF = 进程退出。
            let (code, exited) = {
                let mut g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
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
                    let line = format!("web-err| {}", String::from_utf8_lossy(&buf[..n]).trim_end());
                    log_line(&line);
                    // C3（B2 配方）：内核 stderr 同落 dsh-web.log（4MB 轮转）。
                    crate::logging::append_capped(
                        &shell_core::DshPaths::resolve().logs.join("dsh-web.log"),
                        &line,
                        crate::logging::LOG_CAP_BYTES,
                    );
                }
            });
        }
        Ok(())
    }

    /// 内核退出处理：崩溃环判定。
    fn on_kernel_exit(self: &Arc<Self>, code: Option<i32>, tx: &Sender<SupervisorEvent>) {
        let now = now_ms();
        let (verdict, crashes) = {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
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
            // 崩溃环触发后冷却期内的后续崩溃：维持恢复页，不再自动拉起——
            // 此前 Cooldown 落在 `_` 兜底臂继续自动重启，恢复页背后内核反复
            // 拉起/退出（用户侧「频繁重启」的主机），且任一次走到就绪行还会
            // 经 KernelReady 把页面从恢复页拉回内核页（页面反复横跳）。
            Verdict::Tripped | Verdict::Cooldown => self.enter_recovery_tx(tx, "崩溃环触发"),
            Verdict::Ok => {
                // 未成环：自动重启一次（Electron watchServerProc 语义：异常退出自动拉起）。
                // 探活/换页不在此布防：新内核的就绪行线程统一负责（probe_gen 令牌）。
                let port = self.inner.lock().unwrap_or_else(|p| p.into_inner()).port;
                let gen = self.inner.lock().unwrap_or_else(|p| p.into_inner()).generation;
                let this = Arc::clone(self);
                let tx2 = tx.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                    // 状态门（VB1 残留缺口收口）：自动重启仅覆盖 **Ready 态的运行期
                    // 崩溃**。boot 期（Spawn/Repair 等）的内核退出归瀑布——
                    // ready_tx 已把「内核启动期退出」按本次拉起失败回报给
                    // spawn_and_wait_ready，瀑布二/三层会接管重拉；此前的 2s
                    // 自动重启线程与瀑布二层 spawn 竞速（瀑布先重跑 sidecar
                    // boot，>2s），会产出双内核：自动重启的内核占住端口后被
                    // g.kernel 覆写泄漏，瀑布层内核绑定失败连锁退出（慢机
                    // 「启动期 CPU 尖峰/反复拉起」形态）。唤醒时复查（而非仅
                    // 布防时）：restart() 后到 boot_waterfall 置 Repair 前有
                    // 毫秒级 Ready 空窗，旧线程须在此自灭。
                    if g.stopping || g.generation != gen || g.kernel.is_some() || g.state != RunState::Ready {
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
    /// HTTP 应用层探活：读到任何响应字节（含 404/401——内核对 / 至少回
    /// index/错误页）即证明事件循环在转。TCP 握手由 OS 协议栈完成，进程
    /// 假死时也恒成功——必须发请求读响应才能区分（issue #122/#129）。
    fn http_alive(port: u16) -> bool {
        use std::io::{Read, Write};
        let Ok(addr) = format!("127.0.0.1:{port}").parse() else { return false };
        let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
            return false;
        };
        let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
        if s.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
            return false;
        }
        let mut buf = [0u8; 16];
        matches!(s.read(&mut buf), Ok(n) if n > 0)
    }

    fn probe_loop(self: &Arc<Self>, port: u16, tx: Sender<SupervisorEvent>, gen: u64, probe_gen: u64) {
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            // 就绪后失联分两形态（#122 假死定性）：
            //   a) TCP 连不上（进程死/端口死）→ 连续 3 次按退出处理（原语义）；
            //   b) TCP 通但 HTTP 连续无响应 → 假死，连续 20 次（~60s）受控重启。
            //      阈值从 5(15s) 提到 20(60s)：用户实测内核做上下文压缩/LSTM 推理
            //      时事件循环被占 20-30s——15s 会误杀正在工作的内核（导致
            //      "signal time out" + "中断不了" + 频繁压缩的恶性循环）。
            //      走 on_kernel_exit 的崩溃环窗口限次（天然防死循环）。
            //
            // 退出条件（v0.5.1 频繁重启回归修复）：
            //   - probe_gen 令牌不符（新一代内核已布防，本环属上一代内核）；
            //   - 状态进 CrashLoop/Recovery：崩溃环/恢复页期间不得继续探活——
            //     此前探活环在恢复页期间继续探死端口，3 次失联后 on_kernel_exit
            //     会把崩溃自动重启刚拉起的新内核一并杀掉（复活-再杀循环）。
            let mut consecutive = 0usize;
            let mut zombie = 0usize;
            loop {
                std::thread::sleep(Duration::from_secs(3));
                {
                    let g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                    if g.stopping || g.generation != gen || g.probe_gen != probe_gen {
                        return;
                    }
                    if g.state == RunState::Recovery || g.state == RunState::CrashLoop {
                        return;
                    }
                }
                // SocketAddr::from(([u8;4], u16)) 是全函数——等价于
                // "127.0.0.1:{port}" 解析成功路径，但不留生产 unwrap。
                let tcp_ok = std::net::TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                    Duration::from_secs(2),
                )
                .is_ok();
                if tcp_ok && Self::http_alive(port) {
                    consecutive = 0;
                    zombie = 0;
                    continue;
                }
                if !tcp_ok {
                    zombie = 0;
                    consecutive += 1;
                    let _ = tx.send(SupervisorEvent::ProbeFailed { consecutive });
                    if consecutive >= 3 {
                        // 端口连续失联但进程可能还活着：杀掉按退出处理。
                        // 内核已不在（退出处理链已接管：自动重启或恢复页）时
                        // 不得再记一次崩溃——那会把后续自动重启的新内核当作
                        // 本次失败连带处理。
                        let kernel_present = {
                            let g = this.inner.lock().unwrap_or_else(|p| p.into_inner());
                            g.kernel.is_some()
                        };
                        if kernel_present {
                            this.kill_kernel();
                            this.on_kernel_exit(None, &tx);
                        }
                        return;
                    }
                    continue;
                }
                // TCP 通、HTTP 无响应：假死形态。
                zombie += 1;
                let _ = tx.send(SupervisorEvent::ZombieSuspect { consecutive: zombie });
                log_line(&format!("内核假死可疑（端口通、HTTP 无响应）×{zombie}"));
                if zombie >= 20 {
                    log_line("内核假死判定成立（连续 60s HTTP 无响应，20×3s 探活），受控重启");
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
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
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
        // 幂等：已在崩溃环态（冷却期内后续崩溃）不再重发 CrashLoop 事件——
        // 事件会再导航恢复页 + 弹系统通知，崩溃连环下发会刷屏。
        let already = self.state() == RunState::CrashLoop;
        self.set_state(RunState::CrashLoop);
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            g.last_error = Some(reason.to_string());
            // 内核已死，URL 随之作废——不清则恢复页「重新加载」会按 stale URL
            // 换页到已死端口（真机复现：ERR_CONNECTION_REFUSED 错误页，无任何
            // 可操作按钮，比停在 loading 页更糟）。清空后 reload 走重启分支。
            g.kernel_url = None;
        }
        if already {
            log_line(&format!("崩溃环冷却期内再次崩溃，维持恢复页（{reason}）"));
            return;
        }
        log_line(&format!("崩溃环触发，转恢复页（{reason}）"));
        let crashes = self.inner.lock().unwrap_or_else(|p| p.into_inner()).crash_count;
        let _ = tx.send(SupervisorEvent::CrashLoop { crashes });
    }

    /// 恢复页「重启」：手动复位崩溃环。
    pub fn recovery_restart(self: &Arc<Self>, tx: Sender<SupervisorEvent>) {
        self.recovery_restart_with_port(tx, None);
    }

    /// 恢复页「重启」（带优先端口）：复位崩溃环 + 全链重启。
    /// preferred 传上次内核端口（origin 稳定，SPA localStorage 偏好不丢）。
    pub fn recovery_restart_with_port(self: &Arc<Self>, tx: Sender<SupervisorEvent>, preferred_port: Option<u16>) {
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            g.crash.record_recovery();
            g.crash_count = 0;
            g.last_error = None;
        }
        self.set_state(RunState::Recovery);
        self.restart(tx, preferred_port);
    }

    /// 杀内核整树（restart / 恢复页 / 探活失败 / 应用退出共用）。
    ///
    /// local：Windows taskkill /T /F；Unix：killpg(-pgid, SIGKILL) 整组收割
    /// ——OS 绑定见 kernel_process::kill_tree（本函数仅持锁取 child + 派发）。
    ///
    /// WSL：三层收割（契约 §4.6；发行版级 terminate/shutdown 全局终结命令
    /// **绝不调用**——那会终结整个发行版内用户的其他进程）：
    /// ① WSL 内按 pid 文件 kill（另一条 wsl.exe 调用，≤30s；taskkill /T 对
    ///   WSL 内进程无效——不在 Windows 进程树，/T 枚举不到）；
    /// ② 杀 wsl.exe 包装 child + 收尸；
    /// ③ 300ms 缓冲后再进端口探测（Electron killTree WSL 分支语义）。
    pub fn kill_kernel(&self) {
        let backend = self.wsl_active();
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut c) = g.kernel.take() {
            let pid = c.id();
            match &backend {
                Some(b) => {
                    b.stop();
                    let _ = c.kill();
                    let _ = c.wait();
                    drop(g);
                    std::thread::sleep(Duration::from_millis(300));
                }
                None => kill_tree(&mut c, pid),
            }
        }
    }

    /// 应用退出路径：同步终结（不依赖事件循环）。
    /// WSL 分支：WSL 内 stop fire-and-forget（退出不等 30s 上限；Electron
    /// killTreeSync 同款）+ 同步杀 wsl.exe 包装进程。
    pub fn shutdown(&self) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).stopping = true;
        if let Some(b) = self.wsl_active() {
            std::thread::spawn(move || {
                b.stop();
            });
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(mut c) = g.kernel.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        } else {
            self.kill_kernel();
        }
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

/// 从就绪行 URL 提取端口（WSL 模式实际端口来源——契约 §4.3）：
/// 取最后一个 `:` 后的连续数字段（容忍尾随路径）。无端口 → None。
fn url_port(url: &str) -> Option<u16> {
    let idx = url.rfind(':')?;
    let digits: String = url[idx + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// koffi-preflight 通过判定：stdout 末行 JSON 的 `ok == true`。
/// 此前用 `ends_with("{\"ok\":true}")` 字符串契约——sidecar 的「脚本缺失
/// 跳过」形态 `{"ok":true,"skipped":"no-script"}` 不满足该匹配（X2 指出），
/// 改按 JSON 语义判定（契约放宽为「末行 JSON ok 字段为 true」，WSL 跳过
/// 分支的逐字 `{"ok":true}` 亦满足）。
fn koffi_preflight_passed(stdout: &str) -> bool {
    stdout
        .trim_end()
        .lines()
        .last()
        .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .and_then(|v| v.get("ok").and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

fn log_line(msg: &str) {
    // T4 反馈：无时间戳时恢复耗时只能外部计时——补 HH:MM:SS 前缀。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, m, sec) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    println!("[supervisor {h:02}:{m:02}:{sec:02}] {msg}");
    file_log(&format!("[supervisor {h:02}:{m:02}:{sec:02}] {msg}"));
}

/// 落盘日志（logs/desktop.log）：supervisor/路由事件双写（stdout + 文件）。
/// v0.5.2 真机实测发现：GUI 子系统无控制台，println/eprintln 在安装态无人
/// 接收；而 desktop.log 此前仅被诊断（diag-export）读取、无任何写入方——
/// 崩溃环/看门狗触发后排障时「打开日志」是空目录，恢复页「请导出日志反馈」
/// 无从取证。追加写失败静默（日志绝不影响主流程）。
pub fn file_log(line: &str) {
    // C3（B2 配方）：desktop.log 经 logging::append_capped 落盘（4MB 轮转
    // .old 只留一代；IO 失败静默）——此前 GUI 进程 stdout 丢弃，boot/路由
    // 日志从不落盘。时间戳口径不变（chrono_like_now）。
    crate::logging::append_capped(
        &shell_core::DshPaths::resolve().logs.join("desktop.log"),
        &format!("{} {line}", crate::chrono_like_now()),
        crate::logging::LOG_CAP_BYTES,
    );
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

    /// #122/#129 假死形态的确定性验证：TCP 握手被 OS 协议栈代答、应用层
    /// 永不响应——http_alive 必须判死（纯 TCP 探测恒活的正是这种形态）。
    /// 三态对照：挂死服务器（accept 后不读写）/ 正常 HTTP / 无监听端口。
    #[test]
    fn http_alive_detects_zombie_vs_live_vs_dead() {
        // ① 假死：accept 但永不响应（事件循环卡死的协议栈镜像）
        let zombie = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let zport = zombie.local_addr().unwrap().port();
        let zthread = std::thread::spawn(move || {
            for stream in zombie.incoming() {
                let _stream: std::net::TcpStream = stream.unwrap();
                std::thread::sleep(std::time::Duration::from_secs(30)); // 持住连接不响应
            }
        });
        // ② 正常：最小 HTTP 响应（404 也是活）
        let live = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let lport = live.local_addr().unwrap().port();
        let lthread = std::thread::spawn(move || {
            for stream in live.incoming() {
                let mut s = stream.unwrap();
                use std::io::{Read, Write};
                let mut buf = [0u8; 128];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 404 Not Found
Content-Length: 0

");
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!Supervisor::http_alive(zport), "假死（TCP 通、HTTP 永不响应）必须判死——signal timed out 的根形态");
        assert!(Supervisor::http_alive(lport), "正常 HTTP（含 404）必须判活");
        // ③ 端口不存在
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dport = dead.local_addr().unwrap().port();
        drop(dead);
        assert!(!Supervisor::http_alive(dport), "无监听端口必须判死");
        drop(zthread);
        drop(lthread);
    }

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

    /// 生产 wsl.exe 原语（Node 解析测试构造用：构造期零 wsl.exe 调用，
    /// 真实调用仅发生在 WSL boot 分支——本组测试不进入）。
    fn real_wsl_invoker() -> Arc<dyn wsl_backend::WslInvoker> {
        Arc::new(wsl_backend::RealWslInvoker) as Arc<dyn wsl_backend::WslInvoker>
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

    /// Node 三级解析链优先级（v0.5.4 P0 回归锚点；vendor 平台主名/备名
    /// 选择的底层单测在 kernel-process::node_resolve，此处验证 supervisor
    /// 构造接线）：系统 ≥22 优先 → 过旧/探测失败回落 vendor → 全缺 None。
    #[test]
    fn node_resolution_priority_chain() {
        struct StubNodeProbe {
            path_hit: Option<PathBuf>,
            version: Option<String>,
        }
        impl kernel_process::NodeProbe for StubNodeProbe {
            fn find_node_in_path(&self) -> Option<PathBuf> {
                self.path_hit.clone()
            }
            fn node_version(&self, _exe: &std::path::Path) -> Option<String> {
                self.version.clone()
            }
        }
        let probe = |ver: Option<&str>| {
            Arc::new(StubNodeProbe {
                path_hit: Some(PathBuf::from(if cfg!(windows) { r"C:\fake\node.exe" } else { "/fake/node" })),
                version: ver.map(String::from),
            }) as Arc<dyn kernel_process::NodeProbe>
        };
        let mk = |root: &std::path::Path, with_vendor: bool| -> std::path::PathBuf {
            let d = root.to_path_buf();
            if with_vendor {
                std::fs::create_dir_all(d.join("dsh-desktop").join("vendor").join("node")).unwrap();
                let name = if cfg!(windows) { "node.exe" } else { "node" };
                std::fs::write(d.join("dsh-desktop").join("vendor").join("node").join(name), b"").unwrap();
            }
            d
        };

        // ① 系统 ≥22：即便 vendor 在位也优先系统（瘦身/杀软规避口径）。
        let root = sandbox("nr1");
        let sv = Supervisor::new_with_probes(&mk(&root, true), real_wsl_invoker(), probe(Some("v24.15.0")));
        assert!(matches!(&sv.node_resolved, Some(kernel_process::node_resolve::ResolvedNode::System { major: 24, .. })), "系统 node ≥22 优先");
        assert_eq!(sv.node_exe, sv.node_resolved.as_ref().unwrap().exe(), "node_exe 必须指向命中者");
        // ② 系统过旧（<22）：回落 vendor。
        let root2 = sandbox("nr2");
        let sv2 = Supervisor::new_with_probes(&mk(&root2, true), real_wsl_invoker(), probe(Some("v18.20.4")));
        assert!(matches!(&sv2.node_resolved, Some(kernel_process::node_resolve::ResolvedNode::Vendor(_))), "过旧系统 node 须回落 vendor");
        // ③ 系统探测失败（杀软/商店 stub）：回落 vendor。
        let root3 = sandbox("nr3");
        let sv3 = Supervisor::new_with_probes(&mk(&root3, true), real_wsl_invoker(), probe(None));
        assert!(matches!(&sv3.node_resolved, Some(kernel_process::node_resolve::ResolvedNode::Vendor(_))), "探测失败须回落 vendor");
        // ④ 便携版缺文件形态：无系统 node 且无 vendor → None + 占位 node_exe
        //    （spawn 失败旧路径终防线在位）。
        let root4 = sandbox("nr4");
        let sv4 = Supervisor::new_with_probes(&mk(&root4, false), real_wsl_invoker(), probe(None));
        assert!(sv4.node_resolved.is_none(), "三级链全空 → None");
        let primary = if cfg!(windows) { "node.exe" } else { "node" };
        assert_eq!(sv4.node_exe, root4.join("dsh-desktop").join("vendor").join("node").join(primary), "全缺时占位主名路径");
        for d in [&root, &root2, &root3, &root4] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// Node 全缺的 boot 瀑布首步行为：清晰 BootStep 错误（name=node-resolve）
    /// + last_error + 恢复页态——替代旧「sidecar spawn os error 2」。
    #[test]
    fn node_missing_boot_step_clear_error() {
        struct NoNodeProbe;
        impl kernel_process::NodeProbe for NoNodeProbe {
            fn find_node_in_path(&self) -> Option<PathBuf> { None }
            fn node_version(&self, _exe: &std::path::Path) -> Option<String> { None }
        }
        // 伪仓库根：无 vendor node → 三级链全空（不依赖本机是否装有 node）。
        let root = sandbox("nr-miss");
        std::fs::create_dir_all(root.join("dsh-desktop")).unwrap();
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new_with_probes(
            &root,
            real_wsl_invoker(),
            Arc::new(NoNodeProbe) as Arc<dyn kernel_process::NodeProbe>,
        ));
        assert!(sv.node_resolved.is_none());
        let (tx, rx) = std::sync::mpsc::channel();
        Supervisor::boot_waterfall(Arc::clone(&sv), tx, None);
        // 首个事件即 node-resolve 失败步，错误文案含可操作指引。
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(SupervisorEvent::BootStep { name, ok, error, .. }) => {
                assert_eq!(name, "node-resolve");
                assert!(!ok);
                let e = error.expect("缺失错误必须带 error 文案");
                assert!(e.contains("Node"), "文案须指明 Node: {e}");
                assert!(e.contains("vendor/node"), "文案须指出内置路径: {e}");
            }
            other => panic!("首个事件应为 node-resolve 失败步: {other:?}"),
        }
        assert_eq!(sv.state(), RunState::CrashLoop, "全缺必须立即转恢复页态");
        assert!(sv.last_error().is_some_and(|e| e.contains("Node")), "last_error 须记录缺失原因");
        // 随后的事件只能是恢复页信号（CrashLoop），不得再有任何 boot 步
        // （sidecar 五步等——全缺短路）。
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(SupervisorEvent::CrashLoop { .. }) => {}
            other => panic!("node-resolve 后应只跟恢复页信号: {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "CrashLoop 后不得再有事件");
        let _ = std::fs::remove_dir_all(&root);
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
        let names: Vec<String> = rx.iter().map(|e| match e { SupervisorEvent::BootStep { name, .. } => name, _ => String::new() }).take(5).collect();
        assert_eq!(names, vec!["repair", "sync", "presets", "patches", "preflight"], "boot 步骤顺序契约");
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
        // 版本断言放宽到 0.1.x：内核家族从 0.1.0-rc.8 升到 0.1.1-rc.1（K1 适配），
        // 前缀 0.1. 覆盖两者，防止每次 rc 平移都要改这里。
        assert!(sv.kernel_version.starts_with("0.1."), "内核版本应可读: {}", sv.kernel_version);
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
        assert_eq!(boot_steps, vec!["repair", "sync", "presets", "patches", "preflight"]);
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
        let g0 = sv.inner.lock().unwrap_or_else(|p| p.into_inner()).generation;
        sv.set_state_for_test(RunState::Ready);
        assert_eq!(sv.state(), RunState::Ready);
        let (tx, _rx) = std::sync::mpsc::channel();
        sv.restart(tx, None);
        assert_eq!(sv.inner.lock().unwrap_or_else(|p| p.into_inner()).generation, g0 + 1, "restart 应递增代际号");
        sv.shutdown();
        assert!(sv.inner.lock().unwrap_or_else(|p| p.into_inner()).stopping);
        let _ = Ordering::Relaxed;
    }

    /// 看门狗判定表（纯函数全态枚举）：boot 进行态（Boot/Repair/Sync/Patch/
    /// Spawn）触发转恢复页；Ready（迟到的正常就绪）与 Recovery（瀑布已自愈）
    /// 不触发；stopping（退出路径）压制一切——防退出时误发恢复页事件。
    #[test]
    fn watchdog_decision_table_all_states() {
        use RunState::*;
        for s in [Boot, Repair, Sync, Patch, Spawn, CrashLoop] {
            assert!(Supervisor::watchdog_should_fire(false, s), "{s:?} 仍卡 boot 链应触发看门狗");
        }
        assert!(!Supervisor::watchdog_should_fire(false, Ready), "迟到的正常就绪不得被看门狗误杀");
        assert!(!Supervisor::watchdog_should_fire(false, Recovery), "已进恢复页不得重复触发");
        for s in [Boot, Spawn, Ready, CrashLoop] {
            assert!(!Supervisor::watchdog_should_fire(true, s), "stopping={s:?} 退出路径压制看门狗");
        }
    }

    /// v0.5.1「频繁重启 + 白屏」回归锚点组（真机复现定案的四个断流/复活面）。
    /// 形态断言法（include_str!），防回退：
    ///   ① KernelReady 单源 + 热探：全文件只允许一处 send(KernelReady)——
    ///      在就绪行线程内且前置 http_alive 热探（自动重启路径换页不再竞速
    ///      HTTP bind → 不再产 chrome-error 白页）；on_boot_success 不得再发。
    ///   ② 崩溃环 Cooldown 不得自动重启（此前 `_` 兜底臂把恢复页背后的内核
    ///      反复拉起，页面在恢复页/内核页横跳 = 用户侧「频繁重启」）。
    ///   ③ 探活环令牌 + CrashLoop/Recovery 退出 + 内核不在不补刀（防旧环
    ///      复活/误杀自动重启的新内核）。
    ///   ④ 看门狗代际感知（restart 叠犬不得打断新 boot）。
    #[test]
    fn regression_v051_restart_whitescreen_anchors() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        // ① KernelReady 单源（拼接构串避免测试字面量自匹配 include_str! 文本）。
        let send_tx2 = ["tx2", ".send(", "SupervisorEvent::KernelReady"].concat();
        let send_tx = ["tx", ".send(", "SupervisorEvent::KernelReady"].concat();
        let sends = src.matches(&send_tx2).count() + src.matches(&send_tx).count();
        assert_eq!(sends, 1, "KernelReady 只允许就绪行线程单点发送（双发=双 navigate/双心跳监测/双诊断探针）: {sends}");
        let ready_seg = src
            .split("if url.is_none() {")
            .nth(1)
            .and_then(|s| s.split("// stdout EOF").next())
            .expect("就绪行线程段");
        let probe_pos = ready_seg.find("Self::http_alive(port)").expect("就绪换页前必须 HTTP 热探");
        let send_pos = ready_seg.find(&send_tx2).expect("就绪换页发送");
        assert!(probe_pos < send_pos, "热探必须先于 KernelReady（防就绪行早于 HTTP bind 的白页竞速）");
        let boot_seg = src
            .split("fn on_boot_success")
            .nth(1)
            .and_then(|s| s.split("fn cancelled").next())
            .expect("on_boot_success 段");
        assert!(!boot_seg.contains("KernelReady"), "on_boot_success 不得再发 KernelReady（单源在就绪行线程）");
        assert!(!boot_seg.contains("probe_loop"), "探活布防不在此处（就绪行线程统一布防，覆盖自动重启路径）");
        // ② Cooldown 不自动重启。
        let exit_seg = src
            .split("fn on_kernel_exit")
            .nth(1)
            .and_then(|s| s.split("/// 探活循环").next())
            .expect("on_kernel_exit 段");
        assert!(
            exit_seg.contains("Verdict::Tripped | Verdict::Cooldown =>"),
            "Cooldown 必须与 Tripped 同路进恢复页（不得落自动重启）"
        );
        assert!(exit_seg.contains("Verdict::Ok =>"), "仅 Ok 判定可自动重启");
        assert!(!exit_seg.contains("_ =>"), "不得有兜底臂吞掉 Cooldown");
        // ③ 探活环守卫。
        let probe_seg = src
            .split("fn probe_loop")
            .nth(1)
            .and_then(|s| s.split("/// 原地重启").next())
            .expect("probe_loop 段");
        assert!(probe_seg.contains("g.probe_gen != probe_gen"), "探活环必须校验令牌（同代际换内核不得双环）");
        assert!(probe_seg.contains("RunState::CrashLoop"), "崩溃环态必须退出探活（防恢复页期间复活内核）");
        assert!(probe_seg.contains("kernel_present"), "内核已不在时不得补刀记崩溃（防连带杀掉自动重启的新内核）");
        // ④ 看门狗代际。
        let wd_seg = src
            .split("fn spawn_boot_watchdog")
            .nth(1)
            .and_then(|s| s.split("/// 看门狗触发判定").next())
            .expect("spawn_boot_watchdog 段");
        assert!(wd_seg.contains("g.generation != gen"), "看门狗必须代际感知（restart 叠犬不得打断新 boot）");
        // ⑤ 自动重启状态门（VB1 残留缺口收口）：boot 期退出不得走 2s 自动
        //    重启（与瀑布二层 spawn 竞速 = 双内核/端口互踩）；唤醒时必须
        //    复查 state == Ready，Ready 态运行期崩溃的自动重启语义保持不变。
        let ok_seg = exit_seg
            .split("Verdict::Ok =>")
            .nth(1)
            .and_then(|s| s.split("/// 探活循环").next())
            .expect("自动重启（Verdict::Ok）段");
        let wake_seg = ok_seg
            .split("std::thread::sleep(Duration::from_secs(2))")
            .nth(1)
            .and_then(|s| s.split("this.spawn_kernel").next())
            .expect("自动重启线程唤醒段");
        assert!(
            wake_seg.contains("g.state != RunState::Ready"),
            "自动重启线程唤醒时必须复查 Ready 态（boot 期退出归瀑布 ready_tx 路径）: {wake_seg}"
        );
    }

    /// enter_recovery_tx 幂等锚点：冷却期内后续崩溃不得重发 CrashLoop 事件
    /// （事件会再导航恢复页 + 弹系统通知，连环崩溃下发会刷屏）。
    #[test]
    fn enter_recovery_is_idempotent_while_in_crashloop() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let seg = src
            .split("fn enter_recovery_tx")
            .nth(1)
            .and_then(|s| s.split("/// 恢复页「重启」").next())
            .expect("enter_recovery_tx 段");
        assert!(seg.contains("already"), "必须判定已在崩溃环态");
        let already_pos = seg.find("if already").expect("already 分支");
        let send_pos = seg.find("tx.send(SupervisorEvent::CrashLoop").expect("CrashLoop 事件发送");
        assert!(already_pos < send_pos, "already 分支必须先于事件发送 return");
    }

    /// 看门狗端到端（短超时注入，生产 300s 参数化）：boot 永挂（卡 Boot 态）
    /// → 超时 → CrashLoop 事件 + last_error 带「看门狗」+ 状态落 CrashLoop
    /// （恢复页路径）；对照组：已 Ready 的 supervisor 超时后零事件。
    #[test]
    fn watchdog_short_timeout_routes_stuck_boot_to_recovery() {
        let Some(root) = repo_root() else { eprintln!("[skip] 仓库检出不含 dsh-desktop"); return; };
        // ① 卡 Boot：不跑瀑布，仅让 supervisor 停在初始态。
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        assert_eq!(sv.state(), RunState::Boot);
        let (tx, rx) = std::sync::mpsc::channel();
        Supervisor::spawn_boot_watchdog(&sv, tx, Duration::from_millis(150));
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(SupervisorEvent::CrashLoop { .. }) => {}
            other => panic!("boot 永挂应收到 CrashLoop（恢复页路径），得到 {other:?}"),
        }
        assert!(sv.last_error().as_deref().unwrap_or("").contains("看门狗"), "last_error 应指明看门狗超时: {:?}", sv.last_error());
        assert_eq!(sv.state(), RunState::CrashLoop, "状态应落 CrashLoop（换恢复页的壳侧锚点）");
        // ② 已 Ready：超时不打扰（迟到的正常就绪）。
        let sv2: Arc<Supervisor> = Arc::new(Supervisor::new(&root));
        sv2.set_state_for_test(RunState::Ready);
        let (tx2, rx2) = std::sync::mpsc::channel();
        Supervisor::spawn_boot_watchdog(&sv2, tx2, Duration::from_millis(150));
        assert!(rx2.recv_timeout(Duration::from_secs(1)).is_err(), "Ready 态超时后不得有任何事件");
        assert_eq!(sv2.state(), RunState::Ready);
    }

    // ------------------------------------------------------------------
    // WSL 托管模式（契约 wsl-backend.md；形态锁 + 注桩端到端）
    // ------------------------------------------------------------------

    /// 收割禁令（不变量 §7.2）：supervisor 全文件不得出现发行版级终结命令
    /// （wsl 的 terminate / shutdown 全局形态——那会终结整个发行版内用户的
    /// 其他进程）。kill_kernel 的 WSL 分支必须是 stop（pid 文件）→ 杀包装
    /// child 的次序。（拼接构串避免测试字面量自匹配 include_str! 文本。）
    #[test]
    fn wsl_harvest_never_terminates_shape() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let terminate = ["wsl", " --term", "inate"].concat();
        let shutdown = ["wsl", " --shut", "down"].concat();
        assert!(!src.contains(&terminate), "绝不调用发行版级终结命令（契约 §4.6 红线）");
        assert!(!src.contains(&shutdown), "绝不调用发行版级停机命令");
        let seg = src
            .split("pub fn kill_kernel")
            .nth(1)
            .and_then(|s| s.split("pub fn shutdown").next())
            .expect("kill_kernel 段");
        let stop_pos = seg.find("b.stop();").expect("WSL 分支必须先 stop（WSL 内 pid 文件收割）");
        let kill_pos = seg.find("let _ = c.kill();").expect("再杀 wsl.exe 包装 child");
        assert!(stop_pos < kill_pos, "收割次序：WSL 内 stop 先于杀包装进程");
        // shutdown 的 WSL 分支：stop 必须 fire-and-forget（退出不等 30s 上限）。
        let sd = src.split("pub fn shutdown").nth(1).and_then(|s| s.split("\n    }\n}").next()).expect("shutdown 段");
        assert!(sd.contains("std::thread::spawn(move || {"), "WSL stop 须后台线程 fire-and-forget");
    }

    /// boot 瀑布 WSL 步序形态（契约 §4.2 顺序红线）：configure → 回落分支 →
    /// ensure_installed **先于** sidecar boot（补丁目标含 <UNC>/agent/
    /// node_modules）；farm/koffi 跳过分支在场；端口 --port 0；看门狗 35 分钟。
    #[test]
    fn wsl_boot_waterfall_order_shape() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let seg = src
            .split("fn boot_waterfall")
            .nth(1)
            .and_then(|s| s.split("fn on_boot_success").next())
            .expect("boot_waterfall 段");
        let ensure_pos = seg.find("run_wsl_ensure_installed(&tx)").expect("ensure_installed 步骤");
        let sidecar_pos = seg.find("run_sidecar_boot(&tx, gen)").expect("sidecar boot 步骤");
        assert!(ensure_pos < sidecar_pos, "ensure_installed 必须先于插件/补丁链（Electron main.js 4957 同序）");
        // farm-repair / koffi 的 WSL 跳过分支。
        assert!(seg.contains("if wsl.is_none() {\n                this.run_farm_repair();"), "farm 修复仅 local 跑");
        assert!(seg.contains("if wsl.is_none() {\n                this.run_koffi_preflight();"), "koffi 预检仅 local 跑");
        // 端口：WSL --port 0。
        assert!(seg.contains("let port = if wsl.is_some() {\n                0u16"), "WSL 端口占位 0（实际端口从就绪行解析）");
        // 看门狗放宽常量存在且被选用。
        assert!(src.contains("BOOT_WATCHDOG_TIMEOUT_WSL: Duration = Duration::from_secs(35 * 60)"));
        assert!(src.contains("BOOT_WATCHDOG_TIMEOUT_WSL\n            } else"), "watchdog 按 WSL 意图放宽");
        // sidecar --home 接线（UNC 写穿）。
        let home_seg = src.split("fn sidecar_home_args").nth(1).and_then(|s| s.split("\n    }").next()).expect("sidecar_home_args 段");
        assert!(home_seg.contains("\"--home\""), "WSL 模式 sidecar 子命令须传 --home <UNC>");
    }

    /// spawn 形态：WSL 分支走 wsl_spawn_args（严格 argv）、不设 PGID/current_dir/
    /// env；就绪行线程内 actual port 提取 + 受限端口收链；local 分支 spec 链不变。
    #[test]
    fn wsl_spawn_and_actual_port_shape() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let seg = src
            .split("fn spawn_kernel")
            .nth(1)
            .and_then(|s| s.split("/// 内核退出处理").next())
            .expect("spawn_kernel 段");
        assert!(seg.contains("backend.server_cmd(no_open)"), "WSL 命令串经 wsl-backend spec 构造");
        // 就绪行线程：WSL actual port 提取。
        assert!(seg.contains("url_port(&u)"), "就绪行 URL 提取 actual port（契约 §4.3）");
        assert!(seg.contains("kernel_process::port::is_safe_port(p)"), "受限端口表检查");
        assert!(seg.contains("if wsl_mode {\n                                g.port = Some(port);"), "actual port 写回 Inner.port");
        // local 分支的既有锚点仍在。
        assert!(seg.contains("SpawnSpec::new(&self.node_exe"), "local 分支 SpawnSpec 链不变");
        assert!(seg.contains("set_process_group_leader(&mut cmd)"), "local 分支 PGID 设置不变");
    }

    /// 形态（v0.5.4 Node 三级解析接线）：构造经 resolve_node_with +
    /// existing_vendor_node（非硬编码 vendor 路径）；缺失步 name=node-resolve
    /// 且先于 sidecar boot；spawn 仍经 self.node_exe（命中者注入，spawn_kernel
    /// local 分支零改动）。
    #[test]
    fn node_resolution_wiring_shape() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let ctor = src
            .split("fn new_with_probes")
            .nth(1)
            .and_then(|s| s.split("pub fn state(").next())
            .expect("new_with_probes 段");
        assert!(ctor.contains("kernel_process::node_resolve::resolve_node_with"), "构造必须经三级解析链");
        assert!(ctor.contains("kernel_process::node_resolve::existing_vendor_node"), "vendor 保底经在位判定");
        let wf = src
            .split("fn boot_waterfall")
            .nth(1)
            .and_then(|s| s.split("fn on_boot_success").next())
            .expect("boot_waterfall 段");
        let node_pos = wf.find("\"node-resolve\"").expect("缺失步 name=node-resolve");
        let wsl_pos = wf.find("wsl_configure_or_fallback(&this)").expect("WSL configure 步");
        let sidecar_pos = wf.find("run_sidecar_boot(&tx, gen)").expect("sidecar boot 步");
        assert!(node_pos < wsl_pos && node_pos < sidecar_pos, "node 预检必须先于 WSL configure 与 sidecar boot（sidecar 也依赖 Windows node）");
        assert!(wf[node_pos..].contains("enter_recovery"), "全缺须转恢复页");
    }

    /// koffi-preflight 通过判定契约（X2 指出的形态修正）：末行 JSON `ok==true`
    /// 语义——逐字 `{"ok":true}`（WSL 跳过形态）与 `{"ok":true,"skipped":
    /// "no-script"}`（脚本缺失形态）都过；`{"ok":false}`/非 JSON 不过。
    #[test]
    fn koffi_preflight_passed_json_contract() {
        assert!(koffi_preflight_passed("{\"ok\":true}\n"));
        assert!(koffi_preflight_passed("日志行\n{\"ok\":true,\"skipped\":\"no-script\"}\n"), "脚本缺失跳过形态必须判过（旧 ends_with 契约漏判）");
        assert!(!koffi_preflight_passed("{\"ok\":false}\n"));
        assert!(!koffi_preflight_passed("not json\n"));
        assert!(!koffi_preflight_passed(""));
    }

    /// C2b 形态锚点：假死重启同计——probe_loop 的两条受控重启路径（TCP 失联
    /// ×3 / 假死 ×20）必须经 on_kernel_exit(None) 走同一崩溃环判定（含 C2a
    /// 慢环计数），不得绕开计数直接杀进程拉起。
    #[test]
    fn zombie_restart_shares_crash_loop_counter_shape() {
        let src = include_str!("supervisor.rs").replace("\r\n", "\n");
        let seg = src
            .split("fn probe_loop")
            .nth(1)
            .and_then(|s| s.split("/// 原地重启").next())
            .expect("probe_loop 段");
        let calls = seg.matches("this.on_kernel_exit(None, &tx);").count();
        assert_eq!(calls, 2, "假死（zombie≥20）与端口失联（consecutive≥3）两条路径都必须经 on_kernel_exit（C2b 同计）: {calls}");
        // on_kernel_exit 内部经 record_crash（计数判据入口）。
        let exit_seg = src
            .split("fn on_kernel_exit")
            .nth(1)
            .and_then(|s| s.split("/// 探活循环").next())
            .expect("on_kernel_exit 段");
        assert!(exit_seg.contains("g.crash.record_crash(now)"), "退出判定必须经 CrashLoopDetector（快环窗口 + C2a 慢环计数同源）");
    }

    /// 就绪行 URL 端口提取形态。
    #[test]
    fn url_port_forms() {
        assert_eq!(url_port("http://127.0.0.1:51731"), Some(51731));
        assert_eq!(url_port("http://127.0.0.1:51731/token"), Some(51731));
        assert_eq!(url_port("https://host:80"), Some(80));
        assert_eq!(url_port("http://host"), None, "无端口 → None（按拉起失败收链）");
        assert_eq!(url_port("http://host:0"), Some(0), "0 可解析（受限表外，由 is_safe 放行——OS 已分配不可能为 0）");
    }

    /// WSL 注桩端到端（Windows + 仓库检出；本机 WSL VM 损坏——wsl.exe 全链
    /// 经 StubInvoker 桩替身，UNC 用本地目录模拟形态，与 cli.test.js 的
    /// DSH_TAURI_WSL_UNC_HOME 手法一致）：settings backend=wsl → configure →
    /// ensure_installed（npm 桩）→ sidecar boot（--home，真 node 五步）→
    /// spawn（桩 echo 就绪行）→ actual port 换页事件 → Ready → 收割。
    #[test]
    #[cfg(windows)]
    fn wsl_stub_boot_to_kernel_ready_e2e() {
        use std::sync::Mutex as StdMutex;
        let Some(root) = repo_root() else { eprintln!("[skip] 仓库检出不含 dsh-desktop"); return; };
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let home = sandbox("wsl-e2e");
        let unc_home = home.join("unc-home"); // 模拟 \\wsl.localhost\<distro>\... 形态的落点目录
        std::fs::create_dir_all(&unc_home).unwrap();
        // settings：backend=wsl（distro/installDir 留空——configure 走探测链）。
        std::env::set_var("DSH_TEST_HOME", &home);
        std::env::set_var("DSH_TAURI_USERDATA", home.join("ud"));
        let store = shell_core::SettingsStore::new(shell_core::DshPaths::resolve().settings);
        store.set("backend", serde_json::json!("wsl")).unwrap();
        // 覆盖缝：distro/home/UNC 全注入（supervisor 与 sidecar 两半边同键）。
        std::env::set_var("DSH_TAURI_WSL_DISTRO", "Ubuntu-22.04");
        std::env::set_var("DSH_TAURI_WSL_HOME", "/home/tester");
        std::env::set_var("DSH_TAURI_WSL_UNC_HOME", &unc_home);

        /// wsl.exe 桩：探测/安装全脚本化；spawn 用 cmd echo 就绪行 + ping 保活。
        struct WslStub {
            calls: StdMutex<Vec<String>>,
        }
        impl wsl_backend::WslInvoker for WslStub {
            fn run_with_lines(
                &self,
                _distro: &str,
                cmd: &str,
                _timeout: Duration,
                _on_line: &mut (dyn FnMut(&str) + Send),
            ) -> wsl_backend::WslRunResult {
                self.calls.lock().unwrap_or_else(|p| p.into_inner()).push(cmd.to_string());
                let (stdout, code) = if cmd.contains("printf %s \"$HOME\"") {
                    ("/home/tester\n".to_string(), 0)
                } else if cmd.contains("node --version") {
                    ("v20.11.0\n".to_string(), 0)
                } else if cmd.contains("npm --version") {
                    ("10.2.4\n".to_string(), 0)
                } else if cmd.contains("npm install") {
                    ("...npm 进度行...\nWSL_INSTALL_OK\n".to_string(), 0)
                } else if cmd.contains("mkdir -p") {
                    (String::new(), 0)
                } else if cmd.contains("test -f") {
                    (String::new(), 1) // agent 未就绪 → 走安装分支
                } else if cmd.starts_with("p=") {
                    ("ok\n".to_string(), 0) // stop_cmd（收割）
                } else {
                    (String::new(), 0)
                };
                wsl_backend::WslRunResult { ok: code == 0, code, timed_out: false, stdout, stderr: String::new() }
            }
            fn list_distros(&self) -> Vec<String> {
                vec!["Ubuntu-22.04".into()]
            }
            fn spawn_server(&self, _distro: &str, _cmd: &str) -> std::io::Result<Child> {
                // ping 寿命 300s：必须显著大于热探最坏耗时（50×2.1s≈105s，
                // 防火墙把回环拒绝慢速化时 connect_timeout 每次等满）+ 测试
                // 断言窗——此前 90s 在慢拒绝环境下被热探吃光，kill_kernel 时
                // stub 已自然退出，收割断言必败（环境态竞态，非产品回归）。
                let mut c = Command::new("cmd");
                c.args(["/d", "/c", "echo dsh web: http://127.0.0.1:39517 & ping -n 300 127.0.0.1 > nul"]);
                c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
                c.creation_flags_win(); // WinFlags trait 经 use super::* 可见
                c.spawn()
            }
        }

        let stub = Arc::new(WslStub { calls: StdMutex::new(Vec::new()) });
        let sv: Arc<Supervisor> = Arc::new(Supervisor::new_with_wsl_invoker(
            &root,
            stub.clone() as Arc<dyn wsl_backend::WslInvoker>,
        ));
        assert!(sv.wsl_cfg.is_some(), "settings backend=wsl 应解析为 WSL 意图");
        let (tx, rx) = std::sync::mpsc::channel();
        sv.spawn_boot(tx, None);
        let deadline = Instant::now() + Duration::from_secs(150);
        let mut saw_install = false;
        let mut boot_steps: Vec<String> = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            match rx.recv_timeout(left) {
                Ok(SupervisorEvent::BootStep { name, ok, .. }) => {
                    assert!(ok, "boot 步骤 {name} 不应失败");
                    if name == "wsl-install" { saw_install = true; }
                    if !name.starts_with("wsl-") { boot_steps.push(name); }
                }
                Ok(SupervisorEvent::KernelReady { url, port }) => {
                    assert!(url.starts_with("http://127.0.0.1:"), "就绪 URL 形态: {url}");
                    assert_eq!(port, 39517, "actual port 必须取就绪行解析值（spawn 传入 0）: {port}");
                    break;
                }
                Ok(SupervisorEvent::CrashLoop { .. }) => panic!("WSL 注桩链不应进恢复页"),
                Ok(other) => { let _ = other; }
                Err(_) => panic!("150s 内未就绪（boot_steps={boot_steps:?} saw_install={saw_install}）"),
            }
        }
        // 链路断言：五步全过 + 安装步在场 + 运行态就绪 + actual port 落 Inner。
        assert_eq!(boot_steps, vec!["repair", "sync", "presets", "patches", "preflight"], "sidecar 五步契约（经 --home UNC）");
        assert!(saw_install, "agent 未就绪应触发 wsl-install 步（BootStep 进度上报）");
        assert!(sv.wsl_active().is_some(), "configure 成功后 WSL 运行态生效");
        assert_eq!(sv.backend_effective(), "wsl");
        assert_eq!(sv.fallback_reason(), "", "无回落");
        assert_eq!(sv.inner.lock().unwrap_or_else(|p| p.into_inner()).port, Some(39517), "Inner.port = actual port");
        assert_eq!(sv.effective_home(), unc_home, "effective_home = UNC（模拟目录形态）");
        // 等状态落 Ready（on_boot_success 在 KernelReady 同线程近旁）。
        for _ in 0..50 {
            if sv.state() == RunState::Ready { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(sv.state(), RunState::Ready);
        // 收割：kill_kernel 应发 stop_cmd（pid 文件）+ 杀包装 child。
        sv.kill_kernel();
        let calls = stub.calls.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(
            calls.iter().any(|c| c.starts_with("p=") && c.contains("kill $(cat")),
            "kill_kernel 的 WSL 分支必须发 pid 文件收割命令: {calls:?}"
        );
        let terminate = ["--term", "inate"].concat();
        assert!(!calls.iter().any(|c| c.contains(&terminate)), "绝不调用发行版级终结命令");
        sv.shutdown();
        // 清环境。
        for k in ["DSH_TAURI_WSL_DISTRO", "DSH_TAURI_WSL_HOME", "DSH_TAURI_WSL_UNC_HOME", "DSH_TEST_HOME", "DSH_TAURI_USERDATA"] {
            std::env::remove_var(k);
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}

/// panic 载荷转字符串（&str / String / 其他兜底）。
pub(crate) fn panic_payload_str(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "未知 panic 载荷".to_string()
    }
}

#[cfg(test)]
impl Supervisor {
    /// 测试辅助：直接设置状态（绕过迁移表）。
    fn set_state_for_test(&self, s: RunState) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).state = s;
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
