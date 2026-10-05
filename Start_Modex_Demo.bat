@echo off
setlocal
title Modex Offline Demo
rem Optional: drag the Modex project folder onto this file.
set "MODEX_DEMO_PROJECT=%~1"
if not defined MODEX_DEMO_PROJECT set "MODEX_DEMO_PROJECT=%~dp0"
if exist "%MODEX_DEMO_PROJECT%\apps\desktop\package.json" goto located
set "MODEX_DEMO_PROJECT=C:\Tools\modex-signing-fix"
if exist "%MODEX_DEMO_PROJECT%\apps\desktop\package.json" goto located
echo Cannot find the Modex project.
echo Put this file beside the project's root package.json,
echo or drag the project folder onto this file.
goto failed

:located
cd /d "%MODEX_DEMO_PROJECT%"
if errorlevel 1 goto failed
echo Project: %CD%
echo This opens the offline demo. It does not commit or push anything.
echo.
where node >nul 2>nul
if errorlevel 1 goto node_missing
where npm >nul 2>nul
if errorlevel 1 goto node_missing
node -e "if(Number(process.versions.node.split('.')[0])<22){console.error('Node.js 22 or newer is required.');process.exit(1)}"
if errorlevel 1 goto failed

echo [1/5] Installing or checking dependencies...
call npm install
if errorlevel 1 goto failed

echo [2/5] Building the core...
call npm run build -w @modex/core
if errorlevel 1 goto failed

echo [3/5] Building the desktop main process...
cd apps\desktop
if errorlevel 1 goto failed
node scripts\prepare-terminal.mjs
if errorlevel 1 goto failed
call npx --no-install tsc -p tsconfig.main.json
if errorlevel 1 goto failed
copy /y src\main\preload.cjs dist\src\main\preload.cjs >nul
if errorlevel 1 goto failed

echo [4/5] Building the interface...
call npm run build:renderer
if errorlevel 1 goto failed

echo [5/5] Opening the offline demo...
call npm run start -- --demo
if errorlevel 1 goto failed
echo.
echo Demo closed.
pause
exit /b 0

:node_missing
echo Node.js or npm was not found. Install Node.js 22 or newer,
echo then close this window and run this file again.
:failed
echo.
echo The demo could not start or a command failed.
echo Copy or screenshot the error above so we can check it.
pause
exit /b 1
