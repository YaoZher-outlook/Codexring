@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "LAUNCHER=%PROJECT_DIR%start-codex-pet.cmd"
set "SHORTCUT_NAME=Codey.lnk"

if not exist "%LAUNCHER%" (
  echo Launcher was not found: %LAUNCHER%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$desktop = [Environment]::GetFolderPath('Desktop'); $shortcutPath = Join-Path $desktop '%SHORTCUT_NAME%'; $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($shortcutPath); $shortcut.TargetPath = '%LAUNCHER%'; $shortcut.WorkingDirectory = '%PROJECT_DIR%'; $shortcut.Description = 'Start Codey'; $shortcut.IconLocation = 'shell32.dll,13'; $shortcut.WindowStyle = 1; $shortcut.Save(); Write-Host ('Created shortcut: ' + $shortcutPath)"

if errorlevel 1 (
  echo Failed to create desktop shortcut.
  pause
  exit /b 1
)

echo Desktop shortcut created.
pause
