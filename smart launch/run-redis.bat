@echo off
setlocal

set "REDIS_CONTAINER=proxy_redis_pool"
set "REDIS_IMAGE=redis:7-alpine"
set "REDIS_PORT=6380"

if "%REDIS_PASSWORD%"=="" set "REDIS_PASSWORD=madpool"

echo Starting Redis for ShardX ProxyPool...
echo Container: %REDIS_CONTAINER%
echo Port: %REDIS_PORT% -^> 6379

docker.exe inspect "%REDIS_CONTAINER%" >nul 2>nul
if not errorlevel 1 goto :start_existing

echo Creating Redis container...
docker.exe run -d --name "%REDIS_CONTAINER%" -p "%REDIS_PORT%:6379" "%REDIS_IMAGE%" redis-server --requirepass "%REDIS_PASSWORD%"
if errorlevel 1 goto :error
goto :ok

:start_existing
echo Existing Redis container found. Starting it...
docker.exe start "%REDIS_CONTAINER%" >nul
if errorlevel 1 goto :error
goto :ok

:ok
echo.
echo Redis is ready.
echo ProxyPool Redis URL:
echo redis://:%REDIS_PASSWORD%@127.0.0.1:%REDIS_PORT%/0
echo.
echo If container already existed, password may be different from this value.
goto :done

:error
echo.
echo Redis start failed.
echo Make sure Docker Desktop is running and port %REDIS_PORT% is free.
exit /b 1

:done
endlocal
