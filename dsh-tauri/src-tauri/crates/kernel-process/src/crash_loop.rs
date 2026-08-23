//! 崩溃环判定。
//!
//! 对齐 Electron 版 watchServerProc 的崩溃环状态机语义：滑动时间窗内的崩溃次数
//! 超过阈值 → 判定崩溃环 → 切恢复页（由 supervisor 转 `SupervisorEvent::CrashLoop` 事件路由，非错误码）。判定后进入冷却，
//! 冷却期内的崩溃不改变结论；冷却结束可复位重试。
//!
//! C2 慢环熔断（2026-08 崩溃环强化）：窗口判据只防「快环」（60s 内 5 次连崩）；
//! 每次崩溃间隔 > 窗口的「慢环」（如内核每 2 分钟死一次）永不触发窗口，会
//! 无限自动重启下去。补计数判据：**同一 boot 世代内 `Verdict::Ok` 的自动重启
//! 累计数 ≥ [`MAX_AUTO_RESTARTS`] 同样 Tripped**（窗口防快环、计数防慢环，
//! 互补）。复位点（= 新 boot 世代）：`record_recovery`（恢复页重试）与
//! `record_graceful_restart`（restart_service 手动重启）；**稳定落定不复位**
//! ——每 2 分钟死一次的内核每次都活过 45s 稳定窗，复位会让慢环永久逃逸。

use std::time::Duration;

/// 慢环熔断阈值：同一 boot 世代内 Verdict::Ok 自动重启累计 5 次即进恢复页。
pub const MAX_AUTO_RESTARTS: usize = 5;

/// 崩溃环检测器。
pub struct CrashLoopDetector {
    window: Duration,
    max_crashes: usize,
    cooldown: Duration,
    /// 窗口内崩溃时刻（相对启动的单调毫秒，测试可注入）。
    stamps: Vec<u64>,
    tripped_at: Option<u64>,
    /// C2a 慢环计数：Verdict::Ok 的自动重启累计（含假死/探活失联受控重启——
    /// 它们与真崩溃同走 record_crash，天然同计）。
    auto_restarts: usize,
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
            auto_restarts: 0,
        }
    }

    /// 上报一次崩溃（now_ms 为单调毫秒）。
    ///
    /// 调用方覆盖两条路径，同计同一计数（C2b）：内核进程退出（stdout EOF /
    /// try_wait）与假死/探活失联的受控重启（`on_kernel_exit(None)`）。
    pub fn record_crash(&mut self, now_ms: u64) -> Verdict {
        if let Some(t) = self.tripped_at {
            return if now_ms.saturating_sub(t) < self.cooldown.as_millis() as u64 {
                Verdict::Cooldown
            } else {
                // 冷却结束：复位并继续观察。
                self.tripped_at = None;
                self.stamps.clear();
                self.auto_restarts = 0;
                self.stamps.push(now_ms);
                Verdict::Ok
            };
        }
        self.stamps.retain(|&s| now_ms.saturating_sub(s) <= self.window.as_millis() as u64);
        self.stamps.push(now_ms);
        if self.stamps.len() > self.max_crashes {
            self.tripped_at = Some(now_ms);
            Verdict::Tripped
        } else if self.auto_restarts >= MAX_AUTO_RESTARTS {
            // C2a 慢环熔断：此前已有 MAX_AUTO_RESTARTS 次 Ok 自动重启，本次是
            // 第 +1 次崩溃 → 熔断。与窗口阈值同口径（第 max+1 次触发），
            // 快环（窗口判据）行为零变化。
            self.tripped_at = Some(now_ms);
            Verdict::Tripped
        } else {
            self.auto_restarts += 1;
            Verdict::Ok
        }
    }

    /// 优雅重启是否应豁免崩溃计数（restartService 主动重启不算崩溃）。
    /// C2a 语义补充：手动重启 = 新 boot 世代，慢环计数随之复位（历史 stamps
    /// 保留——快环判定语义不变）；无消费者差异，复位即新世代观察起点。
    pub fn record_graceful_restart(&mut self) {
        self.auto_restarts = 0;
    }

    /// 恢复页用户确认后手动复位。
    pub fn record_recovery(&mut self) {
        self.tripped_at = None;
        self.stamps.clear();
        self.auto_restarts = 0;
    }

    /// C2a 观测：当前 boot 世代内的自动重启累计数（诊断/测试用）。
    pub fn auto_restarts(&self) -> usize {
        self.auto_restarts
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

    /// C2a 慢环熔断：间隔 > 窗口（60s）的崩溃永不触发窗口判据，但自动重启
    /// 累计达 [`MAX_AUTO_RESTARTS`] 后的下一次崩溃同样 Tripped——「内核每 2
    /// 分钟死一次」的无限自动重启形态到点进恢复页。本测试替代旧断言「间隔
    /// 20s 的崩溃永不成环」（该语义随 C2a 慢环熔断落地而废除）。
    #[test]
    fn slow_crashes_trip_at_auto_restart_limit() {
        let mut d = CrashLoopDetector::new();
        // 间隔 120s：窗口判据永不命中（stamps 始终只剩最近 1 个）。
        for i in 0..MAX_AUTO_RESTARTS {
            assert_eq!(d.record_crash(i as u64 * 120_000), Verdict::Ok, "慢崩第 {} 次未达限不应触发", i + 1);
        }
        assert_eq!(d.auto_restarts(), MAX_AUTO_RESTARTS);
        assert_eq!(
            d.record_crash(MAX_AUTO_RESTARTS as u64 * 120_000),
            Verdict::Tripped,
            "同一 boot 世代内 Verdict::Ok 自动重启累计 {} 次后的下一次崩溃必须熔断",
            MAX_AUTO_RESTARTS
        );
        // 熔断后冷却期（5 分钟）内的后续崩溃维持 Cooldown。
        assert_eq!(d.record_crash(MAX_AUTO_RESTARTS as u64 * 120_000 + 60_000), Verdict::Cooldown);
    }

    /// C2a 复位点：手动重启（restart_service = 新 boot 世代）复位慢环计数，
    /// 但快环窗口历史保留（graceful restart 从不算崩溃的既有语义不变）。
    #[test]
    fn graceful_restart_resets_slow_counter() {
        let mut d = CrashLoopDetector::new();
        for i in 0..MAX_AUTO_RESTARTS {
            d.record_crash(i as u64 * 120_000);
        }
        assert_eq!(d.auto_restarts(), MAX_AUTO_RESTARTS);
        d.record_graceful_restart();
        assert_eq!(d.auto_restarts(), 0, "手动重启=新世代，慢环计数复位");
        assert_eq!(d.record_crash(10 * 120_000), Verdict::Ok, "复位后从零重计");
        // record_recovery（恢复页重试）同样复位。
        d.record_recovery();
        assert_eq!(d.record_crash(20 * 120_000), Verdict::Ok);
    }

    #[test]
    fn cooldown_then_reset() {
        let mut d = CrashLoopDetector::new();
        for i in 0..6 {
            d.record_crash(i * 1000);
        }
        assert!(matches!(d.record_crash(30_000), Verdict::Cooldown | Verdict::Tripped));
        assert_eq!(d.record_crash(10 * 60_000), Verdict::Ok, "冷却（5 分钟）结束后复位");
        assert_eq!(d.auto_restarts(), 0, "冷却结束复位含慢环计数");
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
