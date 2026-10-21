@echo off
title QQ AI 助手 - 一键启动
cd /d "%~dp0"

rem ============================================================
rem  一键启动：NapCat(QQ 机器人) + qq-bridge
rem  需要扫码时自动弹出登录二维码；登录成功后自动把桥拉起来
rem ============================================================

rem ---- 定位 node.exe ----
set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

rem ---- NapCat 目录（相对本脚本）----
set "NAPCAT_DIR=%~dp0..\napcat\NapCat.Shell"

echo ==========================================================
echo   QQ AI 助手 - 一键启动
echo ----------------------------------------------------------
echo   1. 拉起 NapCat
echo   2. 需要时自动弹出登录二维码
echo   3. 登录成功后自动启动 qq-bridge
echo.
echo   本窗口是运行日志，不要关闭；Ctrl+C 停止
echo ==========================================================
echo.

if not exist "%NAPCAT_DIR%\start-napcat.bat" (
  echo [错误] 找不到 NapCat：
  echo   %NAPCAT_DIR%
  echo 请确认 napcat\NapCat.Shell 目录完整。
  pause
  exit /b 1
)

echo [1/3] 启动 NapCat ...
start "NapCat 机器人" /D "%NAPCAT_DIR%" "%NAPCAT_DIR%\start-napcat.bat"

echo [2/3] 等待 QQ 登录（需要扫码时会自动弹出二维码）...
"%NODE_EXE%" watch-login.mjs
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo [提示] 启动流程异常结束，退出码 %RC%
echo 程序已退出。
pause
