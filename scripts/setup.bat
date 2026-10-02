@echo off
setlocal
cd /d "%~dp0\.."
echo [setup] installing npm packages...
call npm install --no-audit --no-fund --loglevel=error
echo [setup] applying database migrations...
set DB_PATH=./data/game.db
node --import tsx db\migrations\run.ts
echo [setup] seeding database...
node --import tsx db\seeds\seed.ts
echo [setup] done. Run scripts\start-all.bat next.
pause
