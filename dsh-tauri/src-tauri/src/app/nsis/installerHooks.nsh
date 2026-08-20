; DSH Desktop（Tauri 版）NSIS 安装钩子 —— Electron 版无痛升级链
; ==========================================================================
; 目标：旧用户（Electron NSIS 安装版）双击 Tauri 版安装包 →
;   1. 检测旧版正在运行 → 提示关闭（不杀进程，避免会话数据风险）
;   2. 检测旧版安装（Add/Remove Programs，DisplayName = "DSH Desktop"）
;   3. 静默运行旧版卸载器：`<uninstall> /S /KEEP_APP_DATA --updated`
;      （0.4.1+ 卸载器识别 /KEEP_APP_DATA：保留 %APPDATA%\dsh-desktop 与 ~/.dsh 全部数据）
;   4. 继续安装新版 → 数据原地保留，用户零感知
;
; 数据安全保证：
;   - 本钩子绝不触碰 $APPDATA 与 $PROFILE\.dsh
;   - 旧卸载器带 /KEEP_APP_DATA（无该参数的极旧版卸载器会保数据吗？
;     0.4.0 及更早卸载器在「更新场景」默认保留数据；/S 静默路径同样保留——
;     docs/upgrade-guide.md 有逐版本说明）
;   - 若卸载器定位失败：跳过卸载直接安装（两版本可共存，数据仍不受影响）

!macro NSIS_HOOK_PREINSTALL
  ; ---- 1) 进程占用检测（Electron 版进程名 dsh-desktop.exe / 本版 DSH Desktop.exe）----
  TryClose:
  ${If} ${ProcessExists} "dsh-desktop.exe"
  ${OrIf} ${ProcessExists} "DSH Desktop.exe"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "检测到 DSH Desktop 正在运行。$\n$\n请先完全退出（托盘右键 → 退出），然后点击「重试」继续升级。$\n选择「取消」将中止安装（不会做任何更改）。" \
      IDRETRY TryClose IDCANCEL AbortInstall
    Goto AbortInstall
  ${EndIf}
  Goto DoneProc

  AbortInstall:
    Abort

  DoneProc:

  ; ---- 2) 定位旧版（Electron NSIS）卸载注册表项 ----
  ; electron-builder perUser 安装：HKCU Uninstall 键（GUID 或 appId 命名）；
  ; 兼容 perMachine：HKLM 同查。按 DisplayName = "DSH Desktop" 精确匹配。
  StrCpy $R0 ""   ; 卸载命令

  SetRegView 64
  Push "DSH Desktop"
  Call FindLegacyUninstall
  Pop $R0

  ${If} $R0 == ""
    SetRegView 32
    Push "DSH Desktop"
    Call FindLegacyUninstall
    Pop $R0
  ${EndIf}

  ${If} $R0 != ""
    DetailPrint "检测到旧版 DSH Desktop，正在保数据静默卸载…"
    ; 剥离可能的引号与参数，取纯路径
    StrCpy $R1 $R0 "" 1            ; 去首个引号
    StrCpy $R1 $R1 1 -1            ; 去末个引号（若原始带引号）
    ${If} ${FileExists} "$R1"
      ; ---- 3) 静默卸载 + 保数据（KEEP_APP_DATA 是 0.4.1+ 协议；--updated 兼容更早）----
      ExecWait '"$R1" /S /KEEP_APP_DATA --updated' $R2
      DetailPrint "旧版卸载退出码：$R2"
      ; 等待卸载器收尾（文件释放）
      Sleep 1500
    ${Else}
      DetailPrint "旧版卸载器路径无效（$R1），跳过卸载，直接安装新版"
    ${EndIf}
  ${Else}
    DetailPrint "未检测到旧版 DSH Desktop（全新安装）"
  ${EndIf}

  SetRegView 64
!macroend

; ---------------------------------------------------------------------------
; FindLegacyUninstall：在 HKCU/HKLM Uninstall 下按 DisplayName 找卸载串。
; 栈输入：显示名；栈输出：卸载命令（UninstallString，找不到返回 ""）。
; ---------------------------------------------------------------------------
Function FindLegacyUninstall
  Exch $R3            ; 显示名
  Push $R4            ; 注册表根循环游标
  Push $R5            ; 键句柄
  Push $R6            ; 当前 DisplayName
  StrCpy $R4 0

  FindLoop:
    ; 枚举 HKCU
    EnumRegKey $R5 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    StrCmp $R5 "" TryHKLM
    ReadRegStr $R6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "DisplayName"
    StrCmp $R6 $R3 FoundHKCU
    IntOp $R4 $R4 + 1
    Goto FindLoop

  FoundHKCU:
    ReadRegStr $R7 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
    StrCpy $R3 $R7
    Goto Done

  TryHKLM:
    StrCpy $R4 0
  FindLoopHKLM:
    EnumRegKey $R5 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    StrCmp $R5 "" NotFound
    ReadRegStr $R6 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "DisplayName"
    StrCmp $R6 $R3 FoundHKLM
    IntOp $R4 $R4 + 1
    Goto FindLoopHKLM

  FoundHKLM:
    ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
    StrCpy $R3 $R7
    Goto Done

  NotFound:
    StrCpy $R3 ""

  Done:
    Pop $R6
    Pop $R5
    Pop $R4
    Exch $R3           ; 返回卸载命令（或空串）
FunctionEnd
