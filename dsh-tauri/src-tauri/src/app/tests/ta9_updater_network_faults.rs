//! TA9 混沌测试 —— 网络故障 × 客户端更新引擎（updater_client）。
//!
//! 手法：`#[path]` 把实现源**只读编入**（字节一致 = 测的就是生产实现，
//! session_notify_boundary.rs 同手法）。实现文件的内联单测随之在本测试
//! 二进制里重跑（等价加压；其中 cache_sha256/cache_alt_url 种子化的
//! 换源重试场景由内联单测覆盖，本文件走公共 API 面注入行为故障）。
//!
//! 故障注入全部在本地回环 server 的**行为**里模拟（沙箱内，绝不断真实网络）：
//!   1. 下载中途提前 close（server 发一半即断：RST/提前关闭在 reqwest 侧
//!      同样表现为流中断 chunk 错误）；
//!   2. Content-Length 谎报（声明 N 实发 M < N 后干净关闭）；
//!   3. 302 重定向到白名单外 host（.invalid 保留域，DNS 必败）；
//!   4. 下载 URL 门禁矩阵（经公共入口 download_to_temp 观测：白名单外
//!      host / 远程明文 http / file:// 直拒，不发任何网络请求）；
//!   5. 极慢 drip（对照：容忍慢但不死挂）；
//!   6. 边车 200 但内容是 HTML 错误页（非 64hex → 弃用；无锚 + 小体积
//!      setup → 50MB 下限拒装）；
//!   7. 组合故障：主源哈希错（边车锚与字节不符）+ 换源也错（同样锚不符）
//!      → fail-closed + 清理半截包。

#![allow(dead_code)]

#[path = "../src/commands/updater_client.rs"]
mod updater_live;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use sha2::{Digest, Sha256};
use updater_live::{download_to_temp, ReleaseAsset, UpdaterError};

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

fn asset(name: &str, url: String, size: u64) -> ReleaseAsset {
    ReleaseAsset { name: name.into(), url, size }
}

/// 系统临时目录里是否还有名字含 marker 的 dsh-update-* 残留（失败清理断言用）。
fn temp_leftover(marker: &str) -> bool {
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("dsh-update-"))
        .any(|e| {
            std::fs::read_dir(e.path())
                .map(|d| d.flatten().any(|f| f.file_name().to_string_lossy().contains(marker)))
                .unwrap_or(false)
        })
}

// ---------------------------------------------------------------------------
// 行为注入式本地 HTTP server
// ---------------------------------------------------------------------------

enum Action {
    /// 干净响应（对照组）。
    Ok(Vec<u8>),
    /// 声明完整 Content-Length、只发一半，然后立即断开（提前 close / RST 形态）。
    CloseMidstream(Vec<u8>),
    /// 谎报 Content-Length = body.len() + extra，实发 body 后干净关闭（提前断流）。
    LieContentLength { body: Vec<u8>, extra: u64 },
    /// 302 跳指定 Location。
    Redirect(String),
    /// 极慢 drip：分片慢发。
    Drip { body: Vec<u8>, chunk: usize, delay_ms: u64 },
}

fn spawn_injectable_server(routes: Vec<(&str, Action)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let routes = std::sync::Arc::new(std::sync::Mutex::new(
        routes.into_iter().map(|(p, a)| (p.to_string(), a)).collect::<Vec<_>>(),
    ));
    std::thread::spawn(move || {
        for _ in 0..16 {
            let Ok((mut sock, _)) = listener.accept() else { return };
            let routes = routes.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                let mut head = Vec::new();
                loop {
                    match sock.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            head.extend_from_slice(&buf[..n]);
                            if head.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let line = String::from_utf8_lossy(&head);
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let action = {
                    let mut g = routes.lock().unwrap();
                    if let Some(i) = g.iter().position(|(p, _)| *p == path) {
                        Some(g.remove(i).1)
                    } else if let Some(stripped) = path.strip_suffix(".sha256") {
                        g.iter().position(|(p, _)| p == stripped).map(|i| g.remove(i).1)
                    } else {
                        None
                    }
                };
                let Some(action) = action else {
                    let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = sock.write_all(resp.as_bytes());
                    return;
                };
                match action {
                    Action::Ok(body) => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes());
                        let _ = sock.write_all(&body);
                    }
                    Action::CloseMidstream(body) => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes());
                        let _ = sock.write_all(&body[..body.len() / 2]);
                        drop(sock); // 提前断开（未发满声明的长度）
                    }
                    Action::LieContentLength { body, extra } => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() as u64 + extra
                        );
                        let _ = sock.write_all(resp.as_bytes());
                        let _ = sock.write_all(&body);
                        // 干净半关闭：对端仍期待 extra 字节 → 流中断。
                    }
                    Action::Redirect(loc) => {
                        let resp = format!(
                            "HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = sock.write_all(resp.as_bytes());
                    }
                    Action::Drip { body, chunk, delay_ms } => {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes());
                        for piece in body.chunks(chunk.max(1)) {
                            if sock.write_all(piece).is_err() {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(delay_ms));
                        }
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------
// 1. 下载中途提前断开（RST/提前 close 形态）
// ---------------------------------------------------------------------------

#[test]
fn download_closed_midstream_is_download_error_and_cleans_up() {
    let body: Vec<u8> = (0..8192u32).map(|i| (i % 251) as u8).collect();
    let base = spawn_injectable_server(vec![("/rst.bin", Action::CloseMidstream(body.clone()))]);
    let ast = asset("ta9-rst-9.9.9.bin", format!("{base}/rst.bin"), 0);
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, Some(&sha256_hex(&body)))).unwrap_err();
    assert!(matches!(err, UpdaterError::Download(_)), "提前断开应归 Download，得 {err:?}");
    assert!(!temp_leftover("ta9-rst"), "失败不留半截包");
}

