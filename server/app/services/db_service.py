"""Live SQL Server metadata & profiling (pyodbc).

A browser cannot open a database socket, so this service holds the ODBC driver
and returns schema/profile data over HTTP. Each function returns a
(payload_dict, http_status) tuple; the API layer just jsonifies it, so response
shapes and status codes are unchanged from the original monolith.

Connections are short-lived (opened per request, never persisted).
"""
import re
from typing import Any, Dict, List, Tuple

from app.core.capabilities import pyodbc
from app.services.connection_guard import GENERIC_CONNECTION_ERROR

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

# Custom-rule predicates are AI-authored T-SQL boolean expressions embedded in a WHERE clause.
# They are reviewed by the user before saving, but we still refuse anything that could stack a
# statement, comment-inject, or run DML/DDL — only a read-only boolean expression is allowed.
_UNSAFE_PREDICATE = re.compile(
    r"(;|--|/\*|\*/|\bxp_|\bsp_)|"
    r"\b(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|"
    r"backup|restore|shutdown|waitfor|openrowset|openquery|openxml|into)\b",
    re.IGNORECASE,
)


def _is_safe_predicate(pred: str) -> bool:
    """True only for a bounded read-only boolean expression (no statement terminators,
    comments, DML/DDL, or time-based/OPENROWSET tricks)."""
    p = (pred or "").strip()
    if not p or len(p) > 2000:
        return False
    return _UNSAFE_PREDICATE.search(p) is None


def _is_safe_query(q: str) -> bool:
    """True only for a single read-only SELECT/CTE query (no terminators, comments, DML/DDL,
    SELECT INTO, etc.). Used for AI-authored, user-reviewed custom-rule queries."""
    s = (q or "").strip()
    if not s or len(s) > 4000:
        return False
    if _UNSAFE_PREDICATE.search(s) is not None:
        return False
    return re.match(r"^\s*(select|with)\b", s, re.IGNORECASE) is not None


class ConnectionAttemptError(Exception):
    """A DB connection attempt failed. Carries only the generic SEC-004 message so
    callers surface no reachability/auth detail to the client."""


def build_connection_string(cfg: Dict[str, Any]) -> str:
    """Build a pyodbc connection string from the posted config."""
    driver = cfg.get("driver") or "ODBC Driver 17 for SQL Server"
    server = cfg.get("server", "")
    database = cfg.get("database", "")
    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={server}",
        f"DATABASE={database}",
    ]
    if cfg.get("trusted"):  # Windows integrated auth
        parts.append("Trusted_Connection=yes")
    else:
        parts.append(f"UID={cfg.get('username','')}")
        parts.append(f"PWD={cfg.get('password','')}")
    # TrustServerCertificate is only understood by the modern "ODBC Driver xx
    # for SQL Server". The legacy "SQL Server" driver rejects it with
    # "Invalid connection string attribute", so only add it for MSODBC.
    if "odbc driver" in driver.lower():
        parts.append("TrustServerCertificate=yes")
    return ";".join(parts) + ";"


def open_connection(cfg: Dict[str, Any]):
    """Open a short-lived pyodbc connection from the posted config.

    SEC-004: any connection failure (refused, filtered/timeout, auth failure) is
    collapsed into a single generic ConnectionAttemptError so the HTTP response
    can't be used to distinguish an open host:port from a closed one. The real
    error is printed server-side for operators.
    """
    if pyodbc is None:
        raise RuntimeError("pyodbc is not installed on the server. Run: pip install -r requirements.txt")
    conn_str = build_connection_string(cfg)
    try:
        return pyodbc.connect(conn_str, timeout=int(cfg.get("timeout", 8)))
    except Exception as exc:  # noqa: BLE001 - withhold reachability/auth detail from the client
        print("[db_service] connection attempt failed (details withheld from client): " + repr(exc))
        raise ConnectionAttemptError(GENERIC_CONNECTION_ERROR)


