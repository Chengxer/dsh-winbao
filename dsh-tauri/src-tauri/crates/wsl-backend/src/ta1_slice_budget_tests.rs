//! TA1 属性测试（经 lib.rs cfg(test)] 门接入，访问私有 SliceBudget 状态机）：
//! 随机超时值 × 确定性边界 + 随机 on_slice 序列不变量（阶段单调：
//! Continue* → Kill（恰一次）→ Continue* → Abandon（吸收态）；预算单调不增）。

use crate::{BudgetAction, SliceBudget, POLL_SLICE};

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

#[test]
fn ta1_slice_budget_exact_phase_boundaries_random_timeouts() {
    let slice_ms = POLL_SLICE.as_millis() as u64; // 50
    let mut rng = Rng::new(0xBED6E7);
    for _ in 0..2_000 {
        let timeout_ms = rng.below(20_000);
        let slices = timeout_ms.div_ceil(slice_ms);
        let mut b = SliceBudget::new(std::time::Duration::from_millis(timeout_ms));
        // 阶段 1：恰 slices 次 Continue（预算单调耗尽）。
        for k in 0..slices {
            assert_eq!(b.on_slice(), BudgetAction::Continue, "timeout {timeout_ms}ms 第 {k} 轮应 Continue");
        }
        // 阶段 2：预算归零 → Kill（恰一次出现在这里）。
        assert_eq!(b.on_slice(), BudgetAction::Kill, "timeout {timeout_ms}ms 预算耗尽必 Kill");
        // 阶段 3：收尸宽限 99 次 Continue。
        for g in 0..99 {
            assert_eq!(b.on_slice(), BudgetAction::Continue, "宽限 {g}");
        }
        // 阶段 4：第 100 次宽限 → Abandon，且为吸收态。
        assert_eq!(b.on_slice(), BudgetAction::Abandon, "宽限耗尽必 Abandon");
        for _ in 0..10 {
            assert_eq!(b.on_slice(), BudgetAction::Abandon, "Abandon 吸收态");
        }
    }
}

#[test]
fn ta1_slice_budget_random_sequence_invariants() {
    let mut rng = Rng::new(0x51CE);
    for round in 0..1_000 {
        let timeout_ms = rng.below(5_000);
        let mut b = SliceBudget::new(std::time::Duration::from_millis(timeout_ms));
        let slices = timeout_ms.div_ceil(POLL_SLICE.as_millis() as u64);
        let mut continues_before_kill = 0u64;
        let mut kills = 0u64;
        let mut abandons = 0u64;
        let mut continues_after_kill = 0u64;
        let steps = slices + 150 + rng.below(50); // 必然推进到 Abandon 之后
        for _ in 0..steps {
            match b.on_slice() {
                BudgetAction::Continue => {
                    if kills == 0 {
                        continues_before_kill += 1;
                    } else if abandons == 0 {
                        continues_after_kill += 1;
                    } else {
                        panic!("Abandon 后不得再 Continue");
                    }
                }
                BudgetAction::Kill => {
                    assert_eq!(kills, 0, "Kill 恰一次");
                    assert_eq!(abandons, 0, "Kill 必先于 Abandon");
                    kills += 1;
                }
                BudgetAction::Abandon => {
                    assert_eq!(kills, 1, "Abandon 必在 Kill 后");
                    abandons += 1;
                }
            }
        }
        let _ = round;
        assert_eq!(kills, 1, "序列必达 Kill");
        assert!(abandons >= 1, "steps 足够长必达 Abandon");
        assert_eq!(continues_before_kill, slices, "Kill 前恰 {slices} 次 Continue（预算单调不增）");
        assert_eq!(continues_after_kill, 99, "Kill 后恰 99 次宽限 Continue");
    }
}
