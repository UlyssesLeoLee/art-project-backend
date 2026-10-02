@echo off
setlocal
title art-project-backend / HTTP (port 8080)
cd /d "%~dp0\.."
if not exist node_modules (
  echo [setup] running npm install...
  call npm install --no-audit --no-fund --loglevel=error
)
set DB_PATH=./data/game.db
set PORT=8080
echo [http] starting on port 8080, DB=%DB_PATH%
node --import tsx services\http\src\main.ts
if errorlevel 1 (
  echo [http] exited with error %errorlevel%
  pause
)
