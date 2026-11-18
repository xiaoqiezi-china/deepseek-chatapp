@echo off
chcp 65001 >nul
title Deepseek CE - Dev Servers
cd /d "%~dp0"

echo ============================================
echo   Deepseek CE - Starting dev servers
echo ============================================
echo.

rem Locate Node.js: PATH first, then common install dirs
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :no_node

echo Node: %NODE_EXE%
echo.

if not exist "node_modules\@rspack\cli\bin\rspack.js" goto :no_modules

set "NODE_ENV=development"

echo Starting API server on 8091...
start "Deepseek CE API" /MIN "%NODE_EXE%" "node_modules\tsx\dist\cli.mjs" watch server\index.ts

echo Starting Web dev server on 8090...
start "Deepseek CE Web" /MIN "%NODE_EXE%" "node_modules\@rspack\cli\bin\rspack.js" serve -c rspack.config.ts

echo.
echo   Web: http://127.0.0.1:8090
echo   API: http://127.0.0.1:8091
echo.
echo Close the API / Web windows to stop the servers.
echo.
pause
exit /b 0

:no_node
echo [ERROR] Node.js not found. Install Node.js 22+ first.
pause
exit /b 1

:no_modules
echo [ERROR] node_modules missing. Run pnpm install first.
pause
exit /b 1
