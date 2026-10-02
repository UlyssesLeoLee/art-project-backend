@echo off
setlocal
cd /d "%~dp0\.."
echo [start-all] launching HTTP and TCP in separate windows...
start "art-http" cmd /k call "%~dp0start-http.bat"
timeout /t 2 /nobreak >nul
start "art-tcp"  cmd /k call "%~dp0start-tcp.bat"
echo [start-all] done. Close the two windows to stop services.
