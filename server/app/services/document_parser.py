"""document_parser — normalize an uploaded Know Your Data file into text +
metadata (and, for tabular files, a DataFrame + a "data profile" text summary
suitable for embedding).

Per-format functions (pure, unit-testable, no DB):
    parse_pdf, parse_xml, parse_json, parse_sql_script, parse_excel, parse_csv
Each returns a ``ParseResult`` or raises ``DocumentParseError`` with a
human-readable message. ``parse_document`` dispatches by extension.

``parse_and_store(document_id, filename, raw)`` is the DB-aware orchestrator the
ingestion worker calls: on any parse failure it sets ``documents.status='failed'``
with the error message and returns None; on success it returns the ParseResult
(leaving status for the pipeline to advance).

Optional deps are guarded via app.core.capabilities (PdfReader, openpyxl, pandas)
so importing this module never hard-fails; a missing package surfaces as a clear
DocumentParseError only when that format is actually parsed.
"""
import io
import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.capabilities import PdfReader, openpyxl, pandas  # noqa: F401 (openpyxl = read_excel engine)
from app.parsers.sql_ddl_parser import parse_sql_ddl

_SAMPLE_ROWS = 5          # sample rows included in a data profile
_CELL_MAX = 60            # truncate long cell values in a profile
_TEXT_CAP = 500_000       # hard cap on normalized text length (embedding happens later)


class DocumentParseError(Exception):
    """Raised when a file cannot be parsed; message is safe to show the user."""


@dataclass
class ParseResult:
    kind: str                                  # "unstructured" | "structured"
    text: str                                  # normalized, embed-ready text
    metadata: Dict[str, Any] = field(default_factory=dict)
    dataframe: Any = None                      # pandas.DataFrame for a single-table file, else None
    profile: Optional[str] = None              # data-profile text (tabular)
    tables: List[Dict[str, Any]] = field(default_factory=list)  # [{name,columns,rowCount,sample,profile}]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _text(raw: bytes) -> str:
    return (raw or b"").decode("utf-8", errors="replace")


def _cap(s: str) -> str:
    return s if len(s) <= _TEXT_CAP else s[:_TEXT_CAP] + "\n… (truncated)"


def _cell(v: Any) -> str:
    s = "" if v is None else str(v)
    return s if len(s) <= _CELL_MAX else s[:_CELL_MAX - 3] + "..."


def _require_pandas():
    if pandas is None:
        raise DocumentParseError("Tabular parsing needs the 'pandas' package, which is not installed on the server.")


def _profile_dataframe(df, name: str) -> (str):
    """Build a data-profile TEXT summary (columns, dtypes, row count, sample rows)."""
    cols = [str(c) for c in df.columns]
    n = int(len(df))
    lines = [f"Table: {name}", f"Rows: {n}", f"Columns ({len(cols)}):"]
    for c in df.columns:
        lines.append(f"  - {c} ({df[c].dtype})")
    if n:
        lines.append("Sample rows:")
        lines.append("  " + " | ".join(cols))
        for _, row in df.head(_SAMPLE_ROWS).iterrows():
            lines.append("  " + " | ".join(_cell(row[c]) for c in df.columns))
    return "\n".join(lines)


def _table_from_df(df, name: str) -> Dict[str, Any]:
    profile = _profile_dataframe(df, name)
    sample = df.head(_SAMPLE_ROWS).astype(str).to_dict("records")
    return {
        "name": name,
        "columns": [{"name": str(c), "dtype": str(df[c].dtype)} for c in df.columns],
        "rowCount": int(len(df)),
        "sample": sample,
        "profile": profile,
    }


