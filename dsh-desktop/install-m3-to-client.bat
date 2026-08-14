@echo off
chcp 65001 >nul
title DSH M3 主题安装器

echo ========================================
echo   DSH M3 主题 - 安装到已安装客户端
echo ========================================
echo.

set "SRC_DIR=%~dp0"
set "INSTALL_DIR=D:\app\dsh\DSH Desktop\resources\app"

if not exist "%INSTALL_DIR%\preload.js" (
    echo [错误] 未找到 DSH Desktop 安装目录: %INSTALL_DIR%
    echo.
    echo 请手动修改此脚本中的 INSTALL_DIR 路径。
    pause
    exit /b 1
)

echo [1/4] 备份原始 preload.js...
copy /y "%INSTALL_DIR%\preload.js" "%INSTALL_DIR%\preload.js.bak" >nul
echo       已备份到 preload.js.bak

echo [2/4] 复制 preload.js (含 M3 主题注入)...
copy /y "%SRC_DIR%preload.js" "%INSTALL_DIR%\preload.js" >nul
echo       完成

echo [3/4] 创建 themes 目录...
if not exist "%INSTALL_DIR%\assets\themes" mkdir "%INSTALL_DIR%\assets\themes"

echo [4/4] 复制主题文件...
copy /y "%SRC_DIR%assets\themes\m3-theme.css" "%INSTALL_DIR%\assets\themes\" >nul
copy /y "%SRC_DIR%assets\themes\m3-theme-manager.js" "%INSTALL_DIR%\assets\themes\" >nul
copy /y "%SRC_DIR%assets\themes\m3-preview.html" "%INSTALL_DIR%\assets\themes\" >nul
echo       完成

echo.
echo ========================================
echo   安装完成！
echo ========================================
echo.
echo 使用方法：
echo   1. 重启 DSH Desktop 客户端
echo   2. 打开 设置 -^> 外观
echo   3. 点击第四个 "M3" 主题按钮即可切换
echo.
echo 卸载方法：
echo   运行 uninstall-m3-theme.bat 或
echo   将 preload.js.bak 重命名回 preload.js
echo.
pause
