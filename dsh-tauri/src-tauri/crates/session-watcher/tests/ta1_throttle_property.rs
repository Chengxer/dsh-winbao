//! TA1 属性测试：session-watcher `NotifyThrottle::decide` 随机事件流回放
//! vs 独立 oracle（聚焦豁免不落笔 / 30s 会话窗 / 窗外放行即落笔）。

use session_watcher::{NotifyDecision, NotifyThrottle};

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

struct Oracle {
    interval: u64,
    last: std::collections::HashMap<String, u64>,
}
impl Oracle {
    fn decide(&mut self, sid: &str, focused_on: Option<&str>, now_ms: u64) -> NotifyDecision {
        if focused_on == Some(sid) {
            return NotifyDecision::SuppressedFocused;
        }
        match self.last.get(sid) {
            Some(&t) if now_ms.saturating_sub(t) < self.interval => NotifyDecision::SuppressedRecent,
            _ => {
                self.last.insert(sid.to_string(), now_ms);
                NotifyDecision::Notify
            }
        }
    }
}

#[test]
fn ta1_decide_random_stream_matches_oracle() {
    let mut rng = Rng::new(0x5E55);
    let sessions: Vec<String> = (0..4).map(|i| format!("sess-{i}")).collect();
    for round in 0..300 {
        // 每轮随机节流窗（含极小/极大边界）。
        let interval_ms = match rng.below(4) {
            0 => 1,
            1 => 30_000,
            2 => rng.below(10_000),
            _ => rng.below(200_000),
        };
        let mut t = NotifyThrottle::with_min_interval(std::time::Duration::from_millis(interval_ms));
        let mut oracle = Oracle { interval: interval_ms, last: Default::default() };
        let mut now: u64 = round as u64 * 613;
        let events = 50 + rng.below(200);
        for _ in 0..events {
            now += match rng.below(8) {
                0 => 0,
                1..=4 => rng.below((interval_ms / 4).max(2)),
                5..=6 => interval_ms + rng.below(50),
                _ => rng.below(400_000),
            };
            let sid = sessions[rng.below(sessions.len() as u64) as usize].clone();
            // focused_on：多数 None，偶尔某会话（含当前会话 = 聚焦豁免）。
            let focused = match rng.below(4) {
                0 => Some(sessions[rng.below(sessions.len() as u64) as usize].clone()),
                _ => None,
            };
            let got = t.decide(&sid, focused.as_deref(), now);
            let want = oracle.decide(&sid, focused.as_deref(), now);
            assert_eq!(got, want, "round {round} interval {interval_ms} @{now} sid {sid} focused {focused:?}");
        }
    }
}

#[test]
fn ta1_focused_exemption_does_not_consume_quota() {
    let mut t = NotifyThrottle::new(); // 30s
    // 聚焦豁免两次（不落笔）→ 失焦后 1ms 仍放行（未被豁免消耗额度）。
    assert_eq!(t.decide("s1", Some("s1"), 0), NotifyDecision::SuppressedFocused);
    assert_eq!(t.decide("s1", Some("s1"), 1_000), NotifyDecision::SuppressedFocused);
    assert_eq!(t.decide("s1", None, 1_001), NotifyDecision::Notify);
    // 放行后 30s 内重复压制；窗外放行。
    assert_eq!(t.decide("s1", None, 20_000), NotifyDecision::SuppressedRecent);
    assert_eq!(t.decide("s1", None, 31_002), NotifyDecision::Notify);
}

#[test]
fn ta1_default_interval_and_multiple_sessions_independent() {
    let mut t = NotifyThrottle::default();
    assert_eq!(t.decide("a", None, 0), NotifyDecision::Notify);
    assert_eq!(t.decide("b", None, 1), NotifyDecision::Notify, "会话互不影响");
    assert_eq!(t.decide("a", None, 29_999), NotifyDecision::SuppressedRecent);
    assert_eq!(t.decide("a", None, 30_000), NotifyDecision::Notify, "边界：≥30s 放行");
}
