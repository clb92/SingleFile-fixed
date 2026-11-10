@echo off
rem Builds the SingleFile Firefox extension on Windows.
rem
rem Windows equivalent of build-extension.sh:
rem   1. installs the build dependencies (npm ci)
rem   2. rebuilds the files in lib\ (rollup)
rem   3. packs manifest.json, lib, _locales and src into a zip
rem   4. restores lib\ to the committed version, so that the build output
rem      does not get in the way of future merges
rem
rem Put this file in the root of the repository, then double-click it or run:
rem   build.bat [skipinstall] [keeplib]
rem
rem   skipinstall  do not run "npm ci" (faster when the dependencies are installed)
rem   keeplib      leave the rebuilt files in lib\ (use it when you load the
rem                extension from the folder instead of from the zip)

setlocal
cd /d "%~dp0"

set "OUTPUT=singlefile-extension-firefox.zip"
set "SKIPINSTALL="
set "KEEPLIB="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="skipinstall" set "SKIPINSTALL=1"
if /i "%~1"=="keeplib" set "KEEPLIB=1"
shift
goto parse
:parsed

if not exist manifest.json (
    echo manifest.json not found: put this script in the root of the SingleFile repository.
    goto failed
)

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required. Install it from https://nodejs.org
    goto failed
)
where tar >nul 2>nul
if errorlevel 1 (
    echo tar is required. It is included in Windows 10 ^(1803 and later^) and Windows 11.
    goto failed
)

if not exist node_modules set "SKIPINSTALL="
if defined SKIPINSTALL goto build

echo ==^> Installing the build dependencies
call npm ci
if errorlevel 1 goto failed

:build
echo ==^> Building lib\
call npx rollup -c rollup.config.js
if errorlevel 1 goto failed

echo ==^> Creating %OUTPUT%
if exist "%OUTPUT%" del "%OUTPUT%"
tar -a -c -f "%OUTPUT%" manifest.json lib _locales src
if errorlevel 1 goto failed

if defined KEEPLIB (
    echo lib\ contains the new build ^(not restored^).
    goto done
)
where git >nul 2>nul
if errorlevel 1 (
    echo git was not found on the PATH: discard the changes in lib\ from GitHub Desktop.
    goto done
)
echo ==^> Restoring lib\ to the committed version
git checkout -- lib
if errorlevel 1 goto failed

:done
echo.
echo Done: %OUTPUT%
echo Load it in Firefox from about:debugging ^> This Firefox ^> Load Temporary Add-on.
pause
exit /b 0

:failed
echo.
echo The build failed, see the messages above.
pause
exit /b 1
