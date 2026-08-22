# ta11-run-all-tests.ps1 —— run-all-tests.mjs 的 PowerShell 包装（转发全部参数）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\run-all-tests.ps1 [--js-only|--rust-only|--fast|--allow <pat>...]
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $here "run-all-tests.mjs") @args
exit $LASTEXITCODE
