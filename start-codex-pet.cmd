@echo off
setlocal

cd /d "%~dp0"
set "npm_config_cache=%CD%\.npm-cache"

if not exist "package.json" (
  echo package.json was not found next to this launcher.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Please install Node.js or add npm.cmd to PATH.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Codey...
call npm.cmd run dev

if errorlevel 1 (
  echo Codey exited with an error.
  pause
  exit /b 1
)
