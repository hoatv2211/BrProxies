@echo off
setlocal

cd /d "%~dp0.."

set "REDIS_DIR=%CD%\redis"
set "REDIS_SERVER=%REDIS_DIR%\redis-server.exe"
set "REDIS_CLI=%REDIS_DIR%\redis-cli.exe"
set "REDIS_CONF=%REDIS_DIR%\redis.windows.conf"
set "REDIS_HOST=127.0.0.1"
set "REDIS_PORT=6380"

echo Starting Redis for BrProxies ProxyPool...
echo Server: %REDIS_SERVER%
echo Port: %REDIS_PORT%

if not exist "%REDIS_SERVER%" goto :missing
if not exist "%REDIS_CONF%" goto :missing

"%REDIS_CLI%" -h "%REDIS_HOST%" -p "%REDIS_PORT%" ping 2>nul | findstr /x "PONG" >nul
if not errorlevel 1 goto :already_running

start "BrProxies Redis" /min "%REDIS_SERVER%" "%REDIS_CONF%" --bind "%REDIS_HOST%" --protected-mode yes --port "%REDIS_PORT%"

for /l %%i in (1,1,20) do (
  "%REDIS_CLI%" -h "%REDIS_HOST%" -p "%REDIS_PORT%" ping 2>nul | findstr /x "PONG" >nul
  if not errorlevel 1 goto :ok
  timeout /t 1 /nobreak >nul
)

goto :error

:already_running
echo Redis is already running.
goto :ok

:ok
echo.
echo Redis is ready.
echo ProxyPool Redis URL:
echo redis://127.0.0.1:%REDIS_PORT%/0
goto :done

:missing
echo.
echo Redis files not found in %REDIS_DIR%.
exit /b 1

:error
echo.
echo Redis start failed.
echo Make sure port %REDIS_PORT% is free.
exit /b 1

:done
endlocal
