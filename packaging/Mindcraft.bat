@echo off
setlocal
cd /d "%~dp0"
title Mindcraft
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-mindcraft.ps1" -Installed
if errorlevel 1 pause
