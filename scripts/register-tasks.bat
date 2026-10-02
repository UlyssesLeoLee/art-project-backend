@echo off
setlocal
set ROOT=%~dp0\..
set NODE_EXE=C:\Users\leo19\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe

REM Auto-elevate to Administrator if not already elevated
net session >nul 2>&1
if errorlevel 1 (
  echo [register-tasks] elevating to Administrator...
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

echo [register-tasks] node: %NODE_EXE%
echo [register-tasks] running as Administrator.
echo.

REM HTTP task — runs at user logon, interactive session
schtasks /Create /TN "ArtBackend_HTTP" /F ^
  /TR "\"%NODE_EXE%\" --import tsx \"%ROOT%\services\http\src\main.ts\"" ^
  /SC ONLOGON /RL LIMITED /IT ^
  >nul 2>&1
if errorlevel 1 (
  schtasks /Create /TN "ArtBackend_HTTP" /F ^
    /TR "\"%NODE_EXE%\" --import tsx \"%ROOT%\services\http\src\main.ts\"" ^
    /SC ONLOGON /RL LIMITED ^
    >nul 2>&1 || (
      echo [register-tasks] HTTP task creation FAILED. Need Administrator?
      goto :err
    )
)

schtasks /Create /TN "ArtBackend_TCP" /F ^
  /TR "\"%NODE_EXE%\" --import tsx \"%ROOT%\services\tcp\src\main.ts\"" ^
  /SC ONLOGON /RL LIMITED /IT ^
  >nul 2>&1
if errorlevel 1 (
  schtasks /Create /TN "ArtBackend_TCP" /F ^
    /TR "\"%NODE_EXE%\" --import tsx \"%ROOT%\services\tcp\src\main.ts\"" ^
    /SC ONLOGON /RL LIMITED ^
    >nul 2>&1 || (
      echo [register-tasks] TCP task creation FAILED.
      goto :err
    )
)

REM Set environment so the tasks see DB_PATH
echo [register-tasks] setting per-task environment...
setx DB_PATH "%ROOT%\data\game.db" >nul 2>&1
setx ART_BACKEND_ROOT "%ROOT%" >nul 2>&1

echo.
echo [register-tasks] registered:
schtasks /Query /TN "ArtBackend_HTTP" /V /FO LIST 2>nul | findstr /C:"TaskName" /C:"Status" /C:"Run As"
schtasks /Query /TN "ArtBackend_TCP"  /V /FO LIST 2>nul | findstr /C:"TaskName" /C:"Status" /C:"Run As"
echo.
echo Start now:
echo   schtasks /Run /TN "ArtBackend_HTTP"
echo   schtasks /Run /TN "ArtBackend_TCP"
echo Delete:
echo   scripts\unregister-tasks.bat
goto :end

:err
echo [register-tasks] FAILED. Run this script as Administrator.
exit /b 1

:end
