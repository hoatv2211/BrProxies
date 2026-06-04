@echo off
setlocal

cd /d "%~dp0.."

echo Building ShardX Launcher...

if not exist "node_modules" (
  echo Installing npm dependencies...
  call npm.cmd install
  if errorlevel 1 goto :error
)

echo Building web assets...
call npm.cmd run build
if errorlevel 1 goto :error

echo Building desktop app...
call npm.cmd run tauri build -- --no-bundle
if errorlevel 1 goto :error

echo.
echo Build complete.
echo Output: src-tauri\target\release\shardx-launcher.exe
goto :done

:error
echo.
echo Build failed.
exit /b 1

:done
endlocal
