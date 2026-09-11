"""Data Reconciliation — grounded natural-language → SQL, across multiple schema sources.

Turns a plain-English request into a single read-only SELECT, grounded strictly on the logged-in
client's chosen schema source:
  - "claimcenter": the ClaimCenter dictionary index (cc_dict_*, from entityModel.xml) + claimcenter_sql.md
  - "cmt": the Claim Migration Tool schema (cmt_schema doc)  + migration_sql.md
  - "pmt": the Policy Migration Tool schema (pmt_schema doc) + migration_sql.md
A small provider abstraction binds each source to its read API (has_index/list_tables/catalog/
search/schema_context), conventions doc, and source-specific prompt hints. The AI flow
(table-select → grounding → generate) is identical across sources.
"""
import os
import re
from typing import Any, Dict, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client
from app.services.ai_client_service import call_ai
from app.services import cc_dictionary_service as ccd
from app.services import pc_dictionary_service as pcd
from app.services import migration_schema_service as mig

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

_PROMPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")
_CC_PROMPT = os.path.join(_PROMPTS, "claimcenter_sql.md")
_PC_PROMPT = os.path.join(_PROMPTS, "policycenter_sql.md")
_MIG_PROMPT = os.path.join(_PROMPTS, "migration_sql.md")

_CC_FALLBACK = (
    "ClaimCenter SQL: entity tables are cc_<name>, typelists cctl_<name>. Every entity has an ID "
    "surrogate key; FKs are <Prop>ID joining to the target's ID. Retirable entities have RetiredValue "
    "(0=active) — add WHERE RetiredValue=0 unless retired rows are wanted. Typekey columns store the "
    "code text directly (WHERE State='open'). Default T-SQL. Return ONE read-only SELECT; no DML/DDL, "
    "no multiple statements, no comments. Use only the tables/columns/codes in the schema context."
)
_PC_FALLBACK = (
    "PolicyCenter SQL: entity tables are pc_<name>, typelists pctl_<name>. Every entity has an ID "
    "surrogate key; FKs are <Prop>ID joining to the target's ID. Retirable entities have a physical "
    "Retired column (0=active) — add WHERE Retired=0 unless retired rows are wanted (NOT RetiredValue). "
    "Typekey columns store the code text directly and are NOT consistently lowercase — use the exact "
    "code/case shown (WHERE Status='Bound'). Money is an amount column paired with a sibling <Field>_cur "
    "typekey (typelist Currency) — include _cur on money queries. Subtypes share the parent's table. "
    "Default T-SQL. Return ONE read-only SELECT; no DML/DDL, no multiple statements, no comments. "
    "Use only the tables/columns/codes in the schema context."
)
_MIG_FALLBACK = (
    "Migration-tool SQL (CMT/PMT): PKs vary per table (PMT_ID / PMT_ID1 / PMT_ID2 — use the one shown). "
    "Direct FKs (e.g. PMT_Parent) join child.fkcol = parent.PK. Polymorphic FKs: a value column plus a "
    "sibling <col>_Type naming the target table — resolve with UNION ALL of per-target LEFT JOINs guarded "
    "by <col>_Type='Target', or narrow to the requested type. Typekey columns are plain string filters "
    "(no join; codes not in schema). Default T-SQL. Return ONE read-only SELECT; use only the given tables."
)


