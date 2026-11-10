@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node-v22.23.3-win-x64\node.exe" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-mindcraft.ps1" -Installed
    if errorlevel 1 pause
    exit /b
)
if exist "Mindcraft-Micro-Q4-Setup.exe" (
    start "" "%~dp0Mindcraft-Micro-Q4-Setup.exe"
    exit /b
)
start "" "https://github.com/asd123718/mindcraft-optimized-pack/releases/tag/0.1"
