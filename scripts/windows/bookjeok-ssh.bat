@echo off
rem Book-Jeok: set up SSH access to the Oracle server from this PC (no admin needed).
rem Double-click this file. It runs bookjeok-ssh.ps1 next to it.
setlocal
if not exist "%~dp0bookjeok-ssh.ps1" (
  echo.
  echo  [ERROR] bookjeok-ssh.ps1 not found next to this file.
  echo  Please EXTRACT the zip first, then run bookjeok-ssh.bat from the extracted folder.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bookjeok-ssh.ps1"
endlocal
