@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0smart-build.ps1" %*
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b 1
)

endlocal
