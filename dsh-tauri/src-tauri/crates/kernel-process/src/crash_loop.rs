//! 崩溃环判定。
//!
//! 对齐 Electron 版 watchServerProc 的崩溃环状态机语义：滑动时间窗内的崩溃次数
//! 超过阈值 → 判定崩溃环 → 切恢复页（`E_KERNEL_CRASH_LOOP`）。判定后进入冷却，
//! 冷却期内的崩溃不改变结论；冷却结束可复位重试。

use std::time::Duration;

/// 崩溃环检测器。
pub struct CrashLoopDetector {
    window: Duration,
    max_crashes: usize,
    cooldown: Duration,
    /// 窗口内崩溃时刻（相对启动的单调毫秒，测试可注入）。
    stamps: Vec<u64>,
    tripped_at: Option<u64>,
}

/// 判定结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 正常（未超阈值）。
    Ok,
    /// 崩溃环触发。
    Tripped,
    /// 冷却期内，维持 Tripped。
    Cooldown,
}

impl CrashLoopDetector {
    /// Electron 版口径：60s 窗口 / 5 次崩溃即环；冷却 5 分钟。
    pub fn new() -> Self {
        Self::with_params(Duration::from_secs(60), 5, Duration::from_secs(300))
    }

    pub fn with_params(window: Duration, max_crashes: usize, cooldown: Duration) -> Self {
        Self {
            window,
            max_crashes,
            cooldown,
            stamps: Vec::new(),
            tripped_at: None,
        }
    }

    /// 上报一次崩溃（now_ms 为单调毫秒）。
    pub fn record_crash(&mut self, now_ms: u64) -> Verdict {
        if let Some(t) = self.tripped_at {
            return if now_ms.saturating_sub(t) < self.cooldown.as_millis() as u64 {
                Verdict::Cooldown
            } else {
                // 冷却结束：复位并继续观察。
                self.tripped_at = None;
                self.stamps.clear();
                self.stamps.push(now_ms);
                Verdict::Ok
            };
        }
        self.stamps.retain(|&s| now_ms.saturating_sub(s) <= self.window.as_millis() as u64);
        self.stamps.push(now_ms);
        if self.stamps.len() > self.max_crashes {
            self.tripped_at = Some(now_ms);
            Verdict::Tripped
        } else {
            Verdict::Ok
        }
    }

    /// 优雅重启是否应豁免崩溃计数（restartService 主动重启不算崩溃）。
    pub fn record_graceful_restart(&mut self) {
        // 主动重启不复位历史崩溃，但也不累加——空实现表达「无操作」，
        // 真正的复位发生在冷却结束或 record_recovery()。
    }

    /// 恢复页用户确认后手动复位。
    pub fn record_recovery(&mut self) {
        self.tripped_at = None;
        self.stamps.clear();
    }
}

impl Default for CrashLoopDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_in_window_trips() {
        let mut d = CrashLoopDetector::new();
        for i in 0..5 {
            assert_eq!(d.record_crash(i * 1000), Verdict::Ok, "第 {} 次不应触发", i + 1);
        }
        assert_eq!(d.record_crash(5 * 1000), Verdict::Tripped);
    }

    #[test]
    fn slow_crashes_never_trip() {
        let mut d = CrashLoopDetector::new();
        for i in 0..20 {
            assert_eq!(d.record_crash(i * 20_000), Verdict::Ok, "间隔 20s 的崩溃不应成环");
        }
    }

    #[test]
    fn cooldown_then_reset() {
        let mut d = CrashLoopDetector::new();
        for i in 0..6 {
            d.record_crash(i * 1000);
        }
        assert!(matches!(d.record_crash(30_000), Verdict::Cooldown | Verdict::Tripped));
        assert_eq!(d.record_crash(10 * 60_000), Verdict::Ok, "冷却（5 分钟）结束后复位");
    }

    #[test]
    fn manual_recovery_resets() {
        let mut d = CrashLoopDetector::new();
        for i in 0..6 {
            d.record_crash(i * 1000);
        }
        d.record_recovery();
        assert_eq!(d.record_crash(60_000), Verdict::Ok);
    }
}
