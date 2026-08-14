"""AI usage logging — local, app-owned SQLite store (token counts + metadata only).

Records ONE row per Claude API call made anywhere in the app: which feature
triggered it, model, input/output/total tokens, duration, timestamp, and
success/failed status. NO prompt/response content and NO cost/pricing is ever
stored.

Storage is a single local SQLite file (see config.usage_db_path()) — not a
SQL Server, not a customer/target database. Uses the stdlib `sqlite3` module
(no extra dependency).

Design notes:
- Inserts run on a short-lived background daemon thread so they add NO latency
  to the AI response, and a logging failure can never break an AI feature — it
  is caught and printed, never raised.
- Writes are serialized with a process-wide lock (SQLite allows a single writer)
  and each worker opens/commits/closes its own connection (connections are
  thread-affine in sqlite3).
"""
import sqlite3
import threading
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.config import usage_db_path

_WRITE_LOCK = threading.Lock()

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    call_timestamp TEXT    NOT NULL,
    feature_name   TEXT    NOT NULL,
    model          TEXT,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0,
    duration_ms    INTEGER,
    status         TEXT    NOT NULL,
    error_message  TEXT,
    user_id        INTEGER,
    client_id      INTEGER
)
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(usage_db_path(), timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_owner_columns(conn: sqlite3.Connection) -> None:
    """Add the tenant-scoping columns to a pre-existing (legacy) table.

    SEC-001: older ai_usage_log tables were created without an owner, so
    CREATE TABLE IF NOT EXISTS alone won't add the columns. Migrate in place by
    checking PRAGMA table_info and ALTERing when missing. Idempotent. Caller
    holds _WRITE_LOCK. Rows written before this migration keep NULL owner and are
    therefore never returned/cleared by a tenant-scoped query.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(ai_usage_log)").fetchall()}
    if "user_id" not in cols:
        conn.execute("ALTER TABLE ai_usage_log ADD COLUMN user_id INTEGER")
    if "client_id" not in cols:
        conn.execute("ALTER TABLE ai_usage_log ADD COLUMN client_id INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_usage_scope ON ai_usage_log(user_id, client_id)")


def _session_owner():
    """(user_id, client_id) from the Flask session, or (None, None).

    SEC-001: the log row's owner is derived SERVER-SIDE from the signed session,
    never from client-supplied input. This is read on the REQUEST thread —
    log_ai_call runs synchronously in the request handler and only the _insert is
    backgrounded — so the session is bound here. Fully guarded: outside a request
    context (or if Flask can't be imported) it returns (None, None) so logging
    still proceeds and can never break the AI feature.
    """
    try:
        from flask import session, has_request_context
        if not has_request_context():
            return None, None
        return session.get("uid"), session.get("cid")
    except Exception:  # noqa: BLE001 - owner capture must never break logging
        return None, None


def ensure_usage_table() -> None:
    """Create the ai_usage_log table if it doesn't exist (idempotent).

    Called once at startup. Also migrates a legacy table to add the tenant-scoping
    owner columns (SEC-001). Guarded so a failure here (e.g. read-only dir) is
    logged but never prevents the app from starting.
    """
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(_CREATE_SQL)
                _ensure_owner_columns(conn)
                conn.commit()
            finally:
                conn.close()
    except Exception:  # noqa: BLE001
        print("[ai_usage_logger] ensure_usage_table failed:\n" + traceback.format_exc())


def delete_user_logs(user_id: int) -> int:
    """Delete ALL usage rows for a user (every client) — used when an admin deletes
    the account. The usage log lives in a separate SQLite file with no FK to users,
    so it must be purged explicitly. Returns the number of rows removed."""
    if not user_id:
        return 0
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(_CREATE_SQL)
                _ensure_owner_columns(conn)
                cur = conn.execute("DELETE FROM ai_usage_log WHERE user_id=?", (user_id,))
                conn.commit()
                return int(cur.rowcount or 0)
            finally:
                conn.close()
    except Exception as exc:  # noqa: BLE001
        print("[ai_usage_logger] delete_user_logs failed: " + repr(exc))
        return 0


def clear_logs(user_id: int, client_id: int) -> Dict[str, Any]:
    """Delete this tenant's usage rows (irreversible). Returns {ok, deleted}.

    SEC-001: scoped to the caller's (user_id, client_id) — derived by the route
    from the session — so one account can only ever clear its OWN rows and can
    never wipe another tenant's log. Ensures the table exists + is migrated first
    (using the same held lock — no nested acquire, since threading.Lock is not
    reentrant).
    """
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(_CREATE_SQL)                 # table may not exist yet
                _ensure_owner_columns(conn)               # legacy table may lack owner cols
                cur = conn.execute(
                    "DELETE FROM ai_usage_log WHERE user_id=? AND client_id=?",
                    (user_id, client_id),
                )
                conn.commit()
                return {"ok": True, "deleted": int(cur.rowcount or 0)}
            finally:
                conn.close()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _insert(row: Dict[str, Any]) -> None:
    """Actual insert (runs on the background thread). Never raises."""
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(
                    "INSERT INTO ai_usage_log (call_timestamp, feature_name, model, "
                    "input_tokens, output_tokens, total_tokens, duration_ms, status, error_message, "
                    "user_id, client_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["call_timestamp"], row["feature_name"], row["model"],
                     row["input_tokens"], row["output_tokens"], row["total_tokens"],
                     row["duration_ms"], row["status"], row["error_message"],
                     row.get("user_id"), row.get("client_id")),
                )
                conn.commit()
            finally:
                conn.close()
    except Exception:  # noqa: BLE001 - logging must never break the AI feature
        print("[ai_usage_logger] insert failed:\n" + traceback.format_exc())


def log_ai_call(feature_name: str, model: Optional[str], input_tokens: int,
                output_tokens: int, duration_ms: Optional[int], status: str,
                error_message: Optional[str] = None) -> None:
    """Queue one usage row for insertion on a background daemon thread.

    Returns immediately; the insert happens off the response path. total_tokens
    is computed here as input + output. `error_message` is truncated defensively.
    """
    it = int(input_tokens or 0)
    ot = int(output_tokens or 0)
    uid, cid = _session_owner()   # captured on the request thread, before the insert thread spawns
    row = {
        "call_timestamp": datetime.now(timezone.utc).isoformat(),
        "feature_name": (feature_name or "Unknown")[:100],
        "model": (model or None) and str(model)[:100],
        "input_tokens": it,
        "output_tokens": ot,
        "total_tokens": it + ot,
        "duration_ms": None if duration_ms is None else int(duration_ms),
        "status": ("failed" if status == "failed" else "success"),
        "error_message": (str(error_message)[:1000] if error_message else None),
        "user_id": uid,
        "client_id": cid,
    }
    try:
        threading.Thread(target=_insert, args=(row,), daemon=True).start()
    except Exception:  # noqa: BLE001 - even thread-spawn failure must not propagate
        print("[ai_usage_logger] could not spawn insert thread:\n" + traceback.format_exc())


# --------------------------- read side (report API) --------------------------- #

def _date_filters(user_id: int, client_id: int, start_date: Optional[str],
                  end_date: Optional[str], feature: Optional[str]):
    """Build a tenant-scoped WHERE clause + params (dates are YYYY-MM-DD).

    SEC-002: the (user_id, client_id) predicate is MANDATORY and always first —
    the tenant is derived from the session by the route, never from a query param —
    so a read can only ever return the caller's own rows. Legacy rows written
    before the owner columns existed have a NULL owner and are therefore excluded
    from every tenant-scoped read.
    """
    clauses: List[str] = ["user_id = ?", "client_id = ?"]
    params: List[Any] = [user_id, client_id]
    if start_date:
        clauses.append("date(call_timestamp) >= date(?)")
        params.append(start_date)
    if end_date:
        clauses.append("date(call_timestamp) <= date(?)")
        params.append(end_date)
    if feature:
        clauses.append("feature_name = ?")
        params.append(feature)
    where = " WHERE " + " AND ".join(clauses)
    return where, params


def query_logs(user_id: int, client_id: int, start_date: Optional[str] = None,
               end_date: Optional[str] = None, feature: Optional[str] = None,
               limit: int = 100, offset: int = 0) -> Dict[str, Any]:
    """Return this tenant's paginated log rows (newest first) + matching count."""
    limit = max(1, min(int(limit or 100), 1000))
    offset = max(0, int(offset or 0))
    where, params = _date_filters(user_id, client_id, start_date, end_date, feature)
    try:
        conn = _connect()
        try:
            total = conn.execute("SELECT COUNT(*) AS c FROM ai_usage_log" + where, params).fetchone()["c"]
            rows = conn.execute(
                "SELECT id, call_timestamp, feature_name, model, input_tokens, "
                "output_tokens, total_tokens, duration_ms, status, error_message "
                "FROM ai_usage_log" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
                params + [limit, offset],
            ).fetchall()
            return {"ok": True, "total": int(total), "limit": limit, "offset": offset,
                    "rows": [dict(r) for r in rows]}
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "total": 0, "rows": []}


def summary(user_id: int, client_id: int, start_date: Optional[str] = None,
            end_date: Optional[str] = None) -> Dict[str, Any]:
    """This tenant's overall totals + per-feature breakdown for the report cards/table."""
    where, params = _date_filters(user_id, client_id, start_date, end_date, None)
    try:
        conn = _connect()
        try:
            o = conn.execute(
                "SELECT COUNT(*) AS total_calls, "
                "COALESCE(SUM(input_tokens),0) AS total_input_tokens, "
                "COALESCE(SUM(output_tokens),0) AS total_output_tokens, "
                "COALESCE(SUM(total_tokens),0) AS total_tokens, "
                "COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed_calls "
                "FROM ai_usage_log" + where, params,
            ).fetchone()
            by_feat = conn.execute(
                "SELECT feature_name, COUNT(*) AS total_calls, "
                "COALESCE(SUM(input_tokens),0) AS total_input_tokens, "
                "COALESCE(SUM(output_tokens),0) AS total_output_tokens, "
                "COALESCE(SUM(total_tokens),0) AS total_tokens "
                "FROM ai_usage_log" + where + " GROUP BY feature_name ORDER BY total_tokens DESC",
                params,
            ).fetchall()
            return {"ok": True, "overall": dict(o), "by_feature": [dict(r) for r in by_feat]}
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc),
                "overall": {"total_calls": 0, "total_input_tokens": 0,
                            "total_output_tokens": 0, "total_tokens": 0, "failed_calls": 0},
                "by_feature": []}
