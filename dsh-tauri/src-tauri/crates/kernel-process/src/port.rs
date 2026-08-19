//! 安全端口选择。
//!
//! 对齐 Electron 版 chooseStableWebPort 语义：
//! 1. 优先复用上次端口（端口稳定 → origin 稳定 → localStorage 偏好不丢，
//!    这是 Electron 版实测踩过的坑：origin 漂移导致会话分组/主题全丢）；
//! 2. 候选端口在 Chromium 不安全端口表内的直接跳过；
//! 3. 通过「真实 bind + 立刻释放」探测可用性（TIME_WAIT 残留探测）。
//!
//! Phase 0 交付不安全端口表 + 纯逻辑筛选；真实 bind 探测在 Phase 1 的
//! `choose_stable_port()` OS 绑定里组合使用。

use std::net::TcpListener;

/// Chromium 不安全端口表的常用子集（完整表见 Chromium net/base/port_util.cc；
/// Electron 版取的同一子集：历史上会被浏览器/中间盒劫持的端口）。
pub const UNSAFE_PORTS: &[u16] = &[
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
    102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
    427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
    989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666,
    6667, 6668, 6669, 6697, 10080,
];

/// 端口是否安全（不在不安全表内）。
pub fn is_safe_port(port: u16) -> bool {
    !UNSAFE_PORTS.contains(&port)
}

/// 过滤候选端口列表：保序剔除不安全端口。纯逻辑，可单测。
pub fn filter_safe<'a>(candidates: impl IntoIterator<Item = &'a u16>) -> Vec<u16> {
    candidates.into_iter().copied().filter(|p| is_safe_port(*p)).collect()
}

/// 真实探测（Phase 1 由 supervisor 调用）：bind 127.0.0.1:port 后立即释放，
/// 成功即可用（返回实际绑定成功的端口；传 0 让 OS 分配）。
pub fn probe_bind(port: u16) -> Option<u16> {
    if port != 0 && !is_safe_port(port) {
        return None;
    }
    TcpListener::bind(("127.0.0.1", port)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port())
}

/// 组合语义（Electron chooseStableWebPort 的 Rust 版）：
/// 期望端口（上次的）安全且可 bind → 用它；否则 OS 随机分配一个安全端口。
pub fn choose_stable_port(preferred: Option<u16>) -> Option<u16> {
    if let Some(p) = preferred {
        if is_safe_port(p) {
            if let Some(actual) = probe_bind(p) {
                if actual == p {
                    return Some(p);
                }
            }
        }
    }
    // OS 分配后校验安全性；不安全（极小概率）就重试几次。
    for _ in 0..8 {
        if let Some(p) = probe_bind(0) {
            if is_safe_port(p) {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_unsafe_rejected() {
        for p in [21, 22, 25, 80, 443, 465, 5060, 6000, 6666, 10080] {
            if p == 80 || p == 443 {
                continue; // 80/443 不在表中（Chromium 允许），不在断言里
            }
            assert!(!is_safe_port(p), "{p} 应为不安全端口");
        }
        assert!(is_safe_port(51731));
        assert!(is_safe_port(0), "0（OS 分配）视为安全，由 probe 结果判断");
    }

    #[test]
    fn filter_keeps_order() {
        let got = filter_safe(&[6000, 51731, 6666, 51732]);
        assert_eq!(got, vec![51731, 51732]);
    }

    #[test]
    fn probe_bind_works() {
        let p = probe_bind(0).expect("OS 应能分配端口");
        assert!(p > 0);
        assert!(choose_stable_port(None).is_some());
        // 不安全端口永远不会被选择。
        assert_eq!(choose_stable_port(Some(6666)).map(|p| p != 6666), Some(true));
    }
}
