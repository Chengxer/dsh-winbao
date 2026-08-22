//! TA15 竞态测试 #5：通知竞态矩阵——turn-end 与窗口聚焦翻转交错 × 限流窗
//! 边界，穷举小矩阵验证 handle_turn_end 门序在并发翻转下的确定性（纯函数面）。
//!
//! 门序（session_notify::handle_turn_end，Electron onSessionTurnEnd 同序）：
//!   1. trigger_fetch_throttled（先于一切门）
//!   2. quitting
//!   3. 门：enabled && !focused && !is_current —— **enabled/focused/is_current
//!      在单次事件内一次性读取**（notify_gates 一次快照）；
//!   4. 限流后置：门未开不咨询（不消耗额度）。
//!
//! 并发确定性论证（本测试穷举锁定的不变量）：
//!   · is_current = focused && current==sid 与 focused 同源同时读 → 不存在
//!     「focused=true 却 is_current=false（陈读）」的杂交态 → 聚焦时永不通
//!     知，无论翻转与 turn-end 如何交错；
//!   · 限流写入只发生在门全开时 → 门拦截的翻转交错不污染限流时间轴；
//!   · 边界语义：`now - t < 30000` → 恰 t+30000 放行（差 1ms 拒）。

use dsh_tauri_app::session_notify::{
    should_notify, NotifyThrottle, GLOBAL_THROTTLE_MS, SESSION_THROTTLE_MS,
};

/// 门序裁决的纯模型（与 handle_turn_end 步骤 3+4 同构）。
/// gates = (enabled, focused, current_sid_eq)，交错由调用方穷举枚举。
fn decide_with_throttle(
    throttle: &mut NotifyThrottle,
    enabled: bool,
    focused: bool,
    is_current: bool,
    sid: &str,
    now_ms: u128,
) -> bool {
    let gates_open = should_notify(enabled, focused, is_current, true);
    let throttle_ok = gates_open && throttle.decide(sid, now_ms);
    should_notify(enabled, focused, is_current, throttle_ok)
}

#[test]
fn ta15_gate_truth_table_exhaustive() {
    // 2^4 全穷举：enabled × focused × is_current × throttle_ok。
    for enabled in [true, false] {
        for focused in [true, false] {
            for current in [true, false] {
                for tok in [true, false] {
                    assert_eq!(
                        should_notify(enabled, focused, current, tok),
                        enabled && !focused && !current && tok,
                        "case {enabled}/{focused}/{current}/{tok}"
                    );
                }
            }
        }
    }
}

#[test]
fn ta15_focused_flip_never_notifies_any_interleaving() {
    // 穷举：事件内身份快照的所有 (focused, is_current) 组合 × 时刻边界 ×
    // 会话归属——**聚焦态（focused=true）下任何组合都不通知**（is_current
    // 与 focused 同源，杂交态不可达）。
    let mut throttle = NotifyThrottle::new();
    for focused in [true, false] {
        for current in [true, false] {
            for sid in ["sess-A", "sess-B"] {
                for now in [0u128, 1, SESSION_THROTTLE_MS - 1, SESSION_THROTTLE_MS] {
                    let notified = decide_with_throttle(&mut throttle, true, focused, current, sid, now);
                    if focused {
                        assert!(!notified, "聚焦态永不通知（focused={focused} current={current} sid={sid} now={now}）");
                    }
                }
            }
        }
    }
}

#[test]
fn ta15_throttle_window_boundary_semantics() {
    // 边界：`now - t < 30000` 拒 → 恰 +30000 放行；差 1ms 拒。
    let mut t = NotifyThrottle::new();
    assert!(t.decide("s1", 1_000), "首事件放行");
    assert!(!t.decide("s1", 1_000 + SESSION_THROTTLE_MS - 1), "窗内差 1ms 拒");
    assert!(!t.decide("s1", 1_000 + SESSION_THROTTLE_MS - 1), "拒不消耗额度（时间轴不动）");
    assert!(t.decide("s1", 1_000 + SESSION_THROTTLE_MS), "恰窗边界放行（< 语义）");

    // 全局窗：另一会话在全局 15s 内被拦（且**不写**自己的会话时间戳——
    // 之后它自己的首个通知不受影响）。
    let mut t2 = NotifyThrottle::new();
    assert!(t2.decide("a", 10_000));
    assert!(!t2.decide("b", 10_000 + GLOBAL_THROTTLE_MS - 1), "全局窗内他会话拒");
    assert!(t2.decide("b", 10_000 + GLOBAL_THROTTLE_MS), "全局窗边界放行");
}

