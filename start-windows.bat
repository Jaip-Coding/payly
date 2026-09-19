@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:8000"
  py -m http.server 8000
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:8000"
  python -m http.server 8000
  goto :eof
)
echo Python 3 is required. Install it from https://www.python.org/downloads/
pause