// ---------------------------------------------------------------------------
// 2. Content-Length 谎报
// ---------------------------------------------------------------------------

#[test]
fn download_content_length_lie_is_download_error() {
    let body = b"only-ten!".to_vec();
    let base = spawn_injectable_server(vec![(
        "/lie.bin",
        Action::LieContentLength { body: body.clone(), extra: 4096 },
    )]);
    let ast = asset("ta9-lie-9.9.9.bin", format!("{base}/lie.bin"), 0);
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None)).unwrap_err();
    match err {
        UpdaterError::Download(m) => assert!(!m.is_empty(), "须有可读原因"),
        other => panic!("CL 谎报（流中断）应归 Download，得 {other:?}"),
    }
    assert!(!temp_leftover("ta9-lie"), "失败不留半截包");
}

// ---------------------------------------------------------------------------
// 3. 重定向到白名单外 host
// ---------------------------------------------------------------------------

#[test]
fn download_redirect_to_non_whitelisted_host_fails() {
    // 302 → http://ta9-evil.invalid/x：.invalid 是 RFC 保留域（沙箱内必 DNS 失败，
    // 不触真实网络）。reqwest 默认跟随重定向 → 最终请求必败 → Download。
    let base = spawn_injectable_server(vec![(
        "/hop.bin",
        Action::Redirect("http://ta9-evil.invalid/x.bin".into()),
    )]);
    let ast = asset("ta9-redir-9.9.9.bin", format!("{base}/hop.bin"), 0);
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None)).unwrap_err();
    assert!(matches!(err, UpdaterError::Download(_)), "跳白名单外 host 应失败为 Download，得 {err:?}");
    assert!(!temp_leftover("ta9-redir"));
}

/// URL 门禁（经公共入口观测：门禁在发请求**之前**生效，无 server 也能断言）。
#[test]
fn download_url_gate_matrix_via_public_entry() {
    let try_url = |url: &str| {
        let ast = asset("ta9-gate-9.9.9.bin", url.to_string(), 0);
        tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None))
    };
    // 白名单外 host：不建 server、不监听任何端口——被拒即证明门禁先行。
    for url in [
        "https://evil.example.com/a.exe",
        "http://93.184.216.34/a.exe",
        "http://ta9-evil.invalid/a.exe",
    ] {
        match try_url(url) {
            Err(UpdaterError::Download(m)) => assert!(m.contains("白名单"), "{url}: {m}"),
            other => panic!("{url} 应被门禁拒绝，得 {other:?}"),
        }
    }
    // 远程明文 http / file:// 直拒。
    match try_url("http://github.com/a.exe") {
        Err(UpdaterError::Download(m)) => assert!(m.contains("白名单") || m.contains("非法"), "明文远程 http 拒：{m}"),
        other => panic!("远程明文 http 应拒，得 {other:?}"),
    }
    match try_url("file:///C:/Windows/system32/whatever.exe") {
        Err(UpdaterError::Download(_)) => {}
        other => panic!("file:// 应拒，得 {other:?}"),
    }
    match try_url("not a url") {
        Err(UpdaterError::Download(_)) => {}
        other => panic!("非法 URL 应拒，得 {other:?}"),
    }
    assert!(!temp_leftover("ta9-gate"), "门禁拒绝不产生任何临时目录内容");
}

// ---------------------------------------------------------------------------
// 4. 极慢 drip（对照：慢而不死）
// ---------------------------------------------------------------------------

#[test]
fn download_slow_drip_still_succeeds() {
    let body: Vec<u8> = (0..2048u32).map(|i| (i % 241) as u8).collect();
    let base = spawn_injectable_server(vec![(
        "/drip.bin",
        Action::Drip { body: body.clone(), chunk: 128, delay_ms: 5 },
    )]);
    let ast = asset("ta9-drip-9.9.9.bin", format!("{base}/drip.bin"), body.len() as u64);
    let path = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, Some(&sha256_hex(&body))))
        .expect("drip 慢但完整 → 成功");
    assert_eq!(std::fs::read(&path).unwrap(), body);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// ---------------------------------------------------------------------------
// 5. 边车 200 但内容是 HTML 错误页 → 弃用（非 64hex → 不作为锚）
// ---------------------------------------------------------------------------