def _quote(ident: Any) -> str:
    """Safely quote a SQL Server identifier."""
    return "[" + str(ident).replace("]", "]]") + "]"


def list_drivers() -> Payload:
    """Report which ODBC drivers are available on this machine."""
    if pyodbc is None:
        return {"ok": False, "error": "pyodbc not installed", "drivers": []}
    return {"ok": True, "drivers": [d for d in pyodbc.drivers()]}


def test_connection(cfg: Dict[str, Any]) -> Result:
    """Open a connection and read @@VERSION to confirm it works."""
    try:
        conn = open_connection(cfg)
        cur = conn.cursor()
        cur.execute("SELECT @@VERSION")
        version = cur.fetchone()[0]
        conn.close()
        return {"ok": True, "message": "Connection successful.", "version": version.split("\n")[0]}, 200
    except Exception as exc:  # noqa: BLE001 - surface any driver/auth error to UI
        return {"ok": False, "error": str(exc)}, 400


def get_metadata(cfg: Dict[str, Any]) -> Result:
    """Return real tables + columns (with PK/FK) in the app's source-metadata shape."""
    schema_filter = cfg.get("schema")  # optional, e.g. 'dbo'
    try:
        conn = open_connection(cfg)
        cur = conn.cursor()

        # Columns
        cur.execute(
            """
            SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
                   c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION,
                   c.IS_NULLABLE, c.COLUMN_DEFAULT, c.ORDINAL_POSITION
            FROM INFORMATION_SCHEMA.COLUMNS c
            JOIN INFORMATION_SCHEMA.TABLES t
              ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            WHERE t.TABLE_TYPE = 'BASE TABLE'
            ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
            """
        )
        col_rows = cur.fetchall()

        # Primary keys
        cur.execute(
            """
            SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
              ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            """
        )
        pks = {(r[0], r[1], r[2]) for r in cur.fetchall()}

        # Foreign keys
        cur.execute(
            """
            SELECT cu.TABLE_SCHEMA, cu.TABLE_NAME, cu.COLUMN_NAME
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu
              ON rc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
            """
        )
        fks = {(r[0], r[1], r[2]) for r in cur.fetchall()}

        # Row counts (best-effort, from sys catalog)
        rowcounts: Dict[Tuple[str, str], int] = {}
        try:
            cur.execute(
                """
                SELECT s.name, t.name, SUM(p.rows)
                FROM sys.tables t
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
                GROUP BY s.name, t.name
                """
            )
            for r in cur.fetchall():
                rowcounts[(r[0], r[1])] = int(r[2] or 0)
        except Exception:  # noqa: BLE001
            pass

        conn.close()

        tables: Dict[Tuple[str, str], Dict[str, Any]] = {}
        first_schema = None
        for r in col_rows:
            (tschema, tname, cname, dtype, charlen, numprec,
             is_nullable, default, _pos) = r
            if schema_filter and tschema != schema_filter:
                continue
            if first_schema is None:
                first_schema = tschema
            key = (tschema, tname)
            if key not in tables:
                tables[key] = {
                    "name": tname,
                    "schema": tschema,
                    "description": f"{tschema}.{tname}",
                    "rowCount": rowcounts.get(key, 0),
                    "columns": [],
                }
            tables[key]["columns"].append({
                "name": cname,
                "dataType": (dtype or "").upper(),
                "length": charlen if charlen not in (None, -1) else numprec,
                "nullable": (is_nullable == "YES"),
                "pk": (tschema, tname, cname) in pks,
                "fk": (tschema, tname, cname) in fks,
                "default": default,
                "description": "",
                "businessTerm": "",
                "sample": None,
                "distinctCount": None,
                "nullPct": 0,
            })

        table_list = list(tables.values())
        return {
            "ok": True,
            "connection": cfg.get("database", "Database"),
            "schema": schema_filter or first_schema or "dbo",
            "tableCount": len(table_list),
            "columnCount": sum(len(t["columns"]) for t in table_list),
            "tables": table_list,
        }, 200
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}, 400


