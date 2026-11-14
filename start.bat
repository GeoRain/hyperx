@echo off
title Google AI Search - 1993 / 1998 Edition
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 16 or newer is required, but node.exe was not found in PATH.
  echo Please install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)
echo Starting local gateway on http://127.0.0.1:8080/
echo Keep this window open while using the search page. Press Ctrl+C to stop.
echo.
node server.js
echo.
echo The server has stopped.
pause
