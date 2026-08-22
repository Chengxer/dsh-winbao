//! wsl.exe 输出解码与发行版清单解析（issue #126 三形态）。
//!
//! 逐行移植 Electron `dsh-desktop/wsl-backend.js` 的 `decodeWslText` /
//! `parseWslDistroList` / `looksLikeUtf16leNoBom`——语义单一事实源在那边，
//! 本文件是 Rust 等价物（sidecar JS 半边经 require 复用原实现，无第二份
//! JS 副本；Rust 半边在此唯一实现）。
//!
//! 输出三形态（真实 wsl.exe 实测）：
//! - UTF-16LE 带 BOM（`FF FE` 开头，旧版内置 wsl.exe）；
//! - UTF-16LE 无 BOM（Store 版 / 新版 wsl.exe——`wsl -l -q` 清单与 wsl.exe
//!   自身错误消息均为此形态；旧实现只认 BOM，无 BOM 按 utf8 兜底把清单解出
//!   `d\x00o\x00c\x00k\x00…` 之类的「发行版名」传给 `-d`，spawn 直接炸）；
//! - WSL 内 Linux 程序输出 / ANSI 代码页帮助文本（UTF-8 / GBK）：均不含
//!   NUL 字节，启发式不命中，安全走 utf8 路径。

/// 判定「无 BOM 的 UTF-16LE」字节流（issue #126 启发式）：
/// ASCII/GBK/UTF-8 文本不含 NUL 字节，而 UTF-16LE 的 ASCII 字符高字节恒为 0
/// 且行尾 `\r\n` 贡献奇数位 NUL——奇数位 NUL 明显多于偶数位即是强信号。
pub fn looks_like_utf16le_no_bom(buf: &[u8]) -> bool {
    if buf.len() < 4 || !buf.len().is_multiple_of(2) {
        return false;
    }
    let mut odd = 0usize;
    let mut even = 0usize;
    for pair in buf.chunks_exact(2) {
        if pair[0] == 0 {
            even += 1;
        }
        if pair[1] == 0 {
            odd += 1;
        }
    }
    odd >= 2 && odd > even * 4
}

/// 解码 wsl.exe 输出（stdout/stderr 通用）。可能含乱码，由调用方判定。
pub fn decode_wsl_text(buf: &[u8]) -> String {
    if buf.is_empty() {
        return String::new();
    }
    if buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe {
        return decode_utf16le(&buf[2..]);
    }
    if looks_like_utf16le_no_bom(buf) {
        return decode_utf16le(buf);
    }
    String::from_utf8_lossy(buf).into_owned()
}

fn decode_utf16le(buf: &[u8]) -> String {
    String::from_utf16_lossy(
        &buf.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect::<Vec<u16>>(),
    )
}

/// 帮助/错误文本特征行（中/英）：无发行版时 `wsl -l -q` 输出用法提示，不是清单。
fn is_usage_line(line: &str) -> bool {
    let t = line.trim_start();
    ["Usage:", "用法:", "Copyright", "版权所有"].iter().any(|marker| {
        // ASCII marker 走大小写不敏感前缀比较；中文 marker 精确前缀（无大小写）。
        if marker.is_ascii() {
            t.len() >= marker.len() && t[..marker.len()].eq_ignore_ascii_case(marker)
        } else {
            t.starts_with(marker)
        }
    })
}

