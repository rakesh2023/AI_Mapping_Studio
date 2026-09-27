"""Source Data Filter — legacy → prestage subset extraction (SQL prep).

Real-world flow: a legacy system (DB2 / Oracle / SQL Server / mainframe) is extracted into a
local "prestage" database, which then becomes the source for mapping. You rarely want EVERY
legacy row — you want a filtered, referentially-consistent subset (e.g. 50 specific policies,
or only open claims). This service prepares the extraction SQL for that: one read-only SELECT
per related table, every query filtered to the SAME population so the loaded prestage subset
stays consistent.

Division of labour — the AI does the two intelligent parts and returns COMPACT JSON (never
per-table SQL, so output can't truncate):
  - interpret an optional plain-English condition into a WHERE predicate on the MAIN table
    (using ONLY columns present verbatim in the supplied schema), and
  - for every OTHER table reachable from the main table, give the JOIN chain back to it.
The server then assembles each SELECT deterministically: it owns the SELECT/FROM/WHERE, the
dialect-specific row-cap clause, and the escaping of key literals. Identifiers are emitted
plain (unquoted) — fine for the standard names produced by the DDL/PDF/dictionary extraction;
the dialect governs only the row-cap syntax. Grounded strictly on the supplied source schema.
"""
import json
import re
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client, schema_attempts
from app.services.ai_client_service import call_ai

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

MAX_TABLES = 4000        # safety ceiling on total tables (guards a runaway payload; not a functional limit)
JOIN_CHUNK = 40          # related tables per AI join-inference call; large schemas fan out into chunks
MAX_KEY_VALUES = 1000    # cap an explicit key-values list

# Structured-output schema for the AI's join graph (compact — no per-table SQL).
_SUBSET_SCHEMA = {
    "type": "object",
    "properties": {
        "keyPredicate": {"type": ["string", "null"]},
        "tables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "table": {"type": "string"},
                    "alias": {"type": "string"},
                    "joinSql": {"type": "string"},
                    "note": {"type": "string"},
                },
                "required": ["table", "joinSql"],
            },
        },
        "unrelated": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["tables"],
}


# ---- dialect helpers (the only dialect-specific bits) ---------------------------------------
def _norm_dialect(d: str) -> str:
    d = (d or "ansi").strip().lower()
    if d in ("sqlserver", "sql server", "tsql", "mssql"):
        return "sqlserver"
    if d in ("oracle",):
        return "oracle"
    if d in ("db2", "ibm db2"):
        return "db2"
    return "ansi"


def _dialect_label(d: str) -> str:
    return {"sqlserver": "SQL Server (T-SQL)", "oracle": "Oracle",
            "db2": "IBM DB2", "ansi": "ANSI / generic"}[_norm_dialect(d)]


def _keyset_subquery(main: str, key: str, predicate: str, cap: int, dialect: str) -> str:
    """A subquery yielding the driving key set: SELECT DISTINCT <key> FROM <main> [WHERE ...]
    with a dialect-correct row cap."""
    d = _norm_dialect(dialect)
    sel = "SELECT DISTINCT "
    if d == "sqlserver" and cap:
        sel += "TOP (" + str(cap) + ") "
    sel += key + " FROM " + main
    if predicate:
        sel += " WHERE " + predicate
    if d != "sqlserver" and cap:
        sel += " FETCH FIRST " + str(cap) + " ROWS ONLY"
    return sel


def _keyset_insert_select(main: str, key: str, load_lit: str, predicate: str, cap: int, dialect: str) -> str:
    """INSERT…SELECT body that seeds the control table: a constant Load_Name plus the key,
    for the condition-mode population, with a dialect-correct row cap."""
    d = _norm_dialect(dialect)
    sel = "SELECT DISTINCT "
    if d == "sqlserver" and cap:
        sel += "TOP (" + str(cap) + ") "
    sel += load_lit + " AS Load_Name, " + key + " FROM " + main
    if predicate:
        sel += " WHERE " + predicate
    if d != "sqlserver" and cap:
        sel += " FETCH FIRST " + str(cap) + " ROWS ONLY"
    return sel


# ---- key-value literals ---------------------------------------------------------------------
def _literals(values: List[Any]) -> List[str]:
    """Escape an explicit key-values list into individual SQL literals. All-numeric values are
    emitted unquoted; otherwise every value is a single-quoted string (quotes doubled).
    Empty/whitespace values are dropped; capped at MAX_KEY_VALUES."""
    vals = [str(v).strip() for v in (values or []) if str(v).strip() != ""]
    vals = vals[:MAX_KEY_VALUES]
    if not vals:
        return []
    all_numeric = all(re.fullmatch(r"-?\d+(\.\d+)?", v) for v in vals)
    if all_numeric:
        return vals
    return ["'" + v.replace("'", "''") + "'" for v in vals]


