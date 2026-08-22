//! TA3 链路集成测试：客户端更新链端到端（组件真跑、边界 mock）。
//!
//! 手法说明：
//! - 生产源 `commands/updater_client.rs` 经 `#[path]` **只读编入**本测试
//!   crate（字节一致，测的就是生产实现；与 session_notify_boundary 同款
//!   手段）。其文件内自带 `#[cfg(test)] mod tests` 在本集成测试二进制中
//!   **同样编译并运行**（cargo 以 `--test` 编集成测试 → cfg(test) 生效），
//!   其中 `cache_sha256`/`cache_alt_url`/`resolve_outcome` 的私有面单测
//!   （digest 缓存命中、镜像漂移换源救回、双源裁决 prefer Gitee 等）即
//!   「tests 内同 crate 可见性」的既有同款注入手段，与本文件互补。
//! - 本文件场景走 **公开契约面**（download_to_temp / pick_asset_platform /
//!   cmp_semver / UpdaterError）打本地 127.0.0.1 HTTP 服务（下载门禁白名单
//!   允许回环）：check_latest 的双源 URL 是产品常量不可注入，双源「探测→
//!   裁决→换源」的私有注入场景由上述编入的单测覆盖，本文件覆盖公开面的
//!   端到端链（裁决 glue + 下载 + 完整性 + 门禁）。

#![allow(dead_code)]

#[path = "../src/commands/updater_client.rs"]
mod updater_live;

use std::io::{Read, Write};
use updater_live::{
    cmp_semver, download_to_temp, pick_asset_platform, CheckOutcome, ReleaseAsset, RemoteRelease,
    UpdateSource, UpdaterError,
};

