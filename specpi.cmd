@echo off
setlocal
node "%~dp0scripts\specpi.mjs" %*
exit /b %ERRORLEVEL%
