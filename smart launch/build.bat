@echo off
setlocal

cd /d "%~dp0.."

rem Ensure Rust toolchain binaries are available even if current shell PATH is stale.
if exist "%USERPROFILE%\.cargo\bin" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo Missing Rust Cargo in PATH.
  echo Install Rust from https://rustup.rs/ then reopen terminal or VS Code.
  goto :error
)

where rustc >nul 2>nul
if errorlevel 1 (
  echo.
  echo Missing rustc compiler in PATH.
  echo Install Rust from https://rustup.rs/ then reopen terminal or VS Code.
  goto :error
)

echo Building BrProxies...

set "ANDROID_MANAGER_VENV=android_manager\.venv"
set "ANDROID_MANAGER_PYTHON=%CD%\%ANDROID_MANAGER_VENV%\Scripts\python.exe"

if not exist "node_modules" (
  echo Installing npm dependencies...
  call npm.cmd install
  if errorlevel 1 goto :error
)

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Missing Python in PATH.
  echo Install Python 3.11+ from https://www.python.org/downloads/ then reopen terminal or VS Code.
  goto :error
)

if not exist "%ANDROID_MANAGER_PYTHON%" (
  echo Creating Android Manager Python venv...
  python -m venv "%ANDROID_MANAGER_VENV%"
  if errorlevel 1 goto :error
)

echo Installing Android Manager dependencies...
"%ANDROID_MANAGER_PYTHON%" -m pip install -e "android_manager[dev]"
if errorlevel 1 goto :error

echo Building web assets...
call npm.cmd run build
if errorlevel 1 goto :error

echo Building desktop app...
call npm.cmd run tauri build -- --no-bundle
if errorlevel 1 goto :error

echo.
echo Build complete.
echo Output: src-tauri\target\release\brproxies.exe
goto :done

:error
echo.
echo Build failed.
exit /b 1

:done
endlocal
