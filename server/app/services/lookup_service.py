"""Lookup / typelist store: source lookup sets, their values, and the value-level
mappings (source code -> target value). App-relational, tenant-scoped like KYD.

Every function derives scope from (user_id, client_id) supplied by the caller (the
route reads them from the signed session — never client input) and filters by both,
so lookups can't be addressed across tenants. Returns (payload, http_status) dicts,
mirroring client_service / kyd_document_service. All writes hold write_lock().

A lookup_set is a SOURCE coded column's value set, optionally bound to the target
list column it feeds. Value mappings are unique per (lookup_set, source_code) so a
shared lookup is mapped once and reused.
"""
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.db.app_db import connect, write_lock
from app.core.capabilities import anthropic
from app.core.config import ai_model, EXTRACT_TEXT_BUDGET
from app.parsers.file_parsers import extract_file_text
from app.schemas.ai_schemas import LOOKUP_EXTRACT_SCHEMA, VALUE_MAPPING_SCHEMA
from app.services.ai_client import anthropic_client, schema_attempts
from app.services.ai_client_service import call_ai

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

_VALUE_TYPES = ("exact", "semantic", "defaulted", "unmapped", "manual_override", "ignored")
_MAX_NAME = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def target_lookup_name(target_table: Optional[str], target_column: Optional[str], fallback: str = "") -> str:
    """The canonical lookup name = TargetTable_TargetColumn (target column alone if no
    table). Falls back to the given name only when there is no target column."""
    tc = (target_column or "").strip()
    if not tc:
        return (fallback or "lookup").strip() or "lookup"
    tt = (target_table or "").strip()
    return (tt + "_" + tc) if tt else tc


# ------------------------------------------------------------------ row -> dict
def _row_to_set(r) -> Dict[str, Any]:
    return {
        "id": r["id"], "lookupName": r["lookup_name"],
        "sourceTable": r["source_table"] or "", "sourceColumn": r["source_column"] or "",
        "targetTable": r["target_table"] or "", "targetColumn": r["target_column"] or "",
        "targetValuesSpec": r["target_values_spec"] or "",
        "legacyValuesSpec": (r["legacy_values_spec"] if "legacy_values_spec" in r.keys() else "") or "",
        "sourceDocument": r["source_document"] or "",
        "version": r["version"], "valueCount": r["value_count"],
        "createdAt": r["created_at"], "updatedAt": r["updated_at"],
    }


def _row_to_value(r) -> Dict[str, Any]:
    return {
        "code": r["code"], "description": r["description"] or "",
        "sortOrder": r["sort_order"], "isActive": bool(r["is_active"]),
        "parentCode": r["parent_code"] or "",
        "effectiveFrom": r["effective_from"] or "", "effectiveTo": r["effective_to"] or "",
    }


def _row_to_vm(r) -> Dict[str, Any]:
    return {
        "id": r["id"], "sourceCode": r["source_code"], "sourceDescription": r["source_description"] or "",
        "targetCode": r["target_code"], "targetDescription": r["target_description"] or "",
        "confidence": r["confidence"], "rationale": r["rationale"] or "",
        "mappingType": r["mapping_type"], "isReviewed": bool(r["is_reviewed"]),
        "reviewedBy": r["reviewed_by"], "reviewedAt": r["reviewed_at"], "aiRunId": r["ai_run_id"],
        "createdAt": r["created_at"], "updatedAt": r["updated_at"],
    }


