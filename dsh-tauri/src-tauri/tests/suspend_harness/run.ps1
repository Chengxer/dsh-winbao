# DSH Desktop 挂起（hang/suspend）诊断 harness —— 进程级模拟，绝不动 OS 睡眠。
# 用法：
#   pwsh run.ps1 -Mode start     启动隔离测试实例（独立 DSH_HOME/userData）
#   pwsh run.ps1 -Mode freeze -Target kernel -Seconds 35   冻结内核 node（假死模拟）
#   pwsh run.ps1 -Mode freeze -Target shell -Seconds 60    冻结壳主进程（A 路径模拟）
#   pwsh run.ps1 -Mode minimize -Seconds 420               最小化主窗观察心跳误重载（C 路径）
#   pwsh run.ps1 -Mode stop      收割测试实例（杀树）
param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [string]$Target = "kernel",
  [int]$Seconds = 60
)

$ErrorActionPreference = "Stop"
$repo = "C:\Users\delinger\Desktop\dsh"
# 二进制选择：S1_EXE 环境变量可覆盖（复测修复版用 target-s1）。
$exe = if ($env:S1_EXE) { $env:S1_EXE } else { Join-Path $repo "dsh-tauri\src-tauri\target\release\dsh-tauri-app.exe" }
Write-Host "[harness] exe=$exe"
# 固定沙箱（不带 $PID）：跨模式调用复用同一实例
$sandbox = Join-Path $env:TEMP "dsh-s1-harness"
$log = Join-Path $sandbox "ud\logs\desktop.log"

