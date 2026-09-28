"""Data Reconciliation — grounded natural-language → SQL, across multiple schema sources.

Turns a plain-English request into a single read-only SELECT, grounded strictly on the logged-in
client's chosen schema source:
  - "claimcenter": the ClaimCenter dictionary index (cc_dict_*, from entityModel.xml) + claimcenter_sql.md
  - "policycenter": the PolicyCenter dictionary index (pc_dict_*, from entityModel.xml) + policycenter_sql.md
  - "billingcenter": the BillingCenter dictionary index (bc_dict_*, from entityModel.xml) + billingcenter_sql.md
  - "cmt": the Claim Migration Tool schema (cmt_schema doc)  + migration_sql.md
  - "pmt": the Policy Migration Tool schema (pmt_schema doc) + migration_sql.md
  - "bmt": the Billing Migration Tool schema (bmt_schema doc) + migration_sql.md
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
from app.services import bc_dictionary_service as bcd
from app.services import migration_schema_service as mig

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

_PROMPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")
_CC_PROMPT = os.path.join(_PROMPTS, "claimcenter_sql.md")
_PC_PROMPT = os.path.join(_PROMPTS, "policycenter_sql.md")
_BC_PROMPT = os.path.join(_PROMPTS, "billingcenter_sql.md")
_MIG_PROMPT = os.path.join(_PROMPTS, "migration_sql.md")
_COMPARE_PROMPT = os.path.join(_PROMPTS, "reconcile_compare_sql.md")

# Fallback conventions for the IN-vs-OUT comparison stored proc (if the .md is missing).
_COMPARE_FALLBACK = (
    "Generate ONE Microsoft SQL Server (T-SQL) statement: CREATE OR ALTER PROCEDURE dbo.usp_ReconcileInVsOut "
    "with parameters @InDbName sysname, @OutDbName sysname, @SchemaName sysname = 'dbo'. Both databases "
    "share the SAME schema on the SAME instance; only the database names differ and are supplied at run "
    "time. The procedure returns ONE result set with exactly five columns in this order: [Table Name], "
    "[Column name], [Primary Key], InValue, OutValue — one row for every (table, PK-matched row, column) "
    "where the IN value differs from the OUT value; no row counts, no missing-key lists. [Primary Key] is "
    "the IN-side key value: CONVERT(NVARCHAR(MAX), i.<pk>) for a single key, or CONCAT(i.<pk1>, N'|', "
    "i.<pk2>) for a composite key. Make it METADATA-DRIVEN so it "
    "scales to many tables: declare a table variable @tables(TableName sysname, PkCols nvarchar, IgnoreCols "
    "nvarchar) and INSERT EVERY table from the TABLES list with its PK column(s) and FK columns to ignore; "
    "loop with a cursor; for each table, discover the non-key columns COMMON to both databases from "
    "<db>.INFORMATION_SCHEMA.COLUMNS (excluding the PK cols AND the IgnoreCols) at run time, and for each "
    "such column build a UNION ALL branch SELECT N'<t>' AS [Table Name], N'<col>' AS [Column name], "
    "<in-pk-value> AS [Primary Key], CONVERT(NVARCHAR(MAX), i.<col>) AS InValue, CONVERT(NVARCHAR(MAX), "
    "o.<col>) AS OutValue FROM <In 3-part> i JOIN <Out 3-part> o ON <pk join> WHERE EXISTS(SELECT i.<col> "
    "EXCEPT SELECT o.<col>); INSERT results into a #diffs temp table (columns [Table Name], [Column name], "
    "[Primary Key], InValue, OutValue) and finally SELECT * FROM #diffs ORDER BY [Table Name], [Column "
    "name], [Primary Key]. Match rows on the PK, but the OUT database prefixes each key value with '<digits>_' — normalize "
    "the OUT key by stripping a leading run of digits + underscore before joining: "
    "CASE WHEN o.[K] LIKE '[0-9]%[_]%' AND SUBSTRING(o.[K],1,CHARINDEX('_',o.[K])-1) NOT LIKE '%[^0-9]%' "
    "THEN STUFF(o.[K],1,CHARINDEX('_',o.[K]),'') ELSE o.[K] END. A database name CANNOT be used statically, so build each statement as "
    "NVARCHAR(MAX) and run via sys.sp_executesql; compose 3-part names with QUOTENAME(@InDbName)+N'.'+"
    "QUOTENAME(@SchemaName)+N'.'+QUOTENAME(@t). Default to SQL Server bracket format and WRAP EVERY "
    "IDENTIFIER in QUOTENAME(...) — databases, schema, tables AND every column (including the discovered "
    "column variable). The procedure MUST be syntactically valid (balanced BEGIN/END, parentheses, quotes). "
    "Read-only against the compared data (only #diffs is written); the only DDL is the outer CREATE OR ALTER "
    "PROCEDURE and #diffs. No GO, no USE, no markdown fences, no statements outside the proc."
)

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
_BC_FALLBACK = (
    "BillingCenter SQL: entity tables are bc_<name>, typelists bctl_<name>. Every entity has an ID "
    "surrogate key; FKs are <Prop>ID joining to the target's ID. Retirable entities have a physical "
    "Retired column (0=active) — add WHERE Retired=0 unless retired rows are wanted (NOT RetiredValue). "
    "Typekey columns store the code text directly and are exact-case — use the code shown (WHERE "
    "Subtype='ChargePaidFromAccount'). BC is a double-entry ledger: bc_transaction carries the dollar "
    "Amount directly (paired with Amount_cur, typelist Currency) — no line-item join needed for a "
    "transaction total; join bc_lineitem/bc_taccount only for true ledger detail. Subtypes share the "
    "parent's table, distinguished by Subtype. Money is an amount column paired with a sibling "
    "<Field>_cur typekey — include _cur on money queries. Default T-SQL. Return ONE read-only SELECT; "
    "no DML/DDL, no multiple statements, no comments. Use only the tables/columns/codes in the schema context."
)
_MIG_FALLBACK = (
    "Migration-tool SQL (CMT/PMT/BMT): PKs vary per table (PMT_ID / PMT_ID1 / PMT_ID2 — use the one shown). "
    "Direct FKs (e.g. PMT_Parent) join child.fkcol = parent.PK. Polymorphic FKs: a value column plus a "
    "sibling <col>_Type naming the target table — resolve with UNION ALL of per-target LEFT JOINs guarded "
    "by <col>_Type='Target', or narrow to the requested type. Typekey columns are plain string filters "
    "(no join; codes not in schema). Default T-SQL. Return ONE read-only SELECT; use only the given tables."
)


def _provider(source: str) -> Dict[str, Any]:
    """Bind a schema source to its read API + conventions + prompt hints."""
    s = (source or "claimcenter").strip().lower()
    if s in ("cmt", "pmt", "bmt"):
        dk = mig.DOC_KEY[s]
        label = {"cmt": "CMT (Claim Migration Tool)", "pmt": "PMT (Policy Migration Tool)",
                 "bmt": "BMT (Billing Migration Tool)"}[s]
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
    if s == "billingcenter":
        return {
            "kind": "billingcenter", "label": "BillingCenter dictionary", "noun": "BillingCenter dictionary",
            "conv_path": _BC_PROMPT, "conv_fallback": _BC_FALLBACK,
            "empty_msg": "upload your BillingCenter dictionary .zip on Product Data Dictionary "
                         "(choose BillingCenter; it contains entityModel.xml)",
            "select_example": "e.g. to sum what was billed on a policy include Transaction, and add "
                              "LineItem/InvoiceItem only if you need ledger- or installment-level detail",
            "gen_extra": "Retirable tables filter WHERE Retired = 0 (the physical column is Retired, "
                         "NOT RetiredValue). Typekey codes are stored as exact-case text — use the exact "
                         "code from the typelist code list (e.g. Transaction.Subtype = 'ChargePaidFromAccount'). "
                         "bc_transaction carries the dollar Amount directly (with sibling Amount_cur) — do NOT "
                         "join a line-item table just to total a transaction. If the request involves typelist "
                         "codes / values / names, LEFT JOIN the relevant table(s) from the SCHEMA's 'TYPELIST "
                         "TABLES' section on <entity>.<TypekeyColumn> = <bctl_table>.ID and also select "
                         "<bctl_table>.NAME — one LEFT JOIN per typekey column involved. For money, include the "
                         "sibling <Field>_cur column (typelist Currency).",
            "has_index": lambda u, c: bcd.has_index(u, c),
            "list_tables": lambda u, c, q="": bcd.list_tables(u, c, q),
            "catalog": lambda u, c: bcd.catalog(u, c),
            "search": lambda u, c, p: bcd.search_entity_ids(u, c, p),
            "context": lambda u, c, ids: bcd.schema_context(u, c, ids),
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
    client's Product (Claim -> ClaimCenter + CMT, Policy -> PolicyCenter + PMT,
    Billing -> BillingCenter + BMT)."""
    out = []
    for src in ("claimcenter", "policycenter", "billingcenter", "cmt", "pmt", "bmt"):
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