# ------------------------------------------------------------------ lookup sets
def save_lookup_set(user_id: int, client_id: int, lookup_name: str, values: List[Dict[str, Any]], *,
                    source_table: Optional[str] = None, source_column: Optional[str] = None,
                    target_table: Optional[str] = None, target_column: Optional[str] = None,
                    target_values_spec: Optional[str] = None, source_document: Optional[str] = None) -> Result:
    """Create or replace a lookup set (by name) and its values. Re-saving an existing
    set bumps its version and replaces its values; source codes are de-duplicated
    (first wins). Bindings/spec passed as None are preserved on an existing set."""
    lookup_name = (lookup_name or "").strip()
    if not lookup_name:
        return {"ok": False, "error": "A lookup name is required."}, 400
    if len(lookup_name) > _MAX_NAME:
        return {"ok": False, "error": "Lookup name is too long."}, 400

    # De-dupe by trimmed code (normalization proper lives in the parser layer).
    seen, deduped, dropped = set(), [], 0
    for v in (values or []):
        code = str(v.get("code", "")).strip()
        if not code:
            continue
        if code.lower() in seen:
            dropped += 1
            continue
        seen.add(code.lower())
        deduped.append({**v, "code": code})

    now = _now()
    with write_lock():
        conn = connect()
        try:
            existing = conn.execute(
                "SELECT id, version FROM lookup_sets WHERE user_id=? AND client_id=? AND lookup_name=?",
                (user_id, client_id, lookup_name),
            ).fetchone()
            if existing:
                set_id = existing["id"]
                conn.execute(
                    "UPDATE lookup_sets SET source_table=COALESCE(?,source_table), "
                    "source_column=COALESCE(?,source_column), target_table=COALESCE(?,target_table), "
                    "target_column=COALESCE(?,target_column), target_values_spec=COALESCE(?,target_values_spec), "
                    "source_document=COALESCE(?,source_document), version=?, value_count=?, updated_at=? WHERE id=?",
                    (source_table, source_column, target_table, target_column, target_values_spec,
                     source_document, (existing["version"] or 1) + 1, len(deduped), now, set_id),
                )
                conn.execute("DELETE FROM lookup_values WHERE lookup_set_id=?", (set_id,))
            else:
                cur = conn.execute(
                    "INSERT INTO lookup_sets (user_id, client_id, lookup_name, source_table, source_column, "
                    "target_table, target_column, target_values_spec, source_document, version, value_count, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
                    (user_id, client_id, lookup_name, source_table, source_column, target_table,
                     target_column, target_values_spec, source_document, len(deduped), now),
                )
                set_id = cur.lastrowid
            for i, v in enumerate(deduped):
                conn.execute(
                    "INSERT INTO lookup_values (lookup_set_id, user_id, client_id, code, description, "
                    "sort_order, is_active, parent_code, effective_from, effective_to, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (set_id, user_id, client_id, v["code"], v.get("description"),
                     v.get("sortOrder", i), 1 if v.get("isActive", True) else 0,
                     v.get("parentCode"), v.get("effectiveFrom"), v.get("effectiveTo"), now),
                )
            conn.commit()
            row = conn.execute("SELECT * FROM lookup_sets WHERE id=?", (set_id,)).fetchone()
        finally:
            conn.close()
    return {"ok": True, "set": _row_to_set(row), "valueCount": len(deduped), "duplicatesDropped": dropped}, 200


def snapshot_all(user_id: int, client_id: int) -> Result:
    """All lookup sets WITH their values, in one call — used by the Lookup Data
    System page for display and 'changes since last import' diffing."""
    conn = connect()
    try:
        sets = conn.execute(
            "SELECT * FROM lookup_sets WHERE user_id=? AND client_id=? ORDER BY lookup_name",
            (user_id, client_id),
        ).fetchall()
        ids = [r["id"] for r in sets]
        vals: Dict[int, List[Dict[str, str]]] = {}
        if ids:
            q = ("SELECT lookup_set_id, code, description FROM lookup_values "
                 "WHERE lookup_set_id IN (%s) ORDER BY sort_order, id" % ",".join("?" * len(ids)))
            for v in conn.execute(q, ids).fetchall():
                vals.setdefault(v["lookup_set_id"], []).append(
                    {"code": v["code"], "description": v["description"] or ""})
    finally:
        conn.close()
    out = []
    for r in sets:
        d = _row_to_set(r)
        d["values"] = vals.get(r["id"], [])
        out.append(d)
    return {"ok": True, "at": _now(), "sets": out}, 200


def list_sets(user_id: int, client_id: int) -> Result:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM lookup_sets WHERE user_id=? AND client_id=? ORDER BY lookup_name",
            (user_id, client_id),
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "sets": [_row_to_set(r) for r in rows]}, 200


def get_set(user_id: int, client_id: int, set_id: int) -> Result:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM lookup_sets WHERE id=? AND user_id=? AND client_id=?",
            (set_id, user_id, client_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {"ok": False, "error": "Lookup set not found."}, 404
    return {"ok": True, "set": _row_to_set(row)}, 200


def get_values(user_id: int, client_id: int, set_id: int) -> Result:
    """Values for a set the caller owns. 404 if the set isn't the tenant's."""
    owned, status = get_set(user_id, client_id, set_id)
    if status != 200:
        return owned, status
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM lookup_values WHERE lookup_set_id=? ORDER BY sort_order, id", (set_id,)
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "values": [_row_to_value(r) for r in rows]}, 200


