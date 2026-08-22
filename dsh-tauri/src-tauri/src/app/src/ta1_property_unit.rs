//! TA1 属性测试（手写 xorshift 生成器，零新依赖）：对 updater/日志纯函数
//! 契约做 10^4 量级随机对照 + 传递性/自反性不变量 + 脏输入不 panic。
//!
//! 覆盖（经 lib.rs 的 cfg(test)] 门访问私有 mod 内 pub 契约）：
//! - `commands::updater_client::{cmp_semver, pick_asset_platform}`；
//! - `commands::updater_client::ta1_url_gate::assert_download_url_allowed`
//!   （私有 fn 的测试门包装）；
//! - `logging::scrub_secrets`。

use std::cmp::Ordering;

/// xorshift64*：手写确定性 PRNG（零依赖）。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1) // 种子非零
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

// ---------------------------------------------------------------------------
// 1. cmp_semver：随机合法 semver ×（oracle 对照 / 传递性 / 自反性 / 脏串）
// ---------------------------------------------------------------------------

/// 生成的 semver 结构化形态（oracle 数据面——不回看字符串再解析）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct GenSemver {
    core: Vec<u64>,                    // 2-3 段
    pre: Vec<PreIdent>,                // 可空 = 正式版
    build: Option<String>,             // 元数据（比较必须忽略）
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum PreIdent {
    Num(u64),
    Alnum(String),
}

impl GenSemver {
    fn to_string_form(&self, with_v: bool, with_build: bool) -> String {
        let mut s = String::new();
        if with_v {
            s.push('v');
        }
        let cores: Vec<String> = self.core.iter().map(|c| c.to_string()).collect();
        s.push_str(&cores.join("."));
        if !self.pre.is_empty() {
            s.push('-');
            let idents: Vec<String> = self
                .pre
                .iter()
                .map(|p| match p {
                    PreIdent::Num(n) => n.to_string(),
                    PreIdent::Alnum(a) => a.clone(),
                })
                .collect();
            s.push_str(&idents.join("."));
        }
        if with_build {
            if let Some(b) = &self.build {
                s.push('+');
                s.push_str(b);
            }
        }
        s
    }
}

fn gen_semver(rng: &mut Rng) -> GenSemver {
    let segs = 2 + (rng.below(2) as usize); // 2 或 3 段（缺段=0 语义）
    let core = (0..segs).map(|_| rng.below(50)).collect();
    let npre = rng.below(4) as usize; // 0-3 个 prerelease 标识符
    let pre = (0..npre)
        .map(|_| {
            if rng.below(2) == 0 {
                PreIdent::Num(rng.below(30))
            } else {
                // 字母数字标识符（避免与数值标识符同形歧义：首字符取字母）
                let len = 1 + rng.below(6) as usize;
                let letters = b"abcdefghijklmnopqrstuvwxyz";
                let mut s = String::new();
                for i in 0..len {
                    let idx = rng.below(letters.len() as u64) as usize;
                    s.push(letters[idx] as char);
                    if i == 0 && rng.below(4) == 0 {
                        s.push_str(&rng.below(100).to_string()); // 字母开头的混合
                    }
                }
                PreIdent::Alnum(s)
            }
        })
        .collect();
    let build = if rng.below(2) == 0 {
        Some(format!("b{}.{}", rng.below(1000), rng.below(100)))
    } else {
        None
    };
    GenSemver { core, pre, build }
}

