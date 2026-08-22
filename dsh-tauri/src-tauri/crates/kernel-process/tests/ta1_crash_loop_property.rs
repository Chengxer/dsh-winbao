//! TA1 属性测试：kernel-process `CrashLoopDetector` 随机崩溃间隔序列 ×
//! 独立 oracle（60s 窗内第 6 次崩溃 Tripped；慢环同世代第 6 次崩溃
//! （前 5 次均为 Ok 自动重启）Tripped；冷却期 Cooldown；冷却后复位）。

use kernel_process::crash_loop::{CrashLoopDetector, Verdict};
use std::time::Duration;

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
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n.max(1)
    }
}

/// 快环：间隔 < 窗/6，oracle = 简单计数（第 max+1 次连续窗内崩溃 Tripped，
/// 之后冷却期 Cooldown——间隔小必在冷却内）。
#[test]
fn ta1_fast_loop_counts_window() {
    let window = Duration::from_secs(60);
    let cooldown = Duration::from_secs(300);
    for seed in 0..50u64 {
        let mut rng = Rng::new(seed * 7919 + 3);
        let gap_max = 5_000u64; // 6 连崩必入 60s 窗
        let mut d = CrashLoopDetector::with_params(window, 5, cooldown);
        let mut now = 0u64;
        let mut crashes_in_run = 0usize;
        for crash_idx in 0..30 {
            now += rng.below(gap_max) + 1;
            let v = d.record_crash(now);
            let expect = if crashes_in_run < 5 {
                crashes_in_run += 1;
                Verdict::Ok
            } else if crashes_in_run == 5 {
                crashes_in_run += 1;
                Verdict::Tripped
            } else {
                Verdict::Cooldown // 后续崩溃都在 300s 冷却内
            };
            let _ = crash_idx;
            assert_eq!(v, expect, "seed {seed} crash #{crash_idx} @{now}ms");
        }
    }
}

/// 慢环：间隔 > 窗口（窗口判据永不触发），第 6 次崩溃由累计自动重启数熔断。
#[test]
fn ta1_slow_loop_auto_restart_cap_trips_on_sixth() {
    for seed in 0..30u64 {
        let mut rng = Rng::new(seed * 104729 + 11);
        let mut d = CrashLoopDetector::with_params(
            Duration::from_secs(60),
            5,
            Duration::from_secs(300),
        );
        let mut now = 0u64;
        // 间隔 61-90s（> 60s 窗、< 300s 冷却）。
        for i in 0..8 {
            now += 61_000 + rng.below(29_000);
            let v = d.record_crash(now);
            let expect = match i {
                0..=4 => Verdict::Ok,   // 5 次 Ok 自动重启
                5 => Verdict::Tripped,  // 第 6 次：auto_restarts 已达上限
                _ => Verdict::Cooldown, // 冷却内维持
            };
            assert_eq!(v, expect, "slow seed {seed} crash #{i} @{now}ms");
        }
        // 冷却结束（> 300s）后的崩溃：复位重观察 → Ok。
        now += 301_000;
        assert_eq!(d.record_crash(now), Verdict::Ok, "冷却后复位");
        // 冷却复位分支：崩溃进 stamps 但不递增 auto_restarts（计数从下一次起）。
        assert_eq!(d.auto_restarts(), 0, "复位后计数归零（本次不计）");
    }
}

/// 混合随机序列：oracle 全语义对译（独立实现，含冷却复位分支）。
#[test]
fn ta1_mixed_random_stream_matches_oracle() {
    struct Oracle {
        window_ms: u64,
        max: usize,
        cooldown_ms: u64,
        stamps: Vec<u64>,
        tripped_at: Option<u64>,
        auto_restarts: usize,
    }
    impl Oracle {
        fn record(&mut self, now_ms: u64) -> Verdict {
            if let Some(t) = self.tripped_at {
                if now_ms.saturating_sub(t) < self.cooldown_ms {
                    return Verdict::Cooldown;
                }
                self.tripped_at = None;
                self.stamps.clear();
                self.auto_restarts = 0;
                self.stamps.push(now_ms);
                return Verdict::Ok;
            }
            let w = self.window_ms;
            self.stamps.retain(|&s| now_ms.saturating_sub(s) <= w);
            self.stamps.push(now_ms);
            if self.stamps.len() > self.max || self.auto_restarts >= 5 {
                self.tripped_at = Some(now_ms);
                Verdict::Tripped
            } else {
                self.auto_restarts += 1;
                Verdict::Ok
            }
        }
    }
    let mut rng = Rng::new(0xC4A5);
    for round in 0..200 {
        let mut d = CrashLoopDetector::with_params(Duration::from_secs(60), 5, Duration::from_secs(300));
        let mut o = Oracle { window_ms: 60_000, max: 5, cooldown_ms: 300_000, stamps: vec![], tripped_at: None, auto_restarts: 0 };
        let mut now = 0u64;
        let events = 20 + rng.below(60);
        for e in 0..events {
            now += rng.below(120_000); // 0-120s：跨快/慢/冷却全分支
            let got = d.record_crash(now);
            let want = o.record(now);
            assert_eq!(got, want, "round {round} event {e} @{now}ms");
        }
    }
}

/// 优雅重启 / 恢复页复位语义不变量。
#[test]
fn ta1_graceful_and_recovery_reset_invariants() {
    let mut rng = Rng::new(0x0FF);
    for _ in 0..500 {
        let mut d = CrashLoopDetector::new();
        let mut now = 0u64;
        // 随机积累 1-4 次 Ok 崩溃。
        for _ in 0..(1 + rng.below(4)) {
            now += rng.below(10_000);
            assert_eq!(d.record_crash(now), Verdict::Ok);
        }
        let before = d.auto_restarts();
        d.record_graceful_restart();
        assert_eq!(d.auto_restarts(), 0, "手动重启复位慢环计数（新世代）");
        assert!(before > 0);
        // 复位后再 5 次 Ok + 第 6 次 Tripped（慢环从头计）。
        let mut t2 = now;
        for i in 0..5 {
            t2 += 61_000;
            assert_eq!(d.record_crash(t2), Verdict::Ok, "复位后慢环 #{i}");
        }
        t2 += 61_000;
        assert_eq!(d.record_crash(t2), Verdict::Tripped);
        d.record_recovery();
        assert_eq!(d.record_crash(t2 + 1), Verdict::Ok, "恢复页手动复位后重观察");
    }
}