def _literal_list(values: List[Any]) -> str:
    """Comma-separated literal list for an inline IN (...) clause."""
    return ", ".join(_literals(values))


# ---- control (driver) table -----------------------------------------------------------------
def _sanitize_ident(name: str, fallback: str) -> str:
    """Keep a safe SQL identifier (letters/digits/underscore, must start with a letter/underscore).
    Falls back to `fallback` when nothing usable remains."""
    s = re.sub(r"[^A-Za-z0-9_]", "", _s(name))
    if not s or not re.match(r"[A-Za-z_]", s):
        return fallback
    return s[:128]


def _control_col_type(col: Dict[str, Any]) -> str:
    """A CREATE-TABLE column type for the key column, taken from the source schema's own type
    (the control table lives in the same legacy system, so its native type is appropriate)."""
    if not isinstance(col, dict):
        return "VARCHAR(50)"
    dt = _s(col.get("dataType") or col.get("type"))
    length = col.get("length")
    if not dt:
        return "VARCHAR(50)"
    # If the type already carries precision (e.g. VARCHAR2(20)) leave it; else append length when sensible.
    if "(" in dt:
        return dt
    if length and str(length).strip() not in ("", "0", "-1") and re.match(r"(?i)(var)?char|nvarchar|nchar|number|numeric|decimal", dt):
        return dt + "(" + str(length).strip() + ")"
    return dt


# ---- schema text ----------------------------------------------------------------------------
def _schema_text(tables: List[Dict[str, Any]]) -> str:
    """Compact, AI-readable rendering: one line per table with its columns (PK/FK flagged)."""
    lines = []
    for t in tables:
        cols = []
        for c in (t.get("columns") or []):
            if not isinstance(c, dict):
                if isinstance(c, str) and c.strip():
                    cols.append(c.strip())
                continue
            nm = c.get("name")
            if not nm:
                continue
            tag = ""
            if c.get("pk"):
                tag += " [PK]"
            if c.get("fk"):
                tag += " [FK]"
            dt = c.get("dataType") or c.get("type") or ""
            cols.append(nm + (":" + dt if dt else "") + tag)
        lines.append(t.get("name", "?") + " (" + ", ".join(cols) + ")")
    return "\n".join(lines)


def _format_sql(sql: str) -> str:
    """Pretty-print a single SQL statement (multi-line, keywords upper-cased) with sqlparse when
    available; returned unchanged if sqlparse is missing or formatting fails."""
    s = (sql or "").strip()
    if not s:
        return s
    try:
        import sqlparse
        return sqlparse.format(s, reindent=True, keyword_case="upper",
                               use_space_around_operators=True).strip() or s
    except Exception:  # noqa: BLE001
        return s


def _s(x: Any) -> str:
    """Coerce any AI-returned value to a trimmed string. A bare (non-schema) fallback call can
    return a non-string where a string is expected; this keeps assembly from throwing."""
    if x is None:
        return ""
    return x.strip() if isinstance(x, str) else str(x).strip()


def _build_join_system(main: str, key: str, ask_predicate: bool, schema_text: str) -> str:
    """The join-inference system prompt for one call, grounded on the given schema text (which
    always includes the MAIN table plus the chunk of other tables being related)."""
    return (
        "You are a SQL data-model expert preparing a filtered LEGACY-system extraction. You are given a "
        "SOURCE SCHEMA (tables and their columns), a MAIN table, and its KEY column. Work out how to pull a "
        "referentially-consistent subset anchored on the main table.\n\n"
        "Return ONLY a JSON object (no markdown fences, no prose) with this shape:\n"
        "{\n"
        '  "keyPredicate": <a SQL boolean expression to filter the MAIN table, or null>,\n'
        '  "tables": [ {"table": "<name>", "alias": "<short alias>", "joinSql": "<JOIN ... ON ... chain>", '
        '"note": "<why / relationship, short>"} ],\n'
        '  "unrelated": ["<tables you could not relate to the main table>"]\n'
        "}\n\n"
        "Rules — use ONLY tables and columns that appear VERBATIM in the SCHEMA below; NEVER invent a table, "
        "column, or value:\n"
        "- The MAIN table's alias is always `m`. Do NOT list the main table in `tables`.\n"
        "- For EVERY other table that can be joined back to the main table (directly or through intermediate "
        "tables), add one entry. `joinSql` is a chain of ANSI `JOIN <table> <alias> ON <cond>` clauses that "
        "starts from the main table `m` and ends by joining the target table under its `alias`. Reference the "
        "main table as `m` and each joined table by the alias you introduce. Use plain unquoted identifiers.\n"
        "- Put tables you cannot relate to the main table in `unrelated` (do not guess a join).\n"
        + ("- keyPredicate: translate the user's CONDITION into a boolean expression usable in the WHERE clause "
           "of `SELECT " + key + " FROM " + main + " WHERE <keyPredicate>`. Reference the main table's own "
           "columns UNQUALIFIED (no alias); you MAY use an EXISTS (...) subquery against other schema tables if "
           "the condition needs related data. Use exact column names and realistic code/values from the schema.\n"
           if ask_predicate else "- keyPredicate: return null.\n")
        + "\nSCHEMA (the only tables/columns you may use):\n" + schema_text
    )


