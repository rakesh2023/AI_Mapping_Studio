"""Entry point for the AI Mapping Studio backend.

Run from the server/ directory:
    python main.py
Serves the static site and the /api/* endpoints at http://127.0.0.1:8000.
"""
from app import app
from app.core.config import port

if __name__ == "__main__":
    # use_reloader=False: the reloader spawns a watcher + a serving child and
    # restarts the child on file changes — that would kill in-flight background
    # deployment threads and wipe the in-memory job store. Keep debug (debugger +
    # error pages) but disable the auto-reloader so deploys survive.
    app.run(host="127.0.0.1", port=port(), debug=True, use_reloader=False)
