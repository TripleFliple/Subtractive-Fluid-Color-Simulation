@echo off
echo Launching Star Fluid Sim...
set "DIR=%~dp0"
set "FILE=%DIR%index.html"

REM Try common Chrome locations
set CHROME=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
)

if "%CHROME%"=="" (
    echo Chrome not found in default locations.
    echo Please open Chrome manually with flag: --allow-file-access-from-files
    pause
    exit /b 1
)

start "" "%CHROME%" --allow-file-access-from-files "%FILE%"
echo Done! Chrome should open with the simulation.