def _provider(source: str) -> Dict[str, Any]:
    """Bind a schema source to its read API + conventions + prompt hints."""
    s = (source or "claimcenter").strip().lower()
    if s in ("cmt", "pmt"):
        dk = mig.DOC_KEY[s]
        label = "CMT (Claim Migration Tool)" if s == "cmt" else "PMT (Policy Migration Tool)"
        return {
            "kind": s, "label": label, "noun": s.upper() + " schema",
            "conv_path": _MIG_PROMPT, "conv_fallback": _MIG_FALLBACK,
            "empty_msg": "upload your " + s.upper() + " schema on the Product Schema page (choose " + s.upper() + ")",
            "select_example": "include any join tables (e.g. a PMT_Parent link) and, for a polymorphic "
                              "column, the specific target table(s) the request needs",
            "gen_extra": "Primary keys vary per table (PMT_ID / PMT_ID1 / PMT_ID2) — use the PK column shown "
                         "for each table. Resolve a polymorphic FK (a column marked 'polymorphic FK targets') "
                         "with a UNION ALL of one LEFT JOIN per target guarded by <col>_Type = 'Target', or "
                         "narrow to the requested target type. Typekey columns are plain string filters — no join.",
            "has_index": lambda u, c: mig.has_index(u, c, dk),
            "list_tables": lambda u, c, q="": mig.list_tables(u, c, dk, q),
            "catalog": lambda u, c: mig.catalog(u, c, dk),
            "search": lambda u, c, p: mig.search_entity_ids(u, c, dk, p),
            "context": lambda u, c, ids: mig.schema_context(u, c, dk, ids),
        }
    if s == "policycenter":
        return {
            "kind": "policycenter", "label": "PolicyCenter dictionary", "noun": "PolicyCenter dictionary",
            "conv_path": _PC_PROMPT, "conv_fallback": _PC_FALLBACK,
            "empty_msg": "upload your PolicyCenter dictionary .zip on Product Data Dictionary "
                         "(choose PolicyCenter; it contains entityModel.xml)",
            "select_example": "e.g. to get a named insured's NAME include Policy, PolicyPeriod, "
                              "PolicyContactRole, Contact",
            "gen_extra": "Retirable tables filter WHERE Retired = 0 (the physical column is Retired, "
                         "NOT RetiredValue). Typekey codes are stored as text and are NOT always "
                         "lowercase — use the exact code/case from the typelist code list. If the request "
                         "involves typelist codes / values / names, LEFT JOIN the relevant table(s) from the "
                         "SCHEMA's 'TYPELIST TABLES' section on <entity>.<TypekeyColumn> = <pctl_table>.ID and "
                         "also select <pctl_table>.NAME — one LEFT JOIN per typekey column involved. For money, "
                         "include the sibling <Field>_cur column (typelist Currency).",
            "has_index": lambda u, c: pcd.has_index(u, c),
            "list_tables": lambda u, c, q="": pcd.list_tables(u, c, q),
            "catalog": lambda u, c: pcd.catalog(u, c),
            "search": lambda u, c, p: pcd.search_entity_ids(u, c, p),
            "context": lambda u, c, ids: pcd.schema_context(u, c, ids),
        }
    return {
        "kind": "claimcenter", "label": "ClaimCenter dictionary", "noun": "ClaimCenter dictionary",
        "conv_path": _CC_PROMPT, "conv_fallback": _CC_FALLBACK,
        "empty_msg": "upload your dictionary .zip on Product Data Dictionary (it contains entityModel.xml)",
        "select_example": "e.g. to get an insured's NAME include Claim, ClaimContact, ClaimContactRole, Contact",
        "gen_extra": "If the request involves typelist codes / values / names, LEFT JOIN the relevant table(s) "
                     "from the SCHEMA's 'TYPELIST TABLES' section on <entity>.<TypekeyColumn> = <cctl_table>.ID "
                     "and also select <cctl_table>.NAME — one LEFT JOIN per typekey column involved.",
        "has_index": lambda u, c: ccd.has_index(u, c),
        "list_tables": lambda u, c, q="": ccd.list_tables(u, c, q),
        "catalog": lambda u, c: ccd.catalog(u, c),
        "search": lambda u, c, p: ccd.search_entity_ids(u, c, p),
        "context": lambda u, c, ids: ccd.schema_context(u, c, ids),
    }


def _read_conventions(prov: Dict[str, Any]) -> str:
    try:
        with open(prov["conv_path"], "r", encoding="utf-8") as fh:
            return fh.read().strip() or prov["conv_fallback"]
    except Exception:  # noqa: BLE001
        return prov["conv_fallback"]


def _conv_source(prov: Dict[str, Any]) -> str:
    return os.path.basename(prov["conv_path"]) if os.path.exists(prov["conv_path"]) else "built-in defaults"


def _format_sql(sql: str) -> str:
    """Pretty-print with sqlparse when available; unchanged otherwise."""
    s = (sql or "").strip()
    if not s:
        return s
    try:
        import sqlparse
        return sqlparse.format(s, reindent=True, keyword_case="upper",
                               use_space_around_operators=True).strip() or s
    except Exception:  # noqa: BLE001
        return s


