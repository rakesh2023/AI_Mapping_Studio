"""Pure parser for an uploaded lookup document (no Flask / no DB).

Expected tabular shape (one row per source code; binding repeated per row):
    Target table | Target column | Source Table | Source column | Code | Description

Headers are matched flexibly (case/spacing/synonyms). Rows are grouped into lookup
sets by (source table, source column) — falling back to (target table, target
column) when the source column is absent — collecting the code/description values.
Supports .xlsx/.xlsm/.xls (via openpyxl) and .csv/.txt (stdlib csv).
"""
import csv
import io
from typing import Any, Dict, List

from app.core.capabilities import openpyxl

# canonical field -> accepted header spellings (normalized: lowercased, trimmed)
_HDR = {
    "lookup_name":   ["lookupname", "lookup name", "lookup", "typelist", "typelist name", "lookup set"],
    "target_table":  ["target table", "targettable", "tgt table", "tgttable", "target tbl"],
    "target_column": ["target column", "targetcolumn", "target col", "targetcol", "tgt column", "tgt col"],
    "source_table":  ["source table", "sourcetable", "src table", "srctable", "source tbl"],
    "source_column": ["source column", "sourcecolumn", "source col", "srccol", "src column", "src col"],
    "code":          ["code", "source code", "sourcecode", "src code", "cd", "key"],
    "description":   ["description", "desc", "meaning", "label", "value description"],
    # single free-text column holding the expected source->target mapping / values
    "expected":      ["expected value", "expected values", "expected mapping", "expected",
                      "mapping", "value mapping", "expected value in free text"],
}


def _norm(s: Any) -> str:
    return str(s if s is not None else "").strip().lower()


def _cellstr(v: Any) -> str:
    return str(v if v is not None else "").strip()


def _read_grid(raw: bytes, ext: str) -> List[List[Any]]:
    ext = (ext or "").lower().lstrip(".")
    if ext in ("xlsx", "xlsm", "xls"):
        if not openpyxl:
            raise RuntimeError("Excel support (openpyxl) is not installed on the server.")
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        try:
            ws = wb[wb.sheetnames[0]]
            return [list(r) for r in ws.iter_rows(values_only=True)]
        finally:
            wb.close()
    text = raw.decode("utf-8-sig", errors="replace")
    return [row for row in csv.reader(io.StringIO(text))]


def _fuzzy_canon(key: str) -> str:
    """Best-effort header classification when no exact synonym matches — matches on
    the presence of role + kind tokens, so 'Target Table Name', 'Tgt_Tbl',
    'To Column', etc. still resolve. Returns '' when nothing fits."""
    k = key.replace("_", " ").replace("-", " ")
    tgt = any(t in k for t in ("target", "tgt", "to ", "dest"))
    src = any(t in k for t in ("source", "src", "from"))
    is_table = any(t in k for t in ("table", "tbl", "entity"))
    is_col = "col" in k or "field" in k or "attribute" in k
    if "lookup" in k or "typelist" in k:
        return "lookup_name"
    if "expect" in k or (("map" in k) and not is_table and not is_col):
        return "expected"
    if tgt and is_table:
        return "target_table"
    if tgt and is_col:
        return "target_column"
    if src and is_table:
        return "source_table"
    if src and is_col:
        return "source_column"
    return ""


def _map_headers(header: List[Any]) -> Dict[str, int]:
    idx: Dict[str, int] = {}
    # Pass 1: exact synonym match (authoritative).
    for j, cell in enumerate(header):
        key = _norm(cell)
        for canon, syns in _HDR.items():
            if key in syns and canon not in idx:
                idx[canon] = j
    # Pass 2: fuzzy fill for any role we didn't resolve exactly (tolerates
    # spellings like 'Target Table Name', 'Tgt Col', 'To Column').
    for j, cell in enumerate(header):
        if j in idx.values():
            continue
        canon = _fuzzy_canon(_norm(cell))
        if canon and canon not in idx:
            idx[canon] = j
    return idx


