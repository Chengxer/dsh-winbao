; DSH Desktop（Tauri 版）NSIS 安装钩子 —— Electron 版无痛升级链
; ==========================================================================
; 实测驱动的三版演进：
;   v1 单键检测 → v2 InstallLocation 捕获 → v3 多键并存清扫（本版）
;
; 用户机器真实注册表形态（2026-08-20 实测，驱动本版设计）：
;   键A  DisplayName="DSH Desktop"  InstallLocation=（空）
;        UninstallString="D:\app\dsh\DSH Desktop\Uninstall_DSH_Desktop.exe"（自研卸载器）
;   键B  DisplayName="DSH Desktop"  InstallLocation="D:\app\DSH Desktop"（带引号！）
;        （Tauri 自家上次安装写的键——Electron 键与 Tauri 键【同名并存】）
;
; 流程（NSIS_HOOK_PREINSTALL 运行于 Section Install 首行 SetOutPath 之后、
; 文件复制之前——此处改写 $INSTDIR + SetOutPath，后续 File/快捷方式/卸载
; 登记全部落新值）：
;   1. 进程检测（两代 exe 名：现版 "DSH Desktop.exe"（productName，实测
;      主 exe 真名）/ 旧版 dsh-desktop.exe）
;   2. 两遍扫描所有 DisplayName="DSH Desktop" 键（HKCU/HKLM × regview 64/32）：
;      Pass1（choose）选目录：优先「活体 Electron 目录」（目录内有
;        DSH Desktop.exe / dsh-desktop.exe / Uninstall DSH Desktop.exe 任一
;        标记）；无活体 Electron 则不选——Tauri 模板
;        RestorePreviousInstallLocation 已自动复用 Tauri 自家旧目录。
;      Pass2（purge）逐键静默卸载（键键都清，杜绝残留 ARP 项）：
;        Electron 卸载器（"Uninstall DSH Desktop.exe"官方 /
;        "Uninstall_DSH_Desktop.exe"自研）→ `/S /KEEP_APP_DATA --updated`；
;        Tauri 模板卸载器（固定名 uninstall.exe）→ `/S`。
;        每个带自删轮询 ≤15s（NSIS 卸载器 copy-to-temp 语义下 ExecWait
;        可能提前返回，固定 Sleep 不可靠）。
;   3. 装回选定目录（可写性试探；Program Files 无权 → 回退默认，不硬撑）。
;
; 数据安全保证：
;   - 本钩子绝不触碰 $APPDATA 与 $PROFILE\.dsh
;   - Electron 卸载器带 /KEEP_APP_DATA（无该参数的极旧版在「更新场景」默认
;     保留数据——docs/upgrade-guide.md 逐版本说明）
;   - 卸载器定位失败：跳过卸载直接安装（数据不受影响）

!include "FileFunc.nsh"   ; GetParent（模板亦含；标准头自守护，重复包含安全）

; 单根扫描：枚举 Uninstall 下 DisplayName = "DSH Desktop" 的键，逐个交给
; 对应根的壳函数（ReadRegStr 需编译期根字面量，故按根实例化）。
!macro LegacyScanRoot ROOT UID
  Push $R0
  Push $R4
  Push $R5
  StrCpy $R4 0
  LegacyScan_loop_${ROOT}_${UID}:
    EnumRegKey $R5 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    StrCmp $R5 "" LegacyScan_done_${ROOT}_${UID}
    ReadRegStr $R6 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "DisplayName"
    StrCmp $R6 "DSH Desktop" 0 LegacyScan_next_${ROOT}_${UID}
      Push $R5
      Call LegacyHandleEntry${ROOT}
      Pop $R6
      StrCmp $R6 "1" 0 LegacyScan_norescan_${ROOT}_${UID}
        ; V4 walkthrough #5 (HIGH): purge deletes keys during enumeration which
        ; shifts subsequent indices (skips keys ~50% in dual-key case). Any key
        ; handled (uninstall/removed) restarts enumeration from index 0.
        StrCpy $R4 -1
      LegacyScan_norescan_${ROOT}_${UID}:
    LegacyScan_next_${ROOT}_${UID}:
      IntOp $R4 $R4 + 1
      Goto LegacyScan_loop_${ROOT}_${UID}
  LegacyScan_done_${ROOT}_${UID}:
  Pop $R5
  Pop $R4
  Pop $R0
!macroend