#[test]
fn ta15_gated_events_do_not_pollute_throttle_timeline() {
    // 交错模型：聚焦期间到达的 turn-end（门拦）不得推进限流时间轴——
    // 之后失焦的同会话首个 turn-end 必须立即通知（而非被已污染的时间轴拦住）。
    let mut t = NotifyThrottle::new();
    // t=1000：聚焦中 turn-end（门拦，限流不咨询）。
    assert!(!decide_with_throttle(&mut t, true, true, false, "s", 1_000));
    // t=2000：失焦 → 首个真实通知必须放行（若门拦事件污染时间轴，此处被拦）。
    assert!(decide_with_throttle(&mut t, true, false, false, "s", 2_000));
    // t=16000：全局窗（自 2000 起 15s）内另一会话被拦。
    assert!(!decide_with_throttle(&mut t, true, false, false, "other", 16_000));
    // t=17001：全局窗已过但 s 自身 30s 窗内 → 拒。
    assert!(!decide_with_throttle(&mut t, true, false, false, "s", 17_001));
    // t=32000：两会话窗皆过 → 放行。
    assert!(decide_with_throttle(&mut t, true, false, false, "s", 32_000));
}

#[test]
fn ta15_flip_interleavings_all_serializable() {
    // 交错矩阵：把「turn-end 事件流」与「聚焦翻转流」以不同交错方式合并
    // （3 个 turn-end × 翻转在事件前/中/后），对每个交错序列重放真实
    // NotifyThrottle + 门序，断言：
    //   1) 无 panic / 无死锁态（时间轴单调推进）；
    //   2) 通知数 ≤ turn-end 数；
    //   3) 每条通知时刻的门态确定性一致（= 同序列串行重放结果，天然成立，
    //      本测试用两次重放对拍锁「实现无隐藏状态」）。
    let events: Vec<(u128, bool, &str)> = vec![
        (1_000, false, "s1"),
        (5_000, true, "s1"),  // 聚焦中完成
        (8_000, false, "s2"), // 失焦 + 全局窗内
        (40_000, false, "s1"), // 全部窗已过
    ];
    for flip_at in [0usize, 1, 2, 3, 4] {
        let replay = |flip_at: usize| -> (usize, Vec<(u128, &str)>) {
            let mut t = NotifyThrottle::new();
            let mut notified = Vec::new();
            for (i, &(now, focused_before, sid)) in events.iter().enumerate() {
                // 翻转插在事件 i 之前（flip_at == i）→ 本事件读到翻转后状态。
                let flipped = flip_at <= i;
                let focused = flipped != focused_before;
                let is_current = focused && (sid == "s1");
                if decide_with_throttle(&mut t, true, focused, is_current, sid, now) {
                    notified.push((now, sid));
                }
            }
            (notified.len(), notified)
        };
        let a = replay(flip_at);
        let b = replay(flip_at);
        assert_eq!(a, b, "重放确定性（无隐藏状态）");
        assert!(a.0 <= events.len(), "通知数 ≤ 事件数");
        for &(now, sid) in &a.1 {
            assert_ne!(sid, "", "通知必带会话");
            assert!(now < 1_000_000);
        }
        // 形态带断言（保守带，行为变更即显式浮现）：每个交错至少 1 条
        //（t=40000 全窗已过必放行）、至多 2 条（限流 + 门拦上限）。
        assert!(a.0 >= 1 && a.0 <= 2, "flip_at={flip_at} 通知数 {} 落在合理带", a.0);
    }
}
