@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Install Node.js from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Your current Node.js is too old.
  node --version
  pause
  exit /b 1
)
echo Starting AI BRIEF Ultra...
start "" http://127.0.0.1:8787
node server.js
pause