/// 路径路由迷你 HTTP 服务（与编入模块内单测同款）：每连接一请求。
fn spawn_http_server(routes: Vec<(&'static str, u16, Vec<u8>)>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..64 {
            let Ok((mut sock, _)) = listener.accept() else { return };
            let mut buf = [0u8; 2048];
            let mut head = Vec::new();
            loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let line = String::from_utf8_lossy(&head);
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (status, body) = routes
                .iter()
                .find(|(p, _, _)| path == *p)
                .map(|(_, s, b)| (*s, b.clone()))
                .unwrap_or((404, Vec::new()));
            let reason = match status {
                200 => "OK",
                404 => "Not Found",
                _ => "Error",
            };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
            let _ = sock.write_all(&body);
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

fn asset(name: &str, url: &str, size: u64) -> ReleaseAsset {
    ReleaseAsset { name: name.into(), url: url.into(), size }
}

/// 场景 A（常规）：GitHub+Gitee 双源同 tag → 裁决 glue（生产 resolve_outcome
/// 规则：tag 相等 prefer Gitee，用公开面 cmp_semver + pick_asset_platform
/// 复合断言；私有 resolve_outcome 的同断言由编入单测
/// resolve_both_reachable_both_complete_prefers_gitee 在本二进制内并行运行）
/// → download_to_temp（digest 校验）→ 逐字节落盘成功 + 进度回调。
#[test]
fn scenario_a_dual_source_gitee_preferred_download_succeeds() {
    let body: Vec<u8> = (0..8192u32).map(|i| (i % 249) as u8).collect();
    let base = spawn_http_server(vec![("/gitee.com/pkg-a.exe", 200, body.clone())]);
    let name = "DSH-Desktop-Setup-0.5.3-win-x64.exe";
    let gitee = RemoteRelease {
        tag: "v0.5.3".into(),
        notes: "ta3".into(),
        assets: vec![asset(name, &format!("{base}/gitee.com/pkg-a.exe"), 0)], // Gitee 无 size → 0
    };
    let mut github = gitee.clone();
    github.assets[0].url = "https://github.com/x/pkg-a.exe".into();
    github.assets[0].size = body.len() as u64;

    // 双源裁决 glue（同 resolve_outcome 规则）：tag 相等 → Gitee 在前。
    let cands: Vec<(UpdateSource, &RemoteRelease)> = vec![
        (UpdateSource::Gitee, &gitee), // 生产排序把 Gitee 排前
        (UpdateSource::GitHub, &github),
    ];
    assert_eq!(cmp_semver("0.5.3", "0.5.3"), std::cmp::Ordering::Equal, "同 tag 不换位（prefer Gitee）");
    let mut chosen: Option<(UpdateSource, ReleaseAsset)> = None;
    for (source, rel) in &cands {
        if let Some(a) = pick_asset_platform("windows", "x86_64", &rel.assets) {
            chosen = Some((*source, a));
            break;
        }
    }
    let (source, ast) = chosen.expect("windows/x86_64 必有 Setup 资产");
    assert_eq!(source, UpdateSource::Gitee, "双源同 tag 齐全 → prefer Gitee（国内快）");
    assert_eq!(ast.url, format!("{base}/gitee.com/pkg-a.exe"));
    // 本地版本 0.5.2 < 0.5.3 → Available 语义（CheckOutcome 构造走 pub 面）。
    assert_eq!(cmp_semver("0.5.3", "0.5.2"), std::cmp::Ordering::Greater, "应报 Available 而非 UpToDate");
    let _ = CheckOutcome::Available(updater_live::UpdateAvailable {
        current: "0.5.2".into(),
        next: "0.5.3".into(),
        notes: gitee.notes.clone(),
        asset: ast.clone(),
        source,
    });

    // 下载（digest 校验；缓存注入面 cache_sha256 由编入单测覆盖，此处显式参数
    // 是调用方最高优先级路径——U2 契约面）。
    let mut events = 0usize;
    let path = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| events += 1, Some(&sha256_hex(&body))))
        .expect("digest 正确应下载成功");
    assert_eq!(std::fs::read(&path).unwrap(), body, "落盘逐字节一致");
    assert!(events > 0, "进度回调必须发射");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

/// 场景 B 边界（公开面）：Gitee 形态资产（size=0 未知）digest 不符 →
/// HashMismatch 硬失败 + 临时目录清理。（换源救回 alt_url 链由编入单测
/// download_hash_mismatch_falls_back_to_alt_source / 双源皆篡改硬失败
/// download_hash_mismatch_alt_source_tampered_still_hard_fails 在本二进制内
/// 以 cache_alt_url 注入覆盖。）
#[test]
fn scenario_b_mismatch_hard_fail_cleans_temp() {
    let drifted = b"gitee-mirror-reuploaded-drifted-bytes-ta3-b".to_vec();
    let base = spawn_http_server(vec![("/gitee.com/pkg-b.exe", 200, drifted.clone())]);
    let ast = asset(
        "DSH-Desktop-Setup-0.5.3-win-x64-ta3b.exe",
        &format!("{base}/gitee.com/pkg-b.exe"),
        0, // Gitee 无 size
    );
    let github_digest = sha256_hex(b"authoritative-github-bytes-for-ta3-b");
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, Some(&github_digest))).unwrap_err();
    match err {
        UpdaterError::HashMismatch { expected, actual } => {
            assert_eq!(expected, github_digest);
            assert_eq!(actual, sha256_hex(&drifted));
        }
        other => panic!("漂移应 HashMismatch，得 {other:?}"),
    }
    // 失败不留半截包。
    let leftover = std::fs::read_dir(std::env::temp_dir())
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("dsh-update-"))
        .flat_map(|e| std::fs::read_dir(e.path()).ok().into_iter().flatten().flatten())
        .any(|f| f.file_name().to_string_lossy().contains("ta3b"));
    assert!(!leftover, "失败必须清理临时目录");
}

/// 场景 C（Gitee-only 无锚，fail-closed）：GitHub API/边车不可达 + Gitee 资产
/// 无边车/digest → 公开面 download_to_temp 必须拒绝并报「哈希锚点」。
/// 边车探测会真打 gitee.com 上一个不存在的路径（在线 404 / 离线连接失败
/// 均 → None，两态同断言）。
#[test]
fn scenario_c_gitee_only_no_anchor_fails_closed() {
    let ast = asset(
        "DSH-Desktop-Setup-0.5.4-win-x64-ta3c-unique.exe",
        "https://gitee.com/ta3-nonexistent-repo/DSH-Desktop-Setup-0.5.4-win-x64-ta3c-unique.exe",
        0,
    );
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None)).unwrap_err();
    match err {
        UpdaterError::Download(ref m) => {
            assert!(m.contains("哈希锚点"), "fail-closed 必须报哈希锚点缺失：{m}");
            assert!(m.contains("拒绝自动下载"), "必须明示拒绝自动下载：{m}");
        }
        other => panic!("场景 C 应 fail-closed Download，得 {other:?}"),
    }
}