def update_set(user_id: int, client_id: int, set_id: int, *,
               source_table: Optional[str] = None, source_column: Optional[str] = None,
               target_table: Optional[str] = None, target_column: Optional[str] = None,
               target_values_spec: Optional[str] = None, legacy_values_spec: Optional[str] = None) -> Result:
    """Update a set's source/target binding + optional specs (values untouched)."""
    with write_lock():
        conn = connect()
        try:
            owned = conn.execute(
                "SELECT id FROM lookup_sets WHERE id=? AND user_id=? AND client_id=?",
                (set_id, user_id, client_id),
            ).fetchone()
            if not owned:
                return {"ok": False, "error": "Lookup set not found."}, 404
            conn.execute(
                "UPDATE lookup_sets SET source_table=COALESCE(?,source_table), "
                "source_column=COALESCE(?,source_column), target_table=COALESCE(?,target_table), "
                "target_column=COALESCE(?,target_column), target_values_spec=COALESCE(?,target_values_spec), "
                "legacy_values_spec=COALESCE(?,legacy_values_spec), "
                "updated_at=? WHERE id=?",
                (source_table, source_column, target_table, target_column, target_values_spec,
                 legacy_values_spec, _now(), set_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM lookup_sets WHERE id=?", (set_id,)).fetchone()
        finally:
            conn.close()
    return {"ok": True, "set": _row_to_set(row)}, 200


def delete_all_sets(user_id: int, client_id: int) -> Result:
    """Delete ALL lookup sets for this tenant; values + value mappings cascade away."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute("DELETE FROM lookup_sets WHERE user_id=? AND client_id=?", (user_id, client_id))
            conn.commit()
            removed = cur.rowcount if cur.rowcount is not None else 0
        finally:
            conn.close()
    return {"ok": True, "removed": removed}, 200


def delete_set(user_id: int, client_id: int, set_id: int) -> Result:
    """Delete a set the caller owns; values + value mappings cascade away."""
    with write_lock():
        conn = connect()
        try:
            owned = conn.execute(
                "SELECT id FROM lookup_sets WHERE id=? AND user_id=? AND client_id=?",
                (set_id, user_id, client_id),
            ).fetchone()
            if not owned:
                return {"ok": False, "error": "Lookup set not found."}, 404
            conn.execute("DELETE FROM lookup_sets WHERE id=?", (set_id,))   # cascades values + mappings
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "deletedId": set_id}, 200


# ------------------------------------------------------------- document import
_LOOKUP_EXTRACT_SYSTEM = (
    "You are a data-migration analyst. From the document, extract LOOKUP / TYPELIST mappings. "
    "For EACH lookup identify: its name (lookupName), the SOURCE table & column, the TARGET table "
    "& column, and the EXPECTED value mapping as FREE TEXT exactly as written in the document "
    "(expectedValues) — e.g. '1 then open, 2 then closed, 3 then draft'. If the document instead "
    "lists discrete code/description rows, also return them under values:[{code, description}]. "
    "Return ONLY a JSON object of the form {\"sets\": [{\"lookupName\", \"sourceTable\", "
    "\"sourceColumn\", \"targetTable\", \"targetColumn\", \"expectedValues\", \"values\"}]}. Use "
    "ONLY information present in the document — never invent tables, columns, codes, or values. "
    "If a field is not stated, use an empty string (or an empty list for values). No prose, no fences."
)


def _parse_json_object(txt: str) -> Dict[str, Any]:
    """Best-effort JSON parse (strip fences; fall back to the first {...} block)."""
    t = (txt or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n", "", t)
        t = re.sub(r"\n```$", "", t)
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:  # noqa: BLE001
                return {}
        return {}


def _ai_extract_lookup_sets(filename: str, raw: bytes) -> Dict[str, Any]:
    """Read any file's text and have the AI extract lookup sets (for PDF/Word/messy
    files, or when the deterministic table parser found nothing)."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}
    text, err = extract_file_text(filename, raw)
    if err:
        return {"ok": False, "error": err}
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "Could not read any text from the file."}
    text = text[:EXTRACT_TEXT_BUDGET]
    model = ai_model()
    user = "DOCUMENT (extract every lookup / typelist mapping you can find):\n\n" + text
    try:
        client = anthropic_client()

        def run(extra, _kw=dict(model=model, max_tokens=8000, system=_LOOKUP_EXTRACT_SYSTEM,
                                messages=[{"role": "user", "content": user}])):
            with client.messages.stream(**_kw, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Lookup Data Extraction", run, schema_attempts(LOOKUP_EXTRACT_SCHEMA))
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}
        txt = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        data = _parse_json_object(txt)
        sets = data.get("sets") if isinstance(data, dict) else None
        return {"ok": True, "sets": sets or []}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc) or exc.__class__.__name__}


