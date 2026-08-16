"""Load structured uploads (CSV/Excel) into queryable per-document tables.

Creates one physical table per CSV / Excel sheet named ``kyd_d<document_id>_<slug>``
in the app DB and registers it in ``structured_tables`` (so StructuredQueryTool can
find and query it, scoped to the tenant). SQL scripts are schema-only (no row data)
and load nothing here. Pure of Flask; called from the ingestion worker.
"""
import io
import json
import re
from datetime import datetime, timezone
from typing import Any, List, Tuple

from app.db.app_db import connect, write_lock
from app.core.capabilities import pandas

_MAX_ROWS = 200_000        # safety cap on rows loaded per table
_STRUCTURED_EXTS = {"csv", "xlsx", "xls"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _q(ident: str) -> str:
    return '"' + str(ident).replace('"', '""') + '"'


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", (name or "table")).strip("_").lower() or "table"
    return s[:40]


def _stem(filename: str) -> str:
    base = (filename or "table").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return base.rsplit(".", 1)[0] or "table"


def _py(v: Any):
    """Convert a pandas/numpy cell to a SQLite-bindable Python value."""
    try:
        if pandas.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v.item() if hasattr(v, "item") else v


def _frames(filename: str, raw: bytes) -> List[Tuple[str, Any]]:
    ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    if ext not in _STRUCTURED_EXTS or pandas is None:
        return []
    try:
        if ext == "csv":
            return [(_stem(filename), pandas.read_csv(io.BytesIO(raw or b"")))]
        sheets = pandas.read_excel(io.BytesIO(raw or b""), sheet_name=None)
        return [(str(name), df) for name, df in sheets.items()]
    except Exception:  # noqa: BLE001 - loader failures are non-fatal; caller still embeds profiles
        return []


def load_structured(document_id: int, user_id: int, client_id: int,
                    filename: str, raw: bytes) -> int:
    """Load CSV/Excel row data into per-document tables; register them. Returns
    the number of tables loaded (0 for SQL/unstructured)."""
    frames = _frames(filename, raw)
    if not frames:
        return 0
    ts = _now()
    loaded = 0
    with write_lock():
        conn = connect()
        try:
            for name, df in frames:
                phys = f"kyd_d{document_id}_{_slug(name)}"
                cols = [str(c) for c in df.columns]
                if not cols:
                    continue
                conn.execute(f'DROP TABLE IF EXISTS {_q(phys)}')
                conn.execute(f'CREATE TABLE {_q(phys)} ({", ".join(_q(c) for c in cols)})')
                rows = [tuple(_py(v) for v in rec)
                        for rec in df.itertuples(index=False, name=None)][:_MAX_ROWS]
                if rows:
                    ph = ",".join("?" * len(cols))
                    conn.executemany(f'INSERT INTO {_q(phys)} VALUES ({ph})', rows)
                colmeta = json.dumps([{"name": str(c), "type": str(df[c].dtype)} for c in df.columns])
                conn.execute(
                    "INSERT INTO structured_tables (document_id, user_id, client_id, logical_name, "
                    "physical_table, columns_json, row_count, created_at) VALUES (?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(document_id, physical_table) DO UPDATE SET "
                    "columns_json=excluded.columns_json, row_count=excluded.row_count",
                    (document_id, user_id, client_id, str(name), phys, colmeta, int(len(df)), ts),
                )
                loaded += 1
            conn.commit()
        finally:
            conn.close()
    return loaded
