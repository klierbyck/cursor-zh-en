@echo off
setlocal DisableDelayedExpansion
set "ACTION=%~1"
if not "%ACTION%"=="activate" if not "%ACTION%"=="restore" exit /b 2
if not "%~3"=="" (
  echo Usage: pass at most one Cursor installation folder. 1>&2
  exit /b 2
)
pushd "%~dp0.." || exit /b 1
if not exist "node_modules\.bin\tsx.cmd" (
  call npm ci
  if errorlevel 1 (popd & exit /b 1)
)
if "%~2"=="" (
  call npm run cli:localize -- %ACTION%
) else (
  call npm run cli:localize -- %ACTION% --install-dir "%~2"
)
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
