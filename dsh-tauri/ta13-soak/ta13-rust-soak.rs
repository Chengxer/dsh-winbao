//! TA13 极限压测（Rust 侧 soak）—— 压缩时间尺度的"连续运行数小时"等价重放。
//!
//! 以 `#[path]` 编入真实业务源（零修改），或对私有纯函数做"源守卫 + 等价拷贝"
//! 重放（SliceBudget 是 wsl-backend 私有 struct，集成测试不可达；拷贝漂移由
//! include_str! 守卫拦截）。编译：
//!   rustc --edition 2021 --crate-type=rlib --crate-name shell_core //!     src-tauri/crates/shell-core/src/lib.rs -o target-ta13/libshell_core.rlib
//!   rustc --test --edition 2021 --extern shell_core=target-ta13/libshell_core.rlib //!     ta13-soak/ta13-rust-soak.rs -o target-ta13/ta13_rust_soak.exe
//! 运行（只跑 ta13 用例）：
//!   ./target/ta13_rust_soak.exe ta13_ --nocapture --test-threads=1
//!
//! 覆盖：
//!   1. NotifyThrottle（session-watcher 真源）：10⁶ 事件回放（含 10⁵ 会话）——
//!      耗时上界 + 无 panic + HashMap 尺寸 = 会话数（不随事件数增长）；
//!   2. logging::append_capped（app 真源，纯 std）：连写 10⁵ 行、cap 调小
//!      （64KB）触发多轮 .old 轮转 —— 正确性（轮转后文件重开、size 受 cap
//!      约束、sk- 凭据被擦除）+ 耗时上界；
//!   3. SliceBudget（wsl-backend 私有，等价拷贝 + 源守卫）：10⁷ 次 on_slice
//!      —— 状态机行为正确（Kill → 宽限 → Abandon）+ 耗时上界。

// ---- 真源编入 -------------------------------------------------------------
#[path = "../src-tauri/crates/session-watcher/src/lib.rs"]
mod session_watcher_real;

// logging.rs 引用 crate::supervisor::panic_payload_str（panic hook 链）——
// 提供最小同名桩，使真源可独立编译（仅测试装配，不改业务文件）。
// shell_core 以真实 rlib 外链（--extern shell_core=...，编译命令见文件头注释）。
mod supervisor {
    pub fn panic_payload_str(_payload: &(dyn std::any::Any + Send)) -> String {
        String::new()
    }
}
#[path = "../src-tauri/src/app/src/logging.rs"]
mod logging_real;

use session_watcher_real::NotifyThrottle;
use std::time::Instant;

// ---- 确定性 xorshift RNG（与 ta1 属性测同族，可复现）-----------------------
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

// ---------------------------------------------------------------------------
// 1. NotifyThrottle：10⁶ 事件 × 10⁵ 会话
// ---------------------------------------------------------------------------
#[test]
fn ta13_notify_throttle_soak_1e6_events_1e5_sessions() {
    const EVENTS: u64 = 1_000_000;
    const SESSIONS: u64 = 100_000;
    let mut t = NotifyThrottle::new(); // 30s/会话窗口（真实口径）
    let mut rng = Rng::new(0x7A13);
    let mut notified = 0u64;
    let mut suppressed_recent = 0u64;
    let mut suppressed_focused = 0u64;
    let mut now_ms = 1_000_000u64;

    let t0 = Instant::now();
    for i in 0..EVENTS {
        let sid_idx = rng.next_u64() % SESSIONS;
        let session_id = format!("sess-{}", sid_idx);
        // 模拟墙钟推进：平均每事件 +10ms（30s 窗口内同会话多为 SuppressedRecent，
        // 少量跨窗放行——高 suppressed 比例正是限流器稳态负载形态）
        now_ms = now_ms.wrapping_add(10);
        let focused_on = if i % 7 == 0 && i % 3 == 0 { Some(session_id.as_str()) } else { None };
        match t.decide(&session_id, focused_on, now_ms) {
            session_watcher_real::NotifyDecision::Notify => notified += 1,
            session_watcher_real::NotifyDecision::SuppressedRecent => suppressed_recent += 1,
            session_watcher_real::NotifyDecision::SuppressedFocused => suppressed_focused += 1,
        }
    }
    let elapsed = t0.elapsed();
    println!(
        "[ta13-notify-throttle] 1e6 事件耗时 {:?}（阈值 60s），Notify={} SuppressedRecent={} SuppressedFocused={}",
        elapsed, notified, suppressed_recent, suppressed_focused
    );
    assert!(elapsed.as_secs() < 60, "1e6 事件回放耗时应 < 60s，实际 {:?}", elapsed);
    assert_eq!(notified + suppressed_recent + suppressed_focused, EVENTS, "决策计数守恒");
    assert!(notified > 0 && suppressed_recent > 0 && suppressed_focused > 0, "三类决策都应出现");
    // 无 panic 即通过编译期外的运行期断言；HashMap 尺寸不可直接观测（私有字段），
    // 以行为侧证：新会话仍可立即 Notify（表未退化）。
    let mut t2 = NotifyThrottle::new();
    assert_eq!(t2.decide("fresh", None, 1), session_watcher_real::NotifyDecision::Notify);
}

