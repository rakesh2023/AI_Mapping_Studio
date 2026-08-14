"""Execute a list of T-SQL batches against SQL Server via pyodbc.

The whole script runs in ONE transaction (autocommit off): every batch is
executed in order; on the first failure the entire transaction is rolled back
(never a half-applied schema); on full success it commits.

Credentials arrive in `cfg` (same per-request shape as db_service) and are used
ONLY to open the connection — never logged or returned. The failure payload
contains the failing batch text + SQL Server error number/message/line, but no
connection details.
"""
import re
from typing import Any, Dict, List

from app.core.capabilities import pyodbc
from app.services.db_service import build_connection_string
from app.services.connection_guard import GENERIC_CONNECTION_ERROR

Result = Dict[str, Any]


def _parse_sql_error(exc: Exception) -> Dict[str, Any]:
    """Best-effort extraction of SQL Server error number + line from a pyodbc error."""
    msg = ""
    try:
        # pyodbc.Error.args is usually (sqlstate, "[...]message (number) (SQLExecDirectW)")
        msg = str(exc.args[1]) if len(exc.args) > 1 else str(exc)
    except Exception:  # noqa: BLE001
        msg = str(exc)
    number = None
    m = re.search(r"\((\d{3,6})\)", msg)          # SQL Server error number in parens
    if m:
        number = int(m.group(1))
    line = None
    lm = re.search(r"Line\s+(\d+)", msg, re.IGNORECASE)
    if lm:
        line = int(lm.group(1))
    return {"number": number, "message": msg.strip(), "line": line}


def execute_batches(cfg: Dict[str, Any], batches: List[str], dry_run: bool = False) -> Result:
    """Run batches in a single transaction.

    dry_run: verify connectivity (SELECT 1) but DO NOT execute the script.
    Returns {ok, executed, total, [error:{batchIndex,batchText,number,message,line}]}.
    """
    total = len(batches)
    if not total:
        return {"ok": False, "executed": 0, "total": 0,
                "error": {"batchIndex": -1, "batchText": "", "number": None,
                          "message": "Nothing to deploy — the script has no executable batches.", "line": None}}
    if pyodbc is None:
        return {"ok": False, "executed": 0, "total": total,
                "error": {"batchIndex": -1, "batchText": "", "number": None,
                          "message": "pyodbc is not installed on the server.", "line": None}}

    conn = None
    try:
        conn = pyodbc.connect(build_connection_string(cfg), timeout=int(cfg.get("timeout", 30)), autocommit=False)
    except Exception as exc:  # noqa: BLE001 - connection/auth failure
        # SEC-004: do not leak whether the host:port was reachable/refused/auth-failed.
        print("[sql_execution] connection attempt failed (details withheld from client): " + repr(exc))
        return {"ok": False, "executed": 0, "total": total,
                "error": {"batchIndex": -1, "batchText": "", "number": None,
                          "message": GENERIC_CONNECTION_ERROR, "line": None}}

    try:
        cur = conn.cursor()
        if dry_run:
            # connectivity check only — never runs the deploy script
            cur.execute("SELECT 1")
            cur.fetchall()
            conn.rollback()
            return {"ok": True, "dryRun": True, "executed": 0, "total": total}

        for i, batch in enumerate(batches):
            try:
                cur.execute(batch)
                while cur.nextset():   # drain any result sets so the next batch runs cleanly
                    pass
            except Exception as exc:  # noqa: BLE001 - a batch failed
                try:
                    conn.rollback()          # roll back the WHOLE script
                except Exception:  # noqa: BLE001
                    pass
                info = _parse_sql_error(exc)
                return {"ok": False, "executed": i, "total": total,
                        "error": {"batchIndex": i, "batchText": batch, **info}}
        conn.commit()
        return {"ok": True, "executed": total, "total": total}
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