; 共享键处理逻辑（在壳函数内展开）：
;   输入 $R1=卸载器路径（已去引号）  $R2=InstallLocation（已去引号）
;         $R9=模式   输出：choose → $R8（活体 Electron 目录，首个胜出）
!macro LegacyActOnEntry ROOT
  ; 目录候选：InstallLocation 优先，空则卸载器父目录
  StrCpy $R3 "$R2"
  ${If} $R3 == ""
  ${AndIf} "$R1" != ""
    ${GetParent} "$R1" $R3
  ${EndIf}

  ${If} $R9 == "choose"
    ${If} "$R3" != ""
      IfFileExists "$R3\DSH Desktop.exe" LaeLive 0
      IfFileExists "$R3\dsh-desktop.exe" LaeLive 0
      IfFileExists "$R3\Uninstall DSH Desktop.exe" LaeLive 0
      IfFileExists "$R3\Uninstall_DSH_Desktop.exe" LaeLive LaeNoLive
      LaeLive:
        ${If} $R8 == ""
          StrCpy $R8 "$R3"
          DetailPrint "选定旧版安装位置（活体 Electron）：$R8"
        ${EndIf}
      LaeNoLive:
    ${EndIf}
    Push ""
    Goto LaeDone
  ${Else}
    ; purge：键键都清。V4 walkthrough fixes:
    ;  #3 stale key without uninstaller file -> DeleteRegKey directly.
    ;  #11 currentUser no elevation: HKLM machine-wide old version uninstaller
    ;     may pop UAC and hang ExecWait -> only clear the key, never run it.
    ;  #7 poll cap 30->120 (60s) for slow machines deleting 543MB node_modules.
    ;  #6 case variants for Tauri uninstaller name (StrCmp is case-sensitive).
    ${If} "$R1" != ""
    ${AndIf} ${FileExists} "$R1"
      !if "${ROOT}" == "HKLM"
        DetailPrint "HKLM 机装旧版（键 $R5）：跳过卸载器（避免 UAC 挂死），仅清键"
        DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
        Push "1"
        Goto LaeDone
      !else
      StrCpy $R6 "$R1" "" -13
      StrCmp $R6 "uninstall.exe" LaeTauri
      StrCmp $R6 "Uninstall.exe" LaeTauri LaeElectron
      LaeElectron:
        DetailPrint "静默卸载旧版（保数据）：$R1"
        ExecWait '"$R1" /S /KEEP_APP_DATA --updated' $R0
        Goto LaeWait
      LaeTauri:
        DetailPrint "静默卸载旧 Tauri 安装：$R1"
        ExecWait '"$R1" /S' $R0
      LaeWait:
        StrCpy $R4 0
      LaePoll:
        IfFileExists "$R1" LaePollNext LaePollDone
      LaePollNext:
        Sleep 500
        IntOp $R4 $R4 + 1
        IntCmp $R4 120 LaePollDone LaePoll
      LaePollDone:
      Push "1"
      Goto LaeDone
      !endif
    ${Else}
      DetailPrint "陈旧键（无卸载器文件）清除：$R5"
      DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
      Push "1"
      Goto LaeDone
    ${EndIf}
  ${EndIf}
  Push ""
  LaeDone:
!macroend


; ---------------------------------------------------------------------------
; ProcessLegacyDSH：出参 $R8 = 选定旧安装目录（空 = 沿用模板默认/自复用）。
; $R9 = 模式（choose / purge）。$R8 不入栈（唯一出参）。
; ---------------------------------------------------------------------------
Function ProcessLegacyDSH
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R9
  StrCpy $R8 ""

  StrCpy $R9 "choose"
  SetRegView 64
  !insertmacro LegacyScanRoot HKCU 1
  !insertmacro LegacyScanRoot HKLM 2
  SetRegView 32
  !insertmacro LegacyScanRoot HKLM 3
  SetRegView 64

  StrCpy $R9 "purge"
  SetRegView 64
  !insertmacro LegacyScanRoot HKCU 5
  !insertmacro LegacyScanRoot HKLM 4
  SetRegView 32
  !insertmacro LegacyScanRoot HKLM 6
  SetRegView 64

  Pop $R9
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function LegacyHandleEntryHKCU
  Exch $R5   ; 子键名
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R6
  Push $R7
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
  ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
  Push $R1
  Call LegacyStripQuotes
  Pop $R1
  Push $R2
  Call LegacyStripQuotes
  Pop $R2
  !insertmacro LegacyActOnEntry HKCU
  Pop $R7
  Pop $R6
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $R5
FunctionEnd

Function LegacyHandleEntryHKLM
  Exch $R5   ; 子键名
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R6
  Push $R7
  ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
  ReadRegStr $R2 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
  Push $R1
  Call LegacyStripQuotes
  Pop $R1
  Push $R2
  Call LegacyStripQuotes
  Pop $R2
  !insertmacro LegacyActOnEntry HKLM
  Pop $R7
  Pop $R6
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $R5
FunctionEnd

; 去首尾引号（InstallLocation/UninstallString 实测带引号；无引号不动）。
Function LegacyStripQuotes
  Exch $R3
  StrCpy $R7 $R3 1
  StrCmp $R7 '"' 0 LsqDone
    StrCpy $R3 $R3 "" 1
    StrCpy $R7 $R3 1 -1
    StrCmp $R7 '"' 0 LsqDone
      StrCpy $R3 $R3 1 -1
  LsqDone:
  Exch $R3
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; ---- 1) 进程检测（两代 exe 名；不杀进程——数据风险由用户手动退出承担；
  ;      本版 exe 的检测由模板紧随的 CheckIfAppIsRunning 处理）----
  TryCloseLegacy:
    nsis_tauri_utils::FindProcess "DSH Desktop.exe"
    Pop $R0
    ${If} $R0 <> 0
      nsis_tauri_utils::FindProcess "dsh-desktop.exe"
      Pop $R0
    ${EndIf}
    ${If} $R0 = 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "检测到 DSH Desktop 正在运行。$\n$\n请先完全退出（托盘右键 → 退出），然后点击「重试」继续升级。$\n选择「取消」将中止安装（不会做任何更改）。" \
        IDRETRY TryCloseLegacy IDCANCEL AbortInstallLegacy
      Goto AbortInstallLegacy
    ${EndIf}
    Goto DoneProcLegacy

  AbortInstallLegacy:
    Abort

  DoneProcLegacy:

  ; ---- 2) 多键扫描：选目录 + 全键静默卸载 ----
  Call ProcessLegacyDSH

  ; ---- 3) 装回旧位置 ----
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
!macroend
