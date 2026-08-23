@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==============================================
echo   MABA BUSINESS - PHASE 4 LOCAL
echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js belum terinstall.
  echo Install Node.js 22+ lalu jalankan file ini lagi.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/2] Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)
echo [2/2] Starting Maba Business at http://localhost:5500
start "" "http://localhost:5500"
call npm start
pause
