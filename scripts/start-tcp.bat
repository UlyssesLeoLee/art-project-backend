@echo off
setlocal
title art-project-backend / TCP Game (port 19821)
cd /d "%~dp0\.."
if not exist node_modules (
  echo [setup] running npm install...
  call npm install --no-audit --no-fund --loglevel=error
)
set DB_PATH=./data/game.db
set GAME_PORT=19821
echo [tcp] starting on port 19821, DB=%DB_PATH%
node --import tsx services\tcp\src\main.ts
if errorlevel 1 (
  echo [tcp] exited with error %errorlevel%
  pause
)
