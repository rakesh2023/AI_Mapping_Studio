"""Per-client migration-tool schema provider (CMT / PMT) for the Data Reconciliation SQL
Assistant.

Reads the schema the user uploaded on the Product Schema page — stored per client as the
`cmt_schema` (Claim Migration Tool) or `pmt_schema` (Policy Migration Tool) tenant doc — and
exposes the same read API the ClaimCenter provider does (has_index / list_tables / catalog /
schema_context) so cc_sql_service can ground on it. Surfaces migration-schema specifics: the
actual PK column (PMT_ID / _ID1 / _ID2), direct + polymorphic FKs, and typekey string columns.
Descriptions missing on a migration column are enriched from the imported data dictionary
(dict_descriptions), since the migration column names largely match it.
"""
import re
from typing import Any, Dict, List, Optional

from app.services import tenant_store_service as store

# Which tenant doc backs each source.
DOC_KEY = {"cmt": "cmt_schema", "pmt": "pmt_schema"}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def _entities(user_id: int, client_id: int, doc_key: str) -> List[Dict[str, Any]]:
    payload, _ = store.get_doc(user_id, client_id, doc_key)
    doc = payload.get("value") if payload.get("ok") else None
    ents = doc.get("entities") if isinstance(doc, dict) else None
    return ents if isinstance(ents, list) else []


def _table_of(e: Dict[str, Any]) -> str:
    return (e.get("table") or e.get("name") or "").strip()


def _clean_fk_ref(ref: str) -> str:
    """'entity.Account' / '[claim].[cs_x]' -> a readable target name."""
    r = str(ref or "").strip()
    r = re.sub(r"^entity\.", "", r, flags=re.IGNORECASE)
    return r


# --------------------------------------------------------------- read API

def has_index(user_id: int, client_id: int, doc_key: str) -> Optional[Dict[str, int]]:
    ents = _entities(user_id, client_id, doc_key)
    if not ents:
        return None
    cols = sum(len(e.get("fields") or []) for e in ents)
    return {"tables": len(ents), "columns": cols, "entities": len(ents)}


def list_tables(user_id: int, client_id: int, doc_key: str, q: str = "") -> List[Dict[str, Any]]:
    ql = (q or "").lower().strip()
    out = []
    for e in _entities(user_id, client_id, doc_key):
        tbl = _table_of(e)
        if not tbl:
            continue
        desc = (e.get("description") or "").strip()
        if ql and ql not in (tbl + " " + (e.get("name") or "") + " " + desc).lower():
            continue
        out.append({"id": tbl, "table": tbl, "description": desc})
    out.sort(key=lambda x: x["table"].lower())
    return out


def catalog(user_id: int, client_id: int, doc_key: str) -> List[Dict[str, str]]:
    return list_tables(user_id, client_id, doc_key)


def search_entity_ids(user_id: int, client_id: int, doc_key: str, prompt: str, limit: int = 15) -> List[str]:
    """Keyword fallback (the AI table-select is primary). Matches prompt words against table
    names/descriptions; plural-tolerant."""
    def toks(s):
        s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s or "")
        return [w for w in (p.lower() for p in re.split(r"[^A-Za-z0-9]+", s))
                if w and w not in ("pmt", "the") and len(w) >= 3]
    def sing(w):
        return w[:-1] if (len(w) > 4 and w.endswith("s")) else w
    words = list({sing(w) for w in toks(prompt)})
    if not words:
        return []
    scored = {}
    for e in _entities(user_id, client_id, doc_key):
        tbl = _table_of(e)
        if not tbl:
            continue
        name_tokens = {sing(t) for t in toks(tbl + " " + (e.get("name") or ""))}
        desc_tokens = {sing(t) for t in toks(e.get("description") or "")}
        score = 0
        for w in words:
            if w in name_tokens:
                score += 5
            elif any(t.startswith(w) or w.startswith(t) for t in name_tokens):
                score += 3
            elif w in desc_tokens:
                score += 1
        if score:
            scored[tbl] = score
    return [t for t, _ in sorted(scored.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]


def _desc_index(user_id: int, client_id: int):
    """Per-column descriptions from the imported data dictionary (dict_descriptions doc):
    (normTable, normCol) -> desc, plus a normCol -> desc fallback."""
    payload, _ = store.get_doc(user_id, client_id, "dict_descriptions")
    d = payload.get("value") if payload.get("ok") else None
    by_tc, by_col = {}, {}
    if isinstance(d, dict):
        for tbl, cols in d.items():
            if not isinstance(cols, dict):
                continue
            nt = _norm(tbl)
            for col, desc in cols.items():
                if not desc:
                    continue
                nc = _norm(col)
                by_tc[(nt, nc)] = desc
                by_col.setdefault(nc, desc)
    return by_tc, by_col


def schema_context(user_id: int, client_id: int, doc_key: str, table_ids: List[str],
                   max_tables: int = 20) -> str:
    """Grounding block for the chosen migration tables: physical columns with type, PK, direct
    FKs, polymorphic FKs (targets + _Type discriminator) and typekeys. Descriptions missing on a
    column are filled from the data dictionary (column names largely match)."""
    ids = [t for t in (table_ids or []) if t][:max_tables]
    if not ids:
        return ""
    want = {t.lower() for t in ids}
    by_tc, by_col = _desc_index(user_id, client_id)
    blocks = []
    for e in _entities(user_id, client_id, doc_key):
        tbl = _table_of(e)
        if tbl.lower() not in want:
            continue
        header = "TABLE " + tbl + ((" — " + e["description"]) if e.get("description") else "")
        lines = [header]
        nt = _norm(tbl)
        for f in (e.get("fields") or []):
            col = (f.get("name") or "").strip()
            if not col:
                continue
            parts = [col, (f.get("dataType") or "")]
            flags = []
            if f.get("pk"):
                flags.append("PK")
            poly = (f.get("multipleFkType") or "").strip()
            if poly:
                flags.append("polymorphic FK targets: " + poly + " (discriminator: " + col + "_Type)")
            elif f.get("fk") and (f.get("fkReference") or "").strip():
                flags.append("FK -> " + _clean_fk_ref(f.get("fkReference")))
            tk = (f.get("typeKey") or "").strip()
            if tk:
                flags.append("typekey " + re.sub(r"^typekey\.", "", tk, flags=re.IGNORECASE) + " (string code; no join)")
            desc = (f.get("description") or "").strip()
            if not desc:
                desc = by_tc.get((nt, _norm(col))) or by_col.get(_norm(col)) or ""
            line = "  " + " ".join(p for p in parts if p)
            if flags:
                line += "  [" + "; ".join(flags) + "]"
            if desc:
                line += "  — " + desc[:120]
            lines.append(line)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)