def _split_dotted_binding(s: Dict[str, Any]) -> None:
    """In-place: when a table is missing but the column is dotted ('Tbl.Col'), split
    it into table + column. Applied to both source and target bindings."""
    for tbl_key, col_key in (("targetTable", "targetColumn"), ("sourceTable", "sourceColumn")):
        tbl = (s.get(tbl_key) or "").strip()
        col = (s.get(col_key) or "").strip()
        if not tbl and "." in col:
            head, _, tail = col.rpartition(".")
            if head and tail:
                s[tbl_key] = head
                s[col_key] = tail


# Guidewire product -> physical typelist-table prefix.
_GW_TYPELIST_PREFIX = {"policy": "pctl_", "claim": "cctl_", "billing": "bctl_"}


def _store_dict_descriptions(user_id: int, client_id: int, raw: bytes) -> int:
    """From a Guidewire dictionary zip, build a per-column DESCRIPTION map from the
    db/ entity pages and store it as the tenant doc 'dict_descriptions'
    ({ "<physical table>": { "<normcol>": "<description>" } }). Used by Target System
    'AI fill' to populate column descriptions. Returns the number of tables stored."""
    from app.parsers.gw_dictionary import iter_zip_html, parse_gw_entity
    from app.services import tenant_store_service as store
    try:
        pages = iter_zip_html(raw)
    except Exception:  # noqa: BLE001
        return 0
    has_db = any("/db/" in p.replace("\\", "/").lower() for p, _ in pages)
    out: Dict[str, Dict[str, str]] = {}
    for path, html in pages:
        pl = path.replace("\\", "/").lower()
        if "/typelist/" in pl:
            continue
        if has_db and "/db/" not in pl:
            continue
        ent = parse_gw_entity(html)
        if not ent or not ent.get("columns"):
            continue
        cols: Dict[str, str] = {}
        for c in ent["columns"]:
            d = (c.get("description") or "").strip()
            if not d:
                continue
            key = re.sub(r"[^a-z0-9]", "", (c.get("name") or "").lower())
            if key:
                cols[key] = d
        if cols:
            out[ent.get("physical") or ent.get("name")] = cols
    if out:
        store.set_doc(user_id, client_id, "dict_descriptions", out)
    return len(out)


def _import_gw_typelists(user_id: int, client_id: int, filename: str, raw: bytes,
                         product: Optional[str] = None) -> Result:
    """Import Guidewire typelist pages (from a zipped HTML dictionary or a single
    .html page) as lookup sets — one set per typelist, code list -> values. Binding
    (source/target) is left blank for the user to set on the Lookup Mapping page.

    When `product` is policy/claim/billing, only typelists whose physical table name
    starts with that product's prefix (pctl_/cctl_/bctl_) are imported."""
    from app.parsers.gw_dictionary import iter_zip_html, parse_gw_typelist
    prefix = _GW_TYPELIST_PREFIX.get((product or "").strip().lower())
    # From the SAME zip, also capture entity-column descriptions for Target 'AI fill'.
    dict_tables = 0
    if filename.lower().endswith(".zip"):
        try:
            dict_tables = _store_dict_descriptions(user_id, client_id, raw)
        except Exception:  # noqa: BLE001
            dict_tables = 0
    pages = iter_zip_html(raw) if filename.lower().endswith(".zip") else \
        [(filename, raw.decode("utf-8", errors="ignore"))]
    created, total, skipped = [], 0, 0
    for path, html in pages:
        tl = parse_gw_typelist(html)
        if not tl or not tl.get("values"):
            continue
        name = tl.get("physical") or tl.get("name") or "typelist"
        if prefix and not name.lower().startswith(prefix):
            skipped += 1
            continue                      # not this product's typelist
        vals = [{"code": v["code"], "description": v.get("description", "")} for v in tl["values"]]
        p, st = save_lookup_set(user_id, client_id, name, vals, source_document=filename)
        if st == 200 and p.get("ok"):
            created.append(p["set"]["lookupName"])
            total += p.get("valueCount", 0)
    if not created:
        if dict_tables:
            # No typelists for this product, but we still captured entity descriptions.
            return {"ok": True, "created": 0, "sets": [], "totalValues": 0, "skippedRows": skipped,
                    "extractedByAI": False, "dictTables": dict_tables}, 200
        hint = (" for product '" + product + "' (prefix " + prefix + ")") if prefix else ""
        return {"ok": False, "error": "No Guidewire typelists were found in the upload" + hint + "."}, 400
    return {"ok": True, "created": len(created), "sets": created, "totalValues": total,
            "skippedRows": skipped, "extractedByAI": False, "dictTables": dict_tables}, 200


