//! TA4 回归锁定：C3/B2 `scrub_secrets` 的 api_key 变体矩阵（行为级补锁）。
//!
//! 修复背景（RV8 P1-4 红线）：内核 stdout/stderr 原文落盘 dsh-web.log，
//! 若报错行携带 API key（`api_key=` / `apikey:` / `api-key":"…"` / 引号
//! 包裹 / `sk-` 键）将明文持久化。`scrub_secrets` 以保守形态匹配脱敏
//! （宁漏脱敏不误伤）。
//!
//! logging.rs 是私有模块（`mod logging;`），沿用 session_notify_boundary
//! 的 `#[path]` 只读编入惯例：字节相同 = 测的就是真实实现。
//!
//! 覆盖（api_key 变体矩阵 + 短值不误杀）：
//! · `api_key=` / `apikey:` / `api-key"`（引号包裹 JSON 形态）三种键形；
//! · 大小写不敏感（`API_KEY=`）；
//! · 值长 >= 8 才脱敏——短值（`api_key=abc`）不误杀普通日志；
//! · `sk-` 键恰 20 位边界（19 位留原文 / 20 位 `sk-***`）；
//! · `Bearer` 恰 16 位边界与 `Authorization:` 行；
//! · 混合行：脱敏点之外的文本逐字保留（UTF-8 多字节不被字节扫描劈开）。

// logging.rs 引用 crate::supervisor::panic_payload_str——最小垫片满足编译。
mod supervisor {
    #![allow(dead_code)]
    pub fn panic_payload_str(_p: &(dyn std::any::Any + Send)) -> String {
        String::new()
    }
}

// 真实实现源，只读编入（字节一致，非复制粘贴）。
#[path = "../src/logging.rs"]
mod logging_live;

use logging_live::scrub_secrets;

/// api_key 三种键形 + 冒号/等号/引号分隔都命中脱敏。
#[test]
fn api_key_variant_forms_all_masked() {
    // api_key=<key>
    assert_eq!(scrub_secrets("cfg api_key=abcdefgh1234 rest"), "cfg api_key=*** rest");
    // apikey:<key>（冒号分隔）
    assert_eq!(scrub_secrets("request apikey:abcdefgh1234"), "request apikey=***");
    // api-key（连字符键，JSON 形态 "api-key":"<key>"——引号被跳过分隔）
    assert_eq!(scrub_secrets(r#"{"api-key":"abcdefgh1234"}"#), r#"{"api-key=***"}"#);
    // 裸 api-key=<key>。注意（现状语义）：值扫描止于空白/引号，分号后的
    // 同段文本（;v=2）一并并入被脱敏值——记录为已知保守行为，勿修。
    assert_eq!(scrub_secrets("hdr api-key=abcdefgh1234;v=2"), "hdr api-key=***");
}

/// 大小写不敏感：API_KEY= 同样脱敏。
#[test]
fn api_key_case_insensitive() {
    assert_eq!(scrub_secrets("API_KEY=abcdefgh1234"), "API_KEY=***");
    assert_eq!(scrub_secrets("Api-Key=abcdefgh1234"), "Api-Key=***");
}

/// 短值不误杀（保守匹配红线）：
/// - api_key 值 < 8 字符 → 原文保留；
/// - sk- 后缀 < 20 位 → 原文保留（短 sk- 串多为误报形态）。
#[test]
fn short_values_not_masked() {
    assert_eq!(scrub_secrets("api_key=abc"), "api_key=abc", "3 字符值不脱敏");
    assert_eq!(scrub_secrets("api_key=1234567"), "api_key=1234567", "7 字符值不脱敏");
    // 恰 8 字符是脱敏下界。
    assert_eq!(scrub_secrets("api_key=12345678"), "api_key=***", "8 字符值即脱敏（>=8 闭界）");
    // sk- 恰 19/20 位边界。
    let sk19 = format!("sk-{}", "a".repeat(19));
    let sk20 = format!("sk-{}", "a".repeat(20));
    assert_eq!(scrub_secrets(&sk19), sk19, "19 位 sk- 不误杀");
    assert_eq!(scrub_secrets(&sk20), "sk-***", "20 位 sk- 脱敏（>=20 闭界）");
}

/// Bearer / Authorization 行（矩阵补全——与 api_key 同一扫描器）。
#[test]
fn bearer_and_authorization_boundaries() {
    let t15 = "b".repeat(15);
    let t16 = "b".repeat(16);
    assert_eq!(scrub_secrets(&format!("Bearer {t15}")), format!("Bearer {t15}"), "15 位 token 不误杀");
    assert_eq!(scrub_secrets(&format!("Bearer {t16}")), "Bearer ***", "16 位 token 脱敏");
    // 【已修复】Authorization 改为整行余段打码——Basic/Bearer 的凭据尾一并擦。
    assert_eq!(scrub_secrets("Authorization: Basic YWJj"), "Authorization: ***", "已修：Basic 后的 b64 凭据尾也须被整行打码");
    // 输出键形统一为字面 "Authorization: ***"（键名不保原文——大小写归一）。
    assert_eq!(scrub_secrets("authorization: x"), "Authorization: ***", "Authorization 大小写不敏感且归一输出");
}

/// 混合行多脱敏点 + 非 ASCII 文本不被字节扫描劈开（UTF-8 按字符回填）。
#[test]
fn mixed_line_multiple_hits_and_utf8_safe() {
    let line = "错误：api_key=abcdefgh1234，模型 sk-cccccccccccccccccccc 调用失败";
    let out = scrub_secrets(line);
    assert!(!out.contains("abcdefgh1234"), "api_key 值必须擦除: {out}");
    assert!(!out.contains("cccccccccccccccccccc"), "sk- 键必须擦除: {out}");
    assert!(out.contains("错误："), "UTF-8 前缀逐字保留: {out}");
    // 【已知保守行为】值扫描只认 ASCII 空白/引号——api_key 值后的中文逗号
    // 与相邻文本被并入脱敏段一并擦除（宁多擦不漏擦，非劈字）。断言现状。
    assert!(!out.contains("，模型"), "秘密与下个 ASCII 空白之间的文本并入脱敏段: {out}");
    assert!(out.contains("调用失败"), "UTF-8 后缀逐字保留: {out}");
    assert!(out.contains("调用失败"), "UTF-8 后缀逐字保留: {out}");
    // 普通行零改写。
    assert_eq!(scrub_secrets("GET /v1/chat 200 OK"), "GET /v1/chat 200 OK");
}

/// 引号包裹变体：`"api_key": "…"`（JSON 键带引号 + 值带引号）。
#[test]
fn quoted_json_key_and_value_variants() {
    let out = scrub_secrets(r#"body={"api_key":"zxcvbnm0987"}"#);
    assert!(!out.contains("zxcvbnm0987"), "JSON 引号包裹值必须擦除: {out}");
    assert!(out.contains(r#""api_key=***""#), "键名保留可辨识、值擦除: {out}");
}
