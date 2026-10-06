@echo off
rem ===========================================================
rem  BootAnimForge launcher
rem
rem  No prerequisites. On first run this fetches
rem     runtime\node.exe    (portable Node.js runtime)
rem     runtime\ffmpeg.exe  (video engine)
rem  and then opens the UI in a dedicated Edge/Chrome app window
rem  (no address bar, no tabs).
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses
rem  batch files with the OEM codepage *before* chcp takes effect,
rem  so non-ASCII text here would be executed as commands.
rem
rem  Options:
rem    --quiet        hide ffmpeg log noise in this console
rem    --browser      open in the default browser instead
rem    --port 17321   pin the port
rem ===========================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "BUNDLED=%ROOT%runtime\node.exe"
set "NODE="

rem ---------- 1. Node runtime ----------
rem Prefer a system Node when present; otherwise use the bundled runtime,
rem downloading it only if this is a first run.
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"

if not defined NODE if exist "%BUNDLED%" set "NODE=%BUNDLED%"

if not defined NODE (
  echo.
  echo   First run: setting up the Node.js runtime ^(about 35 MB^) ...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\fetch-node.ps1"
  if exist "%BUNDLED%" (
    set "NODE=%BUNDLED%"
  ) else (
    echo.
    echo   [ERROR] Could not set up the Node.js runtime automatically.
    echo           Please install Node.js 18+ from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
  )
)

rem ---------- 2. Video engine ----------
if not exist "%ROOT%runtime\ffmpeg.exe" (
  echo.
  echo   First run: preparing the video engine ^(ffmpeg^) ...
  echo.
  "%NODE%" "%ROOT%tools\fetch-ffmpeg.js"
  if errorlevel 1 (
    echo.
    echo   [WARN] Engine download failed. The app still starts; use
    echo          "re-download engine" inside the UI.
    echo.
  )
)

rem ---------- 3. Run ----------
"%NODE%" "%ROOT%src\main.js" --quiet %*
endlocal
