"""Clients (tenants) owned by a user.

Every function is scoped by the caller's user_id (the session's uid — never a
client-supplied one). Ownership is enforced here at the service/DB layer so a
user can never read or mutate another user's client, even by guessing ids.
"""
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.db.app_db import connect, write_lock

_MAX_NAME = 120
_MAX_INDUSTRY = 80
_MAX_CONFIG_CHARS = 20000   # cap the onboarding config blob


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_client(row: sqlite3.Row) -> Dict[str, Any]:
    try:
        config = json.loads(row["config_json"]) if row["config_json"] else {}
    except (ValueError, TypeError):
        config = {}
    return {
        "id": row["id"],
        "name": row["name"],
        "industry": row["industry"] or "",
        "config": config,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _validate(name: str, industry: str, config: Any) -> Optional[str]:
    name = (name or "").strip()
    if not name:
        return "Client name is required."
    if len(name) > _MAX_NAME:
        return "Client name is too long."
    if industry and len(industry) > _MAX_INDUSTRY:
        return "Industry is too long."
    if config is not None and not isinstance(config, dict):
        return "Client config must be an object."
    if config and len(json.dumps(config)) > _MAX_CONFIG_CHARS:
        return "Client config is too large."
    return None


def list_clients(user_id: int) -> List[Dict[str, Any]]:
    """All clients owned by this user, most-recent first."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM clients WHERE user_id=? ORDER BY datetime(created_at) DESC", (user_id,)
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_client(r) for r in rows]


def get_client(user_id: int, client_id: int) -> Optional[Dict[str, Any]]:
    """A single client IF it belongs to this user, else None."""
    if not client_id:
        return None
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM clients WHERE id=? AND user_id=?", (client_id, user_id)
        ).fetchone()
    finally:
        conn.close()
    return _row_to_client(row) if row else None


def owns_client(user_id: int, client_id: int) -> bool:
    """True if client_id exists and belongs to user_id (id validation for scoping)."""
    return get_client(user_id, client_id) is not None


def create_client(user_id: int, name: str, industry: str = "", config: Optional[dict] = None) -> Tuple[Dict[str, Any], int]:
    """Create a client for this user. Returns ({ok, client}|{ok:False,error}, status)."""
    err = _validate(name, industry, config)
    if err:
        return {"ok": False, "error": err}, 400
    name = name.strip()
    industry = (industry or "").strip()
    config_json = json.dumps(config or {})
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO clients (user_id, name, industry, config_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (user_id, name, industry, config_json, _now(), _now()),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM clients WHERE id=?", (cur.lastrowid,)).fetchone()
        except sqlite3.IntegrityError:
            return {"ok": False, "error": "You already have a client with that name."}, 409
        finally:
            conn.close()
    return {"ok": True, "client": _row_to_client(row)}, 201


def update_client(user_id: int, client_id: int, name: str, industry: str = "", config: Optional[dict] = None) -> Tuple[Dict[str, Any], int]:
    """Update a client the user owns. Returns ({ok, client}|{ok:False,error}, status)."""
    if not owns_client(user_id, client_id):
        return {"ok": False, "error": "Client not found."}, 404
    err = _validate(name, industry, config)
    if err:
        return {"ok": False, "error": err}, 400
    with write_lock():
        conn = connect()
        try:
            conn.execute(
                "UPDATE clients SET name=?, industry=?, config_json=?, updated_at=? WHERE id=? AND user_id=?",
                (name.strip(), (industry or "").strip(), json.dumps(config or {}), _now(), client_id, user_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM clients WHERE id=?", (client_id,)).fetchone()
        except sqlite3.IntegrityError:
            return {"ok": False, "error": "You already have a client with that name."}, 409
        finally:
            conn.close()
    return {"ok": True, "client": _row_to_client(row)}, 200