#[test]
fn sidecar_html_error_page_discarded_then_size_floor_rejects() {
    // HTML 错误页边车 → 解析不出 64hex → 弃用（不作为哈希锚，也不阻断流程）；
    // 无锚 setup exe → 50MB 下限兜底 → 错误页小体积拒装（HTML 装不成安装器）。
    let body = b"<html>tiny error page</html>".to_vec();
    let sidecar = b"<html>502 from CDN</html>".to_vec();
    let base = spawn_injectable_server(vec![
        ("/s.exe.sha256", Action::Ok(sidecar)),
        ("/s.exe", Action::Ok(body.clone())),
    ]);
    let ast = asset("ta9-html-Setup-9.9.9-win-x64.exe", format!("{base}/s.exe"), body.len() as u64);
    let err = tauri::async_runtime::block_on(download_to_temp(&ast, |_, _| {}, None)).unwrap_err();
    match err {
        UpdaterError::Download(m) => assert!(m.contains("下限") || m.contains("疑似损坏"), "错误页装不成安装器：{m}"),
        other => panic!("HTML 边车被弃用后应走大小兜底拒绝，得 {other:?}"),
    }
    assert!(!temp_leftover("ta9-html"));

    // 对照：同体积但边车给**正确** 64hex → 边车锚生效，放行（弃用的是
    // 「非 64hex 形态」，不是边车机制本身）。
    let small = b"tiny-but-authenticated".to_vec();
    let good_sidecar = format!("{}  tiny.exe\n", sha256_hex(&small)).into_bytes();
    let base2 = spawn_injectable_server(vec![
        ("/t.exe.sha256", Action::Ok(good_sidecar)),
        ("/t.exe", Action::Ok(small.clone())),
    ]);
    let ast2 = asset("ta9-html-ok-Setup-9.9.9-win-x64.exe", format!("{base2}/t.exe"), small.len() as u64);
    let path = tauri::async_runtime::block_on(download_to_temp(&ast2, |_, _| {}, None))
        .expect("合法 64hex 边车锚 → 放行");
    assert_eq!(std::fs::read(&path).unwrap(), small);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

// ---------------------------------------------------------------------------
// 6. 组合故障：主源哈希错（边车锚与字节不符）+ 换源也错
// ---------------------------------------------------------------------------

/// 组合失败的可诊断性现状：错误信息只含哈希失配（期望/实际），不含
/// 「主源 mismatch / 边车锚形态 / 换源重试」三类失败的逐路摘要——
/// 记录为 BUG-TA9-1（诊断性缺口，报告内成表），此处固化现状防回退。
#[test]
fn combined_fault_primary_and_alt_hash_wrong_fail_closed_with_cleanup() {
    let real = b"the-one-true-release-bytes".to_vec();
    let bad_primary = b"tampered-primary".to_vec();
    let bad_alt = b"tampered-alt".to_vec();
    // 边车锚 = 真哈希（「发布元数据说该是什么」）。
    let sidecar = format!("{}  x.exe\n", sha256_hex(&real)).into_bytes();
    let base = spawn_injectable_server(vec![
        ("/primary.exe.sha256", Action::Ok(sidecar.clone())),
        ("/primary.exe", Action::Ok(bad_primary.clone())),
        ("/alt.exe.sha256", Action::Ok(sidecar)),
        ("/alt.exe", Action::Ok(bad_alt.clone())),
    ]);
    // 第一路：主源字节 ≠ 边车锚 → HashMismatch 硬失败。
    let primary = asset("ta9-combined-Setup-9.9.9-win-x64.exe", format!("{base}/primary.exe"), bad_primary.len() as u64);
    let err1 = tauri::async_runtime::block_on(download_to_temp(&primary, |_, _| {}, None)).unwrap_err();
    match &err1 {
        UpdaterError::HashMismatch { expected, actual } => {
            assert_eq!(expected, &sha256_hex(&real));
            assert_eq!(actual, &sha256_hex(&bad_primary));
        }
        other => panic!("主源哈希错应 HashMismatch，得 {other:?}"),
    }
    // 第二路（换源重试的等价公共 API 面）：换源字节也 ≠ 同一锚 → 仍硬失败。
    let alt = asset("ta9-combined-alt-Setup-9.9.9-win-x64.exe", format!("{base}/alt.exe"), bad_alt.len() as u64);
    let err2 = tauri::async_runtime::block_on(download_to_temp(&alt, |_, _| {}, None)).unwrap_err();
    match &err2 {
        UpdaterError::HashMismatch { expected, actual } => {
            assert_eq!(expected, &sha256_hex(&real));
            assert_eq!(actual, &sha256_hex(&bad_alt));
        }
        other => panic!("换源哈希错应 HashMismatch，得 {other:?}"),
    }
    // 两路错误信息均不含逐路摘要（现状固化；修复后此断言应更新为「含摘要」）。
    for e in [&err1, &err2] {
        let msg = e.to_string();
        assert!(!msg.contains("换源") && !msg.contains("边车"), "BUG-TA9-1 现状：错误信息无逐路摘要：{msg}");
    }
    // fail-closed：两路失败都不留半截包。
    assert!(!temp_leftover("ta9-combined"), "组合失败后不得残留半截包");
}
