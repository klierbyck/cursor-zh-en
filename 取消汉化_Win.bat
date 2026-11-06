@echo off
if not "%~2"=="" exit /b 2
call "%~dp0scripts\localize-win.bat" restore "%~1"
exit /b %ERRORLEVEL%
