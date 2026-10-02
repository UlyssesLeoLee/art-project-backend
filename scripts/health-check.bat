@echo off
setlocal
echo [health] checking HTTP 8080 and TCP 19821...
echo.
powershell -NoProfile -Command "try { $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/serverlist.json' -UseBasicParsing -TimeoutSec 2; Write-Host ('HTTP  /serverlist.json -> {0}' -f $h.StatusCode) } catch { Write-Host ('HTTP  /serverlist.json -> DOWN ({0})' -f $_.Exception.Message) }"
powershell -NoProfile -Command "try { $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 19821 -InformationLevel Quiet -WarningAction SilentlyContinue; Write-Host ('TCP   port 19821 -> ' + $t) } catch { Write-Host ('TCP   port 19821 -> DOWN') }"
echo.
echo [health] done.