def profile_table(cfg: Dict[str, Any]) -> Result:
    """Profile ONE table live: row count, and per-column null %, distinct count,
    min/max and top values. Body: connection cfg + {schema, table}.
    """
    schema = cfg.get("schema") or "dbo"
    table = cfg.get("table")
    top_n = int(cfg.get("topN", 5))
    if not table:
        return {"ok": False, "error": "No table specified."}, 400
    try:
        conn = open_connection(cfg)
        cur = conn.cursor()
        fq = f"{_quote(schema)}.{_quote(table)}"

        # total rows
        cur.execute(f"SELECT COUNT(*) FROM {fq}")
        row_count = int(cur.fetchone()[0])

        # column list + types
        cur.execute(
            """
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
            """,
            schema, table,
        )
        col_defs = cur.fetchall()

        columns: List[Dict[str, Any]] = []
        for cname, dtype, charlen in col_defs:
            col = _quote(cname)
            stats: Dict[str, Any] = {
                "name": cname,
                "dataType": (dtype or "").upper(),
                "length": charlen,
                "rowCount": row_count,
                "nullCount": 0,
                "nullPct": 0,
                "distinctCount": 0,
                "sample": None,
                "min": None,
                "max": None,
                "topValues": [],
            }
            try:
                cur.execute(
                    f"SELECT COUNT(*) - COUNT({col}), COUNT(DISTINCT {col}) FROM {fq}"
                )
                nulls, distinct = cur.fetchone()
                stats["nullCount"] = int(nulls or 0)
                stats["distinctCount"] = int(distinct or 0)
                stats["nullPct"] = round((int(nulls or 0) / row_count) * 100, 1) if row_count else 0

                # a sample non-null value
                cur.execute(f"SELECT TOP 1 {col} FROM {fq} WHERE {col} IS NOT NULL")
                s = cur.fetchone()
                if s and s[0] is not None:
                    stats["sample"] = str(s[0])[:120]

                # min / max for comparable types
                if (dtype or "").lower() not in ("text", "ntext", "image", "xml"):
                    try:
                        cur.execute(f"SELECT MIN({col}), MAX({col}) FROM {fq}")
                        mn, mx = cur.fetchone()
                        stats["min"] = None if mn is None else str(mn)[:60]
                        stats["max"] = None if mx is None else str(mx)[:60]
                    except Exception:  # noqa: BLE001
                        pass

                # top values only when the column is low-cardinality (looks categorical)
                if 0 < stats["distinctCount"] <= 50:
                    cur.execute(
                        f"SELECT TOP {top_n} {col} AS v, COUNT(*) AS c FROM {fq} "
                        f"WHERE {col} IS NOT NULL GROUP BY {col} ORDER BY c DESC"
                    )
                    for v, c in cur.fetchall():
                        pct = round((int(c) / row_count) * 100, 1) if row_count else 0
                        stats["topValues"].append({"value": str(v)[:60], "count": int(c), "pct": pct})
            except Exception:  # noqa: BLE001 - keep profiling other columns even if one fails
                pass
            columns.append(stats)

        conn.close()
        return {"ok": True, "schema": schema, "table": table, "rowCount": row_count, "columns": columns}, 200
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}, 400


# Cap on the number of allowed values in a typelist NOT IN (...) check — SQL Server's
# hard parameter ceiling is ~2100; stay well under it and skip oversized domains.
VALIDATE_MAX_DOMAIN = 1000


