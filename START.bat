@echo off
setlocal

rem SAIWORK launcher. Double-click this file.
rem Installs dependencies on first run, then starts the desktop app.

cd /d "%~dp0"

echo ============================================
echo  SAIWORK 0.0.1
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found on PATH.
  echo        Install Node.js 18 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo Node %NODE_VERSION%

where opencode >nul 2>nul
if errorlevel 1 (
  echo [WARN] opencode not found on PATH.
  echo        SAIWORK starts, but no session can run until it is installed.
  echo        See https://opencode.ai
  echo.
)

if not exist "node_modules" (
  echo First run: installing dependencies. This takes a few minutes.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [FAIL] npm install failed. Read the output above, fix, run this again.
    pause
    exit /b 1
  )
  echo.
)

echo Starting SAIWORK...
echo Close this window to stop the app.
echo.
call npm run dev

if errorlevel 1 (
  echo.
  echo [FAIL] SAIWORK exited with an error. Output is above.
  pause
  exit /b 1
)

endlocal