# --------------------------------------------------------------------- IN vs OUT comparison


def _read_compare_conventions() -> str:
    try:
        with open(_COMPARE_PROMPT, "r", encoding="utf-8") as fh:
            return fh.read().strip() or _COMPARE_FALLBACK
    except Exception:  # noqa: BLE001
        return _COMPARE_FALLBACK


def _compare_conv_source() -> str:
    return os.path.basename(_COMPARE_PROMPT) if os.path.exists(_COMPARE_PROMPT) else "built-in defaults"


def _structural_sql_issues(sql: str) -> list:
    """Cheap, deterministic syntax smells for a T-SQL stored proc (no DB needed): unbalanced
    parentheses / BEGIN..END, and not exactly one CREATE ... PROCEDURE. Ignores content inside
    string literals. Returns a list of human-readable issue strings ([] when clean)."""
    s = sql or ""
    # strip single-quoted string literals ('' is an escaped quote) so their contents don't count
    stripped = re.sub(r"'(?:[^']|'')*'", "''", s)
    low = stripped.lower()
    issues = []
    if stripped.count("(") != stripped.count(")"):
        issues.append("unbalanced parentheses")
    begins = len(re.findall(r"\bbegin\b", low))
    ends = len(re.findall(r"\bend\b", low))
    cases = len(re.findall(r"\bcase\b", low))   # each CASE…END has an END but no BEGIN
    if ends - cases != begins:
        issues.append("unbalanced BEGIN/END (%d BEGIN vs %d END, %d CASE)" % (begins, ends, cases))
    if len(re.findall(r"\bcreate\s+(?:or\s+alter\s+)?proc(?:edure)?\b", low)) != 1:
        issues.append("expected exactly one CREATE [OR ALTER] PROCEDURE")
    if s.count("'") % 2 != 0:
        issues.append("odd number of single quotes")
    return issues


def list_compare_columns(user_id: int, client_id: int, source: str, table: str) -> Result:
    """The comparable (non-PK) columns of one migration table, for the IN-vs-OUT column picker.
    Returns {ok, table, columns:[{name, fk}]}; FK columns are flagged so the UI can default them off."""
    src = (source or "").strip().lower()
    if src not in ("cmt", "pmt", "bmt"):
        return {"ok": False, "error": "Column selection applies to a migration-tool schema only."}, 400
    cols = mig.columns_of(user_id, client_id, mig.DOC_KEY[src], table or "")
    # Include PK columns too (flagged), so the key (e.g. PMT_ID) is visible/selectable in the picker.
    out = [{"name": c["name"], "fk": bool(c["fk"]), "pk": bool(c["pk"])} for c in cols]
    return {"ok": True, "table": table, "columns": out}, 200


def _sanitize_compare_sql(sql: str) -> str:
    """Repair a known model hallucination: a made-up placeholder data type (e.g. dbo.NULL_PLACEHOLDER)
    used where a real type is expected. Every value in this proc is NVARCHAR(MAX), so any such token is
    replaced with that concrete type — fixing 'Cannot find data type dbo.NULL_PLACEHOLDER' errors."""
    return re.sub(r"(?i)(?:\[?dbo\]?\.)?\[?NULL_PLACEHOLDER\]?", "NVARCHAR(MAX)", sql or "")


