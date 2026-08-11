"""File readers and chunkers for File System source systems.

Turns an uploaded Excel/PDF/Word/text file into either:
  - a list of text chunks for the looped AI extraction (extract_file_chunks), or
  - a directly-parsed table list for structured Excel dictionaries
    (parse_xlsx_dictionary), which skips the AI entirely.

Depends on optional packages (openpyxl / pypdf / python-docx) via
core.capabilities; each returns a clear "package not installed" message rather
than crashing. No Flask, no Anthropic.
"""
import io
from typing import Any, Dict, List, Optional, Tuple

from app.core.capabilities import openpyxl, PdfReader, docx
from app.core.config import (
    EXTRACT_AI_CHUNK, EXTRACT_XLSX_COL_CAP, EXTRACT_XLSX_SAMPLE_ROWS,
)
from app.parsers.text_chunking import split_by_tables


def xlsx_sheet_chunks(title: str, grid: List[List[str]]) -> List[str]:
    """Turn one sheet's cell grid (list of row-lists) into text chunks.

    - Narrow sheet  -> row-slices (repeat header) so tall sheets are fully read.
    - WIDE sheet    -> column-slices (each carries its columns' header + a few
      sample rows), so a sheet with thousands of COLUMNS never overflows the
      input/output.
    Chunks for the same sheet all use the same 'Sheet:' name, so the merge step
    unions their columns back into one table.
    """
    if not grid:
        return []
    ncols = max((len(r) for r in grid), default=0)
    chunks: List[str] = []

    if ncols > EXTRACT_XLSX_COL_CAP:
        # ---- WIDE sheet: slice by columns ----
        sample = grid[:EXTRACT_XLSX_SAMPLE_ROWS]   # header + a few rows for type inference
        for cstart in range(0, ncols, EXTRACT_XLSX_COL_CAP):
            cend = min(cstart + EXTRACT_XLSX_COL_CAP, ncols)
            lines = []
            for r in sample:
                cells = [(r[i] if i < len(r) else "") for i in range(cstart, cend)]
                if any(cells):
                    lines.append("\t".join(cells))
            if lines:
                chunks.append("Sheet: " + title + " (columns " + str(cstart + 1) + "-" +
                              str(cend) + " of " + str(ncols) + ")\n" + "\n".join(lines))
        return chunks

    # ---- Narrow sheet ----
    grid = [r for r in grid if any(r)]
    if not grid:
        return []
    header_cells = grid[0]
    header = "\t".join(header_cells)

    # Detect a data-dictionary layout: a column whose header names the TABLE/ENTITY.
    # If found, GROUP data rows by that table so each chunk holds complete tables
    # (raw fixed-size row blocks confuse the model and it returns almost nothing).
    tbl_col = None
    for i, h in enumerate(header_cells):
        hl = str(h).strip().lower().replace("_", "").replace(" ", "")
        if hl in ("table", "tablename", "entity", "entityname", "objectname", "object"):
            tbl_col = i
            break

    if tbl_col is not None:
        # group rows by table value, preserving order
        groups: Dict[str, List[str]] = {}
        gorder: List[str] = []
        for r in grid[1:]:
            tv = (r[tbl_col] if tbl_col < len(r) else "").strip()
            if not tv:
                continue
            if tv not in groups:
                groups[tv] = []
                gorder.append(tv)
            groups[tv].append("\t".join(r))
        if gorder:
            # batch a few tables per chunk, bounded by char budget
            cur: List[str] = []
            cur_len = 0
            count = 0

            def flush():
                if cur:
                    chunks.append("Sheet: " + title +
                                  " (data dictionary — each row is a COLUMN; the '" +
                                  str(header_cells[tbl_col]) + "' cell names its table)\n" +
                                  header + "\n" + "\n".join(cur))
            for tv in gorder:
                block_rows = groups[tv]
                block_text = "\n".join(block_rows)
                if cur and (count >= 6 or cur_len + len(block_text) > EXTRACT_AI_CHUNK):
                    flush()
                    cur, cur_len, count = [], 0, 0
                cur.extend(block_rows)
                cur_len += len(block_text)
                count += 1
            flush()
            return chunks

    # No table column -> plain row-slices (small blocks, header repeated).
    rows = ["\t".join(r) for r in grid]
    block = 120
    if len(rows) <= block:
        return ["Sheet: " + title + "\n" + "\n".join(rows)]
    for start in range(1, len(rows), block):
        part = [header] + rows[start:start + block]
        chunks.append("Sheet: " + title + " (rows " + str(start) + "-" +
                      str(start + len(part) - 2) + ")\n" + "\n".join(part))
    return chunks


