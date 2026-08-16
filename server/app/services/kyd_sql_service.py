"""StructuredQueryTool — answer a question over ONE loaded structured table
(used when kyd_query_router picks sql_query / pandas_query).

Flow: resolve the target table from ``structured_tables`` scoped to the session's
(user_id, client_id) → build a schema sample → ask the LLM for a single SQLite
SELECT → VALIDATE it (SELECT-only, no DDL/DML, forced LIMIT, single statement) →
execute it **read-only, with a timeout, in an isolated in-memory database that
contains only that one table**. Isolation is the real security boundary: even if
a query references ``users`` or another tenant's table, those tables don't exist
in the sandbox, so it fails instead of leaking. The real app DB is only ever read
(to copy the one allowed table); the model's SQL never touches it.

Returns capped result rows + the query used, or a generic failure message (the
true cause is logged server-side).
"""
import re
import sqlite3
import threading
import traceback
from typing import Any, Dict, List, Optional

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.db.app_db import connect
from app.services.ai_client import anthropic_client
from app.services.ai_client_service import call_ai

MAX_ROWS = 200                 # cap on returned rows
QUERY_TIMEOUT_SECONDS = 5      # watchdog interrupt for a runaway query
SAMPLE_ROWS = 5                # rows shown to the model in the schema sample
_NO_QUERY = "NO_QUERY_POSSIBLE"

# Keywords that must never appear in a generated query.
_FORBIDDEN = ("insert", "update", "delete", "drop", "alter", "create", "replace",
              "truncate", "attach", "detach", "pragma", "vacuum", "grant", "revoke",
              "exec", "merge", "reindex")

_GENERIC = "Sorry — I couldn't run a query for that question. Please try rephrasing it."


def _q(ident: str) -> str:
    return '"' + str(ident).replace('"', '""') + '"'


def _safe_physical(name: str) -> bool:
    return bool(name) and re.match(r"^kyd_d\d+_[A-Za-z0-9_]+$", name) is not None


def _alias(logical: Optional[str], physical: str) -> str:
    base = (logical or "").strip() or physical
    base = re.sub(r"[^A-Za-z0-9_]", "_", base)
    if not base or not re.match(r"^[A-Za-z_]", base):
        base = "data"
    return base


def _generic() -> Dict[str, Any]:
    return {"ok": False, "error": _GENERIC}


def run_query(user_id: int, client_id: int, question: str, structured_table_id: int) -> Dict[str, Any]:
    """Answer `question` over the given structured table, scoped to (user_id, client_id)."""
    question = (question or "").strip()
    if not question:
        return _generic()

    # 1. Resolve the table — ONLY if it belongs to this tenant.
    conn = connect()
    try:
        row = conn.execute(
            "SELECT logical_name, physical_table, columns_json FROM structured_tables "
            "WHERE id=? AND user_id=? AND client_id=?",
            (structured_table_id, user_id, client_id),
        ).fetchone()
        if not row:
            return {"ok": False, "error": "That data table was not found."}
        physical = row["physical_table"]
        if not _safe_physical(physical):
            print(f"[kyd-sql] refused unsafe physical table name: {physical!r}")
            return _generic()
        alias = _alias(row["logical_name"], physical)

        # Column names + a few sample rows for the prompt (read-only).
        cur = conn.execute(f'SELECT * FROM {_q(physical)} LIMIT {SAMPLE_ROWS}')
        col_names = [d[0] for d in cur.description]
        sample = cur.fetchall()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return _generic()
    finally:
        conn.close()

    if anthropic is None:
        return _generic()

    schema_text = _schema_text(alias, col_names, sample)
    sql = _generate_sql(schema_text, question)
    if sql is None:
        return _generic()
    if sql == _NO_QUERY:
        return {"ok": False, "error": "That question can't be answered from this data.",
                "reason": "no_query"}

    ok, validated = _validate_sql(sql, alias)
    if not ok:
        print(f"[kyd-sql] rejected generated SQL ({validated}): {sql!r}")
        return _generic()

    try:
        columns, rows, truncated = _execute_isolated(physical, alias, validated)
    except Exception as exc:  # noqa: BLE001 - blocked cross-table refs, timeouts, bad SQL
        print(f"[kyd-sql] execution failed: {exc.__class__.__name__}: {exc}")
        return _generic()

    return {"ok": True, "query": validated, "table": alias,
            "columns": columns, "rows": rows, "rowCount": len(rows), "truncated": truncated}


