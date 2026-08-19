//! # session-watcher —— 会话监视
//!
//! 对齐 Electron 版 main.js 的通知链路语义：
//! - 会话完成 → 系统通知；点击 → `notification-jump` 事件（携 sessionId）；
//! - **聚焦豁免**：主窗聚焦且观看的就是该会话 → 不打扰；
//! - **限流**：同一会话的完成通知有最小间隔（防止刷屏）；
//! - `current-session` 上行（3s 轮询、变化才发）在这里落地为状态。
//!
//! Phase 0 交付决策逻辑（纯函数，可单测）；zstd 会话日志扫描（判断「完成」）
//! 在 Phase 3 接入（error-codes.md §4 的 E_FENCE_ZSTD 届时启用）。

use std::collections::HashMap;
use std::time::Duration;

/// 通知节流器：per-session 最小间隔。
pub struct NotifyThrottle {
    min_interval: Duration,
    /// session → 上次通知的单调毫秒。
    last: HashMap<String, u64>,
}

/// 一次通知的决策。
#[derive(Debug, PartialEq, Eq)]
pub enum NotifyDecision {
    /// 发通知。
    Notify,
    /// 间隔内重复，静默。
    SuppressedRecent,
    /// 主窗聚焦且正在观看该会话，聚焦豁免。
    SuppressedFocused,
}

impl NotifyThrottle {
    /// Electron 版口径：同会话 30s 内不重复通知。
    pub fn new() -> Self {
        Self::with_min_interval(Duration::from_secs(30))
    }

    pub fn with_min_interval(min_interval: Duration) -> Self {
        Self { min_interval, last: HashMap::new() }
    }

    /// 判定是否发通知。`focused_on` = 主窗当前聚焦且观看中的 sessionId（若有）。
    pub fn decide(&mut self, session_id: &str, focused_on: Option<&str>, now_ms: u64) -> NotifyDecision {
        if focused_on == Some(session_id) {
            return NotifyDecision::SuppressedFocused;
        }
        match self.last.get(session_id) {
            Some(&t) if now_ms.saturating_sub(t) < self.min_interval.as_millis() as u64 => {
                NotifyDecision::SuppressedRecent
            }
            _ => {
                self.last.insert(session_id.to_string(), now_ms);
                NotifyDecision::Notify
            }
        }
    }
}

impl Default for NotifyThrottle {
    fn default() -> Self {
        Self::new()
    }
}

/// 当前会话跟踪：接收 `current_session` 上行，去抖后提供「正在观看」状态。
/// 契约 §4：3s 轮询、变化才发——本结构只存最新值，去抖由上游（垫片）完成。
#[derive(Debug, Default)]
pub struct CurrentSessionTracker {
    current: Option<String>,
}

impl CurrentSessionTracker {
    pub fn update(&mut self, session_id: &str) {
        self.current = Some(session_id.to_string());
    }

    /// 主窗失焦/关闭时清空（聚焦豁免随之失效）。
    pub fn clear(&mut self) {
        self.current = None;
    }

    pub fn get(&self) -> Option<&str> {
        self.current.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_session_exempt() {
        let mut t = NotifyThrottle::new();
        assert_eq!(t.decide("s1", Some("s1"), 0), NotifyDecision::SuppressedFocused);
    }

    #[test]
    fn throttle_window() {
        let mut t = NotifyThrottle::new();
        assert_eq!(t.decide("s1", None, 0), NotifyDecision::Notify);
        assert_eq!(t.decide("s1", None, 10_000), NotifyDecision::SuppressedRecent);
        assert_eq!(t.decide("s1", None, 31_000), NotifyDecision::Notify);
        // 不同会话互不影响。
        assert_eq!(t.decide("s2", None, 10_000), NotifyDecision::Notify);
    }

    #[test]
    fn focused_other_session_still_notifies() {
        let mut t = NotifyThrottle::new();
        assert_eq!(t.decide("s2", Some("s1"), 0), NotifyDecision::Notify);
    }

    #[test]
    fn tracker_lifecycle() {
        let mut tr = CurrentSessionTracker::default();
        assert_eq!(tr.get(), None);
        tr.update("abc");
        assert_eq!(tr.get(), Some("abc"));
        tr.clear();
        assert_eq!(tr.get(), None);
    }
}