/// 独立 oracle：从结构化数据（非字符串）按 semver 规则比较。
fn oracle_cmp(a: &GenSemver, b: &GenSemver) -> Ordering {
    let n = a.core.len().max(b.core.len());
    for i in 0..n {
        let x = a.core.get(i).copied().unwrap_or(0);
        let y = b.core.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            o => return o,
        }
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for i in 0..a.pre.len().max(b.pre.len()) {
                match (a.pre.get(i), b.pre.get(i)) {
                    (None, Some(_)) => return Ordering::Less,
                    (Some(_), None) => return Ordering::Greater,
                    (Some(x), Some(y)) => match (x, y) {
                        (PreIdent::Num(p), PreIdent::Num(q)) => match p.cmp(q) {
                            Ordering::Equal => continue,
                            o => return o,
                        },
                        (PreIdent::Num(_), PreIdent::Alnum(_)) => return Ordering::Less,
                        (PreIdent::Alnum(_), PreIdent::Num(_)) => return Ordering::Greater,
                        (PreIdent::Alnum(p), PreIdent::Alnum(q)) => match p.cmp(q) {
                            Ordering::Equal => continue,
                            o => return o,
                        },
                    },
                    (None, None) => unreachable!(),
                }
            }
            Ordering::Equal
        }
    }
}

#[test]
fn ta1_cmp_semver_oracle_10k() {
    let u = crate::commands::updater_client::cmp_semver;
    let mut rng = Rng::new(0xD5A11);
    for _ in 0..10_000 {
        let a = gen_semver(&mut rng);
        let b = gen_semver(&mut rng);
        // 随机形态变体：v 前缀 × build 元数据有无（必须不影响比较结果）。
        let sa = a.to_string_form(rng.below(2) == 0, rng.below(2) == 0);
        let sb = b.to_string_form(rng.below(2) == 0, rng.below(2) == 0);
        let got = u(&sa, &sb);
        let want = oracle_cmp(&a, &b);
        assert_eq!(got, want, "cmp_semver({sa:?}, {sb:?}) = {got:?}, oracle = {want:?}",);
    }
}

#[test]
fn ta1_cmp_semver_transitivity_and_reflexivity() {
    let u = crate::commands::updater_client::cmp_semver;
    let mut rng = Rng::new(0x7A5EED);
    for _ in 0..2_000 {
        let a = gen_semver(&mut rng).to_string_form(true, true);
        let b = gen_semver(&mut rng).to_string_form(false, true);
        let c = gen_semver(&mut rng).to_string_form(true, false);
        // 自反（同串必 Equal）。
        assert_eq!(u(&a, &a), Ordering::Equal);
        // 反对称。
        let (ab, ba) = (u(&a, &b), u(&b, &a));
        assert_eq!(ab, ba.reverse(), "反对称失败: {a} vs {b}");
        // 传递性：a<b && b<c ⇒ a<c。
        if u(&a, &b) == Ordering::Less && u(&b, &c) == Ordering::Less {
            assert_eq!(u(&a, &c), Ordering::Less, "传递性失败: {a} < {b} < {c}");
        }
        if u(&a, &b) == Ordering::Greater && u(&b, &c) == Ordering::Greater {
            assert_eq!(u(&a, &c), Ordering::Greater);
        }
    }
}

