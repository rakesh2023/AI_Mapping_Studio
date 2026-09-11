"""Per-client Guidewire dictionary index (ClaimCenter or PolicyCenter).

Builds a queryable schema index from the Guidewire `entityModel.xml` that ships inside
the dictionary `.zip` the user uploads on Product Data Dictionary. Stored per client in
`aims_app.db` and fully replaced on each re-upload — so adding new tables is just a re-upload.
Powers the Data Reconciliation page's grounded NL->SQL.

The four tables are selected by a `prefix` argument: `cc_dict` (ClaimCenter, the default) or
`pc_dict` (PolicyCenter). The parser is identical for both — physical `pc_`/`cc_` table names
come straight from the XML — so the same code indexes either product; `pc_dictionary_service`
is a thin wrapper that passes `prefix="pc_dict"`.

This is the deployed, multi-tenant equivalent of the `.claude/skills/{claim,policy}center-sql`
skills: it ports their `build_index.py` XML parsing and `query.py` reads into the app.
Pure schema/SQL scope — no Flask, no Anthropic here.
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

from app.db.app_db import connect, write_lock

NS = "{http://www.guidewire.com/entityModel/1.0}"

# The dictionary index lives in one of these table sets, chosen per client by product.
_DICT_PREFIXES = ("cc_dict", "pc_dict")


def _tables(prefix: str) -> Dict[str, str]:
    """The four physical table names for a dictionary prefix ('cc_dict' | 'pc_dict')."""
    p = prefix if prefix in _DICT_PREFIXES else "cc_dict"
    return {"entities": p + "_entities", "columns": p + "_columns",
            "typelists": p + "_typelists", "typecodes": p + "_typecodes"}


def all_dict_tables() -> List[str]:
    """Every physical dictionary table across all product prefixes (cc_dict_* and pc_dict_*).
    Used by the per-client reset to clear the ClaimCenter/PolicyCenter schema index, which
    lives in these dedicated tables rather than the tenant-document store."""
    names: List[str] = []
    for p in _DICT_PREFIXES:
        names.extend(_tables(p).values())
    return names


def _tag(t: str) -> str:
    return NS + t


def _bool(el, name: str) -> int:
    return 1 if el.get(name) == "true" else 0


def _desc(el) -> Optional[str]:
    d = (el.findtext(_tag("description")) or el.get("description") or "").strip()
    return d or None


# ---------------------------------------------------------------- build (write)

def _find_entity_model_xml(raw: bytes) -> Optional[bytes]:
    """Return the bytes of the Guidewire entity model XML from inside a dictionary .zip.
    Robust to naming/nesting/namespace: first tries an exact `entityModel.xml` basename,
    then any `.xml` entry whose content looks like an entity model (has an <entityModel>
    root / the entityModel namespace). Returns None if none is found."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception:  # noqa: BLE001 — not a zip
        print("[cc_dictionary] upload is not a zip; skipping schema index.", flush=True)
        return None
    xml_entries = []
    try:
        for nm in zf.namelist():
            if nm.endswith("/"):
                continue
            base = nm.replace("\\", "/").rsplit("/", 1)[-1].lower()
            if base.endswith(".xml"):
                xml_entries.append(nm)
            if base == "entitymodel.xml":
                print("[cc_dictionary] found entityModel.xml at %r" % nm, flush=True)
                return zf.read(nm)
        # No exact match — sniff each .xml for an entity-model signature.
        for nm in xml_entries:
            try:
                head = zf.read(nm)[:4096].lower()
            except Exception:  # noqa: BLE001
                continue
            if b"entitymodel" in head and (b"<entity" in head or b"entitymodel/" in head):
                print("[cc_dictionary] using entity-model XML by content match: %r" % nm, flush=True)
                return zf.read(nm)
        print("[cc_dictionary] no entityModel.xml in zip; .xml entries=%r" % xml_entries[:20], flush=True)
    except Exception as exc:  # noqa: BLE001
        print("[cc_dictionary] error scanning zip: " + repr(exc), flush=True)
        return None
    return None


