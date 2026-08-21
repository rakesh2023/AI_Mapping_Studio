"""Parser for a Guidewire-style HTML data dictionary (pure; no Flask/Anthropic).

A Guidewire data dictionary is a folder of HTML pages, one per entity/typelist:
  - Entity/db pages  -> a table (physical name in <span class="entityname">, e.g.
    cc_account) whose COLUMNS are <p class="column"> blocks:
        <span class="coltitle">AccountNumber</span>
        <span class="titleDesc">shorttext (255)</span>        (type + length,
                                       or "key" -> PK, "foreign key to X" -> FK)
        <span class="spaceandsize">(database column: X)(non-null)(default: 0)</span>
        <span class="desc">The account number</span>
    (The only <table>s on these pages are UI "screen reference" noise.)
  - Typelist pages   -> a code list: <table class="typelistbody"> with header
    Code / Name / Description ... -> lookup values.

This module exposes:
  - parse_gw_entity(html)   -> {name, physical, description, columns[]} | None
  - parse_gw_typelist(html) -> {name, physical, description, values[]}  | None
  - iter_zip_html(raw)      -> [(path, html_text)]   (stdlib zipfile)
No third-party dependency (stdlib html.parser + zipfile).
"""
import io
import re
import zipfile
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

# Safety caps for a whole-dictionary zip (security/ folders can hold thousands of pages).
MAX_ZIP_FILES = 6000
MAX_ZIP_BYTES = 200 * 1024 * 1024   # 200 MB uncompressed budget


def _clean(s: str) -> str:
    """Normalise a captured cell/label: drop non-breaking spaces, collapse runs."""
    return re.sub(r"\s+", " ", (s or "").replace("\xa0", " ")).strip()


# ---------------------------------------------------------------- page header
def _page_names(html: str) -> Tuple[str, str]:
    """(display name, physical name). Physical = first (...) inside .entityname."""
    display = ""
    m = re.search(r'class=["\']?pagetitle["\']?[^>]*>([^<]*)', html, re.I)
    if m:
        display = _clean(m.group(1))
    if not display:
        m = re.search(r"<title>([^<]*)</title>", html, re.I)
        if m:
            display = _clean(m.group(1))
    physical = ""
    m = re.search(r'class=["\']?entityname["\']?[^>]*>\s*\(([^)]+)\)', html, re.I)
    if m:
        physical = _clean(m.group(1))
    return display, physical


def _description(html: str) -> str:
    """Best-effort entity/typelist description."""
    # Typelist / simple: <div class="desc">text</div> (no nested reflink).
    m = re.search(r'<div class=["\']?desc["\']?[^>]*>\s*([^<][^<]*?)\s*</div>', html, re.I)
    if m and _clean(m.group(1)):
        return _clean(m.group(1))
    # Entity: text lives in the hidden refbox after the "Description" link.
    m = re.search(r"<b>Description</b>.*?refbox_inner[^>]*>(.*?)</div>", html, re.I | re.S)
    if m:
        return _clean(re.sub(r"<[^>]+>", " ", m.group(1)))
    return ""