# --------------------------------------------------------------------------- #
# Unstructured
# --------------------------------------------------------------------------- #
def parse_pdf(raw: bytes, filename: str = "document.pdf") -> ParseResult:
    if PdfReader is None:
        raise DocumentParseError("PDF support needs the 'pypdf' package, which is not installed on the server.")
    try:
        reader = PdfReader(io.BytesIO(raw or b""))
        pages = reader.pages
        parts, per_page = [], []
        for i, page in enumerate(pages, 1):
            txt = (page.extract_text() or "").strip()
            per_page.append(len(txt))
            if txt:
                parts.append(f"[page {i}]\n{txt}")
    except DocumentParseError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DocumentParseError("Could not read the PDF (it may be corrupt or password-protected).") from exc
    text = "\n\n".join(parts)
    if not text.strip():
        raise DocumentParseError("No extractable text found (the PDF may be scanned/image-only).")
    return ParseResult(kind="unstructured", text=_cap(text),
                       metadata={"pageCount": len(pages), "charsPerPage": per_page})


def parse_xml(raw: bytes, filename: str = "document.xml") -> ParseResult:
    try:
        root = ET.fromstring(_text(raw))
    except ET.ParseError as exc:
        raise DocumentParseError("Invalid XML: " + str(exc)) from exc
    lines, count = [], 0
    for el in root.iter():
        count += 1
        tag = el.tag.split("}")[-1]  # strip namespace
        for k, v in (el.attrib or {}).items():
            lines.append(f"{tag}@{k.split('}')[-1]}: {v}")
        if el.text and el.text.strip():
            lines.append(f"{tag}: {el.text.strip()}")
    text = "\n".join(lines) or f"(XML document with root <{root.tag}> and {count} elements, no text nodes)"
    return ParseResult(kind="unstructured", text=_cap(text),
                       metadata={"rootTag": root.tag.split("}")[-1], "elementCount": count})


def parse_json(raw: bytes, filename: str = "document.json") -> ParseResult:
    try:
        data = json.loads(_text(raw))
    except json.JSONDecodeError as exc:
        raise DocumentParseError("Invalid JSON: " + str(exc)) from exc

    # A flat array of objects is tabular -> DataFrame + profile.
    if isinstance(data, list) and data and all(isinstance(x, dict) for x in data):
        _require_pandas()
        try:
            df = pandas.json_normalize(data)
        except Exception as exc:  # noqa: BLE001
            raise DocumentParseError("Could not tabulate the JSON records: " + str(exc)) from exc
        table = _table_from_df(df, name=_stem(filename))
        return ParseResult(kind="structured", text=_cap(table["profile"]), dataframe=df,
                           profile=table["profile"], tables=[table],
                           metadata={"topLevelType": "array", "recordCount": int(len(df)),
                                     "columnCount": int(df.shape[1])})
    # Otherwise treat as an unstructured document.
    text = json.dumps(data, indent=2, ensure_ascii=False)
    top = "array" if isinstance(data, list) else ("object" if isinstance(data, dict) else type(data).__name__)
    return ParseResult(kind="unstructured", text=_cap(text), metadata={"topLevelType": top})


# --------------------------------------------------------------------------- #
# Structured
# --------------------------------------------------------------------------- #
def parse_sql_script(raw: bytes, filename: str = "script.sql") -> ParseResult:
    sql = _text(raw)
    if not sql.strip():
        raise DocumentParseError("The SQL script is empty.")
    parsed = parse_sql_ddl(sql)   # [{name, columns:[{name,dataType,length,...}]}]
    tables = []
    for t in parsed:
        cols = [{"name": c.get("name"), "dtype": c.get("dataType") or "", "length": c.get("length")}
                for c in t.get("columns", [])]
        prof_lines = [f"Table: {t['name']}", f"Columns ({len(cols)}):"]
        for c in cols:
            length = f"({c['length']})" if c.get("length") else ""
            prof_lines.append(f"  - {c['name']} ({c['dtype']}{length})")
        tables.append({"name": t["name"], "columns": cols, "rowCount": None,
                       "sample": [], "profile": "\n".join(prof_lines)})
    summary = ("SQL script defining " + str(len(tables)) + " table(s):\n\n"
               + "\n\n".join(t["profile"] for t in tables)) if tables \
              else "SQL script (no CREATE TABLE statements detected)."
    return ParseResult(kind="structured", text=_cap(summary), tables=tables,
                       metadata={"tableCount": len(tables),
                                 "tableNames": [t["name"] for t in tables]})


