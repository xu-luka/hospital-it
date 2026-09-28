@echo off
rem ===== Hospital Info Dept System Diagnostics =====
rem Pure ASCII + CRLF
cd /d "%~dp0"
set "RPT=%~dp0diag-report.txt"

(
  echo ============================================
  echo  Hospital Info Dept System Diagnostic Report
  echo  Time: %DATE% %TIME%
  echo  Dir:  %CD%
  echo ============================================
  echo.
  echo [1] Files in root:
  dir /b "%~dp0" 2>&1
  echo.
  echo [2] Bundled runtime check:
  if exist "%~dp0runtime\node.exe" (
    echo runtime\node.exe EXISTS
    "%~dp0runtime\node.exe" -v 2>&1
    "%~dp0runtime\node.exe" -e "require('node:sqlite');console.log('sqlite OK')" 2>&1
  ) else (
    echo runtime\node.exe MISSING
    if exist "%~dp0runtime" (dir /b "%~dp0runtime" 2>&1) else (echo runtime folder MISSING)
  )
  echo.
  echo [3] node_modules check:
  if exist "%~dp0node_modules\express\package.json" (echo node_modules OK) else (echo node_modules MISSING)
  echo.
  echo [4] node found in PATH:
  where node 2>&1
  echo.
  echo [5] port 3131 usage before test:
  netstat -ano | find ":3131"
  echo.
  echo [6] config.js port line:
  findstr /n "PORT" "%~dp0config.js" 2>&1
  echo.
  echo [7] data folder:
  dir /b "%~dp0data" 2>&1
  echo.
  echo [8] quick start test ^(5 seconds^):
  if exist "%~dp0runtime\node.exe" (
    start "" /b "%~dp0runtime\node.exe" "%~dp0server.js" 1>"%~dp0diag-node.log" 2>&1
    timeout /t 5 /nobreak >nul
    netstat -ano | find ":3131"
    echo --- server output saved to diag-node.log ---
    for /f "tokens=5" %%p in ('netstat -ano ^| find ":3131" ^| find "LISTENING"') do taskkill /f /pid %%p
  ) else (
    echo skipped, runtime missing
  )
  echo.
  echo [9] last 30 lines of diag-node.log:
  if exist "%~dp0diag-node.log" (
    powershell -NoProfile -Command "Get-Content '%~dp0diag-node.log' -Tail 30"
  ) else (
    echo diag-node.log not created
  )
) > "%RPT%" 2>&1

echo Diagnostic done. Report: %RPT%
start notepad "%RPT%"