def _parse_entity_model(xml_bytes: bytes):
    """Parse the entity model XML into row lists for the four tables, NAMESPACE-AGNOSTIC —
    the namespace is derived from the document's root so any Guidewire version (…/1.0, /1.1,
    or none) parses. Returns (entities, columns, typelists, typecodes) — each a list of tuples
    WITHOUT the leading user_id/client_id (added at insert time)."""
    root = ET.fromstring(xml_bytes)
    ns = root.tag[:root.tag.index("}") + 1] if root.tag.startswith("{") else ""

    def t(name):            # namespaced tag for findall/find
        return ns + name

    def lt(el):             # local tag name (namespace stripped)
        return el.tag.split("}")[-1]

    def desc(el):
        d = (el.findtext(t("description")) or el.get("description") or "").strip()
        return d or None

    def boo(el, name):
        return 1 if el.get(name) == "true" else 0

    entities: List[tuple] = []
    columns: List[tuple] = []
    typelists: List[tuple] = []
    typecodes: List[tuple] = []

    def add_columns(owner_id: str, el) -> None:
        for child in el:
            name = lt(child)
            if name == "column":
                columns.append((owner_id, child.get("name"), "column",
                                child.get("columnName") or child.get("name"),
                                child.get("type"), child.get("typeLength"), desc(child),
                                boo(child, "isNonNull"), None, None, None))
            elif name == "typekey":
                tgt = child.find(t("targetTypelist"))
                tgt_id = tgt.get("idref") if tgt is not None else None
                kf = child.find(t("keyFilter"))
                kf_id = None
                if kf is not None:
                    kft = kf.find(t("targetTypelist"))
                    kf_id = kft.get("idref") if kft is not None else None
                columns.append((owner_id, child.get("name"), "typekey",
                                child.get("columnName") or child.get("name"),
                                "typekey", None, desc(child),
                                boo(child, "isNonNull"), None, tgt_id, kf_id))
            elif name == "foreignKey":
                tgt = child.find(t("targetEntity"))
                tgt_id = tgt.get("idref") if tgt is not None else None
                columns.append((owner_id, child.get("name"), "foreignkey",
                                child.get("columnName"), "foreignkey", None, desc(child),
                                boo(child, "isNonNull"), tgt_id, None, None))
            elif name == "array":
                tgt = child.find(t("targetEntity"))
                tgt_id = tgt.get("idref") if tgt is not None else None
                columns.append((owner_id, child.get("name"), "array", None,
                                "array (one-to-many; FK lives on the child table)", None,
                                desc(child), 0, tgt_id, None, None))
            # derivedColumn / delegateto skipped (no physical column here)

    for entity in root.findall(t("entity")):
        eid = entity.get("id")
        entities.append((eid, "entity", None, entity.get("tableName"), desc(entity)))
        add_columns(eid, entity)
        for subtype in entity.findall(t("subtype")):
            sid = subtype.get("id")
            entities.append((sid, "subtype", eid, None, desc(subtype)))
            add_columns(sid, subtype)

    for tl in root.findall(t("typelist")):
        tlid = tl.get("id")
        typelists.append((tlid, tl.get("tableName"), desc(tl)))
        for tc in tl.findall(t("typecode")):
            typecodes.append((tlid, tc.get("code"), tc.get("name"), desc(tc),
                              1 if tc.get("isRetired") == "true" else 0))

    return entities, columns, typelists, typecodes


