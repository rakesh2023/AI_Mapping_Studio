#!/usr/bin/env bash
# Single-user launcher (macOS / Linux). Creates a local venv, installs base deps, runs the app.
set -e
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  echo "Creating local Python environment (.venv) ..."
  python3 -m venv .venv || { echo "ERROR: install Python 3.10+ first (python3)."; exit 1; }
fi

# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --upgrade pip >/dev/null 2>&1 || true
python -m pip install -r requirements-min.txt

echo
echo "Starting AI Data Conversion Studio (single-user) ..."
python run.py
