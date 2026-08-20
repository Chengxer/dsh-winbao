; DSH Desktop（Tauri 版）NSIS 安装钩子 —— Electron 版无痛升级链
; ==========================================================================
; 目标：旧用户（Electron NSIS 安装版）双击 Tauri 版安装包 →
;   1. 检测旧版正在运行 → 提示关闭（不杀进程，避免会话数据风险）
;   2. 检测旧版安装（Add/Remove Programs，DisplayName = "DSH Desktop"），
;      同时捕获同键 InstallLocation（旧版安装目录）
;   3. 静默运行旧版卸载器：`<uninstall> /S /KEEP_APP_DATA --updated`
;      （0.4.1+ 卸载器识别 /KEEP_APP_DATA：保留 %APPDATA%\dsh-desktop 与 ~/.dsh 全部数据）
;   4. 装回旧版安装位置（改写 $INSTDIR + SetOutPath，可写性试探失败则
;      回退默认目录）→ 数据原地保留、目录不变、快捷方式不分裂，用户零感知
;
; 数据安全保证：
;   - 本钩子绝不触碰 $APPDATA 与 $PROFILE\.dsh
;   - 旧卸载器带 /KEEP_APP_DATA（无该参数的极旧版卸载器会保数据吗？
;     0.4.0 及更早卸载器在「更新场景」默认保留数据；/S 静默路径同样保留——
;     docs/upgrade-guide.md 有逐版本说明）
;   - 若卸载器定位失败：跳过卸载直接安装（两版本可共存，数据仍不受影响）

!macro NSIS_HOOK_PREINSTALL
  ; ---- 1) 旧版（Electron）进程占用检测 ----
  ; 用模板同款 nsis_tauri_utils 插件（LogicLib 数字比较；FindProcess 查全会话，
  ; 旧版可能 perMachine 安装）。不杀进程——Electron 内核持有会话数据写入，
  ; 强杀有数据风险，让用户手动退出。
  ; 本版 exe（DSH Desktop.exe）的运行检测由模板紧随本钩子的
  ; CheckIfAppIsRunning 处理（含静默杀 + 重试 UI），无需重复。
  TryCloseLegacy:
    nsis_tauri_utils::FindProcess "dsh-desktop.exe"
    Pop $R0
    ${If} $R0 = 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "检测到旧版 DSH Desktop（Electron）正在运行。$\n$\n请先完全退出（托盘右键 → 退出），然后点击「重试」继续升级。$\n选择「取消」将中止安装（不会做任何更改）。" \
        IDRETRY TryCloseLegacy IDCANCEL AbortInstallLegacy
      Goto AbortInstallLegacy
    ${EndIf}
    Goto DoneProcLegacy

  AbortInstallLegacy:
    Abort

  DoneProcLegacy:

  ; ---- 2) 定位旧版（Electron NSIS）卸载注册表项 ----
  ; electron-builder perUser 安装：HKCU Uninstall 键（GUID 或 appId 命名）；
  ; 兼容 perMachine：HKLM 同查。按 DisplayName = "DSH Desktop" 精确匹配。
  ; FindLegacyUninstall 同时经 $R8 带回同键的 InstallLocation（旧版安装目录，
  ; 必须在静默卸载前捕获——卸载后注册表键即消失）。
  StrCpy $R0 ""   ; 卸载命令
  StrCpy $R8 ""   ; 旧版安装目录（InstallLocation）
  StrCpy $R9 ""   ; 备用：卸载器父目录

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
    DetailPrint "检测到旧版 DSH Desktop（目录：$R8），正在保数据静默卸载…"
    ; 剥离可能的引号与参数，取纯路径
    StrCpy $R1 $R0 "" 1            ; 去首个引号
    StrCpy $R1 $R1 1 -1            ; 去末个引号（若原始带引号）
    ; InstallLocation 缺失时用卸载器父目录兜底（electron-builder 卸载器
    ; 就装在安装根）。
    ${If} $R8 == ""
      ${GetParent} "$R1" $R9
      StrCpy $R8 $R9
    ${EndIf}
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

  ; ---- 4) 装回旧位置（用户诉求：升级不换目录，避免两份并存/快捷方式分裂）----
  ; 本钩子运行于 Section Install 首行 SetOutPath 之后、文件复制之前——
  ; 在此改写 $INSTDIR 并重新 SetOutPath，后续 File/CreateDirectory/快捷方式
  ; /卸载登记全部落到旧目录。可写性试探：旧版若 perMachine 装在
  ; Program Files 而当前用户无权写入，则回退模板默认目录（不硬撑）。
  ${If} $R8 != ""
    ClearErrors
    CreateDirectory "$R8"
    FileOpen $R6 "$R8\.__dsh_write_test" w
    ${If} ${Errors}
      DetailPrint "旧目录不可写（$R8），回退默认安装目录"
    ${Else}
      FileClose $R6
      Delete "$R8\.__dsh_write_test"
      StrCpy $INSTDIR "$R8"
      SetOutPath "$INSTDIR"
      DetailPrint "沿用旧版安装位置：$INSTDIR"
    ${EndIf}
  ${EndIf}

  SetRegView 64
!macroend

; ---------------------------------------------------------------------------
; FindLegacyUninstall：在 HKCU/HKLM Uninstall 下按 DisplayName 找卸载串。
; 栈输入：显示名；栈输出：卸载命令（UninstallString，找不到返回 ""）。
; 副作用（全局寄存器出参）：$R8 = 同键 InstallLocation（旧版安装目录，
; 可能为空）——调用方必须在静默卸载前读取（卸载后注册表键消失）。
; ---------------------------------------------------------------------------
Function FindLegacyUninstall
  Exch $R3            ; 显示名
  Push $R4            ; 注册表根循环游标
  Push $R5            ; 键句柄
  Push $R6            ; 当前 DisplayName
  StrCpy $R8 ""
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
    ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
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
    ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
    Goto Done

  NotFound:
    StrCpy $R3 ""

  Done:
    Pop $R6
    Pop $R5
    Pop $R4
    Exch $R3           ; 返回卸载命令（或空串）
FunctionEnd
