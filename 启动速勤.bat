@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 18 或更新版本： https://nodejs.org/
  pause
  exit /b 1
)

echo 正在启动速勤……
start "" http://127.0.0.1:8123/
node server.js

echo.
echo 服务已停止。
pause
