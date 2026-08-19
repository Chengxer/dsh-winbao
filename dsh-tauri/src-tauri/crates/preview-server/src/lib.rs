//! # preview-server —— 只读静态服务
//!
//! 对齐 Electron 版 main.js 的内置静态服务（端口预览 + recovery 页载体）。
//! 约束：仅监听 `127.0.0.1`；只读；目录穿越拒绝；无 CGI/无写入。
//!
//! Phase 0 交付**可用的最小实现**（std TcpListener + 手写 HTTP/1.0 应答，
//! 零依赖）——它同时是 PoC-A 的页面载体（PoC 页经 `http://127.0.0.1:<port>`
//! 提供，逼真复现「远程页 IPC」链路，与未来内核 Web UI 完全同形态）。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;

/// 服务句柄：后台线程 + 关停。
pub struct PreviewServer {
    pub port: u16,
    root: PathBuf,
    /// 测试/关停用：置 true 后下一个连接处理完退出。
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl PreviewServer {
    /// 在 127.0.0.1 的随机端口上启动（root 为文件系统根）。
    pub fn start(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let root = root.into();
        let thread_root = root.clone();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop2 = stop.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if stop2.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                if let Ok(s) = stream {
                    let root = thread_root.clone();
                    thread::spawn(move || handle(s, &root));
                }
            }
        });
        Ok(Self { port, root, stop })
    }

    /// 该服务上某文件的 URL。
    pub fn url(&self, rel: &str) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, rel.trim_start_matches('/'))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 请求关停（异步，等待在途连接结束）。
    pub fn stop(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn handle(mut stream: TcpStream, root: &Path) {
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).unwrap_or("/");
    // 去查询串；只允许 GET。
    let path = path.split('?').next().unwrap_or("/");
    if !req.starts_with("GET ") {
        let _ = write_response(&mut stream, 405, "text/plain; charset=utf-8", b"method not allowed");
        return;
    }
    let rel = path.trim_start_matches('/');
    let rel = percent_decode(rel);
    // 穿越防御：任何 `..` 组件直接 403（静态只读服务不接受相对回溯）；
    // 盘符前缀/多余根同样拒绝。
    let mut target = PathBuf::new();
    for comp in Path::new(&rel).components() {
        use std::path::Component::*;
        match comp {
            Prefix(_) | RootDir | ParentDir => {
                let _ = write_response(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden");
                return;
            }
            CurDir => {}
            Normal(c) => target.push(c),
        }
    }
    let full = root.join(target);
    match std::fs::read(&full) {
        Ok(body) => {
            let mime = mime_of(&full);
            let _ = write_response(&mut stream, 200, mime, &body);
        }
        Err(_) => {
            let _ = write_response(&mut stream, 404, "text/plain; charset=utf-8", b"not found");
        }
    }
}

fn write_response(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let head = format!("HTTP/1.0 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_file_with_mime() {
        let dir = std::env::temp_dir().join(format!("dsh-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.html"), b"<h1>hi</h1>").unwrap();
        let srv = PreviewServer::start(&dir).unwrap();
        let mut resp = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        resp.write_all(format!("GET /x.html HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).unwrap();
        let mut body = String::new();
        resp.read_to_string(&mut body).unwrap();
        assert!(body.starts_with("HTTP/1.0 200 OK"), "{body}");
        assert!(body.contains("Content-Type: text/html"));
        assert!(body.ends_with("<h1>hi</h1>"));
        srv.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn traversal_forbidden_and_missing_404() {
        let dir = std::env::temp_dir().join(format!("dsh-preview-t-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"A").unwrap();
        let srv = PreviewServer::start(&dir).unwrap();
        let get = |path: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
            s.write_all(format!("GET {path} HTTP/1.0\r\n\r\n").as_bytes()).unwrap();
            let mut b = String::new();
            s.read_to_string(&mut b).unwrap();
            b
        };
        assert!(get("/../a.txt").starts_with("HTTP/1.0 403"), "穿越必须 403");
        assert!(get("/nope.txt").starts_with("HTTP/1.0 404"));
        srv.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mime_map() {
        assert_eq!(mime_of(Path::new("/a/b.JS")), "text/javascript; charset=utf-8");
        assert_eq!(mime_of(Path::new("/a/b.svg")), "image/svg+xml");
        assert_eq!(mime_of(Path::new("/a/b.bin")), "application/octet-stream");
    }
}