def _revalidate_compare_sql(client, model: str, sql: str):
    """Second AI pass: review the generated procedure for T-SQL SYNTAX errors ONLY and return a
    corrected version (unchanged if already valid). Preserves the logic, parameters, the injected table
    list, and QUOTENAME quoting. Returns (sql, changed:bool); on any failure returns the original."""
    system = (
        "You are a Microsoft SQL Server (T-SQL) expert. You are given a metadata-driven stored procedure "
        "that compares a migration tool's IN and OUT databases (it loops over a @tables list and discovers "
        "each table's columns from the catalog at run time). Review it for SYNTAX errors ONLY and return a "
        "corrected version so it compiles cleanly on SQL Server. Check: balanced BEGIN/END, parentheses and "
        "quotes; valid cursor open/fetch/close/deallocate; valid sys.sp_executesql usage (parameter-"
        "definition string + arguments); NVARCHAR(MAX) dynamic-SQL holders; a single well-formed CREATE OR "
        "ALTER PROCEDURE. Ensure EVERY identifier used in the dynamic SQL — databases, schema, tables and "
        "every column (including catalog-discovered column variables via QUOTENAME(@col)) — is wrapped in "
        "QUOTENAME(...) so reserved keywords and names with spaces are safe. Replace any invalid or "
        "user-defined data type (e.g. dbo.NULL_PLACEHOLDER or any made-up placeholder) with the correct "
        "concrete built-in type — every compared value is NVARCHAR(MAX). Do NOT change the logic, the "
        "parameters (@InDbName / @OutDbName / @SchemaName), the set of tables in the @tables INSERT, or the "
        "five-column result set ([Table Name], [Column name], [Primary Key], InValue, OutValue). "
        "Also FORMAT it cleanly and consistently: uppercase T-SQL keywords, 4-space indentation nested by "
        "BEGIN/END and control blocks, one statement per line. Do NOT add commentary. Return ONLY the "
        "T-SQL — no markdown fences, no prose. If it is already valid and well-formatted, return it unchanged."
    )
    try:
        base_kwargs = dict(model=model, max_tokens=16000, system=system,
                           messages=[{"role": "user", "content": sql}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Data Reconciliation - Compare SQL Validate", run, [{"output_config": {"effort": "low"}}, {}])
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        fixed = _strip_sql_fences(text).strip()
        # Only accept a plausible replacement (still a single CREATE ... PROCEDURE).
        if fixed and re.search(r"\bcreate\s+(?:or\s+alter\s+)?proc(?:edure)?\b", fixed, re.IGNORECASE):
            return fixed, (fixed.strip() != (sql or "").strip())
    except Exception as exc:  # noqa: BLE001
        print("[cc_sql] compare re-validation skipped: " + repr(exc))
    return sql, False


def generate_compare_sql(user_id: int, client_id: int, body: Dict[str, Any]) -> Result:
    """IN-vs-OUT value comparison. Body: {source(cmt|pmt|bmt), prompt?, tableIds?[], history?[]}.
    Both databases share the migration schema (grounded on the source's schema_context); the AI emits a
    single CREATE OR ALTER PROCEDURE that takes the IN/OUT database names as parameters and, via dynamic
    SQL, returns one result set [Table Name, Column name, Primary Key, InValue, OutValue] of the values that
    changed. Returns {ok, sql, grounded[], conventions, source, ...}."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    src = (body.get("source") or "").strip().lower()
    if src not in ("cmt", "pmt", "bmt"):
        return {"ok": False, "error": "IN vs OUT comparison applies to a migration-tool schema "
                "(CMT / PMT / BMT) only."}, 400
    prov = _provider(src)
    if not prov["has_index"](user_id, client_id):
        return {"ok": False, "error": "No " + prov["label"] + " loaded for this client yet — "
                + prov["empty_msg"] + " first."}, 400

    prompt = (body.get("prompt") or "").strip()

    # Conversation memory: prior complete turns so follow-ups refine the earlier proc.
    history = [h for h in (body.get("history") or [])
               if isinstance(h, dict) and (h.get("prompt") or "").strip() and (h.get("sql") or "").strip()][-6:]

    # Which tables to compare: user-picked (the UI selects all by default); else AI table-select; else keyword.
    sel_text = "\n".join([h.get("prompt", "") for h in history] + [prompt]).strip()
    entity_ids = [e for e in (body.get("tableIds") or []) if e]
    if not entity_ids and sel_text:
        entity_ids = _select_tables(user_id, client_id, prov, sel_text)
    if not entity_ids and sel_text:
        entity_ids = prov["search"](user_id, client_id, sel_text)
    if not entity_ids:
        return {"ok": False, "error": "Select one or more tables to compare, then try again."}, 400

    # The proc is metadata-driven: it enumerates each table's columns from the DB catalog at run time, so
    # we only need each table's name + PK column(s) + FK columns to ignore here — no 20-table
    # schema_context cap. This lets ALL selected tables (hundreds if need be) be compared compactly.
    dk = mig.DOC_KEY[src]
    keymap = mig.key_map(user_id, client_id, dk, entity_ids)      # {table: [pk_cols]}
    fkmap = mig.fk_map(user_id, client_id, dk, entity_ids)        # {table: [fk_cols]} (ignored in the diff)
    tbl_by_id = {t["id"]: t["table"] for t in prov["list_tables"](user_id, client_id)}
    # Only tables with a detectable PK can be row-matched.
    ordered = [tbl_by_id[e] for e in entity_ids if tbl_by_id.get(e) and keymap.get(tbl_by_id[e])]
    if not ordered:
        return {"ok": False, "error": "None of the selected tables have a primary key to match rows on."}, 400
    grounded = ordered[:]
    # Optional per-table column scope: {table: [cols]} — when given for a table, compare ONLY those columns
    # (instead of every non-key/non-FK column). Empty/absent = compare all comparable columns (default).
    col_scope = body.get("columns") or {}
    if not isinstance(col_scope, dict):
        col_scope = {}

    def _only_block(t):
        cols = [c for c in (col_scope.get(t) or []) if isinstance(c, str) and c.strip()]
        return (", ".join(cols) if cols else "(all comparable columns)")

    tables_block = "\n".join(
        t + " | PK: " + ", ".join(keymap[t]) +
        " | IgnoreFK: " + (", ".join(fkmap.get(t) or []) if fkmap.get(t) else "(none)") +
        " | OnlyCompare: " + _only_block(t)
        for t in ordered)

    request_line = ("Generate the IN-vs-OUT value-difference stored procedure for ALL " + str(len(ordered)) +
                    " tables in the TABLES list — do not omit any." +
                    ((" Additional instructions: " + prompt) if prompt else ""))

    system = (
        _read_compare_conventions() + "\n\n"
        "Respond in EXACTLY this format and nothing else (no markdown fences, no extra prose):\n"
        "PURPOSE: <one sentence: what this reconciliation procedure checks>\n"
        "ANALYSIS:\n"
        "<Explain your reasoning as several concise lines (one point per line, start each with '- '). "
        "Cover: that you included EVERY table from the TABLES list in the @tables INSERT with its PK and "
        "IgnoreFK columns; how rows are matched on the PK after stripping the OUT database's '<digits>_' "
        "prefix; how non-key columns (excluding the PK and IgnoreFK columns) are discovered from the "
        "catalog at run time and diffed NULL-safe; how the five output columns ([Table Name], "
        "[Column name], [Primary Key] = the IN-side key value, InValue, OutValue) are produced (including "
        "the composite-key CONCAT); and how you built the 3-part names from the @InDbName / @OutDbName / "
        "@SchemaName parameters with QUOTENAME and sp_executesql. Do not mention this format.>\n"
        "SQL:\n"
        "<a single CREATE OR ALTER PROCEDURE statement>\n\n"
        "Populate the @tables table variable with EVERY row in the TABLES list below — TableName, its PK "
        "column(s), the FK columns to ignore, and its OnlyCompare list — verbatim; never invent, drop, or "
        "abbreviate a table. Match rows on the PK, stripping the OUT database's leading '<digits>_' prefix "
        "as described above.\n"
        "COLUMN SCOPE: if a table's OnlyCompare is a specific column list, compare ONLY those columns "
        "(still exclude the PK; intersect with the columns actually present in both databases). If it is "
        "'(all comparable columns)', compare every non-key column except the PK and the IgnoreFK columns "
        "(the default). Carry each table's OnlyCompare into @tables (e.g. an OnlyCols column, empty string "
        "meaning 'all') and honor it in the run-time column discovery.\n"
        "Use ONLY concrete built-in T-SQL data types — sysname, NVARCHAR(MAX), NVARCHAR(4000), INT. Every "
        "compared value is CONVERT(NVARCHAR(MAX), ...). NEVER invent, reference, or declare a user-defined "
        "type, and NEVER use a placeholder token such as NULL_PLACEHOLDER where a data type is expected.\n\n"
        "TABLES (format: TableName | PK: col[, col2] | IgnoreFK: col[, col2] | OnlyCompare: col[, col2] or "
        "'(all comparable columns)'):\n" + tables_block
    )

    messages = []
    for h in history:
        messages.append({"role": "user", "content": "Request: " + h["prompt"].strip()})
        messages.append({"role": "assistant", "content": h["sql"].strip()})
    messages.append({"role": "user", "content": request_line})

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=16000, system=system, messages=messages)

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Data Reconciliation - Compare SQL", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        interpretation, analysis, raw_sql = "", "", text
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
        # Don't sqlparse-reindent a stored proc (it garbles BEGIN/END + dynamic SQL) — just de-fence/trim.
        sql = _strip_sql_fences(raw_sql).strip()
        if not sql:
            return {"ok": False, "error": "The AI returned no SQL for this request."}, 400

        # Re-validate: a focused second pass fixes any T-SQL syntax error / missing QUOTENAME. Then a
        # cheap deterministic structural check reports any residual smell in the response.
        sql, revalidated = _revalidate_compare_sql(client, model, sql)
        sanitized = _sanitize_compare_sql(sql)          # repair hallucinated placeholder data types
        if sanitized != sql:
            sql, revalidated = sanitized, True
        issues = _structural_sql_issues(sql)

        header = ["-- IN vs OUT Comparison — AI-generated stored procedure",
                  "-- Output: one result set [Table Name, Column name, Primary Key, InValue, OutValue] of changed values",
                  "-- Conventions Skill: " + _compare_conv_source(),
                  "-- Validation: re-checked for T-SQL syntax" +
                  (" (auto-corrected)" if revalidated else "") +
                  ("; residual warnings: " + "; ".join(issues) if issues else "; no issues found")]
        for line in _analysis_lines(analysis):
            header.append(line)
        divider = "-- " + ("-" * 74)
        sql_out = "\n".join(header) + "\n" + divider + "\n" + sql

        return {"ok": True, "model": model, "sql": sql_out, "interpretation": interpretation,
                "analysis": analysis, "grounded": grounded, "conventions": _compare_conv_source(),
                "source": prov["kind"], "revalidated": revalidated, "issues": issues}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400


# --- Non-Financial Reconciliation (deterministic; no AI) --------------------------------------- #

_NONFIN_IDENT_RE = re.compile(r"[^A-Za-z0-9_]")


def _safe_ident(name: str, fallback: str = "") -> str:
    """Turn a user-supplied recon name into a safe SQL identifier (letters/digits/underscore)."""
    s = _NONFIN_IDENT_RE.sub("_", (name or "").strip())
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        return fallback
    if s[0].isdigit():
        s = "_" + s
    return s[:100]


def _tsql_type(data_type, length) -> str:
    """Map a migration-schema column type to a concrete T-SQL type for the recon staging tables.
    Unknown / missing types fall back to NVARCHAR(255) (recon compares values as text anyway)."""
    dt = (data_type or "").strip().lower()
    if not dt:
        return "NVARCHAR(255)"
    base = dt.split("(")[0].strip()
    simple = {
        "int8": "BIGINT", "bigint": "BIGINT", "long": "BIGINT",
        "int": "INT", "int4": "INT", "integer": "INT", "smallint": "SMALLINT", "int2": "SMALLINT",
        "tinyint": "TINYINT", "bit": "BIT", "boolean": "BIT", "bool": "BIT",
        "datetime": "DATETIME2", "datetime2": "DATETIME2", "smalldatetime": "SMALLDATETIME",
        "date": "DATE", "time": "TIME", "timestamp": "DATETIME2",
        "decimal": "DECIMAL(38,6)", "numeric": "DECIMAL(38,6)", "money": "MONEY", "smallmoney": "SMALLMONEY",
        "float": "FLOAT", "float8": "FLOAT", "double": "FLOAT", "real": "REAL",
        "uniqueidentifier": "UNIQUEIDENTIFIER", "guid": "UNIQUEIDENTIFIER",
        "text": "NVARCHAR(MAX)", "ntext": "NVARCHAR(MAX)", "clob": "NVARCHAR(MAX)", "xml": "NVARCHAR(MAX)",
    }
    if base in simple:
        return simple[base]
    if base in ("varchar", "nvarchar", "char", "nchar"):
        n = None
        m = re.search(r"\(\s*(\d+|max)\s*\)", dt)
        if m:
            n = m.group(1).upper()
        elif length not in (None, "", 0):
            try:
                n = str(int(length))
            except (TypeError, ValueError):
                n = None
        n = n or "255"
        kind = "NCHAR" if base in ("char", "nchar") else "NVARCHAR"
        return kind + "(" + n + ")"
    return "NVARCHAR(255)"


def _nf_fq(t):
    return "[dbo].[" + t + "]"


def _nf_report_ddl(rep, key_cols, left_label, right_label, type_by_col):
    """DROP+CREATE the derived report table (Recon_RunDate, key(s), AttributeName, <L>Value, <R>Value, Status)."""
    lines = ["    [Recon_RunDate] DATETIME2"]
    lines += ["    [" + k + "] " + type_by_col.get(k.lower(), "NVARCHAR(255)") for k in key_cols]
    lines += ["    [AttributeName] NVARCHAR(255)",
              "    [" + left_label + "Value] NVARCHAR(MAX)",
              "    [" + right_label + "Value] NVARCHAR(MAX)",
              "    [Status] NVARCHAR(30)"]
    return ("IF OBJECT_ID(N'" + _nf_fq(rep) + "', N'U') IS NOT NULL DROP TABLE " + _nf_fq(rep) + ";\n"
            "CREATE TABLE " + _nf_fq(rep) + " (\n" + ",\n".join(lines) + "\n);")


def _nf_agg_projection(cols, key_cols, ref):
    """Per-key aggregated projection for an extract that stores ONE row per key: keys are grouped as-is,
    'count' columns become COUNT(col), 'value' columns become MAX(col) (a representative per key).
    `ref(c)` returns the source SQL expression for a column (e.g. 't0.[Name]' or 'src.[Out]').
    Returns (select_list_items, group_by_items)."""
    key_low = {k.lower() for k in key_cols}
    sel, grp = [], []
    for c in cols:
        r = ref(c)
        if c["name"].lower() in key_low or (c.get("out") or "").lower() in key_low:
            sel.append(r + " AS [" + c["out"] + "]"); grp.append(r)
        elif c.get("mode") == "count":
            sel.append("COUNT(" + r + ") AS [" + c["out"] + "]")
        else:
            sel.append("MAX(" + r + ") AS [" + c["out"] + "]")
    return sel, grp


def _nf_compare_proc(proc, rep, left_tbl, right_tbl, left_label, right_label, key_cols, cols):
    """Compare left_tbl vs right_tbl into the report, one INSERT per non-key column, value-by-value on
    the key. The staging tables already hold ONE row per key (count columns were aggregated to COUNT/key
    at extract time), so this is a straight per-key comparison. Row-missing is detected via the key, so a
    NULL value is not mistaken for a missing row. Returns every row with a Status."""
    lval, rval = left_label + "Value", right_label + "Value"
    k0 = key_cols[0]
    key_join = " AND ".join("l.[" + k + "] = r.[" + k + "]" for k in key_cols)
    rep_key_cols = ", ".join("[" + k + "]" for k in key_cols)
    coalesce_keys = ", ".join("COALESCE(l.[" + k + "], r.[" + k + "])" for k in key_cols)
    lfq, rfq, repfq, procfq = _nf_fq(left_tbl), _nf_fq(right_tbl), _nf_fq(rep), _nf_fq(proc)
    key_set = {k.lower() for k in key_cols}
    ins_head = ("    INSERT INTO " + repfq + " ([Recon_RunDate], " + rep_key_cols +
                ", [AttributeName], [" + lval + "], [" + rval + "], [Status])\n")

    stmts = []
    for c in cols:
        nm = c.get("out") or c["name"]   # staging tables hold the alias (out) column names
        if nm.lower() in key_set:
            continue
        is_count = c.get("mode") == "count"
        attr = (nm + (" (count/key)" if is_count else "")).replace("'", "''")
        stmts.append(
            "    -- " + ("COUNT per key" if is_count else "Value per key") + " for [" + nm + "].\n" + ins_head +
            "    SELECT @RunDate, " + coalesce_keys + ", N'" + attr + "',\n"
            "           CONVERT(NVARCHAR(MAX), l.[" + nm + "]), CONVERT(NVARCHAR(MAX), r.[" + nm + "]),\n"
            "           CASE WHEN l.[" + k0 + "] IS NULL THEN N'Missing in " + left_label + "'\n"
            "                WHEN r.[" + k0 + "] IS NULL THEN N'Missing in " + right_label + "'\n"
            "                WHEN COALESCE(CONVERT(NVARCHAR(MAX), l.[" + nm + "]), N'') = COALESCE(CONVERT(NVARCHAR(MAX), r.[" + nm + "]), N'') THEN N'Match'\n"
            "                ELSE N'Mismatch' END\n"
            "    FROM   " + lfq + " l FULL OUTER JOIN " + rfq + " r ON " + key_join + ";"
        )
    body = "\n\n".join(stmts) if stmts else "    -- (no non-key columns selected to compare)"
    return (
        "CREATE OR ALTER PROCEDURE " + procfq + "\nAS\nBEGIN\n"
        "    SET NOCOUNT ON;\n"
        "    DECLARE @RunDate DATETIME2 = SYSDATETIME();\n\n"
        "    TRUNCATE TABLE " + repfq + ";\n\n"
        + body + "\n\n"
        "    SELECT * FROM " + repfq + " ORDER BY [Status], [AttributeName];\nEND"
    )


def _nf_cmt_extract_proc(proc, dest, cols, key_cols):
    """Deterministic INSERT...SELECT populating dest from the CMT migration table(s). Columns are
    grouped by their source table; one table -> a plain SELECT, several -> LEFT JOIN on the key."""
    src_tables = []
    for c in cols:
        st = c.get("srcTable")
        if st and st not in src_tables:
            src_tables.append(st)
    if not src_tables:
        return None
    alias_of = {st: "t" + str(i) for i, st in enumerate(src_tables)}
    key_low = {k.lower() for k in key_cols}
    has_count = any(c.get("mode") == "count" for c in cols)
    # INSERT targets the dest (alias/out) names; the SELECT below yields them positionally.
    insert_cols = ", ".join("[" + c["out"] + "]" for c in cols)
    from_clause = _nf_fq(src_tables[0]) + " t0"
    for i in range(1, len(src_tables)):
        a = "t" + str(i)
        on = " AND ".join("t0.[" + k + "] = " + a + ".[" + k + "]" for k in key_cols)
        from_clause += "\n        LEFT JOIN " + _nf_fq(src_tables[i]) + " " + a + " ON " + on
    if has_count:
        # Quantitative recon: store ONE row per key — COUNT(col) for count columns, MAX(col) for value.
        def _ref(c):
            a = "t0" if c["name"].lower() in key_low else alias_of.get(c.get("srcTable"), "t0")
            return a + ".[" + c["name"] + "]"
        sel, grp = _nf_agg_projection(cols, key_cols, _ref)
        select_list, tail = ", ".join(sel), "\n    GROUP BY " + ", ".join(grp)
        note = "-- Count columns are stored as COUNT(col) grouped by the key; value columns as MAX(col) per key."
    else:
        select_list = ", ".join(alias_of.get(c.get("srcTable"), "t0") + ".[" + c["name"] + "]" for c in cols)
        tail = ""
        note = "-- Deterministic: the recon columns come straight from the CMT migration table(s)."
    return (
        "CREATE OR ALTER PROCEDURE " + _nf_fq(proc) + "\nAS\nBEGIN\n"
        "    SET NOCOUNT ON;\n"
        "    " + note + "\n"
        "    TRUNCATE TABLE " + _nf_fq(dest) + ";\n"
        "    INSERT INTO " + _nf_fq(dest) + " (" + insert_cols + ")\n"
        "    SELECT " + select_list + "\n"
        "    FROM " + from_clause + tail + ";\nEND"
    )


def _nf_cda_extract_proc(user_id, client_id, src, proc, dest, cols, key_cols):
    """AI-generate a SELECT from the ClaimCenter/PolicyCenter/BillingCenter dictionary that maps each
    recon column to its Guidewire equivalent (aliased to the recon column names + key), wrapped in an
    INSERT proc. Returns (proc_sql, generated_bool); a clearly-commented stub when the dictionary isn't
    loaded / the AI SDK is unavailable / generation fails (the rest of the script stays valid)."""
    center = {"cmt": "claimcenter", "pmt": "policycenter", "bmt": "billingcenter"}.get(src, "claimcenter")
    prov = _provider(center)
    all_names = [c["out"] for c in cols]          # output (alias) names — the recon column names
    insert_cols = ", ".join("[" + n + "]" for n in all_names)
    proj = ", ".join("[" + n + "]" for n in all_names)
    has_count = any(c.get("mode") == "count" for c in cols)
    # Quantitative recon: the AI returns GRANULAR rows (aliased to the out names); an outer query then
    # stores one row per key — COUNT(col) for count columns, MAX(col) for value columns.
    if has_count:
        sel_agg, grp_agg = _nf_agg_projection(cols, key_cols, lambda c: "src.[" + c["out"] + "]")
        proj, group_sql = ", ".join(sel_agg), "\n    GROUP BY " + ", ".join(grp_agg)
    else:
        group_sql = ""

    def _stub(reason):
        body = (
            "CREATE OR ALTER PROCEDURE " + _nf_fq(proc) + "\nAS\nBEGIN\n"
            "    SET NOCOUNT ON;\n"
            "    -- " + reason + "\n"
            "    -- When ready this proc should TRUNCATE " + _nf_fq(dest) + " then\n"
            "    --   INSERT INTO " + _nf_fq(dest) + " (" + insert_cols + ")\n"
            "    --   SELECT <" + prov["label"] + " columns aliased to the recon column names + key>;\n"
            "    TRUNCATE TABLE " + _nf_fq(dest) + ";\nEND")
        return body, False

    if anthropic is None:
        return _stub("CDA extraction not generated: the 'anthropic' SDK is not installed on the server.")
    if not prov["has_index"](user_id, client_id):
        return _stub("CDA extraction needs the " + prov["label"] + " - upload it on Product Data Dictionary, then regenerate.")
    src_tables = []
    for c in cols:
        st = c.get("srcTable")
        if st and st not in src_tables:
            src_tables.append(st)
    sel_text = (("Reconcile the " + ", ".join(src_tables) + " entity/entities. ") if src_tables else "") + \
        "Fields: " + ", ".join(
            (c["name"] + (" (" + c["description"] + ")" if c.get("description") else "")) for c in cols)
    entity_ids = _select_tables(user_id, client_id, prov, sel_text) or prov["search"](user_id, client_id, sel_text)
    if not entity_ids:
        return _stub("CDA extraction not generated: could not match " + prov["label"] + " tables to these columns "
                     "- refine the columns, or build the " + center + " SELECT on the SQL Assistant.")
    ctx = prov["context"](user_id, client_id, entity_ids)
    if not ctx:
        return _stub("CDA extraction not generated: the matched tables have no columns in the dictionary.")

    col_meanings = "\n".join(
        "  - [" + c["out"] + "]"
        + ((" (source column: " + c["name"] + ")") if c.get("out") and c["out"] != c["name"] else "")
        + (": " + c["description"] if c.get("description") else "")
        for c in cols)
    system = (
        _read_conventions(prov) + "\n\n"
        "Respond in EXACTLY this format and nothing else (no markdown fences, no extra prose):\n"
        "PURPOSE: <one sentence>\n"
        "ANALYSIS:\n<one '- ' line per point: tables/joins used and which recon column maps to which source column>\n"
        "SQL:\n<a single read-only SELECT>\n\n"
        "TASK: produce ONE read-only SELECT that returns one row per business record for reconciliation, with "
        "these OUTPUT columns aliased EXACTLY as named (case-sensitive, in square brackets) and NOTHING else:\n"
        + col_meanings + "\n"
        "The key column(s) " + ", ".join("[" + k + "]" for k in key_cols) + " MUST be included and aliased to those "
        "exact names. Map each recon column to its equivalent in the SCHEMA below by MEANING (use the description "
        "given above); for any recon column with no equivalent, output NULL AS [<that name>]. Every output column "
        "MUST be aliased with square brackets, e.g. c.PublicID AS [PMT_ID]. Use ONLY the tables/columns in the "
        "SCHEMA below, spelled verbatim; no trailing semicolon; no inline comments; and NO ORDER BY (the result is "
        "wrapped in a derived table).\n"
        + ("IMPORTANT: return GRANULAR rows — one row per underlying source record, and do NOT use "
           "COUNT/SUM/GROUP BY yourself. The key " + ", ".join("[" + k + "]" for k in key_cols) + " must REPEAT "
           "across the related rows so an outer query can COUNT them per key. Output the raw column values.\n"
           if has_count else "")
        + prov["gen_extra"] + "\n\n"
        "SCHEMA (the only tables/columns you may use):\n" + ctx
    )
    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=8000, system=system,
                           messages=[{"role": "user", "content": "Generate the reconciliation extraction SELECT now."}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Non-Financial Recon - CDA extract", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return _stub("CDA extraction not generated: the request was declined by safety classifiers.")
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        raw_sql, analysis, sqm = text, "", None
        for sqm in re.finditer(r"\bsql\s*:\s*", text, re.IGNORECASE):
            pass
        if sqm:
            pre, raw_sql = text[:sqm.start()], text[sqm.end():]
            am = re.search(r"(?is)\banalysis\s*:\s*(.*)\Z", pre)
            if am:
                analysis = am.group(1).strip()
        sel = _strip_sql_fences(raw_sql).strip().rstrip(";").strip()
        if not sel or not re.match(r"(?is)^\s*select\b", sel):
            return _stub("CDA extraction not generated: the AI did not return a SELECT - try again or use the SQL Assistant.")
        indented = "\n".join("        " + ln for ln in sel.splitlines())
        head = ["    -- CDA extraction (AI-generated, grounded on " + prov["label"] + " - REVIEW before running):"]
        for ln in _analysis_lines(analysis)[:12]:
            head.append("    " + ln)
        body = (
            "CREATE OR ALTER PROCEDURE " + _nf_fq(proc) + "\nAS\nBEGIN\n"
            "    SET NOCOUNT ON;\n"
            + "\n".join(head) + "\n"
            "    TRUNCATE TABLE " + _nf_fq(dest) + ";\n"
            "    INSERT INTO " + _nf_fq(dest) + " (" + insert_cols + ")\n"
            "    SELECT " + proj + "\n    FROM (\n" + indented + "\n    ) AS src" + group_sql + ";\nEND")
        return body, True
    except Exception:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return _stub("CDA extraction not generated: an error occurred calling the AI - try again or use the SQL Assistant.")


def generate_nonfin_recon_sql(user_id: int, client_id: int, body: Dict[str, Any]) -> Result:
    """Non-Financial Reconciliation. Builds a SQL script with THREE staging tables (_CMT/_Legacy/_CDA)
    from the selected migration-schema columns, TWO report tables + TWO compare procs (CMT-vs-Legacy,
    CMT-vs-CDA), and TWO extraction procs: _CMT deterministic (INSERT...SELECT from the CMT tables) and
    _CDA AI-generated from the ClaimCenter/PolicyCenter/BillingCenter dictionary skill.
    Body: {source(cmt|pmt|bmt), tableIds[], columns:{table:[cols]}, reconName, keyCols}."""
    src = (body.get("source") or "").strip().lower()
    if src not in ("cmt", "pmt", "bmt"):
        return {"ok": False, "error": "Non-Financial reconciliation applies to a migration-tool schema "
                "(CMT / PMT / BMT) only."}, 400
    prov = _provider(src)
    if not prov["has_index"](user_id, client_id):
        return {"ok": False, "error": "No " + prov["label"] + " loaded for this client yet — "
                + prov["empty_msg"] + " first."}, 400

    recon = _safe_ident(body.get("reconName") or "")
    if not recon:
        return {"ok": False, "error": "Enter a name for the reconciliation tables."}, 400
    key_cols, seen_k = [], set()
    for c in re.split(r"[,\n;]", str(body.get("keyCols") or "")):
        c = c.strip()
        if c and c.lower() not in seen_k:
            seen_k.add(c.lower()); key_cols.append(c)
    if not key_cols:
        return {"ok": False, "error": "Enter the common key column present in both tables "
                "(comma-separated for a composite key)."}, 400

    entity_ids = [e for e in (body.get("tableIds") or []) if e]
    if not entity_ids:
        return {"ok": False, "error": "Select one or more tables, then try again."}, 400

    dk = mig.DOC_KEY[src]
    tbl_by_id = {t["id"]: t["table"] for t in prov["list_tables"](user_id, client_id)}
    col_scope = body.get("columns") or {}
    if not isinstance(col_scope, dict):
        col_scope = {}
    # Per-column reconciliation mode: names listed in countCols are reconciled by COUNT(col) grouped by
    # the key ('count'); everything else is compared value-by-value ('value'). Keys are never counted.
    count_set = {s.lower() for s in (body.get("countCols") or []) if isinstance(s, str) and s.strip()}
    # Per-column alias (output name): the recon column is renamed to the alias EVERYWHERE — staging table
    # column, extract SELECT (source AS [alias]), report AttributeName and the compare. Keys are never
    # aliased (they anchor the join). Brackets are stripped so the alias is a safe bracket-quoted ident.
    alias_map = {}
    for _k, _v in (body.get("aliases") or {}).items() if isinstance(body.get("aliases"), dict) else []:
        if isinstance(_k, str) and isinstance(_v, str):
            _a = _v.replace("[", "").replace("]", "").strip()
            if _a:
                alias_map[_k.strip().lower()] = _a
    key_low = {k.lower() for k in key_cols}
    used_out = set(key_low)

    def _out_for(low, name):
        if low in key_low:
            return name
        a = alias_map.get(low)
        if a and a.lower() not in used_out:
            return a
        return name

    # Flatten + de-dup the selected columns across the selected tables (first occurrence wins),
    # keeping each column's source table (for the CMT extraction) and description (for the CDA mapping).
    cols, seen = [], {}
    for e in entity_ids:
        tname = tbl_by_id.get(e)
        if not tname:
            continue
        want = [c for c in (col_scope.get(e) or col_scope.get(tname) or []) if isinstance(c, str) and c.strip()]
        want_set = {s.lower() for s in want} if want else None       # None -> all columns of this table
        for d in mig.column_defs(user_id, client_id, dk, tname):
            nm = d["name"]; low = nm.lower()
            if (want_set is not None and low not in want_set) or low in seen:
                continue
            seen[low] = True
            out = _out_for(low, nm); used_out.add(out.lower())
            cols.append({"name": nm, "out": out, "type": _tsql_type(d.get("dataType"), d.get("length")),
                         "description": (d.get("description") or ""), "srcTable": tname,
                         "mode": ("count" if low in count_set else "value")})
    if not cols:
        return {"ok": False, "error": "No columns selected. Pick at least one column to reconcile."}, 400

    # Ensure the key column(s) are in the tables (defaulting type/source if not among the selected columns).
    for k in key_cols:
        if k.lower() not in seen:
            seen[k.lower()] = True
            cols.append({"name": k, "out": k, "type": "NVARCHAR(255)", "description": "",
                         "srcTable": (cols[0]["srcTable"] if cols else None), "mode": "value"})
    type_by_col = {c["name"].lower(): c["type"] for c in cols}

    # Naming pattern (data tables kept in the sequence Legacy -> CMT -> CDA):
    #   tables : <Recon>_Legacy, <Recon>_CMT, <Recon>_CDA
    #   reports: <Recon>_LegacyVsCMT_Report, <Recon>_CMTVsCDA_Report
    #   extract: usp_extract_<Recon>_CMT, usp_extract_<Recon>_CDA
    #   compare: usp_report_<Recon>_LegacyVsCMT (Legacy vs CMT), usp_report_<Recon>_CMTVsCDA (CMT vs CDA)
    t_leg, t_cmt, t_cda = recon + "_Legacy", recon + "_CMT", recon + "_CDA"
    rep_lvc, rep_cvd = recon + "_LegacyVsCMT_Report", recon + "_CMTVsCDA_Report"
    proc_lvc, proc_cvd = "usp_report_" + recon + "_LegacyVsCMT", "usp_report_" + recon + "_CMTVsCDA"
    proc_ext_cmt, proc_ext_cda = "usp_extract_" + recon + "_CMT", "usp_extract_" + recon + "_CDA"
    center_label = _provider({"cmt": "claimcenter", "pmt": "policycenter", "bmt": "billingcenter"}[src])["label"]

    def _create_data(tname):
        lines = ",\n".join("    [" + c["out"] + "] " + c["type"] for c in cols)
        return ("IF OBJECT_ID(N'" + _nf_fq(tname) + "', N'U') IS NULL\n"
                "CREATE TABLE " + _nf_fq(tname) + " (\n" + lines + "\n);")

    cmt_extract = _nf_cmt_extract_proc(proc_ext_cmt, t_cmt, cols, key_cols)
    cda_extract, cda_ok = _nf_cda_extract_proc(user_id, client_id, src, proc_ext_cda, t_cda, cols, key_cols)

    header = [
        "-- Non-Financial Reconciliation - Legacy vs CMT AND CMT vs CDA",
        "-- Data tables: " + _nf_fq(t_leg) + ", " + _nf_fq(t_cmt) + ", " + _nf_fq(t_cda) + "   |   Key: " + ", ".join(key_cols),
        "-- Extract procs: " + _nf_fq(proc_ext_cmt) + " (from the CMT tables) ; " + _nf_fq(proc_ext_cda) + " (from " + center_label + ")",
        "-- Report tables: " + _nf_fq(rep_lvc) + " (Legacy vs CMT) ; " + _nf_fq(rep_cvd) + " (CMT vs CDA)",
        "-- Compare procs: " + _nf_fq(proc_lvc) + " ; " + _nf_fq(proc_cvd) + "  (return every row with a Status)",
        "-- Run order: create objects; EXEC the two extract procs to fill _CMT/_CDA (load _Legacy yourself); then EXEC the compare procs.",
    ]
    count_names = [c["out"] for c in cols if c.get("mode") == "count"]
    if count_names:
        header.insert(5, "-- Quantitative (COUNT(col) grouped by " + ", ".join(key_cols) + "): " + ", ".join(count_names)
                      + "   |   all other columns are value-level.")
    # One block per object (title + note + sql) so the UI can render editable cards, like Source Data Filter.
    blocks = [
        {"title": t_leg, "note": "CREATE data table (Legacy side)", "sql": _create_data(t_leg)},
        {"title": t_cmt, "note": "CREATE data table (CMT side)", "sql": _create_data(t_cmt)},
        {"title": t_cda, "note": "CREATE data table (CDA side)", "sql": _create_data(t_cda)},
        {"title": rep_lvc, "note": "CREATE report table - Legacy vs CMT", "sql": _nf_report_ddl(rep_lvc, key_cols, "Legacy", "CMT", type_by_col)},
        {"title": rep_cvd, "note": "CREATE report table - CMT vs CDA", "sql": _nf_report_ddl(rep_cvd, key_cols, "CMT", "CDA", type_by_col)},
    ]
    if cmt_extract:
        blocks.append({"title": proc_ext_cmt, "note": "Extract -> " + t_cmt + " (deterministic, from the CMT tables)", "sql": cmt_extract})
    blocks.append({"title": proc_ext_cda,
                   "note": ("Extract -> " + t_cda + " (AI-mapped from " + center_label + ")") if cda_ok
                           else ("Extract -> " + t_cda + " (STUB - upload the " + center_label + ", then regenerate)"),
                   "sql": cda_extract})
    blocks.append({"title": proc_lvc, "note": "Compare Legacy vs CMT -> " + rep_lvc, "sql": _nf_compare_proc(proc_lvc, rep_lvc, t_leg, t_cmt, "Legacy", "CMT", key_cols, cols)})
    blocks.append({"title": proc_cvd, "note": "Compare CMT vs CDA -> " + rep_cvd, "sql": _nf_compare_proc(proc_cvd, rep_cvd, t_cmt, t_cda, "CMT", "CDA", key_cols, cols)})

    sql = "\n".join(header) + "\n\n" + "\nGO\n\n".join(b["sql"] for b in blocks) + "\nGO\n"

    return {"ok": True, "sql": sql, "blocks": blocks, "tables": [t_leg, t_cmt, t_cda], "reports": [rep_lvc, rep_cvd],
            "procs": [proc_ext_cmt, proc_ext_cda, proc_lvc, proc_cvd], "cdaGenerated": cda_ok,
            "columns": [c["name"] for c in cols], "countCols": count_names, "source": prov["kind"]}, 200
