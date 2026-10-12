@echo off
rem Book-Jeok: fix slow access on KT internet (pins the Cloudflare entry to Seoul).
rem Double-click this file. It restarts itself as administrator and runs bookjeok-fast.ps1.
setlocal
if not exist "%~dp0bookjeok-fast.ps1" (
  echo.
  echo  [ERROR] bookjeok-fast.ps1 not found next to this file.
  echo  Please EXTRACT the zip first, then run bookjeok-fast.bat from the extracted folder.
  echo.
  pause
  exit /b 1
)
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bookjeok-fast.ps1"
endlocal
