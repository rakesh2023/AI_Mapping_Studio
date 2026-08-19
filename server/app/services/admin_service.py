"""Admin user management: list / create / delete accounts.

Only an admin (is_admin=1, seeded from the environment) may call these — the
route enforces that. Creating a user here makes a STANDARD account (is_admin=0);
admins are established solely via the env bootstrap (auth_service.ensure_admin).

Deleting a user is PERMANENT: the users row cascades to their clients and every
tenant_document (ON DELETE CASCADE, foreign_keys=ON), and we also purge their AI
usage-log rows (a separate SQLite file with no FK).
"""
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from werkzeug.security import generate_password_hash

from app.db.app_db import connect, write_lock
from app.services import auth_service, ai_usage_logger


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_admin(uid: Optional[int]) -> bool:
    """True if the (session) user id belongs to an admin account."""
    if not uid:
        return False
    conn = connect()
    try:
        row = conn.execute("SELECT is_admin FROM users WHERE id=?", (uid,)).fetchone()
    finally:
        conn.close()
    return bool(row and row["is_admin"])


def count_admins() -> int:
    conn = connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1").fetchone()
    finally:
        conn.close()
    return int(row["c"]) if row else 0


def list_users() -> List[Dict[str, Any]]:
    """Every account, newest first, each with its client count. No password hashes."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT u.id, u.email, u.name, u.role, u.is_admin, u.created_at, u.last_login_at, "
            "       (SELECT COUNT(*) FROM clients c WHERE c.user_id = u.id) AS client_count "
            "FROM users u ORDER BY datetime(u.created_at) DESC"
        ).fetchall()
    finally:
        conn.close()
    return [{
        "id": r["id"], "email": r["email"], "name": r["name"] or "",
        "role": r["role"] or "", "isAdmin": bool(r["is_admin"]),
        "createdAt": r["created_at"], "lastLoginAt": r["last_login_at"],
        "clientCount": int(r["client_count"] or 0),
    } for r in rows]


def create_user(email: str, password: str, name: str = "") -> Tuple[Dict[str, Any], int]:
    """Create a STANDARD (non-admin) account. Reuses signup validation; no session.
    Returns ({ok, user}|{ok:False,error}, status)."""
    err = auth_service.validate_signup(email, password, name)
    if err:
        return {"ok": False, "error": err}, 400
    email = (email or "").strip().lower()
    name = (name or "").strip()
    pw_hash = generate_password_hash(password)
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, name, role, is_admin, must_change_password, created_at) "
                "VALUES (?,?,?,?,0,1,?)",
                (email, pw_hash, name, "Migration Lead", _now()),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
        except sqlite3.IntegrityError:
            return {"ok": False, "error": "An account with that email already exists."}, 409
        finally:
            conn.close()
    return {"ok": True, "user": auth_service._row_to_user(row)}, 201


def delete_user(uid: int) -> Tuple[Dict[str, Any], int]:
    """Permanently delete an account and ALL its data.

    The users-row delete cascades to clients + tenant_documents; usage-log rows
    (separate DB, no FK) are purged separately. Returns ({ok, removedUsageRows}|
    {ok:False,error}, status). Caller (route) enforces the self / last-admin guards.
    """
    with write_lock():
        conn = connect()
        try:
            exists = conn.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
            if not exists:
                return {"ok": False, "error": "User not found."}, 404
            conn.execute("DELETE FROM users WHERE id=?", (uid,))   # cascades clients + tenant_documents
            conn.commit()
        finally:
            conn.close()
    removed_usage = ai_usage_logger.delete_user_logs(uid)
    return {"ok": True, "removedUsageRows": removed_usage}, 200