def import_document(user_id: int, client_id: int, filename: str, raw: bytes, ext: str,
                    product: Optional[str] = None) -> Result:
    """Import an uploaded lookup document into lookup sets. Structured files
    (xlsx/csv with the expected columns) use the fast deterministic parser; PDFs,
    Word docs, or files where those columns aren't found fall back to AI extraction.
    A .zip (or .html) Guidewire dictionary imports its typelists as lookup sets,
    optionally filtered to a product (policy/claim/billing) by table prefix."""
    from app.parsers.lookup_parsers import parse_lookup_document
    raw = raw or b""
    if (ext or "").lower() == "zip" or (raw[:64].lstrip().lower().startswith(b"<") and "typelistbody" in raw[:20000].decode("utf-8", errors="ignore").lower()):
        return _import_gw_typelists(user_id, client_id, filename, raw, product=product)
    parsed = parse_lookup_document(raw, ext)
    sets = parsed.get("sets") if parsed.get("ok") else None
    used_ai = False
    if not sets:
        ai = _ai_extract_lookup_sets(filename, raw)
        if not ai.get("ok"):
            return {"ok": False, "error": ai.get("error") or parsed.get("error") or
                    "Could not extract lookup data from the file."}, 400
        sets = ai.get("sets") or []
        used_ai = True
    if not sets:
        return {"ok": False, "error": "No lookup data found in the file."}, 400

    created, total = [], 0
    for s in sets:
        # Safety net: if a table wasn't captured but the column arrived dotted
        # ("Table.Column"), split it so the target/source table is recovered.
        _split_dotted_binding(s)
        name = target_lookup_name(s.get("targetTable"), s.get("targetColumn"),
                                  fallback=(s.get("lookupName") or s.get("sourceColumn") or "lookup"))
        vals = [v for v in (s.get("values") or []) if str(v.get("code", "")).strip()]
        spec = (s.get("expectedValues") or "").strip()
        if not vals and not spec:
            continue
        p, st = save_lookup_set(
            user_id, client_id, name, vals,
            source_table=s.get("sourceTable") or None, source_column=s.get("sourceColumn") or None,
            target_table=s.get("targetTable") or None, target_column=s.get("targetColumn") or None,
            target_values_spec=spec or None, source_document=filename)
        if st == 200 and p.get("ok"):
            created.append(p["set"]["lookupName"])
            total += p.get("valueCount", 0)
    return {"ok": True, "created": len(created), "sets": created, "totalValues": total,
            "skippedRows": (0 if used_ai else parsed.get("skipped", 0)), "extractedByAI": used_ai}, 200


