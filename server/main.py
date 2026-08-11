"""Entry point for the AI Mapping Studio backend.

Run from the server/ directory:
    python main.py
Serves the static site and the /api/* endpoints at http://127.0.0.1:8000.
"""
from app import app
from app.core.config import port

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=port(), debug=True)
