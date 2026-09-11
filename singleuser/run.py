"""Single-user launcher for AI Data Conversion Studio.

ADDITIVE — imports the existing multi-user app unchanged and extends the app
instance at runtime. It does NOT modify anything under server/app, js, pages, css.

It isolates the single-user instance from the corporate multi-user setup:
  - AIMS_DISABLE_DOTENV=1 so the shared server/.env (corporate gateway) is ignored;
  - its own singleuser/.env for the user's Claude key + model;
  - its own local SQLite DBs under singleuser/data/.
So running this never affects `cd server && python main.py` (multi-user).

Adds a first-run /setup wizard (API key + requirements) and single-user auto-login
by registering a blueprint + before_request hooks on the app instance.

Launched by run.bat / run.sh (which create a local venv and install base deps).
"""
import os
import sys
import secrets
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SERVER_DIR = os.path.join(REPO, "server")
FROZEN = getattr(sys, "frozen", False)

if FROZEN:
    # PyInstaller .exe: the bundle is read-only/temporary, so working data
    # (config .env, SQLite DBs) must live in a persistent, writable per-user
    # folder. `app`, `_envfile`, `setup_routes` are already importable from the
    # bundle, so no sys.path wiring is needed.
    _base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    DATA_DIR = os.path.join(_base, "AI Data Conversion Studio")
else:
    DATA_DIR = os.path.join(HERE, "data")
    sys.path.insert(0, HERE)          # _envfile, setup_routes
    sys.path.insert(0, SERVER_DIR)    # the existing `app` package

os.makedirs(DATA_DIR, exist_ok=True)
# Point the single-user config file at the writable data dir (frozen-safe).
os.environ.setdefault("AIMS_ENV_FILE", os.path.join(DATA_DIR, ".env"))

import _envfile  # noqa: E402

# ---- Isolate config from the multi-user setup BEFORE importing the app ----
os.environ["AIMS_DISABLE_DOTENV"] = "1"                 # ignore server/.env entirely
# Single-user uses ONLY its own key (from the wizard / singleuser/.env) — never an
# inherited corporate token/gateway from the surrounding shell. Drop those first so a
# fresh install always shows the API-key wizard and always calls the public API.
for _k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
    os.environ.pop(_k, None)
for _k, _v in _envfile.read_env_file().items():         # load OUR singleuser/.env
    os.environ.setdefault(_k, _v)
if not os.environ.get("AIMS_SECRET_KEY"):               # stable, persisted session key
    _sk = secrets.token_urlsafe(48)
    _envfile.upsert({"AIMS_SECRET_KEY": _sk})
    os.environ["AIMS_SECRET_KEY"] = _sk
os.environ.setdefault("AIMS_SINGLE_USER", "1")
os.environ.setdefault("AIMS_MODEL", "claude-sonnet-5")  # public Anthropic default
os.environ.setdefault("AIMS_APP_DB", os.path.join(DATA_DIR, "aims_app.db"))
os.environ.setdefault("AIMS_USAGE_DB", os.path.join(DATA_DIR, "aims_usage.db"))
os.environ.setdefault("AIMS_SIGNUP_ENABLED", "0")

# ---- Import the existing app (create_app runs here, with our isolated env) ----
from app import app                                     # noqa: E402
from app.core.config import port                        # noqa: E402
from app.db.app_db import connect                       # noqa: E402
from app.services import admin_service, client_service  # noqa: E402
import setup_routes                                     # noqa: E402
from flask import session, request, redirect, jsonify   # noqa: E402

LOCAL_EMAIL = "local@studio.local"
LOCAL_NAME = "Local User"
LOCAL_PW = "LocalUser#1"   # never entered interactively (auto-login); local-only


def _bootstrap_local_user():
    """Idempotently ensure one STANDARD local user + a default client. Returns (uid, cid)."""
    conn = connect()
    try:
        row = conn.execute("SELECT id FROM users WHERE email=?", (LOCAL_EMAIL,)).fetchone()
    finally:
        conn.close()
    if row:
        uid = row["id"]
    else:
        res, _ = admin_service.create_user(LOCAL_EMAIL, LOCAL_PW, LOCAL_NAME)
        if not res.get("ok"):
            raise RuntimeError("Could not create local user: %s" % res.get("error"))
        uid = res["user"]["id"]
    # Don't nag the single local user to change their password.
    conn = connect()
    try:
        conn.execute("UPDATE users SET must_change_password=0 WHERE id=?", (uid,))
        conn.commit()
    finally:
        conn.close()
    clients = client_service.list_clients(uid)
    if clients:
        cid = clients[0]["id"]
    else:
        res, _ = client_service.create_client(uid, "My Workspace")
        cid = res["client"]["id"]
    return uid, cid


LOCAL_UID, LOCAL_CID = _bootstrap_local_user()

# ---- Register the setup blueprint + gates on the app instance (no edits to app/) ----
app.register_blueprint(setup_routes.setup_bp)


def _single_user_session():
    """Auto-establish the local session so there's no login step."""
    if not session.get("uid"):
        session.permanent = True
        session["uid"] = LOCAL_UID
        session["cid"] = LOCAL_CID
    return None


def _setup_gate():
    """Until a Claude key is configured, force everything to the /setup wizard."""
    if setup_routes.is_configured():
        return None
    p = request.path or "/"
    if (p == "/setup" or p.startswith("/api/setup/")
            or p.startswith(("/css/", "/js/", "/assets/")) or p == "/favicon.ico"):
        return None
    if p.startswith("/api/"):
        return jsonify({"ok": False, "error": "Setup required: open the app to enter your Claude API key."}), 503
    return redirect("/setup")


# Insert at the FRONT so these run before the app's existing auth/CSRF guards.
# Resulting order: [_setup_gate, _single_user_session, <existing guards>...].
_funcs = app.before_request_funcs.setdefault(None, [])
_funcs.insert(0, _single_user_session)
_funcs.insert(0, _setup_gate)


def _pick_port(preferred):
    """Use the preferred port if free; otherwise let the OS choose a free one — so the
    single-user app never collides with a multi-user server already bound to that port."""
    import socket
    for candidate in (preferred, 0):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", candidate))
            chosen = s.getsockname()[1]
            s.close()
            return chosen
        except OSError:
            s.close()
    return preferred


def main():
    chosen = _pick_port(port())
    url = "http://127.0.0.1:%d/" % chosen
    if not os.environ.get("AIMS_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print("\n  AI Data Conversion Studio (single-user)")
    if chosen != port():
        print("  (port %d was busy — using a free port instead)" % port())
    print("  Open your browser at: %s\n" % url)
    app.run(host="127.0.0.1", port=chosen, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