def _schema_text(alias: str, columns: List[str], sample_rows: List[sqlite3.Row]) -> str:
    lines = [f"Table: {alias}", "Columns:"]
    for c in columns:
        lines.append(f"  - {c}")
    if sample_rows:
        lines.append("Sample rows:")
        lines.append("  " + " | ".join(str(c) for c in columns))
        for r in sample_rows:
            lines.append("  " + " | ".join(_cell(r[c]) for c in columns))
    return "\n".join(lines)


def _cell(v: Any) -> str:
    s = "" if v is None else str(v)
    return s if len(s) <= 40 else s[:37] + "..."


def _generate_sql(schema_text: str, question: str) -> Optional[str]:
    system = (
        "You are a data analyst assistant. Given the schema of a table and a user "
        "question, write a single valid SQL query (SQLite dialect) that answers it.\n\n"
        "Rules: use only existing columns; SELECT statements only (no INSERT/UPDATE/"
        "DELETE/DROP/ALTER); if unanswerable output exactly NO_QUERY_POSSIBLE; output "
        "ONLY the query, no markdown."
    )
    user = "Schema: " + schema_text + '\nQuestion: "' + question + '"'
    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=500, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Know Your Data - Structured Query", run,
                       [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return None
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        return _clean(text)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None


def _clean(text: str) -> str:
    """Strip markdown fences / stray prose and a trailing semicolon."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()
    if s.upper() == _NO_QUERY or s.upper().startswith(_NO_QUERY):
        return _NO_QUERY
    return s.rstrip(";").strip()


def _validate_sql(sql: str, alias: str):
    """(ok, cleaned|reason). Enforce SELECT-only, no forbidden keywords, single
    statement, and a LIMIT. (Isolation is the hard boundary; this is defense-in-depth.)"""
    s = (sql or "").strip()
    if not s:
        return False, "empty"
    if ";" in s:                          # no stacked statements
        return False, "multiple statements"
    first = re.match(r"^\s*([A-Za-z]+)", s)
    if not first or first.group(1).upper() not in ("SELECT", "WITH"):
        return False, "not a SELECT"
    low = s.lower()
    for kw in _FORBIDDEN:
        if re.search(r"\b" + kw + r"\b", low):
            return False, "forbidden keyword: " + kw
    if not re.search(r"\blimit\b", low):
        # +1 so _execute_isolated can detect (and flag) truncation past the cap.
        s = s + f" LIMIT {MAX_ROWS + 1}"
    return True, s


def _execute_isolated(physical: str, alias: str, sql: str):
    """Copy the one allowed table into an in-memory DB and run the query there,
    read-only, with a timeout. Nothing else (users, other tenants' tables) exists."""
    src = connect()
    try:
        cur = src.execute(f'SELECT * FROM {_q(physical)}')
        cols = [d[0] for d in cur.description]
        data = cur.fetchall()
    finally:
        src.close()

    mem = sqlite3.connect(":memory:")
    timer = threading.Timer(QUERY_TIMEOUT_SECONDS, mem.interrupt)
    try:
        mem.execute(f'CREATE TABLE {_q(alias)} ({", ".join(_q(c) for c in cols)})')
        if data:
            placeholders = ",".join("?" * len(cols))
            mem.executemany(f'INSERT INTO {_q(alias)} VALUES ({placeholders})',
                            [tuple(r) for r in data])
        timer.start()
        rcur = mem.execute(sql)
        out_cols = [d[0] for d in rcur.description] if rcur.description else []
        fetched = rcur.fetchmany(MAX_ROWS + 1)
    finally:
        timer.cancel()
        mem.close()
    truncated = len(fetched) > MAX_ROWS
    rows = [list(r) for r in fetched[:MAX_ROWS]]
    return out_cols, rows, truncated