def build_from_zip(user_id: int, client_id: int, raw: bytes, prefix: str = "cc_dict") -> Dict[str, Any]:
    """Find entityModel.xml inside the dictionary .zip and (re)build this client's index into
    the `prefix` table set ('cc_dict' | 'pc_dict'). Returns {indexed:bool, entities, columns,
    typelists, typecodes}. Never raises to the caller — a parse failure just reports
    indexed:false so the zip's other imports proceed. A client keeps ONE dictionary, so this
    also clears the OTHER product's dict rows for the client (product exclusivity)."""
    tag = "pc_dictionary" if prefix == "pc_dict" else "cc_dictionary"
    try:
        xml_bytes = _find_entity_model_xml(raw)
        if not xml_bytes:
            return {"indexed": False, "reason": "no entityModel.xml in the zip"}
        ents, cols, tls, tcs = _parse_entity_model(xml_bytes)
        print("[%s] parsed entity model: entities=%d columns=%d typelists=%d typecodes=%d"
              % (tag, len(ents), len(cols), len(tls), len(tcs)), flush=True)
    except Exception as exc:  # noqa: BLE001
        print("[%s] parse failed: %r" % (tag, exc), flush=True)
        return {"indexed": False, "reason": "could not parse entityModel.xml"}

    T = _tables(prefix)
    with write_lock():
        conn = connect()
        try:
            # One dictionary per client: clear BOTH product dict table sets for this client,
            # then (re)insert into the chosen one.
            for p in _DICT_PREFIXES:
                for t in _tables(p).values():
                    conn.execute("DELETE FROM %s WHERE user_id=? AND client_id=?" % t, (user_id, client_id))
            conn.executemany(
                "INSERT INTO %s (user_id,client_id,id,kind,parent_id,table_name,description) "
                "VALUES (?,?,?,?,?,?,?)" % T["entities"], [(user_id, client_id, *r) for r in ents])
            conn.executemany(
                "INSERT INTO %s (user_id,client_id,owner_id,name,kind,column_name,sql_type,"
                "type_length,description,is_nonnull,target_entity,target_typelist,key_filter_typelist) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)" % T["columns"], [(user_id, client_id, *r) for r in cols])
            conn.executemany(
                "INSERT INTO %s (user_id,client_id,id,table_name,description) "
                "VALUES (?,?,?,?,?)" % T["typelists"], [(user_id, client_id, *r) for r in tls])
            conn.executemany(
                "INSERT INTO %s (user_id,client_id,typelist_id,code,name,description,is_retired) "
                "VALUES (?,?,?,?,?,?,?)" % T["typecodes"], [(user_id, client_id, *r) for r in tcs])
            conn.commit()
        finally:
            conn.close()
    return {"indexed": True, "entities": len(ents), "columns": len(cols),
            "typelists": len(tls), "typecodes": len(tcs)}


def detect_app(raw: bytes) -> Optional[str]:
    """Peek at a dictionary .zip's entityModel.xml and infer the Guidewire application from the
    dominant physical table prefix: 'policy' (pc_/pctl_), 'claim' (cc_/cctl_), or None when there's
    no entityModel.xml or the prefixes are ambiguous. Used to warn on a product mismatch before import."""
    try:
        xml_bytes = _find_entity_model_xml(raw)
        if not xml_bytes:
            return None
        ents, _cols, tls, _tcs = _parse_entity_model(xml_bytes)
    except Exception:  # noqa: BLE001
        return None
    names = [e[3] for e in ents if e[3]] + [t[1] for t in tls if t[1]]  # physical table names
    pc = sum(1 for n in names if n.lower().startswith(("pc_", "pctl_")))
    cc = sum(1 for n in names if n.lower().startswith(("cc_", "cctl_")))
    if pc > cc and pc:
        return "policy"
    if cc > pc and cc:
        return "claim"
    return None


# ---------------------------------------------------------------- read (query)

def has_index(user_id: int, client_id: int, prefix: str = "cc_dict") -> Optional[Dict[str, int]]:
    """Return {entities, columns, typelists, typecodes} counts if this client has an
    index in the `prefix` table set, else None."""
    T = _tables(prefix)
    conn = connect()
    try:
        counts = {}
        for key in ("entities", "columns", "typelists", "typecodes"):
            counts[key] = conn.execute(
                "SELECT COUNT(*) FROM %s WHERE user_id=? AND client_id=?" % T[key],
                (user_id, client_id)).fetchone()[0]
    finally:
        conn.close()
    return counts if counts.get("entities") else None


