; DSH Desktop（Tauri 版）NSIS 安装钩子
; ==========================================================================
; v0.5.0 发布教训：多轮迭代 PREINSTALL 钩子（进程检测 + 注册表扫描 +
; 旧版卸载 + 目录采纳）始终在部分用户机上卡死（NSIS 栈序/strip 引号/
; 模式变量/ExecWait UAC/C# 卸载器自提权——五轮修五轮还有新根因）。
;
; 终极方案：整个 PREINSTALL 钩子置空。Tauri NSIS 模板已自带：
;   · 进程检测（CheckIfAppIsRunning）——检测当前 productName 进程
;   · 安装位置复用（RestorePreviousInstallLocation）——读自身旧键
;   · 文件覆盖安装——旧版目录直接覆盖，数据目录（~/.dsh 与
;     %APPDATA%\dsh-desktop）天然不受影响
;
; 需要清理旧版注册表键的场景（Electron→Tauri 升级）由应用首次启动时
; 的 sidecar boot 链处理（sync/companion-profile 自愈），不再由
; 安装器承担。这消除了 ALL 可能的安装器卡死点。
!macro NSIS_HOOK_PREINSTALL
  ; v0.5.1：PREINSTALL 置空（五轮修复后仍有用户卡死的教训——安装器
  ; 的唯一职责是装文件，清理逻辑交给应用运行时）。
  DetailPrint "PREINSTALL: skip (Tauri template handles process check & location)"
!macroend
