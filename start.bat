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
if not defined PORT set "PORT=8787"
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:%PORT%'; for($i=0;$i -lt 100;$i++){try{if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ($u+'/api/health')).StatusCode -eq 200){Start-Process $u;break}}catch{};Start-Sleep -Milliseconds 200}"
node server.js
pause
