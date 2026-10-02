@echo off
setlocal
echo [stop-all] killing node.exe processes bound to 8080/19821...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }; Get-NetTCPConnection -LocalPort 19821 -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }; 'done'"
echo [stop-all] ports 8080 and 19821 should be free now.
timeout /t 2 /nobreak >nul
