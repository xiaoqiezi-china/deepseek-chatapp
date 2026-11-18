@echo off
chcp 65001 >nul
title DeepSeek Chat - Dev Servers
cd /d "%~dp0"

echo ============================================
echo   DeepSeek Chat - Starting servers
echo ============================================
echo.

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found in PATH. Please install pnpm first.
  pause
  exit /b 1
)

echo Starting API server (port 8091)...
start "chat-api" /MIN cmd /c "pnpm dev:server"

echo Starting Web server (port 8090)...
start "chat-web" /MIN cmd /c "pnpm dev:web"

echo.
echo Servers started:
echo   Web: http://127.0.0.1:8090
echo   API: http://127.0.0.1:8091
echo.
echo Close the two "chat-api" / "chat-web" windows to stop servers.
echo.
pause
