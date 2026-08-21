"""AI-assisted ETL / SQL stored-procedure generation.

Given ONE target table's mappings (target columns + their source columns,
transformation types, and the entity's FROM/JOIN) plus a target database name
and optional free-text instructions, ask Claude to emit a single SQL Server
stored procedure that follows the project's fixed template and honours the
instructions (e.g. TRY_CONVERT, LEFT JOIN for lookups, WHERE filters).

Returns (payload_dict, http_status) so the API layer stays thin.
"""
import re
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client
from app.services.ai_client_service import call_ai

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

# Output-token caps. A wide table's stored proc (one SELECT line per target column)
# easily exceeds a small cap; when the model hits the cap it tends to "close" the
# statement early and drop the remaining columns. Keep these generous; continuation
# still stitches anything beyond a single response.
ETL_MAX_TOKENS = 24000
DDL_MAX_TOKENS = 16000


def _short_name(name: str) -> str:
    """SP / log TableName short form: strip a leading CMT_/PMT_ prefix."""
    return re.sub(r"^(CMT_|PMT_)", "", str(name or ""), flags=re.IGNORECASE)


def _clean_db(name: str) -> str:
    """Sanitise the DB name to a safe SQL identifier for the proc name / USE."""
    return re.sub(r"[^A-Za-z0-9_]", "", str(name or "").strip()) or "CommonStage"


def _mapping_lines(rows: List[Dict[str, Any]]) -> str:
    """One line per target column describing how to fill it, for the prompt."""
    lines = []
    for m in rows:
        tgt = (m.get("targetColumn") or "").strip()
        if not tgt:
            continue
        st = (m.get("sourceTable") or "").strip()
        sc = (m.get("sourceColumn") or "").strip()
        typ = (m.get("mappingType") or "").strip() or "Direct"
        rule = (m.get("transformationRule") or "").strip()
        lookup = (m.get("lookupTable") or "").strip()
        dflt = (m.get("defaultValue") or "").strip()
        tgt_type = (m.get("targetDataType") or "").strip()
        src = (st + "." + sc) if (st and sc) else (sc or "(none)")
        extra = []
        if typ:
            extra.append("type=" + typ)
        if tgt_type:
            extra.append("targetType=" + tgt_type)
        if rule:
            extra.append("rule=" + rule)
        if lookup:
            # Pass ONLY the lookup name (text before the ':'), never the "table: pairs"
            # string — otherwise the model treats the name as a physical table to join.
            extra.append("lookupName=" + lookup.split(":", 1)[0].strip())
        if dflt:
            extra.append("default=" + dflt)
        lines.append("- " + tgt + "  <=  " + src + "  [" + "; ".join(extra) + "]")
    return "\n".join(lines)


def _lookup_insert_block(rows: List[Dict[str, Any]]) -> str:
    """Build a COMMENTED-OUT block of INSERT statements seeding the common [LookupData]
    table from the lookup columns in this procedure. The pairs come from each Lookup
    row's 'lookupTable' attribute, formatted '<lookupName>: <code>-<value>, ...' (as
    written by the Lookup-Mapping sync). Returns '' when there are no lookup columns."""
    order: List[tuple] = []      # (lookupName, code) preserving first-seen order
    targets: Dict[tuple, str] = {}
    names_no_values: List[str] = []
    seen_names = set()
    for m in rows:
        if (m.get("mappingType") or "").strip().lower() != "lookup":
            continue
        lt = (m.get("lookupTable") or "").strip()
        if not lt:
            continue
        name, _, body = lt.partition(":")
        name = name.strip()
        if not name:
            continue
        pairs_found = False
        for pair in body.split(","):
            code, sep, target = pair.partition("-")
            code, target = code.strip(), target.strip()
            if not sep or not code:
                continue
            key = (name, code)
            if key not in targets:
                order.append(key)
            targets[key] = target
            pairs_found = True
        if not pairs_found and name not in seen_names:
            names_no_values.append(name)
        seen_names.add(name)

    if not order and not names_no_values:
        return ""

    def esc(v: str) -> str:
        return str(v).replace("'", "''")

    lines = [
        "",
        "",
        "-- =====================================================================",
        "-- LOOKUP REFERENCE DATA",
        "-- Please insert these values into the common lookup table [LookupData]",
        "-- (columns: LookupName, SourceValue, TargetValue). They back the",
        "-- \"LEFT JOIN LookupData ... AND LookupName = '...'\" joins used above.",
        "-- Uncomment and run once before executing this procedure.",
        "-- ---------------------------------------------------------------------",
    ]
    for (name, code) in order:
        lines.append("-- INSERT INTO LookupData (LookupName, SourceValue, TargetValue) VALUES ('"
                     + esc(name) + "', '" + esc(code) + "', '" + esc(targets[(name, code)]) + "');")
    for name in names_no_values:
        lines.append("-- (no expected values captured for '" + esc(name)
                     + "' - add its SourceValue/TargetValue rows to LookupData manually)")
    lines.append("-- =====================================================================")
    return "\n".join(lines)


