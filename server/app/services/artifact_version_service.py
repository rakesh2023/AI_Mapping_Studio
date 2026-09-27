"""Generic versioned store for generated artifacts (e.g. ETL code), tenant-scoped per feature.

Each save is a new version; the version number auto-increments per (user_id, client_id, feature),
so a page can show the latest and let the user pick or delete an earlier one. Scope is derived from
(user_id, client_id) supplied by the route (from the signed session — never client input) and every
query filters by both plus `feature`. Returns (payload, http_status). Writes hold write_lock().
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, Tuple

from app.db.app_db import connect, write_lock

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

_MAX_CONTENT = 2_000_000   # ~2 MB per version guard


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save_version(user_id: int, client_id: int, feature: str, data: Dict[str, Any]) -> Result:
    """Save `content` (+ title/kind/meta) as the next version. Version auto-increments per
    (tenant, feature, group_key) — so each group_key (e.g. one per table) has its own sequence."""
    content = (data.get("content") or "").strip()
    if not content:
        return {"ok": False, "error": "Nothing to save — the generated SQL is empty."}, 400
    if len(content) > _MAX_CONTENT:
        return {"ok": False, "error": "Generated SQL is too large to save."}, 400
    title = (data.get("title") or "")[:300]
    kind = (data.get("kind") or "")[:80]
    group_key = (data.get("groupKey") or "")[:400]
    meta_json = json.dumps(data.get("meta") or {})
    now = _now()
    with write_lock():
        conn = connect()
        try:
            row = conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions "
                "WHERE user_id=? AND client_id=? AND feature=? AND group_key=?",
                (user_id, client_id, feature, group_key),
            ).fetchone()
            version = int(row["v"]) + 1
            cur = conn.execute(
                "INSERT INTO artifact_versions (user_id, client_id, feature, group_key, version, title, "
                "kind, meta_json, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (user_id, client_id, feature, group_key, version, title, kind, meta_json, content, now),
            )
            new_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": new_id, "version": version, "groupKey": group_key, "createdAt": now}, 200


def list_versions(user_id: int, client_id: int, feature: str) -> Result:
    """Version metadata (no content), newest first, for the dropdown."""
    with write_lock():
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, group_key, version, title, kind, meta_json, created_at, LENGTH(content) AS bytes "
                "FROM artifact_versions WHERE user_id=? AND client_id=? AND feature=? "
                "ORDER BY group_key ASC, version DESC",
                (user_id, client_id, feature),
            ).fetchall()
        finally:
            conn.close()
    out = []
    for r in rows:
        try:
            meta = json.loads(r["meta_json"] or "{}")
        except Exception:  # noqa: BLE001
            meta = {}
        out.append({"id": r["id"], "groupKey": r["group_key"] or "", "version": r["version"],
                    "title": r["title"] or "", "kind": r["kind"] or "", "meta": meta,
                    "bytes": r["bytes"] or 0, "createdAt": r["created_at"]})
    return {"ok": True, "versions": out}, 200


def get_version(user_id: int, client_id: int, feature: str, run_id: int) -> Result:
    """One version's full content + metadata (tenant-scoped)."""
    with write_lock():
        conn = connect()
        try:
            r = conn.execute(
                "SELECT * FROM artifact_versions WHERE id=? AND user_id=? AND client_id=? AND feature=?",
                (run_id, user_id, client_id, feature),
            ).fetchone()
        finally:
            conn.close()
    if not r:
        return {"ok": False, "error": "Version not found."}, 404
    try:
        meta = json.loads(r["meta_json"] or "{}")
    except Exception:  # noqa: BLE001
        meta = {}
    return {"ok": True, "version": {
        "id": r["id"], "version": r["version"], "title": r["title"] or "", "kind": r["kind"] or "",
        "meta": meta, "content": r["content"] or "", "createdAt": r["created_at"],
    }}, 200


def delete_version(user_id: int, client_id: int, feature: str, run_id: int) -> Result:
    """Delete one version the caller owns (tenant + feature scoped)."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "DELETE FROM artifact_versions WHERE id=? AND user_id=? AND client_id=? AND feature=?",
                (run_id, user_id, client_id, feature),
            )
            removed = cur.rowcount if cur.rowcount is not None else 0
            conn.commit()
        finally:
            conn.close()
    if not removed:
        return {"ok": False, "error": "Version not found."}, 404
    return {"ok": True, "removed": removed}, 200
