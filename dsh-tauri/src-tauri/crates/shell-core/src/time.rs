//! 无依赖 UTC 时间换算（days→civil 与时间戳格式化）。
//!
//! Howard Hinnant `civil_from_days` 算法。壳内多处消费同一实现
//! （panics.log 时间戳、诊断/备份文件名时间戳），此前各持一份拷贝
//! （lib.rs format_unix_secs 与旧 commands.rs civil_from_days），2026-08
//! 提炼至此单一来源。刻意不引 chrono：壳依赖面保持最小。

/// days since 1970-01-01 → (年, 月, 日)。
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// unix 秒 → `YYYY-MM-DD HH:MM:SS`（UTC；本地时区换算需平台调用，日志用途
/// UTC 稳定可排序即足够）。
pub fn format_unix_secs(secs: u64) -> String {
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_epoch_and_known_dates() {
        // 1970-01-01 = day 0。
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-07-19 = day 20653（node: new Date(20653*86400e3) 校准）。
        assert_eq!(civil_from_days(20653), (2026, 7, 19));
    }

    #[test]
    fn unix_secs_format_known_timestamps() {
        // 1784419200 = 2026-07-19 00:00:00 UTC（day 20653 同源基准）。
        assert_eq!(format_unix_secs(1_784_419_200), "2026-07-19 00:00:00");
        assert_eq!(format_unix_secs(1_784_419_200 + 3661), "2026-07-19 01:01:01");
        assert_eq!(format_unix_secs(0), "1970-01-01 00:00:00");
    }
}