# ------------------------------------------------------------- value mappings
def upsert_value_mapping(user_id: int, client_id: int, set_id: int, m: Dict[str, Any], *,
                         force: bool = False) -> Result:
    """Insert/update one value mapping, unique per (set, source_code). Preserves a
    reviewed or manual_override row unless force=True (returns skipped:True then)."""
    src = str(m.get("sourceCode", "")).strip()
    if not src:
        return {"ok": False, "error": "sourceCode is required."}, 400
    mtype = (m.get("mappingType") or "unmapped").strip().lower()
    if mtype not in _VALUE_TYPES:
        mtype = "unmapped"
    now = _now()
    with write_lock():
        conn = connect()
        try:
            owned = conn.execute(
                "SELECT id FROM lookup_sets WHERE id=? AND user_id=? AND client_id=?",
                (set_id, user_id, client_id),
            ).fetchone()
            if not owned:
                return {"ok": False, "error": "Lookup set not found."}, 404
            existing = conn.execute(
                "SELECT id, is_reviewed, mapping_type FROM lookup_value_mappings "
                "WHERE lookup_set_id=? AND source_code=?", (set_id, src),
            ).fetchone()
            if existing:
                if not force and (existing["is_reviewed"] or existing["mapping_type"] == "manual_override"):
                    return {"ok": True, "skipped": True, "id": existing["id"]}, 200
                conn.execute(
                    "UPDATE lookup_value_mappings SET source_description=?, target_code=?, target_description=?, "
                    "confidence=?, rationale=?, mapping_type=?, ai_run_id=?, updated_at=? WHERE id=?",
                    (m.get("sourceDescription"), m.get("targetCode"), m.get("targetDescription"),
                     m.get("confidence"), m.get("rationale"), mtype, m.get("aiRunId"), now, existing["id"]),
                )
                vid = existing["id"]
            else:
                cur = conn.execute(
                    "INSERT INTO lookup_value_mappings (lookup_set_id, user_id, client_id, source_code, "
                    "source_description, target_code, target_description, confidence, rationale, mapping_type, "
                    "ai_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (set_id, user_id, client_id, src, m.get("sourceDescription"), m.get("targetCode"),
                     m.get("targetDescription"), m.get("confidence"), m.get("rationale"), mtype,
                     m.get("aiRunId"), now),
                )
                vid = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": vid}, 200


def list_value_mappings(user_id: int, client_id: int, set_id: int) -> Result:
    owned, status = get_set(user_id, client_id, set_id)
    if status != 200:
        return owned, status
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM lookup_value_mappings WHERE lookup_set_id=? ORDER BY source_code", (set_id,)
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "mappings": [_row_to_vm(r) for r in rows]}, 200


