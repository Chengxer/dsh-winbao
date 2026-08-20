//! 就绪行解析：`dsh web: https://127.0.0.1:xxxxx`。
//!
//! Electron 版为单行正则 `dsh web:\s+(https?://\S+)`（main.js watchServerProc）。
//! Tauri 版改为流式有状态解析（stdout 分 chunk 到达时跨缓冲拼接），
//! 命中后立即产出 URL，同时保证「先打日志后打 URL」的乱序容忍。

/// 流式就绪行解析器。
///
/// ```ignore
/// let mut p = ReadyLineParser::new();
/// p.feed("... 日志 ...\ndsh web: https://127.0.0");
/// assert!(p.url().is_none());
/// p.feed(".0.1:51731 ready\n...");
/// assert_eq!(p.url().unwrap(), "https://127.0.0.1:51731");
/// ```
#[derive(Debug)]
pub struct ReadyLineParser {
    url: Option<String>,
    buf: String,
}

/// 就绪行的稳定前缀（Electron 版正则的 `dsh web:\s+` 部分）。
const PREFIX: &str = "dsh web:";

impl ReadyLineParser {
    pub fn new() -> Self {
        Self { url: None, buf: String::new() }
    }

    /// 喂入一段 stdout 文本；返回本段内解析出的 URL（若无则 None）。
    /// 解析成功后进入终态，后续 feed 直接返回已有 URL。
    pub fn feed(&mut self, chunk: &str) -> Option<String> {
        if self.url.is_some() {
            return self.url.clone();
        }
        self.buf.push_str(chunk);
        // 只保留尾部窗口：PREFIX + 最长合理 URL（8KB 足够，防日志洪水撑爆内存）。
        let keep = 8 * 1024;
        if self.buf.len() > keep {
            let cut = self.buf.len() - keep;
            self.buf.drain(..cut);
        }
        // 在「已完成的一行」里找前缀；行未完成的部分留缓冲等下一段。
        if let Some(pos) = self.buf.find(PREFIX) {
            let after = &self.buf[pos + PREFIX.len()..];
            if let Some(nl) = after.find('\n') {
                let line = &after[..nl];
                if let Some(url) = first_url_token(line) {
                    self.url = Some(url.clone());
                    return Some(url);
                }
                // 前缀行已完整但没有 URL：丢弃该行，继续扫后续。
                self.buf.drain(..pos + PREFIX.len() + nl);
            }
            // 行未完成：留在缓冲里，返回 None。
        }
        None
    }

    /// 当前已解析出的 URL（可能为 None）。
    pub fn url(&self) -> Option<String> {
        self.url.clone()
    }
}

impl Default for ReadyLineParser {
    fn default() -> Self {
        Self::new()
    }
}

/// 取行内第一个 http(s) token（对齐 `\S+` 语义，但要求以 http 开头——
/// Electron 版正则捕获组本身就带协议前缀，这里是防御性收紧）。
fn first_url_token(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|t| t.starts_with("http://") || t.starts_with("https://"))
        .map(|t| t.trim_end_matches(['\r', ',']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line() {
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh web: http://127.0.0.1:51731\n"), Some("http://127.0.0.1:51731".into()));
    }

    #[test]
    fn split_across_chunks() {
        let mut p = ReadyLineParser::new();
        p.feed("noise\ndsh web: https://127.0.0");
        assert!(p.url().is_none(), "URL 未完整到达前不得产出");
        assert_eq!(p.feed(".1:9/token\nmore"), Some("https://127.0.0.1:9/token".into()));
    }

    #[test]
    fn crlf_and_trailing_comma() {
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh web:  http://x:1,\r\n"), Some("http://x:1".into()));
    }

    #[test]
    fn prefix_line_without_url_skipped() {
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh web:\n"), None);
        assert_eq!(p.feed("booting\ndsh web: https://h:2\n"), Some("https://h:2".into()));
    }

    #[test]
    fn terminal_state_stable() {
        let mut p = ReadyLineParser::new();
        p.feed("dsh web: https://a:1\n");
        assert_eq!(p.feed("garbage"), Some("https://a:1".into()));
        assert_eq!(p.url().unwrap(), "https://a:1");
    }

    #[test]
    fn flood_does_not_break_match() {
        let mut p = ReadyLineParser::new();
        let flood = "x".repeat(64 * 1024);
        p.feed(&flood);
        p.feed("dsh web: https://b:3\n");
        assert_eq!(p.url().unwrap(), "https://b:3");
    }

    // ---- 畸形输入（急修后补强：就绪行是 boot 瀑布的第一道信号面） ----

    #[test]
    fn prefix_split_across_chunks() {
        // 前缀本身被 chunk 边界切开："dsh we" | "b: https://x:1\n"。
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh we"), None);
        assert_eq!(p.feed("b: https://x:1\n"), Some("https://x:1".into()));
    }

    #[test]
    fn first_http_token_wins_and_non_http_ignored() {
        // 同行多候选：取第一个 http(s) token（对齐 Electron 正则首个命中语义）。
        let mut p = ReadyLineParser::new();
        assert_eq!(
            p.feed("dsh web: ready at http://a:1 backup https://b:2\n"),
            Some("http://a:1".into())
        );
        // 非 http token（ftp/裸主机名）不算就绪 URL：该行作废，继续扫描后续行。
        let mut q = ReadyLineParser::new();
        assert_eq!(q.feed("dsh web: ftp://x localhost:9\n"), None);
        assert_eq!(q.feed("dsh web: https://real:2\n"), Some("https://real:2".into()));
    }

    #[test]
    fn unterminated_prefix_line_yields_none() {
        // 前缀行永不换行（内核半路卡死）：解析器必须保持 None 而非误产出。
        let mut p = ReadyLineParser::new();
        assert_eq!(p.feed("dsh web: https://hang"), None);
        assert_eq!(p.feed(" more noise without newline"), None);
        assert!(p.url().is_none());
    }
}