def _parse_json(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        pass
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e != -1 and e > s:
        try:
            return json.loads(text[s:e + 1])
        except Exception:  # noqa: BLE001
            pass
    return {}


def generate(body: Dict[str, Any]) -> Result:
    """Body: {sourceName?, schema:{tables:[{name, columns:[{name,dataType,pk,fk}]}]}, mainTable,
    keyColumn, dialect?, mode:"keys"|"condition", keyValues?[], condition?, rowCap?,
    useControlTable?, controlTable?}. When useControlTable is set, the first query is a control
    (driver) table CREATE+INSERT script and every extract JOINs that table instead of an inline
    IN (...). Returns {ok, queries:[{table, sql, joinSql, note}], keyPredicate, unrelated[],
    dialect, model, useControlTable, controlTable}."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400

    schema = body.get("schema") or {}
    tables = [t for t in (schema.get("tables") or []) if isinstance(t, dict) and t.get("name")]
    if not tables:
        return {"ok": False, "error": "No source schema supplied — select a source with extracted "
                "tables first."}, 400
    if len(tables) > MAX_TABLES:
        tables = tables[:MAX_TABLES]

    main = (body.get("mainTable") or "").strip()
    key = (body.get("keyColumn") or "").strip()
    if not main or not key:
        return {"ok": False, "error": "Pick a main table and its key column."}, 400

    by_name = {t["name"].lower(): t for t in tables}
    main_tbl = by_name.get(main.lower())
    if not main_tbl:
        return {"ok": False, "error": "Main table '" + main + "' is not in the selected source."}, 400
    main = main_tbl["name"]  # canonical case
    main_col_objs = [c for c in (main_tbl.get("columns") or []) if isinstance(c, dict) and c.get("name")]
    main_cols = {c["name"].lower(): c["name"] for c in main_col_objs}
    if key.lower() not in main_cols:
        return {"ok": False, "error": "Key column '" + key + "' is not on table '" + main + "'."}, 400
    key = main_cols[key.lower()]
    key_col_obj = next((c for c in main_col_objs if c["name"] == key), {})

    dialect = _norm_dialect(body.get("dialect"))
    mode = (body.get("mode") or "keys").strip().lower()
    condition = (body.get("condition") or "").strip()
    try:
        cap = int(body.get("rowCap") or 0)
    except (TypeError, ValueError):
        cap = 0
    if cap < 0:
        cap = 0

    # Optional control (driver) table: load the keys once (tagged with a Load_Name), then every
    # extract INNER JOINs it on the key + Load_Name.
    use_control = bool(body.get("useControlTable"))
    control_name = _sanitize_ident(body.get("controlTable"), "CTL_" + _sanitize_ident(main, "MAIN") + "_KEYS")
    load_name = (_s(body.get("loadName")) or "LOAD_1")[:100]

    # The population: an explicit key list, or a subquery from the AI-interpreted condition. With a
    # control (driver) table the population lives in that table, so no key values / condition are
    # required — the user loads the control table and every extract just INNER JOINs it.
    literals = ""
    if mode == "keys":
        literals = _literal_list(body.get("keyValues"))
        if not literals and not use_control:
            return {"ok": False, "error": "Paste at least one key value, or switch to a condition."}, 400
    elif mode == "condition":
        if not condition and not cap and not use_control:
            return {"ok": False, "error": "Describe a condition (e.g. 'only open claims') or set a row cap."}, 400
    else:
        return {"ok": False, "error": "Unknown filter mode."}, 400

    # ---- AI: interpret the condition + infer join chains (grounded, compact JSON) ----
    # The MAIN table anchors every call. The OTHER tables are processed in chunks of JOIN_CHUNK
    # (each call sees MAIN + its chunk), and the per-chunk join graphs are merged — so this scales
    # to any table count without one huge prompt or a truncated response.
    need_predicate = (mode == "condition" and bool(condition))
    other_tables = [t for t in tables if t["name"].lower() != main.lower()]
    chunks = [other_tables[i:i + JOIN_CHUNK] for i in range(0, len(other_tables), JOIN_CHUNK)] or [[]]

    model = ai_model()
    try:
        client = anthropic_client()
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400

    merged_tables, seen_tables = [], set()
    unrelated_list, seen_unrelated = [], set()
    key_predicate_raw = None
    chunk_fail = 0

    for ci, chunk in enumerate(chunks):
        ask_pred = need_predicate and (ci == 0)   # interpret the condition once, on the first chunk
        system = _build_join_system(main, key, ask_pred, _schema_text([main_tbl] + chunk))
        user = ("MAIN table: " + main + "\nKEY column: " + key + "\n"
                + ("CONDITION: " + condition + "\n" if ask_pred else "")
                + "List the join chain for every related table in the schema"
                + (", and the keyPredicate for the condition." if ask_pred else "."))
        base_kwargs = dict(model=model, max_tokens=8000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        graph = None
        for attempt in range(2):   # one retry per chunk; then skip it rather than fail the whole run
            try:
                resp = call_ai("Source Data Filter - Join Graph", run, schema_attempts(_SUBSET_SCHEMA))
                if getattr(resp, "stop_reason", None) == "refusal":
                    graph = {}
                    break
                text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
                graph = _parse_json(text)
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == 1:
                    import traceback
                    traceback.print_exc()
                    graph = None
        if graph is None:
            chunk_fail += 1
            continue
        if ask_pred and key_predicate_raw is None:
            key_predicate_raw = graph.get("keyPredicate")
        for entry in (graph.get("tables") if isinstance(graph.get("tables"), list) else []):
            if not isinstance(entry, dict):
                continue
            low = _s(entry.get("table")).lower()
            if low and low != main.lower() and low not in seen_tables:
                seen_tables.add(low)
                merged_tables.append(entry)
        for u in (graph.get("unrelated") or []):
            us = _s(u)
            if us and us.lower() not in seen_unrelated:
                seen_unrelated.add(us.lower())
                unrelated_list.append(us)

    # If there were tables to relate and every chunk failed, surface it rather than returning only main.
    if chunk_fail and not merged_tables and other_tables:
        return {"ok": False, "error": "Could not infer the join relationships — all "
                + str(len(chunks)) + " AI batch(es) failed. Please try again."}, 400

    graph = {"keyPredicate": key_predicate_raw, "tables": merged_tables, "unrelated": unrelated_list}

    # ---- Assemble the queries. Wrapped so a malformed AI graph can never 500 (it degrades to a
    # clear error the UI can show) — the AI's fields may be non-strings on a bare fallback call. ----
    try:
        key_predicate = _s(graph.get("keyPredicate")) or None if need_predicate else None
        load_lit = "'" + load_name.replace("'", "''") + "'"   # Load_Name as a SQL string literal

        # ---- Build the driving key set (identical population for every table) ----
        if mode == "keys":
            keyset = "IN (" + literals + ")"
        else:
            keyset = "IN (" + _keyset_subquery(main, key, key_predicate or "", cap, dialect) + ")"

        pop_desc = ("control table " + control_name) if use_control else \
            (("keys: " + str(len(body.get("keyValues") or [])) + " value(s)") if mode == "keys"
             else ("condition" + ((" — " + condition) if condition else "") + (" — first " + str(cap) + " rows" if cap else "")))

        def header(tbl: str, join_sql: str) -> str:
            h = ["-- Source Data Filter — legacy → prestage extraction (AI-assisted)",
                 "-- Source: " + _s(body.get("sourceName") or "?") + "   Dialect: " + _dialect_label(dialect),
                 "-- Table: " + tbl + "   Anchored on: " + main + "." + key + "   Population: " + pop_desc]
            if key_predicate:
                h.append("-- Main-table filter: " + key_predicate)
            if use_control:
                h.append("-- Control join: INNER JOIN " + control_name + " ctl ON ctl." + key + " = m." + key
                         + " AND ctl.Load_Name = " + load_lit)
            if join_sql:
                h.append("-- Join path: " + join_sql)
            h.append("-- " + ("-" * 74))
            return "\n".join(h)

        # Build one extract SELECT. With a control table every query INNER JOINs it on the key +
        # Load_Name (always); otherwise the population is filtered inline via the key set.
        control_join = (" INNER JOIN " + control_name + " ctl ON ctl." + key + " = m." + key
                        + " AND ctl.Load_Name = " + load_lit)
        def extract_sql(alias: str, join_sql: str) -> str:
            if use_control:
                raw = ("SELECT " + alias + ".* FROM " + main + " m" + control_join
                       + ((" " + join_sql) if join_sql else ""))
            else:
                raw = ("SELECT " + alias + ".* FROM " + main + " m "
                       + ((join_sql + " ") if join_sql else "") + "WHERE m." + key + " " + keyset)
            return _format_sql(raw) + ";"

        queries = []

        # Control (driver) table. First query = the CREATE script (Load_Name + the key column);
        # second = populate it (INSERTs / INSERT…SELECT). Then every extract INNER JOINs it.
        if use_control:
            create = ["-- Control (driver) table — holds the keys to extract, tagged by Load_Name.",
                      "-- Every extract below INNER JOINs it on " + key + " + Load_Name. Load_Name = " + load_lit,
                      "-- " + ("-" * 74),
                      "-- Create it once (adjust the column types to match your system if needed):",
                      "CREATE TABLE " + control_name + " (",
                      "  Load_Name VARCHAR(100) NOT NULL,",
                      "  " + key + " " + _control_col_type(key_col_obj) + " NOT NULL",
                      ");"]
            queries.append({"table": control_name + " — CREATE control table", "sql": "\n".join(create),
                            "joinSql": "", "note": "Run first — creates the control (driver) table."})

            populate = ["-- Populate the control table with the population to extract (Load_Name = " + load_lit + ").",
                        "-- " + ("-" * 74)]
            key_lits = _literals(body.get("keyValues")) if mode == "keys" else []
            if key_lits:
                for lit in key_lits:
                    populate.append("INSERT INTO " + control_name + " (Load_Name, " + key + ") VALUES (" + load_lit + ", " + lit + ");")
            elif mode == "condition" and (condition or cap):
                ins = ("INSERT INTO " + control_name + " (Load_Name, " + key + ")\n"
                       + _keyset_insert_select(main, key, load_lit, key_predicate or "", cap, dialect))
                populate.append(_format_sql(ins) + ";")
            else:
                # No population was provided (control-table mode) — the user loads it themselves.
                populate.append("-- Load the keys to extract here yourself (from a file/spreadsheet import, or an")
                populate.append("-- INSERT … SELECT from the legacy system). Example:")
                populate.append("-- INSERT INTO " + control_name + " (Load_Name, " + key + ") VALUES (" + load_lit + ", <key value>);")
            queries.append({"table": control_name + " — populate control table", "sql": "\n".join(populate),
                            "joinSql": "", "note": "Run second — loads the keys for this Load_Name."})

        # main table extract
        queries.append({"table": main, "sql": header(main, "") + "\n" + extract_sql("m", ""),
                        "joinSql": "", "note": "Main table (anchor)."})

        graph_tables = graph.get("tables") if isinstance(graph.get("tables"), list) else []
        grounded = [main]
        for entry in graph_tables:
            if not isinstance(entry, dict):
                continue
            tname = _s(entry.get("table"))
            tbl = by_name.get(tname.lower())
            if not tbl or tbl["name"].lower() == main.lower():
                continue  # never invent a table; skip the main table if echoed back
            tname = tbl["name"]
            alias = _s(entry.get("alias")) or tname
            join_sql = _s(entry.get("joinSql"))
            if not join_sql:
                continue
            queries.append({"table": tname, "sql": header(tname, join_sql) + "\n" + extract_sql(alias, join_sql),
                            "joinSql": join_sql, "note": _s(entry.get("note"))})
            grounded.append(tname)

        unrelated = [_s(u) for u in (graph.get("unrelated") or []) if _s(u)]
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": "Could not assemble the extraction SQL from the AI response: "
                + (str(exc) or exc.__class__.__name__)}, 400

    return {"ok": True, "model": model, "dialect": dialect, "keyPredicate": key_predicate,
            "queries": queries, "grounded": grounded, "unrelated": unrelated,
            "useControlTable": use_control, "controlTable": control_name if use_control else None,
            "loadName": load_name if use_control else None,
            "batches": len(chunks), "tableCount": len(tables)}, 200
