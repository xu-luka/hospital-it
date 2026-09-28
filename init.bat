@echo off
rem ===== First-time deployment init (ASCII only, keep CRLF) =====
rem Generates secrets\master.key on THIS machine if missing.
rem The master key is protected by Windows DPAPI (LocalMachine),
rem so it can never be copied from another machine.
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Keep runtime\node.exe in the package.
  pause
  exit /b 1
)

"%NODE_EXE%" scripts\init-deploy.js
echo.
pause
