@echo off
rem ===========================================================
rem  BootAnimForge launcher
rem  Runs the local engine with node, then opens the UI in a
rem  dedicated Edge/Chrome app window (no address bar, no tabs).
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses
rem  batch files with the OEM codepage *before* chcp takes effect,
rem  so non-ASCII text here would be executed as commands.
rem
rem  Options:
rem    启动.cmd --quiet        hide ffmpeg log noise in console
rem    启动.cmd --browser      open in the default browser instead
rem    启动.cmd --port 17321   pin the port
rem ===========================================================
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Please install Node.js 18 or newer.
  echo.
  pause
  exit /b 1
)

rem First run: fetch the video engine if it is missing (npm mirror, a few seconds)
if not exist "%ROOT%runtime\ffmpeg.exe" (
  echo.
  echo   First run: preparing the video engine ^(ffmpeg^) ...
  echo.
  node "%ROOT%tools\fetch-ffmpeg.js"
  if errorlevel 1 (
    echo.
    echo   [WARN] Engine download failed. The app still starts; use
    echo          "re-download engine" inside the UI.
    echo.
  )
)

node "%ROOT%src\main.js" --quiet %*
endlocal