#[test]
fn ta1_cmp_semver_dirty_strings_never_panic() {
    let u = crate::commands::updater_client::cmp_semver;
    let mut rng = Rng::new(0xBA0BAB);
    let dirty_pool = [
        "", " ", "garbage", "v", "V", "-", "+", "v+", ". . .", "1..3",
        "v1.2.3-", "v1.2.3+", "١.٢.٣", "1.2.3.4.5.6.7.8.9.10.11",
        "999999999999999999999999999999", "a.b.c-...", "1.2.3-rc..1",
        "\u{1}\u{7}x", "1.2.3+\u{0}", "vVv1.2.3", "--", "1.-2.3",
    ];
    for i in 0..4_000 {
        let a = if i % 2 == 0 {
            dirty_pool[rng.below(dirty_pool.len() as u64) as usize].to_string()
        } else {
            // 随机字节串（lossy UTF-8，含非法序列）。
            let len = rng.below(24) as usize;
            let bytes: Vec<u8> = (0..len).map(|_| (rng.below(256)) as u8).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let b = gen_semver(&mut rng).to_string_form(rng.below(2) == 0, true);
        // 只断言不 panic 且返回三态之一（垃圾进垃圾出，但绝不炸）。
        let _ = u(&a, &b);
        let _ = u(&b, &a);
        let _ = u(&a, &a);
    }
}

// ---------------------------------------------------------------------------
// 2. pick_asset_platform：随机资产名集合 × 不变量
// ---------------------------------------------------------------------------

#[test]
fn ta1_pick_asset_platform_membership_and_purity() {
    let u = crate::commands::updater_client::pick_asset_platform;
    let mut rng = Rng::new(0xA55E7);
    let mk = |name: &str| crate::commands::updater_client::ReleaseAsset {
        name: name.to_string(),
        url: format!("https://github.com/x/{name}"),
        size: 1,
    };
    let pool = [
        // Windows 合法（x64 系标签）。
        "DSH-Desktop-Setup-0.5.3-win-x64.exe",
        "DSH-Desktop-Setup-0.5.3-win-x86_64.exe",
        "DSH-Desktop-Setup-0.5.3-win_amd64.exe",
        "DSH-Desktop-Setup-0.5.3-win64.exe",
        // Windows 合法 arm64。
        "DSH-Desktop-Setup-0.5.3-win-arm64.exe",
        "DSH-Desktop-Setup-0.5.3-win-aarch64.exe",
        // 毒化：Portable / 非安装器 / 边车 / 源码包 / 其他平台。
        "DSH-Desktop-Portable-0.5.3-win-x64.zip",
        "DSH-Desktop-0.5.3-win-x64.zip",
        "DSH-Desktop-Setup-0.5.3-win-x64.exe.sha256",
        "DSH-Desktop-Setup-0.5.3-win-x64.exe.blockmap",
        "DSH-Desktop-Setup-0.5.3-win-x64.exe.sig",
        "v0.5.3.zip",
        "v0.5.3.tar.gz",
        "DSH-Desktop-0.5.3-macos-arm64.dmg",
        "DSH-Desktop-0.5.3-linux-x86_64.AppImage",
        "DSH-Desktop-0.5.3-linux-amd64.deb",
        "random-junk.bin",
        "setup-win-x64.exe.txt",
        "",
    ];
    let os_arch = [
        ("windows", "x86_64"),
        ("windows", "aarch64"),
        ("macos", "aarch64"),
        ("macos", "x86_64"),
        ("linux", "x86_64"),
        ("linux", "aarch64"),
        ("haiku", "x86_64"), // 未知平台恒 None
    ];
    for _ in 0..5_000 {
        let n = 1 + rng.below(pool.len() as u64) as usize;
        let names: Vec<String> = (0..n)
            .map(|_| {
                let base = pool[rng.below(pool.len() as u64) as usize];
                // 随机大小写形态（内部 lowercase 归一——不变量按小写判）。
                if rng.below(3) == 0 {
                    base.to_uppercase()
                } else {
                    base.to_string()
                }
            })
            .collect();
        let assets: Vec<_> = names.iter().map(|s| mk(s)).collect();
        let (os, arch) = os_arch[rng.below(os_arch.len() as u64) as usize];
        let picked = u(os, arch, &assets);
        if let Some(a) = picked {
            // 不变量 1：返回者必属输入集。
            assert!(
                names.iter().any(|n| n.eq_ignore_ascii_case(&a.name)),
                "挑选结果不在输入集: {} not in {names:?}",
                a.name
            );
            let lower = a.name.to_ascii_lowercase();
            // 不变量 2（任务口径）：Windows 产物必含 win- 平台标记且非 Portable。
            if os == "windows" {
                assert!(lower.contains("win-") || lower.contains("win_") || lower.contains("win64"),
                    "Windows 产物缺 win- 标记: {}", a.name);
                assert!(!lower.contains("portable"), "Windows 更新链绝不用 Portable: {}", a.name);
                assert!(lower.ends_with(".exe") && lower.contains("setup"), "Windows 产物必须 Setup exe: {}", a.name);
            }
            if os == "macos" {
                assert!(lower.ends_with(".dmg"), "macOS 产物必须 dmg: {}", a.name);
            }
            if os == "linux" {
                assert!(lower.ends_with(".appimage") || lower.ends_with(".deb"), "Linux 产物形态: {}", a.name);
            }
            // 不变量 3：边车/源码包绝不入选。
            assert!(!lower.ends_with(".sha256") && !lower.ends_with(".blockmap") && !lower.ends_with(".sig"));
        }
        // 未知平台恒 None。
        assert!(u("haiku", "x86_64", &assets).is_none());
    }
}

// ---------------------------------------------------------------------------
// 3. assert_download_url_allowed：合法/毒化 URL 矩阵
// ---------------------------------------------------------------------------

#[test]
fn ta1_download_url_gate_matrix() {
    let u = crate::commands::updater_client::ta1_url_gate::assert_download_url_allowed;
    let allow = [
        "https://github.com/owner/repo/releases/download/v1/d.exe",
        "https://gitee.com/owner/repo/attachments/download/x/d.exe",
        "https://objects.githubusercontent.com/pkg/github-release/abc",
        // url crate 归一：scheme/host 大小写不敏感（DNS 语义，合法）。
        "HTTPS://github.com/a/b",
        "https://GITHUB.COM/a/b",
        "https://GitHub.com/a/b",
        // userinfo 混淆：host 真身是 github.com → 放行（ userinfo 不参与判定）。
        "https://evil%40attacker@githuB.com/a/b",
        "https://user:pass@github.com/a/b",
        // 回环（本地测试缝）。
        "http://127.0.0.1:8080/x",
        "https://127.0.0.1/x",
        "http://localhost/x",
        "http://[::1]:9/x",
    ];
    let deny = [
        // 末尾点 host（DNS 根域形态，白名单绕过尝试）。
        "https://github.com./a/b",
        "https://github.com.evil.com/a/b",
        // @ 混淆：host 真身是攻击者。
        "https://github.com@evil.com/a/b",
        "https://github.com:8443@evil.com/a/b",
        // 非 https 远程 / file:// / 内网 IP。
        "http://github.com/a/b",
        "file:///C:/Windows/evil.exe",
        "file://github.com/x",
        "ftp://github.com/x",
        "https://192.168.1.1/x",
        "https://10.0.0.1/x",
        "https://172.16.0.1/x",
        "https://127.0.0.2/x", // 非白名单字面回环（127/8 其余地址不放行）
        "https://169.254.169.254/latest/meta-data", // 云元数据端点
        "https://[::ffff:127.0.0.1]/x",
        "https://raw.githubusercontent.com/x",
        "https://evil.com/x",
        "https://github.com.evil.io/x",
        "javascript:alert(1)",
        "",
        "not a url",
        "https://", // 无 host
        "//github.com/x",
        r"https://github\.com/x",
    ];
    for u_allow in allow {
        assert!(u(u_allow).is_ok(), "合法 URL 被拒: {u_allow}");
    }
    for d in deny {
        assert!(u(d).is_err(), "毒化 URL 被放行: {d}");
    }
}

#[test]
fn ta1_download_url_gate_generated_never_panics() {
    let u = crate::commands::updater_client::ta1_url_gate::assert_download_url_allowed;
    let mut rng = Rng::new(0xF00D);
    let hosts = ["github.com", "gitee.com", "objects.githubusercontent.com", "evil.com", "127.0.0.1", "localhost", "192.168.0.1", "[::1]", "github.com."];
    let schemes = ["https", "http", "file", "ftp", "", "HTTPS"];
    for _ in 0..4_000 {
        let h = hosts[rng.below(hosts.len() as u64) as usize];
        let s = schemes[rng.below(schemes.len() as u64) as usize];
        let port = if rng.below(2) == 0 { String::new() } else { format!(":{}", rng.below(65536)) };
        let userinfo = if rng.below(4) == 0 { format!("user{}@", rng.below(100)) } else { String::new() };
        let url = format!("{s}://{userinfo}{h}{port}/p{}", rng.below(1000));
        // 只断言三态确定、不 panic；判定正确性由上面固定矩阵锚定。
        let _ = u(&url);
    }
}

// ---------------------------------------------------------------------------
// 4. scrub_secrets：随机注入 × 不变量
// ---------------------------------------------------------------------------

#[test]
fn ta1_scrub_secrets_injected_tokens_removed_10k() {
    let u = crate::logging::scrub_secrets;
    let mut rng = Rng::new(0x5EC1E7);
    let words = ["kernel", "boot", "ok", "ws://127.0.0.1", "port=9", "error:", "hint", "中文日志", "path C:\\x", "2026-08-22T00:00:00Z"];
    let alnum = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let rands = |rng: &mut Rng, n: usize| -> String {
        (0..n).map(|_| alnum[rng.below(alnum.len() as u64) as usize] as char).collect()
    };
    for i in 0..10_000 {
        let word = words[rng.below(words.len() as u64) as usize];
        let prelen = rng.below(12) as usize;
        let prefix = format!("{word} {}", rands(&mut rng, prelen));
        let suflen = rng.below(12) as usize;
        let suffix = format!("{} tail", rands(&mut rng, suflen));
        let toklen = 20 + rng.below(20) as usize; // ≥20 位
        let token = rands(&mut rng, toklen);
        let (line, marker) = match i % 4 {
            0 => (format!("{prefix} sk-{token} {suffix}"), format!("sk-{token}")),
            1 => (format!("{prefix} Bearer {token} {suffix}"), token.clone()),
            2 => (format!("{prefix} Authorization: {token} {suffix}"), token.clone()),
            _ => (format!("{prefix} api_key={token} {suffix}"), token.clone()),
        };
        let out = u(&line);
        assert!(!out.contains(&marker), "原 token 残留: {out:?}（含 {marker:?}）");
        assert!(out.contains("***"), "脱敏必须留痕: {out:?}");
    }
}

#[test]
fn ta1_scrub_secrets_benign_lines_unchanged_10k() {
    let u = crate::logging::scrub_secrets;
    let mut rng = Rng::new(0xBE012);
    // 纯小写字母 + 空格 + 少量符号：形态上不可能命中 sk-/Bearer/Authorization。
    let chars = b"abcdefghijklmnopqrstuvwxyz 0123456789 .:/\\=+[]()#%";
    for _ in 0..10_000 {
        let len = 1 + rng.below(80) as usize;
        let line: String = (0..len).map(|_| chars[rng.below(chars.len() as u64) as usize] as char).collect();
        if line.contains("bearer") || line.contains("authorization") || line.contains("api_key") {
            continue; // 生成器撞形（大小写不敏感命中）→ 排除
        }
        assert_eq!(u(&line), line, "普通日志行被误改: {line:?}");
    }
}

#[test]
fn ta1_scrub_secrets_dirty_never_panics() {
    let u = crate::logging::scrub_secrets;
    let mut rng = Rng::new(0xC0A15);
    for _ in 0..3_000 {
        let len = rng.below(64) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| (rng.below(256)) as u8).collect();
        let line = String::from_utf8_lossy(&bytes).into_owned();
        let _ = u(&line);
    }
    // 边界：空串。
    assert_eq!(u(""), "");
}

/// 【TA1 缺陷锚点——已修复，断言已反转（2026-08-22）】
/// Authorization 值（scheme + 空格 + 凭据复合）改为整行余段打码，
/// Bearer/Basic 裸凭据不再残留。
#[test]
fn ta1_scrub_secrets_known_gap_authorization_bearer_value_survives() {
    let u = crate::logging::scrub_secrets;
    let token = "TfQNQcCsqGnu2hm2a3rdEAtoyag"; // 28 位，非 sk- 前缀
    let out = u(&format!("Authorization: Bearer {token}"));
    assert!(!out.contains(token), "Bearer 裸 token 必须被整行打码（已修复）");
    assert!(out.contains("***"), "打码标记在位");
}