def parse_excel(raw: bytes, filename: str = "workbook.xlsx") -> ParseResult:
    _require_pandas()
    if openpyxl is None:
        raise DocumentParseError("Excel support needs the 'openpyxl' package, which is not installed on the server.")
    try:
        sheets = pandas.read_excel(io.BytesIO(raw or b""), sheet_name=None)  # {name: DataFrame}
    except Exception as exc:  # noqa: BLE001
        raise DocumentParseError("Could not read the Excel workbook: " + str(exc)) from exc
    if not sheets:
        raise DocumentParseError("The workbook has no sheets.")
    tables = [_table_from_df(df, name=str(name)) for name, df in sheets.items()]
    text = "\n\n".join(t["profile"] for t in tables)
    only_df = list(sheets.values())[0] if len(sheets) == 1 else None
    return ParseResult(kind="structured", text=_cap(text), dataframe=only_df,
                       profile=text, tables=tables,
                       metadata={"sheetCount": len(sheets), "sheetNames": list(map(str, sheets.keys())),
                                 "rowsPerSheet": {str(k): int(len(v)) for k, v in sheets.items()}})


def parse_csv(raw: bytes, filename: str = "data.csv") -> ParseResult:
    _require_pandas()
    try:
        df = pandas.read_csv(io.BytesIO(raw or b""))
    except pandas.errors.EmptyDataError as exc:
        raise DocumentParseError("The CSV file has no data.") from exc
    except UnicodeDecodeError as exc:
        raise DocumentParseError("Could not decode the CSV (unexpected text encoding).") from exc
    except Exception as exc:  # noqa: BLE001
        raise DocumentParseError("Could not parse the CSV: " + str(exc)) from exc
    table = _table_from_df(df, name=_stem(filename))
    return ParseResult(kind="structured", text=_cap(table["profile"]), dataframe=df,
                       profile=table["profile"], tables=[table],
                       metadata={"rowCount": int(len(df)), "columnCount": int(df.shape[1]),
                                 "columns": [str(c) for c in df.columns]})


# --------------------------------------------------------------------------- #
# Dispatch + DB-aware orchestration
# --------------------------------------------------------------------------- #
_DISPATCH = {
    "pdf": parse_pdf, "xml": parse_xml, "json": parse_json,
    "sql": parse_sql_script, "xlsx": parse_excel, "xls": parse_excel, "csv": parse_csv,
}


def _ext(filename: str) -> str:
    name = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _stem(filename: str) -> str:
    name = (filename or "table").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return name.rsplit(".", 1)[0] or "table"


def parse_document(filename: str, raw: bytes) -> ParseResult:
    """Route to the right parser by extension. Raises DocumentParseError."""
    ext = _ext(filename)
    fn = _DISPATCH.get(ext)
    if not fn:
        raise DocumentParseError("Unsupported file type '." + (ext or "?") + "'.")
    return fn(raw, filename)


def parse_and_store(document_id: int, filename: str, raw: bytes) -> Optional[ParseResult]:
    """Parse for the ingestion pipeline. On failure, set documents.status='failed'
    with the error message and return None; on success return the ParseResult."""
    try:
        return parse_document(filename, raw)
    except DocumentParseError as exc:
        _mark_failed(document_id, str(exc))
        return None
    except Exception as exc:  # noqa: BLE001 - never let an unexpected parser error escape unrecorded
        _mark_failed(document_id, "Unexpected parsing error: " + (str(exc) or exc.__class__.__name__))
        return None


def _mark_failed(document_id: int, message: str) -> None:
    from app.db.app_db import connect, write_lock
    ts = datetime.now(timezone.utc).isoformat()
    with write_lock():
        conn = connect()
        try:
            conn.execute(
                "UPDATE documents SET status='failed', status_detail=?, updated_at=? WHERE id=?",
                (message[:1000], ts, document_id),
            )
            conn.commit()
        finally:
            conn.close()
