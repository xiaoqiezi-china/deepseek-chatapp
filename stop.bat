@echo off
chcp 65001 >nul
echo Stopping Deepseek CE dev servers...

set "FOUND=0"
for %%P in (8091 8090) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo Killing PID %%A on port %%P
    taskkill /PID %%A /F >nul 2>nul
    set "FOUND=1"
  )
)

if "%FOUND%"=="0" echo No dev server found on ports 8090/8091.
echo Done.
pause
