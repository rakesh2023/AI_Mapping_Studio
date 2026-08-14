"""Per-client working data (the stores that used to live in browser localStorage).

Each store is a single JSON document keyed by (user_id, client_id, doc_key). This
is the multi-tenancy boundary: every read/write is filtered by the SESSION's
user_id and the active client_id (passed in by the route from the session) — never
by a client-supplied user id — so one account can never read or write another's data.

`doc_key` is validated against a fixed allowlist (the 12 known stores) so callers
can't create arbitrary rows.
"""
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from app.db.app_db import connect, write_lock

# The 12 per-client stores (localStorage key minus the 'aims_' prefix).
ALLOWED_DOC_KEYS = frozenset({
    "db_connections", "target_connections", "active_target",
    "target_schema", "ai_mappings", "ai_joins", "mapping_overrides",
    "mapping_history", "deploy_history", "exports", "business_context",
    "etl_instructions",
})

_MAX_DOC_CHARS = 6_000_000   # ~6 MB per document (guards against runaway payloads)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_allowed(doc_key: str) -> bool:
    return doc_key in ALLOWED_DOC_KEYS


def get_doc(user_id: int, client_id: int, doc_key: str) -> Tuple[Dict[str, Any], int]:
    """Return {ok, value} for one store (value is None if unset)."""
    if not is_allowed(doc_key):
        return {"ok": False, "error": "Unknown document key."}, 400
    conn = connect()
    try:
        row = conn.execute(
            "SELECT json FROM tenant_documents WHERE user_id=? AND client_id=? AND doc_key=?",
            (user_id, client_id, doc_key),
        ).fetchone()
    finally:
        conn.close()
    value = None
    if row:
        try:
            value = json.loads(row["json"])
        except (ValueError, TypeError):
            value = None
    return {"ok": True, "value": value}, 200


def set_doc(user_id: int, client_id: int, doc_key: str, value: Any) -> Tuple[Dict[str, Any], int]:
    """Upsert one store's JSON value (scoped to this user+client)."""
    if not is_allowed(doc_key):
        return {"ok": False, "error": "Unknown document key."}, 400
    try:
        blob = json.dumps(value)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Value is not JSON-serializable."}, 400
    if len(blob) > _MAX_DOC_CHARS:
        return {"ok": False, "error": "Document is too large to store."}, 413
    with write_lock():
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO tenant_documents (user_id, client_id, doc_key, json, updated_at) "
                "VALUES (?,?,?,?,?) "
                "ON CONFLICT(user_id, client_id, doc_key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                (user_id, client_id, doc_key, blob, _now()),
            )
            conn.commit()
        finally:
            conn.close()
    return {"ok": True}, 200


def get_bundle(user_id: int, client_id: int) -> Dict[str, Any]:
    """Return {doc_key: value} for every stored doc of this user+client."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT doc_key, json FROM tenant_documents WHERE user_id=? AND client_id=?",
            (user_id, client_id),
        ).fetchall()
    finally:
        conn.close()
    out: Dict[str, Any] = {}
    for r in rows:
        try:
            out[r["doc_key"]] = json.loads(r["json"])
        except (ValueError, TypeError):
            pass
    return out


def delete_all(user_id: int, client_id: int) -> Tuple[Dict[str, Any], int]:
    """Delete every stored doc for this user+client (the 'reset application' action)."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "DELETE FROM tenant_documents WHERE user_id=? AND client_id=?",
                (user_id, client_id),
            )
            conn.commit()
            removed = cur.rowcount
        finally:
            conn.close()
    return {"ok": True, "removed": removed}, 200
