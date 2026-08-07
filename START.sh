#!/usr/bin/env bash
# SAIWORK launcher. Run ./START.sh
# Installs dependencies on first run, then starts the desktop app.
set -u

cd "$(dirname "$0")"

echo "============================================"
echo " SAIWORK 0.0.1"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[FAIL] Node.js not found on PATH."
  echo "       Install Node.js 18 or newer from https://nodejs.org and run this again."
  exit 1
fi

echo "Node $(node -v)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "[WARN] opencode not found on PATH."
  echo "       SAIWORK starts, but no session can run until it is installed."
  echo "       See https://opencode.ai"
  echo
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies. This takes a few minutes."
  echo
  if ! npm install --no-audit --no-fund; then
    echo
    echo "[FAIL] npm install failed. Read the output above, fix, run this again."
    exit 1
  fi
  echo
fi

echo "Starting SAIWORK..."
echo "Press Ctrl+C to stop."
echo
exec npm run dev
