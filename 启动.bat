@echo off
chcp 65001 >nul 2>nul
title Portkey
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [ERROR] runtime\node.exe not found.
    echo   Please keep the folder structure intact, or install Node.js first.
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

if not exist "%~dp0app\node_modules\ssh2" (
  echo.
  echo   [ERROR] Missing dependency: app\node_modules\ssh2
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0app\data" mkdir "%~dp0app\data" >nul 2>nul

echo   Starting LanLink client ...
start "" /min "%NODE_EXE%" "%~dp0app\src\main.js"
exit /b 0
