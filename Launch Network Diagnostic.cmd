@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm was not found. Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

if not exist node_modules (
  call npm.cmd install --cache .\.npm-cache
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

call npm.cmd run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

start "" "http://localhost:4317"
node server\index.mjs
pause
