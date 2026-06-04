@echo off
setlocal

echo Pulling Redis Docker image...
docker.exe pull redis:7-alpine
if errorlevel 1 goto :error

echo.
echo Redis image ready: redis:7-alpine
goto :done

:error
echo.
echo Redis image pull failed.
echo Make sure Docker Desktop is running.
exit /b 1

:done
endlocal
