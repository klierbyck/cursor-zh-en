@echo off
if not "%~2"=="" exit /b 2
call "%~dp0scripts\localize-win.bat" activate "%~1"
exit /b %ERRORLEVEL%
