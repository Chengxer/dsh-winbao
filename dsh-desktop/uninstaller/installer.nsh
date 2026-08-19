; DSH Desktop custom NSIS hooks.
;
; Replaces the default Electron-builder NSIS uninstaller with our custom
; Uninstall_DSH_Desktop.exe (built by scripts/build-uninstaller.ps1):
;   1. extraResources ships the exe into resources/Uninstall_DSH_Desktop.exe
;   2. this install hook copies it to $INSTDIR\Uninstall_DSH_Desktop.exe
;   3. both normal and quiet Add/Remove Programs entries are repointed to it.
;
; The custom uninstaller performs generic registry scanning, process shutdown,
; shortcut removal and optional user-data retention.

!macro customInit
  # ── 升级链路修复（2026-08 数据丢失事故）──────────────────────────────────
  # electron-builder 的 uninstallOldVersion（installSection 阶段）会把注册表
  # 里旧的 UninstallString 指向的卸载器拷到临时目录执行：
  #     old-uninstaller.exe /S /KEEP_APP_DATA --updated
  # 旧版自定义卸载器不识别这两个升级契约参数，静默模式下默认全删用户数据
  # （.dsh 的 sessions/settings/credentials 与 Roaming\DSH Desktop），导致
  # 每次覆盖升级都清空用户对话与配置。
  #
  # .onInit 早于 install section 执行：此处抢先把旧安装目录里的
  # Uninstall_DSH_Desktop.exe 覆盖为本安装包自带的修复版。升级时实际执行
  # 的"旧卸载器"即修复版——识别 /KEEP_APP_DATA 与 --updated，保留全部
  # 用户数据。仅当目标文件名匹配自定义卸载器时覆盖，绝不动默认 NSIS
  # 卸载器。覆盖失败不阻塞安装（CopyFiles 静默降级）。
  StrCpy $R7 ""
  ReadRegStr $R7 SHCTX "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $R7 != ""
    ${if} ${FileExists} "$R7\Uninstall_DSH_Desktop.exe"
      File /oname=$PLUGINSDIR\dsh-fixed-uninstaller.exe "${BUILD_RESOURCES_DIR}\Uninstall_DSH_Desktop.exe"
      CopyFiles /SILENT $PLUGINSDIR\dsh-fixed-uninstaller.exe "$R7\Uninstall_DSH_Desktop.exe"
    ${endif}
  ${else}
    # InstallLocation 缺失时回退解析 UninstallString（形如 "C:\...\xxx.exe"）。
    ReadRegStr $R7 SHCTX "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${if} $R7 != ""
      StrCpy $R8 $R7
      # 去掉首尾引号（若存在）。
      StrCpy $R9 $R8 1
      ${if} $R9 == '"'
        StrCpy $R8 $R8 "" 1
        StrCpy $R8 $R8 -1
      ${endif}
      # 仅当文件名确为自定义卸载器（25 字符）时覆盖，避免误伤默认卸载器。
      StrCpy $R9 $R8 "" -25
      ${if} $R9 == "Uninstall_DSH_Desktop.exe"
      ${andIf} ${FileExists} "$R8"
        File /oname=$PLUGINSDIR\dsh-fixed-uninstaller.exe "${BUILD_RESOURCES_DIR}\Uninstall_DSH_Desktop.exe"
        CopyFiles /SILENT $PLUGINSDIR\dsh-fixed-uninstaller.exe "$R8"
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro customInstall
  SetOutPath "$INSTDIR"
  CopyFiles /SILENT "$INSTDIR\resources\Uninstall_DSH_Desktop.exe" "$INSTDIR\Uninstall_DSH_Desktop.exe"
  Delete "$INSTDIR\resources\Uninstall_DSH_Desktop.exe"

  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString" '"$INSTDIR\Uninstall_DSH_Desktop.exe"'
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall_DSH_Desktop.exe" /S'
!macroend
