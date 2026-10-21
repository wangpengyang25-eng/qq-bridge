@echo off
title QQ 群 AI 助手桥
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

echo ========================================
echo   QQ 群 AI 助手桥
echo   保持本窗口开启即可长期运行，Ctrl+C 停止
echo ========================================
echo.

"%NODE_EXE%" bridge.mjs

echo.
echo 程序已退出。
pause
