@echo off
rem ===== Hospital Info Dept System Backup =====
rem Usage: backup.bat [targetDir] [keepCount]
cd /d "%~dp0"

rem ---- 1) prefer bundled runtime ----
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

rem ---- 2) fall back to node in PATH ----
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

rem ---- 3) fall back to common install locations ----
if not defined NODE_EXE (
  if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
  if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
)

if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo Keep the bundled runtime\node.exe, or install Node.js v22.5 or newer.
  pause
  exit /b 1
)

"%NODE_EXE%" scripts\backup.js %1 %2
pause