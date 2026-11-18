@echo off
chcp 65001 >nul
echo Stopping dev servers...
for %%P in (8091 8090) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo Killing PID %%a on port %%P
    taskkill /PID %%a /F >nul 2>nul
  )
)
echo Done.
pause