def list_tables(user_id: int, client_id: int, q: str = "", limit: int = 500,
                prefix: str = "cc_dict") -> List[Dict[str, Any]]:
    """Persistent entities (those with a physical table) for the table picker, newest match
    first. `q` filters on entity id / table name / description (case-insensitive)."""
    T = _tables(prefix)
    conn = connect()
    try:
        sql = ("SELECT id, table_name, description FROM %s "
               "WHERE user_id=? AND client_id=? AND table_name IS NOT NULL AND table_name<>''" % T["entities"])
        args: List[Any] = [user_id, client_id]
        if q:
            sql += " AND (LOWER(id) LIKE ? OR LOWER(table_name) LIKE ? OR LOWER(IFNULL(description,'')) LIKE ?)"
            like = "%" + q.lower() + "%"
            args += [like, like, like]
        sql += " ORDER BY table_name LIMIT ?"
        args.append(int(limit))
        return [{"id": r["id"], "table": r["table_name"], "description": r["description"] or ""}
                for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


# Common words that shouldn't drive table selection.
_STOP = {"show", "give", "get", "list", "all", "the", "me", "my", "of", "in", "on", "for", "and",
         "with", "from", "to", "an", "data", "rows", "row", "table", "tables", "column", "columns",
         "record", "records", "please", "want", "need", "see", "find", "query", "select", "where",
         "that", "this", "are", "is", "each", "every", "any", "their", "its", "value", "values",
         "code", "codes", "name", "names", "join", "count", "total", "number"}


def _tokens(s: str) -> List[str]:
    """Split a name into lowercase word tokens: break camelCase and non-alnum, drop the
    cc_/cctl_ table prefixes and 1-char noise."""
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s or "")          # camelCase -> spaced
    out = []
    for p in re.split(r"[^A-Za-z0-9]+", s):
        p = p.lower()
        if p and p not in ("cc", "cctl", "pctl", "bctl", "pc", "bc") and len(p) >= 2:
            out.append(p)
    return out


def _singular(w: str) -> str:
    return w[:-1] if (len(w) > 4 and w.endswith("s")) else w


def catalog(user_id: int, client_id: int, prefix: str = "cc_dict") -> List[Dict[str, str]]:
    """All persistent entities (id, physical table, description) — the menu the AI picks from
    when choosing which tables a request needs (join/lookup tables included)."""
    T = _tables(prefix)
    conn = connect()
    try:
        return [{"id": r["id"], "table": r["table_name"], "description": r["description"] or ""}
                for r in conn.execute(
                    "SELECT id, table_name, IFNULL(description,'') description FROM %s "
                    "WHERE user_id=? AND client_id=? AND table_name IS NOT NULL AND table_name<>'' "
                    "ORDER BY id" % T["entities"], (user_id, client_id)).fetchall()]
    finally:
        conn.close()