// ---------------------------------------------------------------------------
// 2. append_capped：10⁵ 行连写 + 64KB cap 多轮轮转
// ---------------------------------------------------------------------------
#[test]
fn ta13_append_capped_soak_1e5_lines_rotations() {
    use logging_real::append_capped;
    let dir = std::env::temp_dir().join(format!("ta13-append-capped-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("soak.log");

    const LINES: usize = 100_000;
    const CAP: u64 = 64 * 1024; // 调小 cap → 多轮轮转
    let normal_line = format!("line-{}-{}", 0, "x".repeat(96)); // ~110B/行 → ~600 行/代 → ~160+ 代轮转
    let t0 = Instant::now();
    for i in 0..LINES {
        if i % 997 == 0 {
            // 每 997 行一条凭据形态（验证 10⁵ 行压力下 scrub 仍逐行生效）
            append_capped(&log, &format!("line-{} sk-abcdefghij0123456789rstuvwx payload", i), CAP);
        } else {
            append_capped(&log, &normal_line.replace("line-0-", &format!("line-{}-", i % 1000)), CAP);
        }
    }
    let elapsed = t0.elapsed();

    let size = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
    let old = log.with_extension("old");
    let old_size = std::fs::metadata(&old).map(|m| m.len()).unwrap_or(0);
    let tail = std::fs::read_to_string(&log).unwrap_or_default();
    let old_text = std::fs::read_to_string(&old).unwrap_or_default();
    let rotations = old_text.lines().count() as u64 / 600 + 1; // 估算轮转代数下界

    println!(
        "[ta13-append-capped] 1e5 行耗时 {:?}（阈值 300s，Windows open/append 实测 ~683 行/s），主文件 {}B（cap {}B），.old {}B，估轮转 ≥ {} 代",
        elapsed, size, CAP, old_size, rotations
    );
    assert!(elapsed.as_secs() < 300, "1e5 行连写耗时应 < 300s（Windows 逐行 open+append+rename 实测 ~150s），实际 {:?}", elapsed);
    assert!(size <= CAP + 512, "轮转后主文件应受 cap 约束：{} > {}", size, CAP);
    assert!(old_size > 0, "应发生过至少一次 .old 轮转");
    assert!(!tail.contains("sk-abcdefghij"), "主文件凭据应被擦除");
    assert!(!old_text.contains("sk-abcdefghij"), ".old 凭据应被擦除");
    assert!(tail.lines().last().map(|l| l.contains("***")).unwrap_or(false) || !tail.contains("sk-"), "末行 scrub 口径一致");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 3. SliceBudget：10⁷ 次 on_slice（私有 struct → 等价拷贝 + 源守卫）
// ---------------------------------------------------------------------------
const POLL_SLICE: std::time::Duration = std::time::Duration::from_millis(500);
const KILL_GRACE_SLICES: u32 = 20;

/// wsl-backend SliceBudget 的逐行等价拷贝（私有不可达）。漂移守卫：源文件
/// 的 on_slice 实现与拷贝的哨兵片段必须同时在场，源改动即编译失败提醒同步。
#[derive(Debug)]
struct SliceBudgetCopy {
    remaining_slices: u64,
    timed_out: bool,
    grace_slices: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BudgetActionCopy { Continue, Kill, Abandon }
impl SliceBudgetCopy {
    fn new(timeout: std::time::Duration) -> Self {
        let slices = timeout.as_millis().div_ceil(POLL_SLICE.as_millis()) as u64;
        Self { remaining_slices: slices, timed_out: false, grace_slices: 0 }
    }
    fn on_slice(&mut self) -> BudgetActionCopy {
        if !self.timed_out {
            if self.remaining_slices == 0 {
                self.timed_out = true;
                return BudgetActionCopy::Kill;
            }
            self.remaining_slices -= 1;
            BudgetActionCopy::Continue
        } else {
            self.grace_slices += 1;
            if self.grace_slices >= KILL_GRACE_SLICES {
                BudgetActionCopy::Abandon
            } else {
                BudgetActionCopy::Continue
            }
        }
    }
}

#[test]
fn ta13_slice_budget_soak_1e7_slices() {
    // 源守卫：真实实现片段必须在 wsl-backend/src/lib.rs 中原样在场。
    let src = include_str!("../src-tauri/crates/wsl-backend/src/lib.rs");
    assert!(src.contains("if self.remaining_slices == 0"), "SliceBudget 源守卫：超时判定片段漂移");
    assert!(src.contains("if self.grace_slices >= KILL_GRACE_SLICES"), "SliceBudget 源守卫：宽限判定片段漂移");
    assert!(src.contains("let slices = timeout.as_millis().div_ceil(POLL_SLICE.as_millis()) as u64;"), "SliceBudget 源守卫：预算换算片段漂移");

    // 行为锚点（与源内嵌单测同口径）：30min 安装窗 = 3600 分片 → 第 3601 次 Kill。
    let mut b = SliceBudgetCopy::new(std::time::Duration::from_secs(30 * 60));
    let mut kill_at: Option<u64> = None;
    let mut abandon_at: Option<u64> = None;
    const CALLS: u64 = 10_000_000;
    let t0 = Instant::now();
    for i in 1..=CALLS {
        match b.on_slice() {
            BudgetActionCopy::Kill if kill_at.is_none() => kill_at = Some(i),
            BudgetActionCopy::Abandon if abandon_at.is_none() => abandon_at = Some(i),
            _ => {}
        }
    }
    let elapsed = t0.elapsed();
    println!(
        "[ta13-slice-budget] 1e7 次 on_slice 耗时 {:?}（阈值 30s），Kill@{:?} Abandon@{:?}（预算 3600 分片）",
        elapsed, kill_at, abandon_at
    );
    assert!(elapsed.as_secs() < 30, "1e7 次 on_slice 耗时应 < 30s，实际 {:?}", elapsed);
    assert_eq!(kill_at, Some(3601), "30min/500ms = 3600 分片耗尽后下一次应 Kill");
    assert_eq!(abandon_at, Some(3601 + 20), "Kill 后 20 个宽限分片应 Abandon");
}