# ---------------------------------------------------------------- entity fields
class _FieldParser(HTMLParser):
    """Collect <p class="column"> field blocks. A new column starts at each
    <span class="coltitle">; the following titleDesc / spaceandsize / desc spans
    belong to it. <sup>/<script>/<style> content is ignored (glossary popups)."""
    CAP = {"coltitle", "titledesc", "spaceandsize", "desc"}
    SKIP = {"sup", "script", "style"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.columns: List[Dict[str, Any]] = []
        self._skip = 0
        self._spans: List[Optional[str]] = []   # per open <span>: its CAP key or None
        self._cur: Optional[Dict[str, str]] = None
        self._buf: Dict[str, str] = {}

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
            return
        if tag == "span":
            cls = (dict(attrs).get("class") or "").strip().strip("'\"").lower()
            key = cls if cls in self.CAP else None
            if key == "coltitle":
                self._flush()
                self._cur = {}
                self._buf = {}
            self._spans.append(key)

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            if self._skip > 0:
                self._skip -= 1
            return
        if tag == "span" and self._spans:
            self._spans.pop()

    def handle_data(self, data):
        if self._skip > 0 or self._cur is None:
            return
        key = next((k for k in reversed(self._spans) if k), None)
        if key:
            self._buf[key] = self._buf.get(key, "") + data

    def _flush(self):
        if self._cur is not None:
            name = _clean(self._buf.get("coltitle", ""))
            if name:
                self._cur = {
                    "name": name,
                    "titleDesc": _clean(self._buf.get("titledesc", "")),
                    "spaceandsize": _clean(self._buf.get("spaceandsize", "")),
                    "desc": _clean(self._buf.get("desc", "")),
                }
                self.columns.append(self._cur)
        self._cur = None

    def close(self):
        super().close()
        self._flush()


def _column_shape(raw: Dict[str, str]) -> Dict[str, Any]:
    """Turn a raw field block into the source-column shape (+ pk/fk/mandatory)."""
    td = raw["titleDesc"]
    sz = raw["spaceandsize"]
    tdl = td.lower()
    data_type, length, pk, fk, fk_ref = "", None, False, False, ""

    if "foreign key to" in tdl:
        fk = True
        m = re.search(r"foreign key to\s+([A-Za-z0-9_]+)", td)
        if m:
            fk_ref = m.group(1)
        data_type = "foreignkey"
    elif tdl == "key" or tdl.startswith("key"):
        pk = True
        data_type = "key"
    else:
        m = re.match(r"\s*([A-Za-z0-9_ /]+?)\s*(?:\((\d+)\))?\s*$", td)
        if m:
            data_type = _clean(m.group(1))
            if m.group(2):
                length = int(m.group(2))

    db_col = ""
    m = re.search(r"database column:\s*([A-Za-z0-9_]+)", sz, re.I)
    if m:
        db_col = m.group(1)
    mandatory = "non-null" in sz.lower()
    default = ""
    m = re.search(r"default:\s*([^)]*)", sz, re.I)
    if m:
        default = _clean(m.group(1))

    return {
        "name": raw["name"], "dbColumn": db_col, "dataType": data_type, "length": length,
        "mandatory": mandatory, "pk": pk, "fk": fk, "fkReference": fk_ref,
        "default": default, "description": raw["desc"],
    }


def parse_gw_entity(html: str) -> Optional[Dict[str, Any]]:
    """Parse one Guidewire entity/db page. Returns None if it has no field blocks
    (so index / frame / security / typelist pages are skipped)."""
    if not html or "coltitle" not in html:
        return None
    fp = _FieldParser()
    try:
        fp.feed(html)
        fp.close()
    except Exception:  # noqa: BLE001 — lenient: a malformed page shouldn't abort a folder
        pass
    if not fp.columns:
        return None
    display, physical = _page_names(html)
    cols = [_column_shape(c) for c in fp.columns]
    return {"name": display or physical, "physical": physical or display,
            "description": _description(html), "columns": cols}


# ---------------------------------------------------------------- typelist codes
class _FirstTableGrid(HTMLParser):
    """Rows (list of cell-text) of the FIRST <table> whose class contains `needle`."""
    def __init__(self, needle: str):
        super().__init__(convert_charrefs=True)
        self._needle = needle
        self.rows: List[List[str]] = []
        self._in = False
        self._depth = 0
        self._done = False
        self._row: Optional[List[str]] = None
        self._cell: Optional[str] = None

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        if tag == "table":
            cls = (dict(attrs).get("class") or "").lower()
            if not self._in and self._needle in cls:
                self._in, self._depth = True, 1
            elif self._in:
                self._depth += 1
            return
        if not self._in:
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = ""

    def handle_endtag(self, tag):
        if self._done or not self._in:
            return
        if tag == "table":
            self._depth -= 1
            if self._depth == 0:
                self._in, self._done = False, True
            return
        if tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row.append(_clean(self._cell))
            self._cell = None

    def handle_data(self, data):
        if self._in and self._cell is not None:
            self._cell += data


def parse_gw_typelist(html: str) -> Optional[Dict[str, Any]]:
    """Parse one Guidewire typelist page's Typecodes table into lookup values.
    Returns None if there is no typelist code table."""
    if not html or "typelistbody" not in html:
        return None
    g = _FirstTableGrid("typelistbody")
    try:
        g.feed(html)
        g.close()
    except Exception:  # noqa: BLE001
        pass
    rows = [r for r in g.rows if any(c for c in r)]
    if len(rows) < 2:
        return None
    # Header maps Code / Name / Description; default to first three columns.
    header = [c.lower() for c in rows[0]]
    def col(names, default):
        for i, h in enumerate(header):
            if h in names:
                return i
        return default
    ci = col(("code", "typecode", "cd"), 0)
    ni = col(("name",), 1)
    di = col(("description", "desc"), 2)
    values: List[Dict[str, str]] = []
    seen = set()
    for r in rows[1:]:
        code = r[ci] if ci < len(r) else ""
        if not code or code.lower() in seen:
            continue
        seen.add(code.lower())
        desc = (r[di] if di < len(r) else "") or (r[ni] if ni < len(r) else "")
        values.append({"code": code, "description": desc})
    if not values:
        return None
    display, physical = _page_names(html)
    return {"name": display or physical, "physical": physical or display,
            "description": _description(html), "values": values}


# ---------------------------------------------------------------- zip iteration
def iter_zip_html(raw: bytes) -> List[Tuple[str, str]]:
    """Yield (archive_path, html_text) for every .htm/.html entry in a zip,
    bounded by MAX_ZIP_FILES / MAX_ZIP_BYTES. Non-HTML entries are ignored."""
    out: List[Tuple[str, str]] = []
    total = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not name.lower().endswith((".htm", ".html")):
                continue
            if len(out) >= MAX_ZIP_FILES or total >= MAX_ZIP_BYTES:
                break
            try:
                data = z.read(info)
            except Exception:  # noqa: BLE001
                continue
            total += len(data)
            out.append((name, data.decode("utf-8", errors="ignore")))
    return out
