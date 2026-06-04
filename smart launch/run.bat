@echo off
setlocal

cd /d "%~dp0.."

set "APP_EXE=src-tauri\target\release\shardx-launcher.exe"

if not exist "%APP_EXE%" (
  echo ShardX Launcher build not found.
  echo Run "smart launch\build.bat" first.
  exit /b 1
)

echo Stopping old ProxyPool Python sidecar if it is stuck...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\cleanup-proxypool.ps1"

echo Starting ShardX Launcher...
start "" "%APP_EXE%"

endlocal