def validate_table(cfg: Dict[str, Any]) -> Result:
    """Data-quality validation of ONE target table live. Body: connection cfg +
    {schema, table, keyColumns[], mandatoryColumns[], typelistChecks[], fkChecks[], sampleLimit}.

    Runs, each guarded independently so one failing check never aborts the rest:
      - duplicates   : GROUP BY keyColumns HAVING COUNT(*) > 1
      - mandatory    : NULL count per column
      - typelist     : values NOT IN the allowed domain
      - foreignKeys  : orphan FK values (anti-join to the parent table)
    Returns {ok, schema, table, rowCount, checks:[...]} where each check carries a
    type, the columns involved, an offending count, and a few samples.
    """
    schema = cfg.get("schema") or "dbo"
    table = cfg.get("table")
    sample_limit = int(cfg.get("sampleLimit", 10))
    if not table:
        return {"ok": False, "error": "No table specified."}, 400

    key_columns = [c for c in (cfg.get("keyColumns") or []) if c]
    mandatory_columns = [c for c in (cfg.get("mandatoryColumns") or []) if c]
    typelist_checks = cfg.get("typelistChecks") or []
    fk_checks = cfg.get("fkChecks") or []
    custom_checks = cfg.get("customChecks") or []

    try:
        conn = open_connection(cfg)
        try:
            conn.timeout = int(cfg.get("queryTimeout", 30))  # bound each query (seconds)
        except Exception:  # noqa: BLE001
            pass
        cur = conn.cursor()
        fq = f"{_quote(schema)}.{_quote(table)}"

        # total rows
        cur.execute(f"SELECT COUNT(*) FROM {fq}")
        row_count = int(cur.fetchone()[0])

        checks: List[Dict[str, Any]] = []

        # --- duplicates on the uniqueness key ---
        if key_columns:
            try:
                cols_sql = ", ".join(_quote(c) for c in key_columns)
                cur.execute(
                    f"SELECT {cols_sql}, COUNT(*) AS c FROM {fq} "
                    f"GROUP BY {cols_sql} HAVING COUNT(*) > 1 ORDER BY c DESC"
                )
                rows = cur.fetchall()
                dup_groups = len(rows)
                dup_rows = sum(int(r[-1]) for r in rows)
                samples = []
                for r in rows[:sample_limit]:
                    key_vals = ", ".join("-" if v is None else str(v)[:60] for v in r[:-1])
                    samples.append({"key": key_vals, "count": int(r[-1])})
                checks.append({
                    "type": "duplicate",
                    "columns": key_columns,
                    "groupCount": dup_groups,
                    "count": dup_rows,           # total offending rows
                    "samples": samples,
                })
            except Exception as exc:  # noqa: BLE001 - keep running the other checks
                checks.append({"type": "duplicate", "columns": key_columns, "error": str(exc)})

        # --- mandatory (not-null) ---
        for col in mandatory_columns:
            try:
                qc = _quote(col)
                cur.execute(f"SELECT COUNT(*) - COUNT({qc}) FROM {fq}")
                nulls = int(cur.fetchone()[0] or 0)
                if nulls > 0:
                    checks.append({"type": "mandatory", "columns": [col], "count": nulls})
            except Exception as exc:  # noqa: BLE001
                checks.append({"type": "mandatory", "columns": [col], "error": str(exc)})

        # --- typelist membership ---
        for chk in typelist_checks:
            col = chk.get("column")
            allowed = [v for v in (chk.get("allowedValues") or []) if v is not None]
            if not col or not allowed or len(allowed) > VALIDATE_MAX_DOMAIN:
                continue
            try:
                qc = _quote(col)
                placeholders = ", ".join("?" for _ in allowed)
                params = [str(v) for v in allowed]
                # total offending rows
                cur.execute(
                    f"SELECT COUNT(*) FROM {fq} WHERE {qc} IS NOT NULL AND {qc} NOT IN ({placeholders})",
                    *params,
                )
                bad = int(cur.fetchone()[0] or 0)
                samples = []
                if bad > 0:
                    cur.execute(
                        f"SELECT TOP {sample_limit} {qc} AS v, COUNT(*) AS c FROM {fq} "
                        f"WHERE {qc} IS NOT NULL AND {qc} NOT IN ({placeholders}) "
                        f"GROUP BY {qc} ORDER BY c DESC",
                        *params,
                    )
                    for v, c in cur.fetchall():
                        samples.append({"value": str(v)[:60], "count": int(c)})
                if bad > 0:
                    checks.append({"type": "typelist", "columns": [col], "count": bad, "samples": samples})
            except Exception as exc:  # noqa: BLE001
                checks.append({"type": "typelist", "columns": [col], "error": str(exc)})

        # --- foreign keys (orphan anti-join) ---
        for chk in fk_checks:
            col = chk.get("column")
            parent_table = chk.get("parentTable")
            parent_col = chk.get("parentColumn")
            parent_schema = chk.get("parentSchema") or schema
            if not col or not parent_table or not parent_col:
                continue
            try:
                qc = _quote(col)
                pfq = f"{_quote(parent_schema)}.{_quote(parent_table)}"
                qpc = _quote(parent_col)
                cur.execute(
                    f"SELECT COUNT(*) FROM {fq} c "
                    f"LEFT JOIN {pfq} p ON c.{qc} = p.{qpc} "
                    f"WHERE c.{qc} IS NOT NULL AND p.{qpc} IS NULL"
                )
                orphans = int(cur.fetchone()[0] or 0)
                samples = []
                if orphans > 0:
                    cur.execute(
                        f"SELECT TOP {sample_limit} c.{qc} AS v, COUNT(*) AS n FROM {fq} c "
                        f"LEFT JOIN {pfq} p ON c.{qc} = p.{qpc} "
                        f"WHERE c.{qc} IS NOT NULL AND p.{qpc} IS NULL "
                        f"GROUP BY c.{qc} ORDER BY n DESC"
                    )
                    for v, n in cur.fetchall():
                        samples.append({"value": str(v)[:60], "count": int(n)})
                if orphans > 0:
                    checks.append({
                        "type": "foreignKey",
                        "columns": [col],
                        "reference": f"{parent_table}.{parent_col}",
                        "count": orphans,
                        "samples": samples,
                    })
            except Exception as exc:  # noqa: BLE001
                checks.append({"type": "foreignKey", "columns": [col], "error": str(exc)})

        # --- custom rules (AI-authored, user-reviewed boolean predicate) ---
        for chk in custom_checks:
            name = chk.get("name") or "Custom rule"
            pred = (chk.get("predicate") or "").strip()
            if not pred:
                continue
            if not _is_safe_predicate(pred):
                checks.append({"type": "custom", "name": name, "columns": [],
                               "error": "Rule rejected by the safety filter (must be a read-only boolean expression)."})
                continue
            try:
                cur.execute(f"SELECT COUNT(*) FROM {fq} WHERE ({pred})")
                bad = int(cur.fetchone()[0] or 0)
                if bad > 0:
                    checks.append({"type": "custom", "name": name, "columns": [], "count": bad})
            except Exception as exc:  # noqa: BLE001
                checks.append({"type": "custom", "name": name, "columns": [], "error": str(exc)})

        conn.close()
        return {"ok": True, "schema": schema, "table": table, "rowCount": row_count, "checks": checks}, 200
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}, 400


def run_custom_query(cfg: Dict[str, Any]) -> Result:
    """Count the offending rows for a custom-rule query (may span multiple tables).

    Body: connection cfg + {query, queryTimeout?}. The query is an AI-authored, user-reviewed
    SELECT that returns the violating rows; we count them read-only as COUNT(*) over a derived
    table. Guarded by _is_safe_query.
    """
    query = (cfg.get("query") or "").strip()
    if not query:
        return {"ok": False, "error": "No query provided."}, 400
    if not _is_safe_query(query):
        return {"ok": False, "error": "Query rejected by the safety filter (a single read-only SELECT only)."}, 400
    try:
        conn = open_connection(cfg)
        try:
            conn.timeout = int(cfg.get("queryTimeout", 30))
        except Exception:  # noqa: BLE001
            pass
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM ({query}) AS _vr")
        count = int(cur.fetchone()[0] or 0)
        conn.close()
        return {"ok": True, "count": count}, 200
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}, 400
