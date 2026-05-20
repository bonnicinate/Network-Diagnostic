@echo off
setlocal

if /i "%~1"=="--help" goto help
if /i "%~1"=="/?" goto help
if /i "%~1"=="--elevated" goto elevated

net session >nul 2>nul
if not "%errorlevel%"=="0" (
  echo Requesting an elevated interactive setup shell...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k ""%~f0"" --elevated' -WorkingDirectory '%~dp0' -Verb RunAs"
  exit /b
)

:elevated
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

echo.
echo Network Diagnostic setup
echo ========================
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm was not found.
  echo Install Node.js from https://nodejs.org/ and run prep.cmd again.
  echo.
  pause
  exit /b 1
)

echo Installing Node dependencies...
call npm.cmd install --cache .\.npm-cache
if errorlevel 1 (
  echo.
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo Building the frontend...
call npm.cmd run build
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Installing optional LLDP capture module: PSDiscoveryProtocol
echo PowerShell may ask you to confirm NuGet/PSGallery prompts. Enter Y when prompted.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Install-Module -Name PSDiscoveryProtocol -Scope CurrentUser -AllowClobber; Get-Module -ListAvailable PSDiscoveryProtocol | Select-Object -First 1 Name,Version"
if errorlevel 1 (
  echo.
  echo PSDiscoveryProtocol install did not complete. You can still use the app, but LLDP capture may be unavailable.
  echo You can retry from the app with the Install agent button.
) else (
  echo.
  echo PSDiscoveryProtocol is installed.
)

echo.
echo Setup complete. You can now run:
echo   Launch Network Diagnostic.cmd
echo   Launch Network Diagnostic Elevated.cmd
echo.
pause
exit /b 0

:help
echo Usage: prep.cmd
echo.
echo Opens an elevated interactive setup shell, installs Node dependencies,
echo builds the frontend, and installs PSDiscoveryProtocol for LLDP capture.
exit /b 0
