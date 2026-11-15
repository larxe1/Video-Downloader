@echo off
title Free Video Downloader - Auto Reload Server
cd /d "%~dp0\.."

echo Starting Free Video Downloader auto-reload server...
echo.
node scripts/dev-reload-server.mjs

if errorlevel 1 (
  echo.
  echo The auto-reload server stopped with an error.
  echo If Node.js is not installed yet, download it from https://nodejs.org/
  pause
)
