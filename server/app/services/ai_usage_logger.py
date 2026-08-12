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
    error_message  TEXT
)
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(usage_db_path(), timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_usage_table() -> None:
    """Create the ai_usage_log table if it doesn't exist (idempotent).

    Called once at startup. Guarded so a failure here (e.g. read-only dir) is
    logged but never prevents the app from starting.
    """
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(_CREATE_SQL)
                conn.commit()
            finally:
                conn.close()
    except Exception:  # noqa: BLE001
        print("[ai_usage_logger] ensure_usage_table failed:\n" + traceback.format_exc())


def clear_logs() -> Dict[str, Any]:
    """Delete ALL rows from the usage log (irreversible). Returns {ok, deleted}.

    Ensures the table exists first (using the same held lock — no nested acquire,
    since threading.Lock is not reentrant).
    """
    try:
        with _WRITE_LOCK:
            conn = _connect()
            try:
                conn.execute(_CREATE_SQL)                 # table may not exist yet
                cur = conn.execute("DELETE FROM ai_usage_log")
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
                    "input_tokens, output_tokens, total_tokens, duration_ms, status, error_message) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["call_timestamp"], row["feature_name"], row["model"],
                     row["input_tokens"], row["output_tokens"], row["total_tokens"],
                     row["duration_ms"], row["status"], row["error_message"]),
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
    }
    try:
        threading.Thread(target=_insert, args=(row,), daemon=True).start()
    except Exception:  # noqa: BLE001 - even thread-spawn failure must not propagate
        print("[ai_usage_logger] could not spawn insert thread:\n" + traceback.format_exc())


# --------------------------- read side (report API) --------------------------- #

def _date_filters(start_date: Optional[str], end_date: Optional[str],
                  feature: Optional[str]):
    """Build a WHERE clause + params from optional filters (dates are YYYY-MM-DD)."""
    clauses: List[str] = []
    params: List[Any] = []
    if start_date:
        clauses.append("date(call_timestamp) >= date(?)")
        params.append(start_date)
    if end_date:
        clauses.append("date(call_timestamp) <= date(?)")
        params.append(end_date)
    if feature:
        clauses.append("feature_name = ?")
        params.append(feature)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def query_logs(start_date: Optional[str] = None, end_date: Optional[str] = None,
               feature: Optional[str] = None, limit: int = 100,
               offset: int = 0) -> Dict[str, Any]:
    """Return paginated log rows (newest first) + the total matching count."""
    limit = max(1, min(int(limit or 100), 1000))
    offset = max(0, int(offset or 0))
    where, params = _date_filters(start_date, end_date, feature)
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


def summary(start_date: Optional[str] = None, end_date: Optional[str] = None) -> Dict[str, Any]:
    """Overall totals + per-feature breakdown for the report cards/table."""
    where, params = _date_filters(start_date, end_date, None)
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
