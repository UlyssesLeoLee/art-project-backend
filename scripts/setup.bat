@echo off
setlocal
cd /d "%~dp0\.."
echo [setup] installing npm packages...
call npm install --no-audit --no-fund --loglevel=error
echo [setup] seeding database...
set DB_PATH=./data/game.db
node --import tsx db\seeds\seed.ts
echo [setup] done. Run scripts\start-all.bat next.
pause
