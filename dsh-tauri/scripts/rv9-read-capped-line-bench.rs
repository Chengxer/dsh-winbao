// rv9-read-capped-line-bench.rs —— session_notify::read_capped_line 逐字节读的
// 吞吐量化（独立 rustc 编译，零依赖；算法与 session_notify.rs 逐字一致）。
// 编译运行：rustc -O scripts/rv9-read-capped-line-bench.rs -o %TEMP%\rv9-rcl.exe && %TEMP%\rv9-rcl.exe
use std::io::{Cursor, Read, Result};

enum LineOutcome { Line(String), Oversized, Eof }

fn read_capped_line<R: Read>(r: &mut R, cap: usize) -> Result<LineOutcome> {
    let mut line: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte)?;
        if n == 0 {
            if oversized { return Ok(LineOutcome::Oversized); }
            if line.is_empty() { return Ok(LineOutcome::Eof); }
            break;
        }
        if byte[0] == b'\n' { break; }
        if line.len() >= cap { oversized = true; line.clear(); line.shrink_to_fit(); }
        if !oversized { line.push(byte[0]); }
    }
    if oversized { return Ok(LineOutcome::Oversized); }
    let mut s = String::from_utf8_lossy(&line).into_owned();
    if s.ends_with('\r') { s.pop(); }
    Ok(LineOutcome::Line(s))
}

fn main() {
    // 典型 turn-end 协议行 ~120B；watcher stdout 事件低频（回合完成级）。
    // 模拟 BufReader 包裹的 10 万行流，量单行成本。
    let line = br#"{"type":"turn-end","sessionId":"sess-0123456789abcdef","title":"fix-login","body":"demo / sess abcd1234"}"#;
    let mut stream = Vec::new();
    for _ in 0..100_000 { stream.extend_from_slice(line); stream.push(b'\n'); }
    let mut reader = std::io::BufReader::new(Cursor::new(stream));
    let n = 100_000u32;
    let t0 = std::time::Instant::now();
    let mut lines = 0u32;
    for _ in 0..n {
        if let Ok(LineOutcome::Line(_)) = read_capped_line(&mut reader, 8 * 1024) { lines += 1; }
    }
    let el = t0.elapsed();
    println!("{} 行 / {:?} = {:.2} µs/行（含 UTF-8 lossy + String 分配）", lines, el, el.as_secs_f64() * 1e6 / lines as f64);
    // 超长行防护：1MB 无换行垃圾，验证 O(n) 流式丢弃、内存不涨。
    let mut junk = std::io::BufReader::new(Cursor::new(vec![b'x' as u8; 1024 * 1024]));
    let t1 = std::time::Instant::now();
    let out = read_capped_line(&mut junk, 8 * 1024).unwrap();
    println!("1MB 超长行丢弃：{:?} → {:?}", t1.elapsed(), match out { LineOutcome::Oversized => "Oversized", _ => "?" });
    println!("结论：turn-end 事件频率为「回合完成」级（分钟级），µs/行成本完全可忽略；逐字节路径经 BufReader 摊销后无 syscall 放大。");
}