def extract_file_chunks(filename: str, raw: bytes) -> Tuple[Optional[List[str]], Optional[str]]:
    """Extract text from an uploaded file as a LIST of chunks for looped extraction.

    Big files lose tables when sent to the model in one shot (input/output
    truncation and summarising). So we slice the file — Excel by sheet (further
    split if huge), PDF by page-groups, others by text size — and the caller runs
    the AI per chunk and merges the results. Returns (chunks, error); one is
    always None.
    """
    name = (filename or "").lower()
    try:
        if name.endswith((".xlsx", ".xlsm", ".xls")):
            if openpyxl is None:
                return None, "The 'openpyxl' package is not installed on the server (pip install openpyxl)."
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            chunks: List[str] = []
            for ws in wb.worksheets:
                # Read the sheet into a cell grid, then chunk by rows (tall) or columns
                # (wide) via xlsx_sheet_chunks so no sheet overflows the model limits.
                grid = []
                for row in ws.iter_rows(values_only=True):
                    grid.append(["" if c is None else str(c) for c in row])
                chunks.extend(xlsx_sheet_chunks(ws.title, grid))
            return chunks, None

        if name.endswith(".pdf"):
            if PdfReader is None:
                return None, "The 'pypdf' package is not installed on the server (pip install pypdf)."
            reader = PdfReader(io.BytesIO(raw))
            full = "\n".join((p.extract_text() or "") for p in reader.pages)
            # Split on TABLE boundaries (batch a few tables per chunk) so the model
            # returns EVERY table instead of summarising a long dictionary into a few.
            return split_by_tables(full), None

        if name.endswith(".docx"):
            if docx is None:
                return None, "The 'python-docx' package is not installed on the server (pip install python-docx)."
            document = docx.Document(io.BytesIO(raw))
            parts = [p.text for p in document.paragraphs if p.text]
            for tbl in document.tables:
                for row in tbl.rows:
                    cells = [c.text for c in row.cells]
                    if any(cells):
                        parts.append("\t".join(cells))
            return split_by_tables("\n".join(parts)), None

        # .sql, .txt, .csv, .json, .xml and anything else -> decode as text, then split by
        # table boundaries (SQL CREATE TABLE with real DDL is handled by the parser upstream).
        return split_by_tables(raw.decode("utf-8", errors="ignore")), None
    except Exception as exc:  # noqa: BLE001
        return None, "Could not read the file: " + (str(exc) or exc.__class__.__name__)


def extract_file_text(filename: str, raw: bytes) -> Tuple[Optional[str], Optional[str]]:
    """Back-compat: return the whole file text joined (used by the SQL fast-path check)."""
    chunks, err = extract_file_chunks(filename, raw)
    if err:
        return None, err
    return "\n".join(chunks or []), None


# Header synonyms for a structured Excel data dictionary (normalised: lowercase,
# no spaces/underscores). Used to read attributes DIRECTLY from cells — no AI.
_XLSX_HDR = {
    "table":       ("table", "tablename", "targettable", "physicaltable", "entity",
                    "entityname", "objectname", "object", "sourcetable"),
    "column":      ("column", "columnname", "field", "fieldname", "attribute",
                    "attributename", "sourcecolumn", "targetcolumn"),
    "datatype":    ("datatype", "type", "columntype", "sqltype", "fieldtype"),
    "length":      ("length", "len", "size", "columnlength", "fieldlength", "maxlength"),
    "description": ("description", "desc", "comment", "comments", "notes", "definition", "remarks"),
    "businessterm":("businessterm", "business", "glossaryterm", "businessname", "term"),
    "sample":      ("sample", "samplevalue", "example", "examplevalue", "sampledata"),
}


def norm_hdr(h: Any) -> str:
    return str(h or "").strip().lower().replace("_", "").replace(" ", "").replace("-", "")


def parse_xlsx_dictionary(raw: bytes) -> Optional[List[Dict[str, Any]]]:
    """Deterministically parse a STRUCTURED Excel data dictionary into the source
    shape, reading every attribute (name, dataType, length, description,
    businessTerm, sample) straight from the cells — no AI, verbatim, instant.

    Returns a list of tables, or None if the sheet isn't a recognisable
    dictionary (no table-name + column-name header pair) so the caller falls
    back to the AI loop.
    """
    if openpyxl is None:
        return None
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception:  # noqa: BLE001
        return None

    tables: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    recognised_any = False

    for ws in wb.worksheets:
        rows = [["" if c is None else str(c).strip() for c in r]
                for r in ws.iter_rows(values_only=True)]
        rows = [r for r in rows if any(v for v in r)]
        if len(rows) < 2:
            continue
        header = rows[0]
        # map each attribute to a column index via synonyms
        idx: Dict[str, int] = {}
        for ci, h in enumerate(header):
            n = norm_hdr(h)
            for key, syns in _XLSX_HDR.items():
                if key not in idx and n in syns:
                    idx[key] = ci
                    break
        # need at least a TABLE column and a COLUMN column to be a dictionary
        if "table" not in idx or "column" not in idx:
            continue
        recognised_any = True

        def cell(r, key):
            i = idx.get(key)
            return (r[i].strip() if (i is not None and i < len(r)) else "")

        for r in rows[1:]:
            tname = cell(r, "table")
            cname = cell(r, "column")
            if not tname or not cname:
                continue
            if tname not in tables:
                tables[tname] = {"name": tname, "columns": [], "_seen": set()}
                order.append(tname)
            b = tables[tname]
            if cname.lower() in b["_seen"]:
                continue
            b["_seen"].add(cname.lower())
            lraw = cell(r, "length")
            length = int(lraw) if lraw.isdigit() else (lraw or None)
            b["columns"].append({
                "name": cname,
                "dataType": (cell(r, "datatype") or "").lower(),
                "length": length,
                "businessTerm": cell(r, "businessterm"),
                "description": cell(r, "description"),
                "sample": cell(r, "sample"),
            })

    if not recognised_any:
        return None
    out = [{"name": t["name"], "columns": t["columns"]}
           for t in (tables[k] for k in order) if t["columns"]]
    return out or None
