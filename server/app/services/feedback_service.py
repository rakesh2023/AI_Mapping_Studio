"""Feedback: user-raised suggestions / bug reports (app-wide, admin-reviewed).

Stored in the app DB (`feedback` table) — NOT tenant-scoped. Any logged-in user
can create feedback; admins list it and move it through a status lifecycle
(new -> accepted -> in_development -> done, or declined). Services return plain
(payload, status) dicts; routes own the session and admin gating.
"""
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.db.app_db import connect, write_lock

_TYPES = ("suggestion", "bug", "other")
_STATUSES = ("new", "accepted", "in_development", "done", "declined")
_MAX_MESSAGE = 5000
_MAX_PAGE = 300
_MAX_UA = 400


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_feedback(user_id: int, type_: str, message: str,
                    page: str = "", user_agent: str = "") -> Tuple[Dict[str, Any], int]:
    """Create a feedback row for a logged-in user. Returns ({ok, id}|{ok:False,error}, status)."""
    type_ = (type_ or "other").strip().lower()
    if type_ not in _TYPES:
        type_ = "other"
    message = (message or "").strip()
    if not message:
        return {"ok": False, "error": "Please enter a message."}, 400
    if len(message) > _MAX_MESSAGE:
        return {"ok": False, "error": "Message is too long."}, 400
    page = (page or "")[:_MAX_PAGE]
    user_agent = (user_agent or "")[:_MAX_UA]
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO feedback (user_id, type, message, page, user_agent, status, created_at) "
                "VALUES (?,?,?,?,?,'new',?)",
                (user_id, type_, message, page, user_agent, _now()),
            )
            conn.commit()
            fid = cur.lastrowid
        finally:
            conn.close()
    return {"ok": True, "id": fid}, 201


def list_feedback() -> List[Dict[str, Any]]:
    """All feedback, newest first, with submitter email/name (—' if the user was deleted)."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT f.id, f.type, f.message, f.page, f.user_agent, f.status, f.created_at, f.updated_at, "
            "       u.email AS submitter_email, u.name AS submitter_name "
            "FROM feedback f LEFT JOIN users u ON u.id = f.user_id "
            "ORDER BY datetime(f.created_at) DESC"
        ).fetchall()
    finally:
        conn.close()
    return [{
        "id": r["id"], "type": r["type"], "message": r["message"], "page": r["page"] or "",
        "userAgent": r["user_agent"] or "", "status": r["status"],
        "createdAt": r["created_at"], "updatedAt": r["updated_at"],
        "submitterEmail": r["submitter_email"] or "", "submitterName": r["submitter_name"] or "",
    } for r in rows]


def set_status(fid: int, status: str) -> Tuple[Dict[str, Any], int]:
    """Move a feedback item to a new lifecycle status (admin)."""
    status = (status or "").strip().lower()
    if status not in _STATUSES:
        return {"ok": False, "error": "Invalid status."}, 400
    with write_lock():
        conn = connect()
        try:
            row = conn.execute("SELECT id FROM feedback WHERE id=?", (fid,)).fetchone()
            if not row:
                return {"ok": False, "error": "Feedback not found."}, 404
            conn.execute("UPDATE feedback SET status=?, updated_at=? WHERE id=?", (status, _now(), fid))
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": fid, "status": status}, 200