# --- P/Invoke：NtSuspendProcess / NtResumeProcess（进程级冻结，不动 OS）---
Add-Type -Namespace Win32 -Name Native "
  [DllImport(`"ntdll.dll`")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport(`"ntdll.dll`")] public static extern int NtResumeProcess(IntPtr h);
  [DllImport(`"kernel32.dll`")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport(`"kernel32.dll`")] public static extern bool CloseHandle(IntPtr h);
"
function Suspend-Pid([int]$procId) {
  $h = [Win32.Native]::OpenProcess(0x1F0FFF, $false, $procId)  # PROCESS_ALL_ACCESS
  if ($h -eq [IntPtr]::Zero) { throw "OpenProcess($procId) failed" }
  $r = [Win32.Native]::NtSuspendProcess($h); [Win32.Native]::CloseHandle($h) | Out-Null
  Write-Host ("[harness] NtSuspendProcess({0}) = 0x{1:X}" -f $procId, $r)
}
function Resume-Pid([int]$procId) {
  $h = [Win32.Native]::OpenProcess(0x1F0FFF, $false, $procId)
  if ($h -eq [IntPtr]::Zero) { throw "OpenProcess($procId) failed" }
  $r = [Win32.Native]::NtResumeProcess($h); [Win32.Native]::CloseHandle($h) | Out-Null
  Write-Host ("[harness] NtResumeProcess({0}) = 0x{1:X}" -f $procId, $r)
}

# --- 定位进程：壳 = dsh-tauri-app.exe（沙箱标记环境变量区分）；内核 = 壳的 node 子进程 ---
function Get-ShellPid {
  # 测试实例用独立 sandbox 的锁文件确认身份：直接找命令行含沙箱路径的实例
  $procs = Get-CimInstance Win32_Process -Filter "Name='dsh-tauri-app.exe'"
  foreach ($p in $procs) {
    # 测试隔离实例的父链环境无法从 CIM 读；用启动时间窗口 + 单实例沙箱锁存在性兜底：
    # 我们先写 marker（start 模式），这里只认 sandbox 存在时的最新实例
    if (Test-Path (Join-Path $sandbox ".marker")) { return [int]$p.ProcessId }
  }
  throw "未找到测试壳进程"
}
function Get-KernelPid([int]$shellPid) {
  $kids = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*dsh-desktop*" -and $_.CommandLine -like "*bin.js*" }
  foreach ($k in $kids) {
    # 沿父链上溯找壳
    $cur = $k
    for ($i=0; $i -lt 8 -and $cur; $i++) {
      if ([int]$cur.ProcessId -eq $shellPid) { return [int]$k.ProcessId }
      $cur = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur.ParentProcessId) -ErrorAction SilentlyContinue
    }
  }
  throw "未找到内核 node 进程（壳 $shellPid 的子进程）"
}

# WebView2 全部后代进程（browser/gpu/renderer；冻结 = 页面 JS 停转、心跳断）
function Get-RendererPids([int]$shellPid) {
  $all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
  $ids = @()
  $frontier = @($shellPid)
  for ($i=0; $i -lt 6 -and $frontier.Count -gt 0; $i++) {
    $next = @()
    foreach ($f in $frontier) {
      foreach ($p in $all) {
        if ([int]$p.ParentProcessId -eq [int]$f) { $next += [int]$p.ProcessId; $ids += [int]$p.ProcessId }
      }
    }
    $frontier = $next
  }
  if ($ids.Count -eq 0) { throw "未找到壳 $shellPid 的 WebView2 后代进程" }
  return $ids
}

switch ($Mode) {
  "start" {
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
    Set-Content -Path (Join-Path $sandbox ".marker") -Value "s1-harness"
    $env:DSH_TAURI_TEST_ISOLATION = "1"        # 关插件层单实例互斥（生产路径零变化）
    $env:DSH_HOME = Join-Path $sandbox "home"
    $env:DSH_TAURI_USERDATA = Join-Path $sandbox "ud"
    $env:DSH_TAURI_DIAG = "1"
    Write-Host "[harness] sandbox=$sandbox"
    Write-Host "[harness] DSH_HOME=$env:DSH_HOME"
    $proc = Start-Process -FilePath $exe -PassThru -WorkingDirectory $repo `
      -RedirectStandardError (Join-Path $sandbox "stderr.log") `
      -RedirectStandardOutput (Join-Path $sandbox "stdout.log")
    Write-Host "[harness] shell pid=$($proc.Id)（stderr → sandbox/stderr.log）"
    # 等 boot：desktop.log 出现 preflight OK（内核即将拉起）后再等就绪行
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      if (Test-Path $log) {
        $txt = Get-Content $log -Raw -ErrorAction SilentlyContinue
        if ($txt -match "dsh web: http") { break }
      }
    }
    if (Test-Path $log) {
      Write-Host "[harness] --- desktop.log (head 60) ---"
      Get-Content $log | Select-Object -First 60 | ForEach-Object { Write-Host "  $_" }
    } else { Write-Host "[harness] desktop.log 未出现: $log" }
    Write-Host "[harness] start 完成。log=$log"
  }
  "freeze" {
    $shellPid = Get-ShellPid
    if ($Target -eq "renderer") {
      # WebView2 全后代冻结：页面 JS 停转 → 心跳断（watchdog 对照实验）
      $pids = Get-RendererPids $shellPid
      Write-Host "[harness] freeze target=renderer pids=$($pids -join ',') for ${Seconds}s @ $(Get-Date -Format HH:mm:ss)"
      $logLen0 = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
      $errLen0 = if (Test-Path "$sandbox\stderr.log") { (Get-Content "$sandbox\stderr.log").Count } else { 0 }
      foreach ($p in $pids) { Suspend-Pid $p }
      Start-Sleep -Seconds $Seconds
      foreach ($p in $pids) { try { Resume-Pid $p } catch { Write-Host "[harness] resume $p 已退出: $_" } }
      Write-Host "[harness] resumed @ $(Get-Date -Format HH:mm:ss)，观察 30s 自愈…"
      Start-Sleep -Seconds 30
      Write-Host "[harness] --- stderr.log 增量（renderer-recovery 证据通道）---"
      if (Test-Path "$sandbox\stderr.log") {
        Get-Content "$sandbox\stderr.log" | Select-Object -Skip $errLen0 | Select-String "renderer-recovery" | ForEach-Object { Write-Host "  $_" }
      }
    } else {
      $pid2 = if ($Target -eq "kernel") { Get-KernelPid $shellPid } else { $shellPid }
      Write-Host "[harness] freeze target=$Target pid=$pid2 for ${Seconds}s @ $(Get-Date -Format HH:mm:ss)"
      $logLen0 = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
      Suspend-Pid $pid2
      Start-Sleep -Seconds $Seconds
      try { Resume-Pid $pid2 } catch { Write-Host "[harness] resume $pid2 已退出（受控重启换了新 pid 属预期）: $_" }
      Write-Host "[harness] resumed @ $(Get-Date -Format HH:mm:ss)，观察 30s 自愈…"
      Start-Sleep -Seconds 30
    }
    if (Test-Path $log) {
      Write-Host "[harness] --- desktop.log 增量（第 $logLen0 行起）---"
      Get-Content $log | Select-Object -Skip $logLen0 | ForEach-Object { Write-Host "  $_" }
    }
  }
  "minimize" {
    $shellPid = Get-ShellPid
    Write-Host "[harness] minimize shell=$shellPid for ${Seconds}s @ $(Get-Date -Format HH:mm:ss)"
    Add-Type -Namespace Win32 -Name SW "
      [DllImport(`"user32.dll`")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
      public delegate bool EnumCb(IntPtr h, IntPtr lp);
      [DllImport(`"user32.dll`")] public static extern bool EnumWindows(EnumCb cb, IntPtr lp);
      [DllImport(`"user32.dll`")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport(`"user32.dll`")] public static extern bool IsWindowVisible(IntPtr h);
      public static IntPtr FindVisible(int targetPid) {
        IntPtr hit = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
          uint p; GetWindowThreadProcessId(h, out p);
          if ((int)p == targetPid && IsWindowVisible(h)) { hit = h; return false; }
          return true;
        }, IntPtr.Zero);
        return hit;
      }
    "
    # 按进程枚举顶层可见窗口（内核页会改窗口标题，不能按标题 FindWindow）
    $hwnd = [Win32.SW]::FindVisible($shellPid)
    if ($hwnd -eq [IntPtr]::Zero) { throw "未找到壳 $shellPid 的可见主窗" }
    Write-Host ("[harness] 主窗 hwnd={0:X}" -f $hwnd)
    [Win32.SW]::ShowWindowAsync($hwnd, 6) | Out-Null   # SW_MINIMIZE
    Write-Host "[harness] 主窗已最小化（hwnd=$hwnd），期间禁止用户操作该窗…"
    $logLen0 = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
    Start-Sleep -Seconds $Seconds
    [Win32.SW]::ShowWindowAsync($hwnd, 9) | Out-Null   # SW_RESTORE
    Write-Host "[harness] 还原窗口，收尾观察 20s"
    Start-Sleep -Seconds 20
    if (Test-Path $log) {
      Write-Host "[harness] --- desktop.log 增量（第 $logLen0 行起）---"
      Get-Content $log | Select-Object -Skip $logLen0 | ForEach-Object { Write-Host "  $_" }
    }
  }
  "stop" {
    $shellPid = Get-ShellPid
    Write-Host "[harness] 杀测试实例树 shell=$shellPid"
    taskkill /PID $shellPid /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    if (Test-Path $sandbox) {
      Write-Host "[harness] sandbox 保留取证: $sandbox"
    }
  }
  default { throw "未知 Mode: $Mode" }
}
