//! 构建脚本：tauri-build 资源生成 + Windows manifest 对所有产物（含测试 exe）注入。

fn main() {
    // Windows 集成测试修复（tauri 已知 bug #13419/#13948/#14580）：
    // tauri-build 的 tauri-winres::compile 只把 app manifest 嵌进主 bin，
    // 测试 exe（tests/*.rs）无 manifest → 加载器解析 comctl32 SxS 依赖失败
    // → STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139）启动即崩。
    // 解法（tauri 官方仓库自用姿势）：关掉 tauri-build 的 manifest 注入，
    // 改用 embed_resource::compile_for_everything 把同一份 manifest 嵌进
    // 所有产物（bin / tests / benches）。
    let mut attributes = tauri_build::Attributes::new();
    #[cfg(windows)]
    {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        // windows-app.rc（静态文件：资源类型 24 = manifest，ID 1 = exe 默认
        // 清单）引用同目录 windows-app.manifest，embed-resource 编译后经
        // rustc-link-arg 链进所有产物——与 tauri-winres 同套路（tauri-winres
        // 只有 compile() 嵌主 bin，测试 exe 拿不到，故绕行）。
        embed_resource::compile_for_everything("windows-app.rc", None::<&str>)
            .manifest_required()
            .expect("app manifest 必须嵌入（含测试 exe）");
    }
    tauri_build::try_build(attributes).expect("tauri-build 失败");
    println!("cargo:rerun-if-changed=windows-app.manifest");
    println!("cargo:rerun-if-changed=windows-app.rc");
}
