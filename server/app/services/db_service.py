"""Live SQL Server metadata & profiling (pyodbc).

A browser cannot open a database socket, so this service holds the ODBC driver
and returns schema/profile data over HTTP. Each function returns a
(payload_dict, http_status) tuple; the API layer just jsonifies it, so response
shapes and status codes are unchanged from the original monolith.

Connections are short-lived (opened per request, never persisted).
"""
from typing import Any, Dict, List, Tuple

from app.core.capabilities import pyodbc

Payload = Dict[str, Any]
Result = Tuple[Payload, int]


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
    """Open a short-lived pyodbc connection from the posted config."""
    if pyodbc is None:
        raise RuntimeError("pyodbc is not installed on the server. Run: pip install -r requirements.txt")
    conn_str = build_connection_string(cfg)
    return pyodbc.connect(conn_str, timeout=int(cfg.get("timeout", 8)))


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
