@echo off
setlocal
node "%~dp0scripts\zenpi.mjs" %*
exit /b %ERRORLEVEL%