def set_value_mapping_override(user_id: int, client_id: int, mapping_id: int, target_code: Optional[str],
                               target_description: Optional[str] = None, reviewed_by: Optional[int] = None) -> Result:
    """User edit: mark a value mapping manual_override + reviewed with a chosen target."""
    with write_lock():
        conn = connect()
        try:
            owned = conn.execute(
                "SELECT id FROM lookup_value_mappings WHERE id=? AND user_id=? AND client_id=?",
                (mapping_id, user_id, client_id),
            ).fetchone()
            if not owned:
                return {"ok": False, "error": "Value mapping not found."}, 404
            conn.execute(
                "UPDATE lookup_value_mappings SET target_code=?, target_description=?, "
                "mapping_type='manual_override', is_reviewed=1, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?",
                (target_code, target_description, reviewed_by, _now(), _now(), mapping_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM lookup_value_mappings WHERE id=?", (mapping_id,)).fetchone()
        finally:
            conn.close()
    return {"ok": True, "mapping": _row_to_vm(row)}, 200


# ------------------------------------------------------ AI value-mapping (pass 2)
_VALUE_MAP_SYSTEM = (
    "You map a legacy/source system's coded values to a target Guidewire TYPELIST. "
    "You are given the LEGACY VALUES (free text the analyst typed — it may be 'code = label', "
    "'code then label', or a plain list of codes/labels) and the TARGET CODES (the allowed "
    "Guidewire typecodes, each with a name/description). For EACH distinct legacy value, choose "
    "the single best target code by MEANING (compare against the target codes' names/descriptions, "
    "not exact strings). Return: sourceCode (the legacy code exactly as given), sourceDescription "
    "(its label if present, else \"\"), targetCode (EXACTLY one of the provided target codes, or \"\" "
    "if none fits), mappingType ('exact' = clearly the same meaning, 'semantic' = inferred match, "
    "'defaulted' = a fallback/default, 'unmapped' = no target fits), confidence 0-1, and a short "
    "rationale. Use ONLY the provided target codes — NEVER invent a target code. Return ONLY JSON "
    "{\"mappings\":[{sourceCode, sourceDescription, targetCode, mappingType, confidence, rationale}]}."
)


def generate_value_mappings(user_id: int, client_id: int, set_id: int,
                            legacy_values: str, target_codes: Optional[List[Dict[str, Any]]] = None) -> Result:
    """AI-map a lookup set's LEGACY values (free text) to its target Guidewire typelist
    codes. Persists the legacy text + a readable summary on the set, upserts one value
    mapping per legacy code (preserving reviewed/manual overrides), and logs a pass."""
    owned, st = get_set(user_id, client_id, set_id)
    if st != 200:
        return owned, st
    legacy = (legacy_values or "").strip()
    if not legacy:
        return {"ok": False, "error": "Enter the legacy values to map."}, 400
    codes = [c for c in (target_codes or []) if isinstance(c, dict) and str(c.get("code", "")).strip()]
    if not codes:
        return {"ok": False, "error": "No target typelist codes for this column — import its "
                "Guidewire typelist (Product Data Dictionary) and set the column's Type Key (Target AI fill)."}, 400
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400

    model = ai_model()
    user = ("TARGET CODES (Guidewire typelist — the ONLY allowed target values):\n" +
            json.dumps(codes, ensure_ascii=False) +
            "\n\nLEGACY VALUES (source system, free text):\n" + legacy)
    client = anthropic_client()
    kw = dict(model=model, max_tokens=8000, system=_VALUE_MAP_SYSTEM,
              messages=[{"role": "user", "content": user}])

    def run(extra):
        with client.messages.stream(**kw, **extra) as stream:
            return stream.get_final_message()

    try:
        resp = call_ai("Lookup Value Mapping", run, schema_attempts(VALUE_MAPPING_SCHEMA))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc) or exc.__class__.__name__}, 400
    if getattr(resp, "stop_reason", None) == "refusal":
        return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
    txt = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    data = _parse_json_object(txt)
    rows = data.get("mappings") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        rows = []

    # Clear the previous run's AI rows so a NEW legacy set fully replaces the old one
    # (otherwise codes from an earlier legacy input linger and pollute the summary).
    # Manual / reviewed overrides are kept — they represent explicit user decisions.
    with write_lock():
        conn = connect()
        try:
            conn.execute(
                "DELETE FROM lookup_value_mappings WHERE lookup_set_id=? AND user_id=? AND client_id=? "
                "AND is_reviewed=0 AND mapping_type <> 'manual_override'",
                (set_id, user_id, client_id))
            conn.commit()
        finally:
            conn.close()

    for m in rows:
        if not isinstance(m, dict):
            continue
        sc = str(m.get("sourceCode", "")).strip()
        if not sc:
            continue
        tc = str(m.get("targetCode", "") or "").strip()
        mt = (m.get("mappingType") or ("unmapped" if not tc else "semantic")).strip().lower()
        # force=False preserves a reviewed / manual_override row from an earlier pass.
        upsert_value_mapping(user_id, client_id, set_id, {
            "sourceCode": sc, "sourceDescription": m.get("sourceDescription", ""),
            "targetCode": tc, "mappingType": mt,
            "confidence": m.get("confidence", 0), "rationale": m.get("rationale", ""),
        }, force=False)

    vms, _ = list_value_mappings(user_id, client_id, set_id)
    ms = vms.get("mappings", [])
    # One "legacyCode ---> gwCode" per line (the "--->" arrow is what the Sync parser reads).
    spec = "\n".join((v.get("sourceCode", "") + " ---> " + (v.get("targetCode") or "(unmapped)")) for v in ms)
    update_set(user_id, client_id, set_id, target_values_spec=(spec or None), legacy_values_spec=legacy)
    mapped = sum(1 for v in ms if (v.get("targetCode") or "").strip())
    log_run(user_id, client_id, 2, prompt_version="value.v1", model=model,
            counts={"mapped": mapped, "unmapped": len(ms) - mapped, "total": len(ms)})
    return {"ok": True, "saved": len(ms), "mapped": mapped, "spec": spec, "mappings": ms}, 200


# ------------------------------------------------------------------ run audit
def log_run(user_id: int, client_id: int, pass_no: int, *, prompt_version: Optional[str] = None,
            model: Optional[str] = None, input_tokens: int = 0, output_tokens: int = 0,
            duration_ms: Optional[int] = None, counts: Optional[Dict[str, Any]] = None,
            status: str = "success", error: Optional[str] = None) -> int:
    """Record one AI mapping run (per pass). Returns the new run id."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO ai_mapping_runs (user_id, client_id, pass_no, prompt_version, model, "
                "input_tokens, output_tokens, duration_ms, counts_json, status, error, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (user_id, client_id, pass_no, prompt_version, model, input_tokens, output_tokens,
                 duration_ms, json.dumps(counts or {}), status, error, _now()),
            )
            conn.commit()
            rid = cur.lastrowid
        finally:
            conn.close()
    return rid