def generate_etl(body: Dict[str, Any]) -> Result:
    """Generate ONE stored procedure for a target table.

    Body: {
      database: str,
      targetTable: str,
      targetEntity: str,
      joinCondition: str,
      instructions: str,
      mappings: [ {targetColumn, sourceTable, sourceColumn, mappingType,
                   transformationRule, businessRule, lookupTable, defaultValue,
                   nullHandling, targetDataType} ]
    }
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server. Run: pip install anthropic"}, 400

    db = _clean_db(body.get("database"))
    target_table = (body.get("targetTable") or body.get("targetEntity") or "").strip()
    rows = body.get("mappings") or []
    if not target_table:
        return {"ok": False, "error": "No target table provided."}, 400
    if not rows:
        return {"ok": False, "error": "No mappings provided for this target table."}, 400

    short = _short_name(target_table)
    proc = "INSERT_" + db + "_" + short
    join = (body.get("joinCondition") or "").strip()
    instructions = (body.get("instructions") or "").strip()

    template = (
        "SET ANSI_NULLS ON\n"
        "GO\n"
        "SET QUOTED_IDENTIFIER ON\n"
        "GO\n\n"
        "IF OBJECT_ID('[dbo].[" + proc + "]', 'P') IS NOT NULL\n"
        "    DROP PROCEDURE [dbo].[" + proc + "];\n"
        "GO\n\n"
        "CREATE PROCEDURE [dbo].[" + proc + "]\n"
        "@DSMName varchar(255)\n"
        "AS\n"
        "BEGIN\n"
        "    SET NOCOUNT ON;\n"
        "    SET XACT_ABORT, QUOTED_IDENTIFIER, ANSI_NULLS, ANSI_PADDING,\n"
        "        ANSI_WARNINGS, ARITHABORT, CONCAT_NULL_YIELDS_NULL ON;\n"
        "    SET NUMERIC_ROUNDABORT OFF;\n"
        "    DECLARE @ProcName Varchar(200)=Object_Name(@@PROCID)\n"
        "            Declare @StartTime datetime =Getdate()\n"
        "    DECLARE @localTran bit\n"
        "    DECLARE @RowInserted INT\n"
        "    IF @@TRANCOUNT = 0\n"
        "    BEGIN\n"
        "        SET @localTran = 1\n"
        "        BEGIN TRANSACTION LocalTran\n"
        "    END\n\n"
        "    BEGIN TRY\n"
        "    INSERT INTO " + target_table + "\n"
        "    (\n        <target columns>\n    )\n"
        "    SELECT\n        <source expr AS target column, one per line>\n"
        "    <FROM / JOIN>\n"
        "    ;\n"
        "    --End of Logic\n\n"
        "    SET @RowInserted=@@ROWCOUNT\n\n"
        "    IF @localTran = 1 AND XACT_STATE() = 1\n"
        "        Insert into CLAIM_CONVERSION_EXECUTION_LOG\n"
        "            (DSM_Name,ExecutionStartTime,SpName,TableName,RecordsInserted,Status,ErrorMessage)\n"
        "        values(@DSMName,@StartTime,@ProcName,'" + short + "',@RowInserted,'Successful',null)\n"
        "        COMMIT TRANSACTION LocalTran\n"
        "    END TRY\n"
        "    BEGIN CATCH\n"
        "        DECLARE @ErrorMessage NVARCHAR(4000)\n"
        "        DECLARE @ErrorSeverity INT\n"
        "        DECLARE @ErrorState INT\n"
        "        SELECT  @ErrorMessage = ERROR_MESSAGE(),\n"
        "                @ErrorSeverity = ERROR_SEVERITY(),\n"
        "                @ErrorState = ERROR_STATE()\n"
        "        IF @localTran = 1 AND XACT_STATE() <> 0\n"
        "        ROLLBACK TRAN\n"
        "        Insert into CLAIM_CONVERSION_EXECUTION_LOG\n"
        "            (DSM_NAME,ExecutionStartTime,SpName,TableName,RecordsInserted,Status,ErrorMessage)\n"
        "        values(@DSMName,@StartTime,@ProcName,'" + short + "',0,'Failed',@ErrorMessage)\n"
        "        RAISERROR ( @ErrorMessage, @ErrorSeverity, @ErrorState)\n"
        "    END CATCH\n"
        "END;"
    )

    system = (
        "You are a senior ETL / SQL engineer. Produce ONE stored procedure that "
        "inserts into a target table from mapped source columns.\n\n"
        "DIALECT: default to Microsoft SQL Server (T-SQL). If the ADDITIONAL INSTRUCTIONS "
        "specify a different target dialect (e.g. Oracle PL/SQL, PostgreSQL, MySQL), generate "
        "for THAT dialect instead and adapt the template accordingly.\n\n"
        "Start from the TEMPLATE below as the DEFAULT structure and fill its three "
        "placeholders:\n"
        "  <target columns>            -> the INSERT column list (the target columns)\n"
        "  <source expr AS target column, one per line> -> the SELECT list\n"
        "  <FROM / JOIN>               -> the FROM / JOIN clause\n\n"
        "COLUMN RULES:\n"
        "- OUTPUT EVERY COLUMN: emit exactly one SELECT line for EACH target column in the "
        "COLUMN MAPPINGS list, in order. The SELECT list MUST have the same number of columns "
        "as the INSERT list. NEVER omit, merge, summarise, abbreviate, or stop early — include "
        "all of them even if there are hundreds.\n"
        "- One SELECT line per target column, in the SAME order as the INSERT list, as "
        "'<expr> AS <TargetColumn>'.\n"
        "- The list separator comma MUST come immediately after the column alias and BEFORE any "
        "inline '-- comment' (e.g. 'NULL AS Foo,   -- Not Mapped'). Never place the comma after a "
        "'--' comment — it would be commented out and break the SQL. The last SELECT line has no comma.\n"
        "- Direct -> sourceTable.sourceColumn. Data Type Conversion / Format Conversion -> "
        "CAST(sourceTable.sourceColumn AS <targetType>). Lookup -> resolve the source code to the "
        "target value via the lookup reference table (see LOOKUP JOIN RULE below). "
        "Constant/Default -> the literal value (no source).\n"
        "- LOOKUP JOIN RULE (mandatory): all lookup / typelist values live in ONE common reference "
        "table named [LookupData] with columns (LookupName, SourceValue, TargetValue). For every "
        "column whose type is 'Lookup', LEFT JOIN [LookupData] with a UNIQUE alias and select "
        "<alias>.TargetValue AS the target column. The ON clause MUST both (a) match the source "
        "code column and (b) ALWAYS restrict the rows to THIS lookup by its lookup name — i.e. "
        "`LEFT JOIN LookupData <alias> ON <alias>.SourceValue = <sourceExpr> "
        "AND <alias>.LookupName = '<lookupName>'`. The column's 'lookupName=' attribute gives the "
        "'<lookupName>' value to put in that filter. CRITICAL: 'lookupName' is NOT a table — it is "
        "only the value of the LookupName column. Never use it (or anything like "
        "'cs_address_addresstype') as the table you join to; the ONLY lookup table is [LookupData]. "
        "This lookup-name predicate is REQUIRED on every lookup JOIN: without it, a source code that "
        "exists in more than one lookup (e.g. Status 1=Open vs AddressType 1=Home) would match the "
        "wrong rows. Never emit a lookup JOIN without the lookup-name filter.\n"
        "- DEFAULT VALUES: if a column has a 'default=' attribute, USE that default expression "
        "as its SELECT value (emit it verbatim, e.g. '(getdate()) AS src_upd_dt' or '0 AS Flag'). "
        "This takes precedence over NULL and applies EVEN WHEN the type is 'Not Mapped' or there "
        "is no source column. Only when a column has NEITHER a usable source NOR a 'default=' -> "
        "emit NULL with a trailing comment '-- Not Mapped'.\n"
        "- Use ONLY the source tables/columns present in the mapping list and the provided "
        "FROM/JOIN. Do NOT invent tables or columns. This is the ONE hard rule that the "
        "user's instructions cannot override.\n"
        "- Do NOT emit a 'USE [database]' statement. The target database is chosen at deploy "
        "time; the procedure must NOT hard-code a database. Begin with the SET options, then a "
        "drop-if-exists guard (IF OBJECT_ID(...,'P') IS NOT NULL DROP PROCEDURE ...; GO), then "
        "CREATE PROCEDURE. (Only add USE if the user's instructions explicitly ask for it.)\n\n"
        "ADDITIONAL INSTRUCTIONS override the template. The user's instructions take FULL "
        "priority and may change ANYTHING about the procedure — for example: "
        "change the letter-casing of the procedure name / table names / columns, "
        "rename the procedure, adjust SET options, change join types, add WHERE filters, use "
        "TRY_CONVERT instead of CAST, etc. Apply every instruction the user gives. When an "
        "instruction conflicts with the template, follow the INSTRUCTION, not the template. "
        "Preserve the transaction / TRY..CATCH / CLAIM_CONVERSION_EXECUTION_LOG logging "
        "structure UNLESS the user explicitly asks to change or remove it.\n\n"
        "Return ONLY the SQL. No prose, no markdown fences."
    )

    user = (
        "TARGET TABLE: " + target_table + "  (default log TableName = '" + short + "', default procedure name = " + proc + ")\n"
        "DATABASE: " + db + "\n\n"
        "COLUMN MAPPINGS (targetColumn <= source [attributes]):\n" + _mapping_lines(rows) + "\n\n"
        "FROM / JOIN CLAUSE TO USE:\n" + (join if join else "(none provided — infer a single-table FROM from the source tables above)") + "\n\n"
        "ADDITIONAL INSTRUCTIONS (these OVERRIDE the template — apply all of them):\n" +
        (instructions if instructions else "(none)") + "\n\n"
        "TEMPLATE (default structure — adapt it per the ADDITIONAL INSTRUCTIONS above):\n\n" + template
    )

    model = ai_model()
    try:
        client = anthropic_client()
        # Big procedures can exceed one response; generate with auto-continuation so a
        # long proc is never truncated (parts are stitched together).
        text, resp = _generate_with_continuation(
            client, "ETL Code Generator - Stored Procedure", model, system, user,
            max_tokens=ETL_MAX_TOKENS, attempts=[{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        sql = _strip_fences(text)
        # The model tends to prepend a 'USE [db]' out of habit. The DB is chosen at
        # deploy time, so strip it — unless the user explicitly asked for a USE statement.
        wants_use = bool(re.search(r"use\s+\[|use\s+database|use\s+statement",
                                   instructions or "", re.IGNORECASE))
        if not wants_use:
            sql = _strip_leading_use(sql)
        if not sql.strip():
            return {"ok": False, "error": "The AI returned no SQL for this table."}, 400

        # Completeness guard: never silently ship a half procedure. If any target
        # column didn't make it into the SELECT list (output-token truncation, the
        # model closing early, etc.), flag it loudly rather than returning half.
        target_cols, seen = [], set()
        for m in rows:
            tc = (m.get("targetColumn") or "").strip()
            if tc and tc.lower() not in seen:
                seen.add(tc.lower()); target_cols.append(tc)
        # The 'AS <col>' completeness check is T-SQL-shaped; skip it when the user asked
        # for a different dialect (aliasing differs) to avoid false "incomplete" flags.
        other_dialect = bool(re.search(r"oracle|postgre|pl/?sql|mysql|snowflake|bigquery|db2|sqlite|mariadb",
                                       instructions or "", re.IGNORECASE))
        missing = [] if other_dialect else _missing_target_columns(sql, target_cols)
        # Append a commented-out INSERT block seeding the common [LookupData] table for
        # any lookup columns in this procedure (based on the mapping's lookupTable pairs).
        lookup_block = _lookup_insert_block(rows)
        if lookup_block:
            sql = sql.rstrip() + "\n" + lookup_block + "\n"
        payload = {"ok": True, "model": model, "targetTable": target_table,
                   "procedure": proc, "sql": sql, "warnings": []}
        if missing:
            shown = ", ".join(missing[:20]) + ("…" if len(missing) > 20 else "")
            payload["incomplete"] = True
            payload["missingColumns"] = missing
            payload["warnings"] = [
                "This procedure is INCOMPLETE: %d of %d target columns are missing from the "
                "SELECT list (likely truncated) — do NOT deploy as-is. Missing: %s"
                % (len(missing), len(target_cols), shown)]
            print("[etl] incomplete proc for %s — missing %d/%d columns: %s"
                  % (target_table, len(missing), len(target_cols), missing))
        return payload, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = str(exc) or (exc.__class__.__name__ + " (see server log)")
        return {"ok": False, "error": msg}, 400


def _missing_target_columns(sql: str, target_cols: List[str]) -> List[str]:
    """Target columns with no 'AS <col>' alias in the generated SELECT list —
    i.e. columns the procedure dropped (usually from truncation)."""
    low = (sql or "").lower()
    missing = []
    for c in target_cols:
        if not re.search(r"\bas\s+\[?" + re.escape(c.lower()) + r"\]?", low):
            missing.append(c)
    return missing


def _strip_fences(text: str) -> str:
    """Remove ```sql ... ``` fences if the model added them despite instructions."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n", "", t)
        t = re.sub(r"\n```$", "", t)
    return t.strip()


