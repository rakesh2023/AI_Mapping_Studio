"""Source Data Filter — persistence of generated extraction query sets, versioned per tenant.

Every successful generation is saved as a new row in `source_filter_runs`; the version number
auto-increments per (user_id, client_id) so the page can show the latest and let the user pick an
earlier one. App-relational and tenant-scoped like lookup_service: scope is derived from
(user_id, client_id) supplied by the route (from the signed session — never client input), and
every query filters by both. Returns (payload, http_status) dicts. Writes hold write_lock().
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from app.db.app_db import connect, write_lock

Payload = Dict[str, Any]
Result = Tuple[Payload, int]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save_version(user_id: int, client_id: int, body: Dict[str, Any], result: Dict[str, Any]) -> Result:
    """Save a generated query set as the next version for this tenant.

    `body` is the original generate request (for the config metadata); `result` is the service's
    successful payload (queries + grounding). Returns {ok, id, version, createdAt}."""
    queries = result.get("queries") or []
    if not queries:
        return {"ok": False, "error": "Nothing to save — no queries were generated."}, 400
    payload = {
        "queries": queries,
        "grounded": result.get("grounded") or [],
        "unrelated": result.get("unrelated") or [],
        "keyPredicate": result.get("keyPredicate"),
    }
    now = _now()
    with write_lock():
        conn = connect()
        try:
            row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS v FROM source_filter_runs WHERE user_id=? AND client_id=?",
                (user_id, client_id),
            ).fetchone()
            version = int(row["v"]) + 1
            cur = conn.execute(
                "INSERT INTO source_filter_runs (user_id, client_id, version, source_name, main_table, "
                "key_column, dialect, use_control, control_table, load_name, mode, query_count, "
                "payload_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (user_id, client_id, version,
                 (body.get("sourceName") or ""), (body.get("mainTable") or ""),
                 (body.get("keyColumn") or ""), (result.get("dialect") or body.get("dialect") or ""),
                 1 if result.get("useControlTable") else 0,
                 (result.get("controlTable") or ""), (result.get("loadName") or ""),
                 (body.get("mode") or ""), len(queries), json.dumps(payload), now),
            )
            new_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": new_id, "version": version, "createdAt": now}, 200


def list_versions(user_id: int, client_id: int) -> Result:
    """List saved versions (metadata only), newest first, for the version dropdown."""
    with write_lock():
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, version, source_name, main_table, key_column, dialect, use_control, "
                "control_table, load_name, mode, query_count, created_at FROM source_filter_runs "
                "WHERE user_id=? AND client_id=? ORDER BY version DESC",
                (user_id, client_id),
            ).fetchall()
        finally:
            conn.close()
    versions = [{
        "id": r["id"], "version": r["version"], "sourceName": r["source_name"] or "",
        "mainTable": r["main_table"] or "", "keyColumn": r["key_column"] or "",
        "dialect": r["dialect"] or "", "useControlTable": bool(r["use_control"]),
        "controlTable": r["control_table"] or "", "loadName": r["load_name"] or "",
        "mode": r["mode"] or "", "queryCount": r["query_count"] or 0, "createdAt": r["created_at"],
    } for r in rows]
    return {"ok": True, "versions": versions}, 200


def delete_version(user_id: int, client_id: int, run_id: int) -> Result:
    """Delete one saved version the caller owns (tenant-scoped)."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "DELETE FROM source_filter_runs WHERE id=? AND user_id=? AND client_id=?",
                (run_id, user_id, client_id),
            )
            removed = cur.rowcount if cur.rowcount is not None else 0
            conn.commit()
        finally:
            conn.close()
    if not removed:
        return {"ok": False, "error": "Version not found."}, 404
    return {"ok": True, "removed": removed}, 200


def get_version(user_id: int, client_id: int, run_id: int) -> Result:
    """Return one saved version's full queries + metadata (tenant-scoped)."""
    with write_lock():
        conn = connect()
        try:
            r = conn.execute(
                "SELECT * FROM source_filter_runs WHERE id=? AND user_id=? AND client_id=?",
                (run_id, user_id, client_id),
            ).fetchone()
        finally:
            conn.close()
    if not r:
        return {"ok": False, "error": "Version not found."}, 404
    try:
        payload = json.loads(r["payload_json"]) or {}
    except Exception:  # noqa: BLE001
        payload = {}
    return {"ok": True, "version": {
        "id": r["id"], "version": r["version"], "sourceName": r["source_name"] or "",
        "mainTable": r["main_table"] or "", "keyColumn": r["key_column"] or "",
        "dialect": r["dialect"] or "", "useControlTable": bool(r["use_control"]),
        "controlTable": r["control_table"] or "", "loadName": r["load_name"] or "",
        "mode": r["mode"] or "", "queryCount": r["query_count"] or 0, "createdAt": r["created_at"],
        "queries": payload.get("queries") or [], "grounded": payload.get("grounded") or [],
        "unrelated": payload.get("unrelated") or [], "keyPredicate": payload.get("keyPredicate"),
    }}, 200