def parse_lookup_document(raw: bytes, ext: str) -> Dict[str, Any]:
    """Parse the document into lookup sets. Two shapes are supported:

    - EXPECTED-VALUE mode: LookupName | Source table/column | Target table/column |
      Expected value (free text). One set per row; the free text is kept verbatim
      as `expectedValues` (also handles the merged layout where the expected value
      spans several rows under one LookupName).
    - CODE/DESCRIPTION mode: … | Code | Description (one row per code) -> `values`.

    Returns {ok, sets:[{lookupName, sourceTable, sourceColumn, targetTable,
    targetColumn, expectedValues, values:[{code, description}]}], rowCount, skipped}
    or {ok:False, error}."""
    try:
        rows = _read_grid(raw, ext)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc) or "Could not read the file."}

    # Locate the header row: needs a Code or Expected column + a source/target/lookup column.
    header_i, idx = None, {}
    for i, row in enumerate(rows[:10]):
        m = _map_headers(row)
        has_key = ("code" in m) or ("expected" in m)
        has_binding = ("source_column" in m) or ("target_column" in m) or ("lookup_name" in m)
        if has_key and has_binding:
            header_i, idx = i, m
            break
    if header_i is None:
        return {"ok": False, "error": "Could not find the expected columns (LookupName, Source table/column, "
                "Target table/column, and an Expected value column — or Code + Description)."}

    def cell(row: List[Any], key: str) -> str:
        j = idx.get(key)
        if j is None or j >= len(row):
            return ""
        return _cellstr(row[j])

    expected_mode = "expected" in idx and "code" not in idx
    sets: Dict[Any, Dict[str, Any]] = {}
    order: List[Any] = []
    skipped = 0
    last_key = None

    for row in rows[header_i + 1:]:
        if not any(_cellstr(c) for c in row):
            continue
        ln = cell(row, "lookup_name")
        st, sc = cell(row, "source_table"), cell(row, "source_column")
        tt, tc = cell(row, "target_table"), cell(row, "target_column")

        if expected_mode:
            exp = cell(row, "expected")
            # A continuation row (only more expected text, no binding) -> append to the last set.
            if not ln and not sc and not tc and not st and not tt and exp and last_key is not None:
                g = sets[last_key]
                g["expectedValues"] = (g["expectedValues"] + "\n" + exp).strip() if g["expectedValues"] else exp
                continue
            key = _norm(ln) if ln else ((_norm(st), _norm(sc)) if sc else (_norm(tt), _norm(tc)))
            if key not in sets:
                sets[key] = {"lookupName": ln or sc or tc or "lookup", "sourceTable": st, "sourceColumn": sc,
                             "targetTable": tt, "targetColumn": tc, "expectedValues": exp, "values": []}
                order.append(key)
            else:
                g = sets[key]
                for f, val in (("sourceTable", st), ("sourceColumn", sc), ("targetTable", tt), ("targetColumn", tc)):
                    if not g[f] and val:
                        g[f] = val
                if ln and not g["lookupName"]:
                    g["lookupName"] = ln
                if exp:
                    g["expectedValues"] = (g["expectedValues"] + "\n" + exp).strip() if g["expectedValues"] else exp
            last_key = key
            continue

        # CODE / DESCRIPTION mode
        code = cell(row, "code")
        if not code:
            skipped += 1
            continue
        key = _norm(ln) if ln else ((_norm(st), _norm(sc)) if sc else (_norm(tt), _norm(tc)))
        if key not in sets:
            sets[key] = {"lookupName": ln or sc or tc or "lookup", "sourceTable": st, "sourceColumn": sc,
                         "targetTable": tt, "targetColumn": tc, "expectedValues": "", "values": []}
            order.append(key)
        else:
            g = sets[key]
            for f, val in (("sourceTable", st), ("sourceColumn", sc), ("targetTable", tt), ("targetColumn", tc)):
                if not g[f] and val:
                    g[f] = val
        sets[key]["values"].append({"code": code, "description": cell(row, "description")})

    # Drop empty groups (no values and no expected text).
    out = [s for s in (sets[k] for k in order) if s["values"] or (s.get("expectedValues") or "").strip()]
    return {"ok": True, "sets": out,
            "rowCount": sum(len(s["values"]) for s in out), "skipped": skipped}
