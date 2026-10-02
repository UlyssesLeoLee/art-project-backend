@echo off
schtasks /Delete /TN "ArtBackend_HTTP" /F >nul 2>&1
schtasks /Delete /TN "ArtBackend_TCP"  /F >nul 2>&1
echo [unregister-tasks] done. (any error above means tasks were not registered)
timeout /t 2 /nobreak >nul
