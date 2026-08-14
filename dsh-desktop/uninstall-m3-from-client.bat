@echo off
chcp 65001 >nul
title DSH M3 主题卸载器

echo ========================================
echo   DSH M3 主题 - 从已安装客户端卸载
echo ========================================
echo.

set "INSTALL_DIR=D:\app\dsh\DSH Desktop\resources\app"

if not exist "%INSTALL_DIR%\preload.js.bak" (
    echo [错误] 未找到备份文件 preload.js.bak
    echo 无法自动卸载，请手动恢复。
    pause
    exit /b 1
)

echo [1/2] 恢复原始 preload.js...
copy /y "%INSTALL_DIR%\preload.js.bak" "%INSTALL_DIR%\preload.js" >nul
echo       完成

echo [2/2] 删除主题文件...
if exist "%INSTALL_DIR%\assets\themes\m3-theme.css" del "%INSTALL_DIR%\assets\themes\m3-theme.css"
if exist "%INSTALL_DIR%\assets\themes\m3-theme-manager.js" del "%INSTALL_DIR%\assets\themes\m3-theme-manager.js"
if exist "%INSTALL_DIR%\assets\themes\m3-preview.html" del "%INSTALL_DIR%\assets\themes\m3-preview.html"
echo       完成

echo.
echo ========================================
echo   卸载完成！
echo ========================================
echo.
echo 请重启 DSH Desktop 客户端以恢复默认主题。
echo.
pause
