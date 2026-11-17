@echo off
rem Double-click to start the overlay on Windows. Quit from the tray icon (right click).
rem   start-windows.bat              primary screen
rem   start-windows.bat -Screen 1    second screen
rem Keep this file ASCII only: Japanese text in a .bat is garbled depending on the console code page.
cd /d "%~dp0"
if not exist "%~dp0overlay\win-overlay.ps1" goto missing

rem The check below is not "if errorlevel 1": PowerShell also ends with negative exit codes
rem (script file not found, crash), and the window would close before the error can be read.
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0overlay\win-overlay.ps1" %*
if "%errorlevel%"=="0" goto :eof
echo.
echo [overlay] Stopped with an error (exit code %errorlevel%). Please check the messages above.
pause
goto :eof

:missing
echo [overlay] Not found: "%~dp0overlay\win-overlay.ps1"
echo [overlay] If you started this from inside a ZIP file, extract the whole ZIP first
echo [overlay] and run start-windows.bat in the extracted folder.
pause
exit /b 1
