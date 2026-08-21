//! 二进制入口：只调 `dsh_tauri_app::run()`（装配逻辑全在 lib，main 仅接线）。

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_tauri_app::run()
}