def _analysis_lines(analysis: str) -> list:
    """Turn the AI's ANALYSIS block into SQL comment lines: an '-- Analysis:' heading followed by one
    '--   - <point>' per non-empty line (existing bullet markers normalized). [] when there's none."""
    raw = (analysis or "").strip()
    if not raw:
        return []
    out = ["--", "-- Analysis (why this query was generated):"]
    for ln in raw.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        ln = re.sub(r"^[-*•\d.\)\s]+", "", ln).strip()  # drop leading bullet/number markers
        if ln:
            out.append("--   - " + ln)
    return out if len(out) > 2 else []


def _strip_sql_fences(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _select_tables(user_id: int, client_id: int, prov: Dict[str, Any], prompt: str) -> list:
    """AI-choose the tables a request needs (join/link/lookup tables included). Returns validated
    ids from the source's catalog, or [] to fall back to keyword search."""
    cat = prov["catalog"](user_id, client_id)
    if not cat:
        return []
    by_id = {c["id"].lower(): c["id"] for c in cat}
    by_tbl = {c["table"].lower(): c["id"] for c in cat if c["table"]}
    lines = [c["id"] + " | " + c["table"] + ((" — " + c["description"][:70]) if c["description"] else "")
             for c in cat]
    system = (
        "You are a Guidewire " + prov["label"] + " data-model expert. From the CATALOG below, choose the "
        "tables needed to answer the request — INCLUDING every join / link / lookup table required to reach "
        "the data (" + prov["select_example"] + "). Prefer the smallest set that fully answers it.\n"
        "Return ONLY a comma-separated list of ids copied verbatim from the CATALOG (max 15). No prose.\n\n"
        "CATALOG (id | table — description):\n" + "\n".join(lines)
    )
    user = "Request: " + prompt
    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=400, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Data Reconciliation - Table Select", run,
                       [{"output_config": {"effort": "low"}}, {}])
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        picked, seen = [], set()
        for tok in re.split(r"[,\n]", text):
            key = tok.strip().lower()
            eid = by_id.get(key) or by_tbl.get(key)
            if eid and eid not in seen:
                seen.add(eid)
                picked.append(eid)
        return picked[:15]
    except Exception as exc:  # noqa: BLE001
        print("[cc_sql] table-select failed, falling back to keyword: " + repr(exc))
        return []


def context_status(user_id: int, client_id: int, source: str = "claimcenter") -> Result:
    """Page banner: {ok, source, label, indexed, counts}."""
    prov = _provider(source)
    counts = prov["has_index"](user_id, client_id)
    return {"ok": True, "source": prov["kind"], "label": prov["label"],
            "indexed": bool(counts), "counts": counts or {}}, 200


def list_sources(user_id: int, client_id: int) -> Result:
    """Which schema sources this client actually has, for the SQL Assistant source picker.
    Reports all sources with an `indexed` flag; the frontend shows the pair matching the
    client's Product (Claim -> ClaimCenter + CMT, Policy -> PolicyCenter + PMT)."""
    out = []
    for src in ("claimcenter", "policycenter", "cmt", "pmt"):
        prov = _provider(src)
        counts = prov["has_index"](user_id, client_id)
        out.append({"source": prov["kind"], "label": prov["label"],
                    "indexed": bool(counts), "counts": counts or {}})
    return {"ok": True, "sources": out}, 200


def list_tables(user_id: int, client_id: int, source: str = "claimcenter", q: str = "") -> Result:
    prov = _provider(source)
    return {"ok": True, "source": prov["kind"], "tables": prov["list_tables"](user_id, client_id, q or "")}, 200


