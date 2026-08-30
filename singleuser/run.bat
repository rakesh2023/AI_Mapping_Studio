@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating local Python environment ^(.venv^) ...
  py -3 -m venv .venv 2>nul || python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
  echo.
  echo ERROR: Could not create a Python environment. Install Python 3.10+ from
  echo https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and re-run.
  echo.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip >nul 2>&1
python -m pip install -r requirements-min.txt
if errorlevel 1 (
  echo.
  echo ERROR: Could not install base dependencies. Check your internet/proxy and re-run.
  pause
  exit /b 1
)

echo.
echo Starting AI Data Conversion Studio ^(single-user^) ...
python run.py
pause