def _strip_leading_use(sql: str) -> str:
    """Drop a leading 'USE [db]' statement (and its trailing GO), if present.

    The target database is selected at deploy time, so a hard-coded USE would
    override it. Only removes it when it's the very first statement.
    """
    return re.sub(r"^\s*USE\s+[^\n;]+;?[ \t]*\n(?:[ \t]*GO[ \t]*\n)?", "",
                  sql or "", count=1, flags=re.IGNORECASE)


# Max number of extra "continue" calls when a generation hits the output-token cap.
_CONTINUE_LIMIT = 5

def _generate_with_continuation(client, feature, model, system, user, max_tokens, attempts):
    """Generate SQL and, if the model stops at the output-token cap, keep continuing
    and stitch the parts together — so a large procedure/DDL is never truncated.

    Continuation works by prefilling the assistant turn with the text produced so far;
    the model resumes exactly where it left off (the API returns only the NEW text).
    Returns (full_text, last_response). Each segment is logged via call_ai().
    """
    messages = [{"role": "user", "content": user}]
    full = ""
    resp = None
    for _ in range(_CONTINUE_LIMIT + 1):
        base_kwargs = dict(model=model, max_tokens=max_tokens, system=system, messages=messages)

        def run(extra, _bk=base_kwargs):
            with client.messages.stream(**_bk, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai(feature, run, attempts)
        if getattr(resp, "stop_reason", None) == "refusal":
            return full, resp
        part = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        full += part
        if getattr(resp, "stop_reason", None) != "max_tokens":
            break
        # Prefill the assistant with everything so far and ask the model to continue it.
        messages = [{"role": "user", "content": user},
                    {"role": "assistant", "content": full}]
    return full, resp


def generate_ddl(body: dict):
    """AI-assisted CREATE TABLE DDL for ONE target table.

    Applies the user's instruction to a deterministic baseline DDL while keeping
    the real columns accurate. Body: {database, targetTable, columns:[{name,
    dataType,length,mandatory,pk,fk,fkReference,default}], baselineDdl, instructions}.
    Returns (payload, status) with payload.warnings listing any column
    identifiers the AI introduced that are NOT in the real schema.
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server. Run: pip install anthropic"}, 400

    target_table = (body.get("targetTable") or "").strip()
    columns = body.get("columns") or []
    baseline = (body.get("baselineDdl") or "").strip()
    instructions = (body.get("instructions") or "").strip()
    if not target_table:
        return {"ok": False, "error": "No target table provided."}, 400
    if not columns:
        return {"ok": False, "error": "No columns provided for this target table."}, 400

    col_lines = []
    for c in columns:
        bits = [str(c.get("name", "")), str(c.get("dataType", "") or "")]
        if c.get("length"):
            bits[-1] += "(" + str(c.get("length")) + ")"
        attrs = []
        if c.get("mandatory"):
            attrs.append("NOT NULL")
        if c.get("pk"):
            attrs.append("PK")
        if c.get("fk"):
            attrs.append("FK -> " + str(c.get("fkReference") or "?"))
        if c.get("default") not in (None, ""):
            attrs.append("DEFAULT: " + str(c.get("default")))
        col_lines.append("- " + bits[0] + " " + bits[1] + ("  [" + ", ".join(attrs) + "]" if attrs else ""))
    cols_block = "\n".join(col_lines)

    system = (
        "You are a senior SQL Server (T-SQL) engineer. Produce ONE CREATE TABLE statement "
        "for the given target table. Use the BASELINE DDL as the default and apply the "
        "user's ADDITIONAL INSTRUCTIONS.\n\n"
        "HARD RULES (cannot be overridden):\n"
        "- Use ONLY the columns listed in COLUMNS. Do NOT invent, rename, or drop columns "
        "unless an instruction explicitly says to. Keep each column's real name and data "
        "type accurate to the schema.\n\n"
        "DIALECT (default, overridable): default to Microsoft SQL Server (T-SQL) — bracket "
        "identifiers like [dbo].[Table] and [column] and use SQL Server types. If the "
        "ADDITIONAL INSTRUCTIONS specify another dialect (Oracle, PostgreSQL, MySQL, …), "
        "generate for that dialect instead.\n\n"
        "DEFAULTS: when a column lists a DEFAULT, emit a DEFAULT constraint for it, "
        "translating the value into a valid expression for the dialect — a number -> "
        "DEFAULT (0); a date/time -> DEFAULT (GETDATE()); a plain value -> DEFAULT "
        "('value'). If the DEFAULT is a purely descriptive placeholder (e.g. "
        "'auto-generated', 'system generated', 'identity', 'sequence'), do NOT emit a "
        "literal DEFAULT — use the right mechanism only if clearly implied (IDENTITY, "
        "NEWID(), …), otherwise omit it. Never invent defaults for columns that don't list one.\n\n"
        "The instructions may add NOT NULL/defaults, composite primary keys, indexes, "
        "column comments, IF NOT EXISTS, etc. Apply them faithfully. If there are no "
        "instructions, return clean standard DDL equivalent to the baseline.\n\n"
        "Return ONLY the SQL. No prose, no markdown fences."
    )
    user = (
        "TARGET TABLE: " + target_table + "\n"
        "DATABASE: " + (body.get("database") or "CommonStage") + "\n\n"
        "COLUMNS (name, type [attrs]):\n" + cols_block + "\n\n"
        "ADDITIONAL INSTRUCTIONS (apply these):\n" + (instructions or "(none)") + "\n\n"
        "BASELINE DDL (default to adapt):\n\n" + (baseline or "(none — build it from COLUMNS)")
    )

    model = ai_model()
    try:
        client = anthropic_client()
        # Wide tables can exceed one response; auto-continue so the DDL is never truncated.
        text, resp = _generate_with_continuation(
            client, "ETL Code Generator - Create Table", model, system, user,
            max_tokens=DDL_MAX_TOKENS, attempts=[{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        sql = _strip_fences(text)
        if not sql.strip():
            return {"ok": False, "error": "The AI returned no SQL for this table."}, 400

        warnings = _ddl_hallucination_warnings(sql, columns, target_table)
        return {"ok": True, "model": model, "targetTable": target_table,
                "sql": sql, "warnings": warnings}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = str(exc) or (exc.__class__.__name__ + " (see server log)")
        return {"ok": False, "error": msg}, 400


def _ddl_hallucination_warnings(sql: str, columns, target_table: str):
    """Best-effort guard: flag bracketed [identifiers] in the DDL that are not a
    known column, the table name, or a constraint/index name. Heuristic — meant
    to surface obvious hallucinations, not to be exhaustive."""
    known = {str(c.get("name", "")).lower() for c in columns if c.get("name")}
    known.add(str(target_table).lower())
    # include FK-referenced tables/columns as legitimate
    for c in columns:
        ref = str(c.get("fkReference") or "")
        for part in re.split(r"[.\s]+", ref):
            if part:
                known.add(part.strip("[]").lower())
    suspicious = []
    for ident in re.findall(r"\[([^\]]+)\]", sql):
        low = ident.lower()
        if low in known or low == "dbo":
            continue
        # skip obvious constraint / index / schema names
        if re.match(r"^(pk|fk|ix|uq|df|ck)[_0-9a-z]*$", low) or "_" in low or low.startswith("idx"):
            continue
        suspicious.append(ident)
    # de-dup, preserve order
    seen, out = set(), []
    for s in suspicious:
        if s.lower() not in seen:
            seen.add(s.lower()); out.append(s)
    return out