/// 场景 D（跨源锚链，公开面）：边车（`<asset.url>.sha256` 形态，跨源锚
/// cache_cross_anchor 指向的 GitHub 边车即此 URL 形态）命中 → 哈希校验通过
/// → 成功；边车不符 → 硬失败。（cache_cross_anchor 私有注入版由编入单测
/// 覆盖；此处验证「本源无边车→锚字节对→放行」的真实 fetch 链。）
#[test]
fn scenario_d_sidecar_anchor_verifies_and_mismatch_fails() {
    let body = b"ta3-d-bytes-anchored-by-sidecar".to_vec();
    let sidecar = format!("{}  pkg-d.exe\n", sha256_hex(&body));
    let base = spawn_http_server(vec![
        ("/pkg-d.exe.sha256", 200, sidecar.into_bytes()),
        ("/pkg-d.exe", 200, body.clone()),
    ]);
    let ast = asset("pkg-d.exe", &format!("{base}/pkg-d.exe"), body.len() as u64);
    let path = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None))
        .expect("边车哈希校验通过应成功");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());

    // 边车内容与实际不符 → HashMismatch（fail-closed 不放松）。
    let bad = format!("{}  pkg-d.exe\n", sha256_hex(b"not-the-body"));
    let base2 = spawn_http_server(vec![
        ("/pkg-d.exe.sha256", 200, bad.into_bytes()),
        ("/pkg-d.exe", 200, body.clone()),
    ]);
    let ast2 = asset("pkg-d-2.exe", &format!("{base2}/pkg-d.exe"), body.len() as u64);
    let err = tauri::async_runtime::block_on(download_to_temp(&ast2, |_, _| {}, None)).unwrap_err();
    assert!(matches!(err, UpdaterError::HashMismatch { .. }), "边车不符应硬失败：{err:?}");
}

/// 场景 E（毒化 URL）：资产 URL 指向非白名单 host / 非 https scheme →
/// 下载门禁（assert_download_url_allowed，经 stream_to_file 首行）拒绝，
/// 请求不外发（门禁在 send 之前）。
#[test]
fn scenario_e_poisoned_url_rejected_by_gate() {
    for url in [
        "https://evil-mirror.example.com/DSH-Desktop-Setup-0.5.3-win-x64.exe",
        "http://203.0.113.10/payload.exe", // http 且非回环
        "file:///C:/Windows/evil.exe",
        "ftp://github.com/x.exe",
    ] {
        let ast = asset("poison.exe", url, 1);
        let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None)).unwrap_err();
        match err {
            UpdaterError::Download(ref m) => {
                assert!(m.contains("白名单") || m.contains("非法"), "应被 URL 门禁拒绝：{url} → {m}");
            }
            other => panic!("毒化 URL {url} 应被门禁拒绝，得 {other:?}"),
        }
    }
    // 回环 http 放行（本地测试面）——门禁不是一刀切禁 http。
    let base = spawn_http_server(vec![("/ok.exe", 200, b"loopback-ok".to_vec())]);
    let ast = asset("loopback-ok.exe", &format!("{base}/ok.exe"), 11);
    let path = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, Some(&sha256_hex(b"loopback-ok"))))
        .expect("回环 http + 显式 digest 应放行");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

/// 镜像 tag 滞后边界（场景 A 补充）：tag 分歧时取严格更新者（Gitee 滞后
/// 不打折；私有 resolve_outcome 版由编入单测
/// resolve_gitee_lagging_tag_loses_to_newer_github 覆盖）。
#[test]
fn scenario_a_edge_gitee_lagging_tag() {
    assert_eq!(cmp_semver("0.5.3", "0.5.2"), std::cmp::Ordering::Greater, "GitHub v0.5.3 严格新于 Gitee v0.5.2 → 取 GitHub");
}