def generate_sql(user_id: int, client_id: int, body: Dict[str, Any]) -> Result:
    """Body: {prompt, source?, tableIds?[], history?[]}. Returns {ok, sql, grounded[], conventions, source}."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    prov = _provider(body.get("source"))
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "Describe what you want to query."}, 400
    if not prov["has_index"](user_id, client_id):
        return {"ok": False, "error": "No " + prov["label"] + " loaded for this client yet — "
                + prov["empty_msg"] + " first."}, 400

    # Conversation memory: prior complete turns so follow-ups build on the earlier answer.
    history = [h for h in (body.get("history") or [])
               if isinstance(h, dict) and (h.get("prompt") or "").strip() and (h.get("sql") or "").strip()][-6:]

    # Which tables to ground on: user-picked; else AI table-select; else keyword. Uses the
    # conversation so a follow-up keeps earlier tables in scope.
    sel_text = "\n".join([h.get("prompt", "") for h in history] + [prompt]).strip()
    entity_ids = [e for e in (body.get("tableIds") or []) if e]
    if not entity_ids:
        entity_ids = _select_tables(user_id, client_id, prov, sel_text)
    if not entity_ids:
        entity_ids = prov["search"](user_id, client_id, sel_text)
    if not entity_ids:
        return {"ok": False, "error": "Couldn't match any tables to your request — pick one or more "
                "tables from the list and try again."}, 400

    ctx = prov["context"](user_id, client_id, entity_ids)
    if not ctx:
        return {"ok": False, "error": "The selected tables have no columns in the schema."}, 400

    tbl_by_id = {t["id"]: t["table"] for t in prov["list_tables"](user_id, client_id)}
    grounded = [tbl_by_id[e] for e in entity_ids if tbl_by_id.get(e)]

    system = (
        _read_conventions(prov) + "\n\n"
        "Respond in EXACTLY this format and nothing else (no markdown fences, no extra prose):\n"
        "PURPOSE: <one sentence: why this query answers the request>\n"
        "ANALYSIS:\n"
        "<Explain your full reasoning as several concise lines (one point per line, start each with '- '). "
        "Cover everything you analysed: how you interpreted the request; which tables/entities you chose and "
        "why (including any join / link / lookup tables and the join path between them); every JOIN and the "
        "column it joins on; any typelist / currency / display-name joins you added and why; every WHERE "
        "filter and why (e.g. Retired = 0 to exclude retired rows); any assumptions or ambiguities and how you "
        "resolved them; and which schema conventions you applied. Do not mention this format or the word "
        "'schema context'.>\n"
        "SQL:\n"
        "<a single read-only SELECT statement>\n\n"
        "The SQL uses ONLY the tables/columns in the SCHEMA below, spelled verbatim — never invent a table, "
        "column, or code value; no trailing semicolon; no inline comments.\n"
        "For \"all columns\" of a table you MAY use <alias>.* rather than listing every column.\n"
        + prov["gen_extra"] + "\n\n"
        "SCHEMA (the only tables/columns you may use):\n" + ctx
    )
    user = "Request: " + prompt

    messages = []
    for h in history:
        messages.append({"role": "user", "content": "Request: " + h["prompt"].strip()})
        messages.append({"role": "assistant", "content": h["sql"].strip()})
    messages.append({"role": "user", "content": user})

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=8000, system=system, messages=messages)

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Data Reconciliation - SQL", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        interpretation, analysis, raw_sql = "", "", text
        # SQL is everything after the LAST 'SQL:' marker; PURPOSE / ANALYSIS come before it.
        sqm = None
        for sqm in re.finditer(r"\bsql\s*:\s*", text, re.IGNORECASE):
            pass
        if sqm:
            pre, raw_sql = text[:sqm.start()], text[sqm.end():]
            pm = re.search(r"(?is)\bpurpose\s*:\s*(.*?)(?:\r?\n\s*analysis\s*:|\Z)", pre)
            if pm:
                interpretation = " ".join(pm.group(1).split())
            am = re.search(r"(?is)\banalysis\s*:\s*(.*)\Z", pre)
            if am:
                analysis = am.group(1).strip()
        sql = _format_sql(_strip_sql_fences(raw_sql))
        if not sql:
            return {"ok": False, "error": "The AI returned no SQL for this request."}, 400

        header = ["-- Data Reconciliation — AI-generated query"]
        header.append("-- Conventions Skill: " + _conv_source(prov))
        # Full reasoning — every point the AI analysed, one per comment line.
        for line in _analysis_lines(analysis):
            header.append(line)
        divider = "-- " + ("-" * 74)          # separates the commentary from the SQL
        sql_out = "\n".join(header) + "\n" + divider + "\n" + sql

        return {"ok": True, "model": model, "sql": sql_out, "interpretation": interpretation,
                "analysis": analysis, "grounded": grounded, "conventions": _conv_source(prov),
                "source": prov["kind"]}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400
