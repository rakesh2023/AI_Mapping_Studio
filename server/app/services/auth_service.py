"""Authentication: signup / login / user lookup for the multi-tenant layer.

Passwords are hashed with werkzeug.security (scrypt) — no plaintext is ever
stored or returned. Services return plain dicts; the routes own the Flask
session. All DB access goes through app.db.app_db (stdlib sqlite3).
"""
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from werkzeug.security import generate_password_hash, check_password_hash

from app.db.app_db import connect, write_lock

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MIN_PASSWORD = 8
_MAX_EMAIL = 254
_MAX_NAME = 120

# --- Simple in-memory login throttling (per-email) --- #
# Not distributed (single-process dev server), but blunts brute-forcing: after
# MAX_FAILS failures within WINDOW seconds, the account is locked for LOCKOUT seconds.
_FAIL_LOCK = threading.Lock()
_FAILS: Dict[str, list] = {}      # email -> [failure epoch seconds]
_MAX_FAILS = 5
_WINDOW = 15 * 60
_LOCKOUT = 15 * 60


def _prune(email: str, now: float) -> list:
    hits = [t for t in _FAILS.get(email, []) if now - t < _WINDOW]
    _FAILS[email] = hits
    return hits


def login_locked_seconds(email: str) -> int:
    """Seconds remaining before this email may try again, or 0 if not locked."""
    email = (email or "").strip().lower()
    now = time.time()
    with _FAIL_LOCK:
        hits = _prune(email, now)
        if len(hits) >= _MAX_FAILS:
            return max(0, int(_LOCKOUT - (now - hits[-1])))
    return 0


def record_login_result(email: str, success: bool) -> None:
    """Clear the counter on success; record a timestamped failure otherwise."""
    email = (email or "").strip().lower()
    now = time.time()
    with _FAIL_LOCK:
        if success:
            _FAILS.pop(email, None)
        else:
            hits = _prune(email, now)
            hits.append(now)
            _FAILS[email] = hits


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_user(row: sqlite3.Row) -> Dict[str, Any]:
    """Public user dict — NEVER includes password_hash."""
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"] or "",
        "role": row["role"] or "",
        "isAdmin": bool(row["is_admin"]) if "is_admin" in row.keys() else False,
        "createdAt": row["created_at"],
        "lastLoginAt": row["last_login_at"],
    }


def validate_signup(email: str, password: str, name: str) -> Optional[str]:
    """Return an error message if the signup inputs are invalid, else None."""
    email = (email or "").strip()
    if not email or len(email) > _MAX_EMAIL or not _EMAIL_RE.match(email):
        return "Enter a valid email address."
    if not password or len(password) < _MIN_PASSWORD:
        return "Password must be at least %d characters." % _MIN_PASSWORD
    if len(password) > 200:
        return "Password is too long."
    if name and len(name) > _MAX_NAME:
        return "Name is too long."
    return None


def signup(email: str, password: str, name: str = "", role: str = "Migration Lead") -> Tuple[Dict[str, Any], int]:
    """Create a user. Returns ({ok, user}|{ok:False,error}, status)."""
    err = validate_signup(email, password, name)
    if err:
        return {"ok": False, "error": err}, 400
    email = email.strip().lower()
    name = (name or "").strip()
    pw_hash = generate_password_hash(password)
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?,?,?,?,?)",
                (email, pw_hash, name, role or "Migration Lead", _now()),
            )
            conn.commit()
            uid = cur.lastrowid
            row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        except sqlite3.IntegrityError:
            return {"ok": False, "error": "An account with that email already exists."}, 409
        finally:
            conn.close()
    return {"ok": True, "user": _row_to_user(row)}, 201


def authenticate(email: str, password: str) -> Optional[Dict[str, Any]]:
    """Return the public user dict if credentials are valid, else None.

    Updates last_login_at on success. Uses a constant-ish path (always runs a
    hash check) so a missing email isn't trivially distinguishable by timing.
    """
    email = (email or "").strip().lower()
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    finally:
        conn.close()
    # Always run a check to reduce user-enumeration timing signal.
    stored = row["password_hash"] if row else "scrypt:32768:8:1$placeholder$0"
    ok = check_password_hash(stored, password or "")
    if not row or not ok:
        return None
    with write_lock():
        conn = connect()
        try:
            conn.execute("UPDATE users SET last_login_at=? WHERE id=?", (_now(), row["id"]))
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
        finally:
            conn.close()
    return _row_to_user(row)


def get_user(uid: int) -> Optional[Dict[str, Any]]:
    """Public user dict for a logged-in session's uid, or None."""
    if not uid:
        return None
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        conn.close()
    return _row_to_user(row) if row else None


def ensure_admin() -> None:
    """Bootstrap the admin account from the environment (AIMS_ADMIN_EMAIL / _PASSWORD).

    Since self-signup is disabled, at least one admin must exist to manage users.
    If AIMS_ADMIN_EMAIL matches an existing account, promote it (is_admin=1);
    otherwise create it with AIMS_ADMIN_PASSWORD. No-op (with a warning) when the
    email is unset, or when the account is missing and no password is provided.
    Called once at startup; guarded so it can never block app boot.
    """
    from app.core.config import admin_email, admin_password
    email = admin_email()
    if not email:
        return
    pw = admin_password()
    try:
        with write_lock():
            conn = connect()
            try:
                row = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
                if row:
                    conn.execute("UPDATE users SET is_admin=1 WHERE id=?", (row["id"],))
                    conn.commit()
                    print("[auth] admin ensured (promoted existing account): " + email)
                elif pw:
                    conn.execute(
                        "INSERT INTO users (email, password_hash, name, role, is_admin, created_at) "
                        "VALUES (?,?,?,?,1,?)",
                        (email, generate_password_hash(pw), "Administrator", "Administrator", _now()),
                    )
                    conn.commit()
                    print("[auth] admin ensured (created new account): " + email)
                else:
                    print("[auth] WARNING: AIMS_ADMIN_EMAIL is set but the account does not exist "
                          "and AIMS_ADMIN_PASSWORD is not set — no admin was created.")
            finally:
                conn.close()
    except Exception as exc:  # noqa: BLE001 - admin bootstrap must never block startup
        print("[auth] ensure_admin failed: " + repr(exc))
