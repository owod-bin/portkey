@echo off
chcp 65001 >nul 2>nul
title Portkey Stop
cd /d "%~dp0"

echo   Stopping LanLink client ...

set "PIDFILE=%~dp0app\data\app.pid"
set "PID="
if exist "%PIDFILE%" set /p PID=<"%PIDFILE%"

if defined PID (
  tasklist /FI "PID eq %PID%" 2>nul | findstr /I "node.exe" >nul
  if not errorlevel 1 (
    taskkill /PID %PID% /F >nul 2>nul
    echo   Stopped ^(PID %PID%^).
    del /q "%PIDFILE%" >nul 2>nul
    goto done
  )
)

echo   No running instance found.
echo   ^(If the window is still open, just close it.^)

:done
exit /b 0