/// 把 `wsl -l -q` 解码文本解析为发行版名列表：
/// - 含用法/版权特征行（未安装任何发行版）→ 空列表；
/// - 空输出/仅空白 → 空列表；
/// - 其余按行拆分、去首尾空白、剥 NUL 残留、过滤空行与控制字符行
///   （发行版名允许含空格）。
///
/// 防御（issue #126）：任何解码策略的残余失误都不允许把含 NUL/控制字符的
/// 「名字」放进列表——一旦被当作 `-d <distro>` 参数传给 wsl.exe，报错完全
/// 不可读。ASCII 名字在 UTF-16LE 被误按单字节解码的形态（`U\x00b\x00…`）
/// 剥 NUL 后即可自愈。
pub fn parse_distro_list(text: &str) -> Vec<String> {
    let raw = text.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = raw.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    // 用法文本命中 → 整体视为无发行版（与 JS WSL_USAGE_TEXT_RE 全文 test 等价）。
    if lines.iter().any(|l| is_usage_line(l)) {
        return Vec::new();
    }
    lines
        .iter()
        .map(|l| l.replace('\u{0}', "").trim().to_string())
        .filter(|l| !l.is_empty() && !l.chars().any(|c| (c.is_control() && c != '\u{0}') || c == '\u{7f}'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BOM UTF-16LE（旧版内置 wsl.exe 实测形态）。
    #[test]
    fn bom_utf16le_decodes() {
        let bytes: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain("Ubuntu\r\nDebian\r\n".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode_wsl_text(&bytes), "Ubuntu\r\nDebian\r\n");
    }

    /// 无 BOM UTF-16LE（Store 版 wsl -l -q 实测形态，issue #126 回归锚点）。
    #[test]
    fn no_bom_utf16le_decodes_via_heuristic() {
        let bytes: Vec<u8> = "Ubuntu\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_wsl_text(&bytes), "Ubuntu\r\n");
    }

    /// UTF-8（WSL 内 Linux 程序输出）：启发式不命中，走 utf8。
    #[test]
    fn utf8_passes_through() {
        assert_eq!(decode_wsl_text(b"v18.17.0\n"), "v18.17.0\n");
        // 含中文（多字节）也不误判。
        assert_eq!(decode_wsl_text("版本信息\n".as_bytes()), "版本信息\n");
    }

    /// GBK/ANSI 帮助文本（中文系统 wsl -? 输出）：无 NUL，安全 utf8（乱码无害）。
    #[test]
    fn ansi_help_text_is_lossy_utf8() {
        let bytes = [0xd0, 0xd0, 0xb1, 0xbe]; // GBK 片段
        let out = decode_wsl_text(&bytes);
        assert!(!out.contains('\u{0}'));
    }

    /// 边界：空 / <4 字节 / 奇数长度不 panic。
    #[test]
    fn short_and_odd_inputs_do_not_panic() {
        assert_eq!(decode_wsl_text(&[]), "");
        assert_eq!(decode_wsl_text(&[0x55]), "U");
        assert_eq!(decode_wsl_text(&[0x55, 0x00, 0x62]), "U\u{0}b");
    }

    /// 用法文本（中/英）→ 空列表。
    #[test]
    fn usage_text_yields_empty_list() {
        assert!(parse_distro_list("Usage: wsl.exe [Argument]\n").is_empty());
        assert!(parse_distro_list("用法: wsl.exe [参数]\n").is_empty());
        assert!(parse_distro_list("Copyright (c) Microsoft Corporation\nUbuntu\n").is_empty(), "版权行优先判死整表");
        assert!(parse_distro_list("").is_empty());
    }

    /// NUL 残留名自愈（误按单字节解码形态）。
    #[test]
    fn nul_residual_names_heal() {
        assert_eq!(
            parse_distro_list("U\u{0}b\u{0}u\u{0}n\u{0}t\u{0}u\u{0}\r\n"),
            vec!["Ubuntu".to_string()]
        );
    }

    /// 控制字符行整行剔除（防 `-d` 参数带控制字符）。
    #[test]
    fn control_char_lines_dropped() {
        assert!(parse_distro_list("Ubu\x01ntu\n").is_empty());
        assert!(parse_distro_list("Ubuntu\u{7f}\n").is_empty());
    }

    /// 含空格发行版名保留（distro 允许空格，经 argv 传递）。
    #[test]
    fn distro_name_with_space_kept() {
        assert_eq!(
            parse_distro_list("Ubuntu-24.04 LTS\r\n"),
            vec!["Ubuntu-24.04 LTS".to_string()]
        );
    }

    /// 多行清单 + BOM 剥除。
    #[test]
    fn multi_line_list() {
        assert_eq!(
            parse_distro_list("\u{feff}docker-desktop\r\nUbuntu-22.04\r\nDebian\r\n"),
            vec!["docker-desktop".to_string(), "Ubuntu-22.04".to_string(), "Debian".to_string()]
        );
    }
}
