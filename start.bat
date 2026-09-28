@echo off
rem ===== Hospital Info Dept Daily Management Launcher =====
rem Pure ASCII + CRLF, do NOT save as UTF-8
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

"%NODE_EXE%" -e "require('node:sqlite');" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This build of Node.js does NOT include node:sqlite.
  echo Please use Node.js 22.5+ or 24.x.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [ERROR] node_modules not found.
  echo Please run npm install once on a machine with internet.
  pause
  exit /b 1
)

rem ---- 4) inspection-related dependencies + external assets ----
rem Since the two systems were merged, a missing inspection dependency would
rem silently degrade monitoring while contracts/issues keep working. Check here
rem so the operator sees it immediately instead of finding an empty dashboard.
"%NODE_EXE%" -e "require('ssh2');require('oracledb');require('tedious');require('iconv-lite');" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Inspection dependencies missing or broken.
  echo        Contract and issue modules will still run; monitoring will be disabled.
  echo        Fix: npm install  on a machine with internet access.
  echo.
)

if not exist "%~dp0secrets\KeyVault.exe" (
  echo [WARN] secrets\KeyVault.exe not found - encrypted device credentials cannot be decrypted.
)
if not exist "%~dp0secrets\master.key" (
  echo [WARN] secrets\master.key not found - encrypted device credentials cannot be decrypted.
)
if not exist "%~dp0wmitools\WmiQuery.exe" (
  echo [WARN] wmitools\WmiQuery.exe not found - Windows WMI collection will fail.
)

echo Starting Hospital IT System (business + inspection) on http://127.0.0.1:3131 ...
echo Press Ctrl+C to stop.
echo Tip: if anything looks wrong, run "npm run check" first to diagnose.
"%NODE_EXE%" server.js
pause