def search_entity_ids(user_id: int, client_id: int, prompt: str, limit: int = 15,
                      prefix: str = "cc_dict") -> List[str]:
    """Auto-select: entity ids whose TABLE/ID tokens (or description) best match the prompt's
    words. Tokenizes names (camelCase + cc_ prefix aware), ignores stopwords, and is
    plural-tolerant, so 'transactions'/'cc_transaction' both hit the Transaction entity."""
    words = list({_singular(w) for w in _tokens(prompt) if w not in _STOP and len(w) >= 3})
    if not words:
        return []
    T = _tables(prefix)
    conn = connect()
    try:
        scored: Dict[str, int] = {}
        for r in conn.execute(
                "SELECT id, table_name, IFNULL(description,'') d FROM %s "
                "WHERE user_id=? AND client_id=? AND table_name IS NOT NULL AND table_name<>''" % T["entities"],
                (user_id, client_id)).fetchall():
            name_tokens = {_singular(t) for t in _tokens(r["id"] + " " + (r["table_name"] or ""))}
            desc_tokens = {_singular(t) for t in _tokens(r["d"])}
            score = 0
            for w in words:
                if w in name_tokens:
                    score += 5                                   # exact table/entity word
                elif any(t.startswith(w) or w.startswith(t) for t in name_tokens):
                    score += 3                                   # prefix (e.g. transactionline)
                elif w in desc_tokens:
                    score += 1                                   # only mentioned in the description
            if score:
                scored[r["id"]] = score
        return [eid for eid, _ in sorted(scored.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]
    finally:
        conn.close()


def schema_context(user_id: int, client_id: int, entity_ids: List[str], max_tables: int = 20,
                   prefix: str = "cc_dict") -> str:
    """Compact grounding block for the given entities: physical table, each column's physical
    name + type + FK target table + typelist, plus the typecodes of any typelists used. This is
    what bounds prompt size (the full 8k-column schema can't go in one prompt)."""
    entity_ids = [e for e in (entity_ids or []) if e][:max_tables]
    if not entity_ids:
        return ""
    T = _tables(prefix)
    conn = connect()
    try:
        ph = ",".join("?" for _ in entity_ids)
        ents = {r["id"]: r for r in conn.execute(
            "SELECT id, table_name, description FROM %s "
            "WHERE user_id=? AND client_id=? AND id IN (%s)" % (T["entities"], ph),
            [user_id, client_id, *entity_ids]).fetchall()}
        cols = conn.execute(
            "SELECT owner_id, name, kind, column_name, sql_type, target_entity, target_typelist "
            "FROM %s WHERE user_id=? AND client_id=? AND owner_id IN (%s)" % (T["columns"], ph),
            [user_id, client_id, *entity_ids]).fetchall()
        # physical table name for FK targets
        tname = {r["id"]: r["table_name"] for r in conn.execute(
            "SELECT id, table_name FROM %s WHERE user_id=? AND client_id=?" % T["entities"],
            (user_id, client_id)).fetchall()}
        # typecodes + physical table for the typelists referenced by these columns
        used_tls = sorted({r["target_typelist"] for r in cols if r["target_typelist"]})
        codes: Dict[str, List[str]] = {}
        tl_table: Dict[str, str] = {}
        if used_tls:
            tph = ",".join("?" for _ in used_tls)
            for r in conn.execute(
                    "SELECT typelist_id, code FROM %s WHERE user_id=? AND client_id=? "
                    "AND typelist_id IN (%s) AND IFNULL(is_retired,0)=0 ORDER BY typelist_id" % (T["typecodes"], tph),
                    [user_id, client_id, *used_tls]).fetchall():
                codes.setdefault(r["typelist_id"], []).append(r["code"])
            for r in conn.execute(
                    "SELECT id, table_name FROM %s WHERE user_id=? AND client_id=? "
                    "AND id IN (%s)" % (T["typelists"], tph), [user_id, client_id, *used_tls]).fetchall():
                if r["table_name"]:
                    tl_table[r["id"]] = r["table_name"]
    finally:
        conn.close()

    by_owner: Dict[str, List[Any]] = {}
    for r in cols:
        by_owner.setdefault(r["owner_id"], []).append(r)

    blocks = []
    for eid in entity_ids:
        e = ents.get(eid)
        if not e or not e["table_name"]:
            continue
        lines = ["TABLE " + e["table_name"] + "  (entity " + eid + ")" +
                 (" — " + e["description"] if e["description"] else "")]
        for c in by_owner.get(eid, []):
            if c["kind"] == "array" or not c["column_name"]:
                continue   # one-to-many: no column here
            desc = c["column_name"]
            if c["kind"] == "typekey" and c["target_typelist"]:
                tl = c["target_typelist"]
                phys = tl_table.get(tl)
                cv = codes.get(tl, [])
                shown = ", ".join(cv[:15]) + (" …" if len(cv) > 15 else "")
                desc += ("  (typekey; stores the code; typelist " + tl +
                         (" -> table " + phys if phys else "") + (": " + shown if shown else "") + ")")
            elif c["kind"] == "foreignkey" and c["target_entity"]:
                desc += "  (FK -> " + (tname.get(c["target_entity"]) or c["target_entity"]) + ")"
            else:
                desc += "  " + (c["sql_type"] or "")
            lines.append("  " + desc)
        blocks.append("\n".join(lines))

    # Typelist tables — so the model can JOIN to include a typekey column's display name.
    tl_lines = []
    for tl in used_tls:
        phys = tl_table.get(tl)
        if not phys:
            continue
        cv = codes.get(tl, [])
        shown = ", ".join(cv[:12]) + (" …" if len(cv) > 12 else "")
        tl_lines.append("  " + phys + "  (typelist " + tl + ") — columns: ID (the code; equals the "
                        "typekey column's value), NAME (display label), DESCRIPTION, PRIORITY, RETIRED" +
                        (";  codes: " + shown if shown else ""))
    if tl_lines:
        blocks.append("TYPELIST TABLES (LEFT JOIN one of these on <entity>.<TypekeyColumn> = <typelist_table>.ID "
                      "to include a typelist code's display NAME/DESCRIPTION):\n" + "\n".join(tl_lines))
    return "\n\n".join(blocks)
