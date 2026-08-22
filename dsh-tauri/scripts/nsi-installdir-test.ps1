# DSH NSIS InstallDir 三场景实测脚本（NS1 子代理专用，测试后可删）
# 用法:
#   nsi-installdir-test.ps1 backup        - 备份现有 DSH 相关键
#   nsi-installdir-test.ps1 clean         - 删除所有 DSH 测试键/默认目录（不含 legacy 模拟）
#   nsi-installdir-test.ps1 simlegacy <dir> <variant> - 写 Electron 模拟键
#       variant: installkey | uninstallkey | both
#   nsi-installdir-test.ps1 install <setup.exe> [dir] - 静默安装（可选 /D）
#   nsi-installdir-test.ps1 uninstall <dir> - 从目录静默卸载并等待完成
#   nsi-installdir-test.ps1 state         - 打印当前检测相关状态
param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$Setup,
  [string]$Dir,
  [string]$Variant
)
$ErrorActionPreference = 'Continue'

$UuidKey = '62276e9d-c5f3-5091-b4ee-c7144d6db450'
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH Desktop'
$ManuKey   = 'HKCU:\Software\deepseek\DSH Desktop'
$LegacyInstallKey = 'HKCU:\Software\DSH Desktop'
$LegacyUninstKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$UuidKey"
$BackupDir = Join-Path $env:TEMP 'dsh_nsi_test\backup'
$DefaultDir = Join-Path $env:LOCALAPPDATA 'DSH Desktop'

function State {
  Write-Host '=== STATE ==='
  foreach ($label in @(
    @{n='TauriManuKey(deepseek)'; p=$ManuKey},
    @{n='TauriUninstKey';         p=$UninstKey},
    @{n='LegacyInstallKey';       p=$LegacyInstallKey},
    @{n='LegacyUninstKey(uuid)';  p=$LegacyUninstKey}
  )) {
    if (Test-Path $label.p) {
      $v = (Get-ItemProperty $label.p)
      $loc = $v.InstallLocation
      $def = (Get-Item $label.p).GetValue('')
      Write-Host ("EXISTS  {0}  InstallLocation={1} default={2}" -f $label.n, $loc, $def)
    } else { Write-Host ("absent  {0}" -f $label.n) }
  }
  Write-Host ("DefaultDir({0}) exists: {1}" -f $DefaultDir, (Test-Path $DefaultDir))
  if (Test-Path $DefaultDir) { Write-Host ("  DefaultDir main exe: {0}" -f (Test-Path (Join-Path $DefaultDir 'dsh-tauri-app.exe'))) }
}

# 兼容：目录型动作（simlegacy/uninstall）的第一位置参数（$Setup 位）统一视作 $Dir
if ($Action -in @('simlegacy','uninstall') -and $Setup) { $Dir = $Setup }

switch ($Action) {
  'backup' {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    foreach ($k in @('HKCU:\Software\deepseek', 'HKCU:\Software\DSH Desktop',
                     'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH Desktop',
                     "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$UuidKey")) {
      if (Test-Path $k) {
        $name = ($k -replace '[\\:]', '_') + '.reg'
        $rk = $k -replace ':', ''
        reg.exe export $rk (Join-Path $BackupDir $name) /y | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "BACKED UP: $k" } else { Write-Host "EXPORT FAILED: $k" }
      } else { Write-Host "absent(无需备份): $k" }
    }
  }
  'clean' {
    foreach ($k in @($UninstKey, $ManuKey, 'HKCU:\Software\deepseek', $LegacyInstallKey, $LegacyUninstKey)) {
      if (Test-Path $k) { Remove-Item -Recurse -Force $k -ErrorAction SilentlyContinue; Write-Host "DELETED KEY: $k" }
    }
    if (Test-Path $DefaultDir) { Remove-Item -Recurse -Force $DefaultDir -ErrorAction SilentlyContinue; Write-Host "DELETED DIR: $DefaultDir" }
    Write-Host 'clean done'
  }
  'simlegacy' {
    # $Dir = 模拟的 Electron 旧安装目录（需已含标记文件）
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    if ($Variant -eq 'installkey' -or $Variant -eq 'both') {
      New-Item -Path ($LegacyInstallKey -replace 'DSH Desktop$','') -Name 'DSH Desktop' -Force | Out-Null
      Set-ItemProperty $LegacyInstallKey -Name 'InstallLocation' -Value $Dir
      Write-Host "SIM: $LegacyInstallKey InstallLocation = $Dir"
    }
    if ($Variant -eq 'uninstallkey' -or $Variant -eq 'both') {
      New-Item -Path ($LegacyUninstKey -replace '[^\\]+$','') -Name $UuidKey -Force | Out-Null
      Set-ItemProperty $LegacyUninstKey -Name 'InstallLocation' -Value ('"' + $Dir + '"')
      Set-ItemProperty $LegacyUninstKey -Name 'DisplayName' -Value 'DSH Desktop'
      Write-Host "SIM: $LegacyUninstKey InstallLocation = `"$Dir`" (带引号)"
    }
  }
  'install' {
    $args_ = '/S'
    if ($Dir) { $args_ = "/S /D=$Dir" }
    Write-Host "RUN: `"$Setup`" $args_"
    $p = Start-Process -FilePath $Setup -ArgumentList $args_ -Wait -PassThru
    Write-Host ("setup exit code: {0}" -f $p.ExitCode)
    State
  }
  'uninstall' {
    $un = Join-Path $Dir 'uninstall.exe'
    if (-not (Test-Path $un)) { Write-Host "no uninstaller at $un"; break }
    Start-Process -FilePath $un -ArgumentList '/S' -Wait
    # NSIS 卸载器 copy-to-temp 异步：轮询键/目录消失（上限 60s）
    $i = 0
    while ($i -lt 60 -and (Test-Path $UninstKey)) { Start-Sleep 1; $i++ }
    Start-Sleep 2
    Write-Host ("uninstall waited {0}s; UninstKey exists: {1}; dir exists: {2}" -f $i, (Test-Path $UninstKey), (Test-Path $Dir))
    State
  }
  'state' { State }
  default { Write-Host "unknown action: $Action" }
}
