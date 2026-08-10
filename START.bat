@echo off
setlocal

rem SAIWORK visible debug launcher. Use START_HIDDEN.vbs for normal startup.
rem Installs dependencies on first run, then starts the desktop app with logs here.

cd /d "%~dp0"

echo ============================================
echo  SAIWORK 0.0.2
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found on PATH.
  echo        Install Node.js 20.19+ ^(20.x^) or 22.12+ from https://nodejs.org.
  echo.
  if not defined SAIWORK_HIDDEN pause
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
    if not defined SAIWORK_HIDDEN pause
    exit /b 1
  )
  echo.
)

echo Starting SAIWORK...
echo Close this window to stop the app.
echo.

rem ELECTRON_RUN_AS_NODE must not leak into the dev launcher: it makes
rem electron run as a plain Node process, so electron.app is undefined and
rem the main process crashes before any window is created.
set "ELECTRON_RUN_AS_NODE="

call npm run dev

if errorlevel 1 (
  echo.
  echo [FAIL] SAIWORK exited with an error. Output is above.
  if not defined SAIWORK_HIDDEN pause
  exit /b 1
)

endlocal
