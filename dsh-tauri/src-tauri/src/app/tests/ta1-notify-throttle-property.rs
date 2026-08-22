//! TA1 属性 + 并发：`dsh_tauri_app::session_notify::{NotifyThrottle, should_notify}`
//! （pub mod，集成测试可达）。
//!
//! - decide：随机事件流回放 vs 独立 oracle（30s/会话 + 15s 全局，全局窗拦截
//!   不消耗会话额度）；
//! - should_notify：真值表 oracle；
//! - 多线程 Mutex 共享 decide：无死锁、无 panic、放行数 ≤ 事件数。

use dsh_tauri_app::session_notify::{should_notify, NotifyThrottle};

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

/// 独立 oracle：Electron main.js:2647-2652 语义（模块文档口径）。
#[derive(Default)]
struct Oracle {
    session_last: std::collections::HashMap<String, u128>,
    global_last: Option<u128>,
}
impl Oracle {
    fn decide(&mut self, sid: &str, now_ms: u128) -> bool {
        const S: u128 = 30_000;
        const G: u128 = 15_000;
        if let Some(&t) = self.session_last.get(sid) {
            if now_ms.saturating_sub(t) < S {
                return false;
            }
        }
        if let Some(g) = self.global_last {
            if now_ms.saturating_sub(g) < G {
                return false; // 不写 session_last
            }
        }
        self.session_last.insert(sid.to_string(), now_ms);
        self.global_last = Some(now_ms);
        true
    }
}

#[test]
fn ta1_decide_random_stream_matches_oracle() {
    let mut rng = Rng::new(0x30007);
    let sessions: Vec<String> = (0..5).map(|i| format!("s{i}")).collect();
    for round in 0..200 {
        let mut t = NotifyThrottle::new();
        let mut oracle = Oracle::default();
        let mut now: u128 = round as u128 * 997;
        let events = 50 + rng.below(150);
        for _ in 0..events {
            // 时间推进：偶尔回跳（saturating 语义不 panic）、常步进。
            now += match rng.below(10) {
                0 => 0,
                1..=5 => rng.below(8_000) as u128,   // 高频（撞两窗）
                6..=8 => rng.below(40_000) as u128,  // 过会话窗
                _ => rng.below(120_000) as u128,     // 过全局窗
            };
            let sid = &sessions[rng.below(sessions.len() as u64) as usize];
            let got = t.decide(sid, now);
            let want = oracle.decide(sid, now);
            assert_eq!(got, want, "round {round} @{now} sid {sid}");
        }
    }
}

#[test]
fn ta1_decide_global_window_does_not_consume_session_quota() {
    // 契约特写：全局窗拦截时不写会话时间戳——s1 于 t=0 放行；s2 于 t=5_000
    // 被全局窗拦（不消耗额度）；s1 于 t=16_000（>15s 全局、<30s 会话）
    // 仍被会话窗拦；s2 于 t=31_000... 会话未写过 → 只看全局（31_000-5_000
    // 被? s2 未落笔）→ 放行。
    let mut t = NotifyThrottle::new();
    assert!(t.decide("s1", 0));
    assert!(!t.decide("s2", 5_000), "全局 15s 窗拦截");
    assert!(!t.decide("s1", 16_000), "s1 会话 30s 窗拦截");
    assert!(t.decide("s2", 31_000), "s2 额度未被全局窗消耗 → 放行");
}

#[test]
fn ta1_should_notify_truth_table_oracle() {
    for enabled in [false, true] {
        for focused in [false, true] {
            for current in [false, true] {
                for throttle in [false, true] {
                    let got = should_notify(enabled, focused, current, throttle);
                    let want = enabled && !focused && !current && throttle;
                    assert_eq!(got, want, "({enabled},{focused},{current},{throttle})");
                }
            }
        }
    }
}

#[test]
fn ta1_decide_multithreaded_shared_mutex_no_deadlock() {
    use std::sync::{Arc, Mutex};
    let throttle = Arc::new(Mutex::new(NotifyThrottle::new()));
    let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let total = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();
    for tid in 0..4 {
        let t = Arc::clone(&throttle);
        let n = Arc::clone(&notified);
        let tot = Arc::clone(&total);
        handles.push(std::thread::spawn(move || {
            for i in 0..2_000u128 {
                let sid = format!("t{}-s{}", tid, i % 3);
                // 单调时间轴（线程本地）：撞窗高频并发。
                let now = tid as u128 * 1_000_000 + i * 100;
                let ok = t.lock().unwrap_or_else(|p| p.into_inner()).decide(&sid, now);
                tot.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if ok {
                    n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }));
    }
    for h in handles {
        h.join().expect("无 panic/死锁（join 完成）");
    }
    let total_events = total.load(std::sync::atomic::Ordering::Relaxed);
    let allow = notified.load(std::sync::atomic::Ordering::Relaxed);
    assert!(allow <= total_events, "放行数 {allow} ≤ 事件数 {total_events}");
    assert!(allow > 0, "时间轴推进跨窗，必有放行");
}
