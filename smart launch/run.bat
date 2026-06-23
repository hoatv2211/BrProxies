@echo off
setlocal

cd /d "%~dp0.."

set "APP_EXE=src-tauri\target\release\brproxies.exe"
set "PROXYPOOL_PYTHON=%CD%\proxypool_service\.venv\Scripts\python.exe"

if not exist "%APP_EXE%" (
  echo BrProxies build not found.
  echo Run "smart launch\build.bat" first.
  exit /b 1
)

call "%CD%\smart launch\run-redis.bat"
if errorlevel 1 exit /b 1

echo Stopping old ProxyPool Python sidecar if it is stuck...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\cleanup-proxypool.ps1"

echo Starting BrProxies...
if exist "%PROXYPOOL_PYTHON%" echo ProxyPool Python: %PROXYPOOL_PYTHON%
start "" "%APP_EXE%"

endlocal
