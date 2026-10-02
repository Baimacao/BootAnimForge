@echo off
rem Dev helper: run the local service in the foreground with --no-open.
rem ASCII-only on purpose (see 启动.cmd for why).
chcp 65001 >nul
set "ROOT=%~dp0.."
node "%ROOT%\src\main.js" --no-open --quiet --port 17321
