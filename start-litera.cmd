@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run Litera Reader.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

set HOST=127.0.0.1
set PORT=4173

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = 4173; $busy = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue; if (-not $busy) { Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden }"

timeout /t 2 >nul

where msedge >nul 2>nul
if not errorlevel 1 (
  start "" msedge --app=http://127.0.0.1:4173/
  exit /b 0
)

where chrome >nul 2>nul
if not errorlevel 1 (
  start "" chrome --app=http://127.0.0.1:4173/
  exit /b 0
)

start "" http://127.0.0.1:4173/
