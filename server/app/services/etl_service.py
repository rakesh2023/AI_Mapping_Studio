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
            extra.append("lookupTable=" + lookup)
        if dflt:
            extra.append("default=" + dflt)
        lines.append("- " + tgt + "  <=  " + src + "  [" + "; ".join(extra) + "]")
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
        "ALTER   PROCEDURE [dbo].[" + proc + "]\n"
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
        "You are a senior SQL Server ETL engineer. Produce ONE stored procedure that "
        "inserts into a target table from mapped source columns.\n\n"
        "Start from the TEMPLATE below as the DEFAULT structure and fill its three "
        "placeholders:\n"
        "  <target columns>            -> the INSERT column list (the target columns)\n"
        "  <source expr AS target column, one per line> -> the SELECT list\n"
        "  <FROM / JOIN>               -> the FROM / JOIN clause\n\n"
        "COLUMN RULES:\n"
        "- One SELECT line per target column, in the SAME order as the INSERT list, as "
        "'<expr> AS <TargetColumn>'.\n"
        "- Direct -> sourceTable.sourceColumn. Data Type Conversion / Format Conversion -> "
        "CAST(sourceTable.sourceColumn AS <targetType>). Lookup -> select the looked-up "
        "column and JOIN its lookup table. Constant/Default -> the literal value (no source). "
        "Not Mapped or missing source -> NULL with a trailing comment '-- Not Mapped'.\n"
        "- Use ONLY the source tables/columns present in the mapping list and the provided "
        "FROM/JOIN. Do NOT invent tables or columns. This is the ONE hard rule that the "
        "user's instructions cannot override.\n"
        "- Do NOT emit a 'USE [database]' statement. The target database is chosen at deploy "
        "time; the procedure must NOT hard-code a database. Begin with the SET options, then "
        "the ALTER PROCEDURE. (Only add USE if the user's instructions explicitly ask for it.)\n\n"
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
        base_kwargs = dict(model=model, max_tokens=4000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("ETL Code Generator - Stored Procedure", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        sql = _strip_fences(text)
        # The model tends to prepend a 'USE [db]' out of habit. The DB is chosen at
        # deploy time, so strip it — unless the user explicitly asked for a USE statement.
        wants_use = bool(re.search(r"use\s+\[|use\s+database|use\s+statement",
                                   instructions or "", re.IGNORECASE))
        if not wants_use:
            sql = _strip_leading_use(sql)
        if not sql.strip():
            return {"ok": False, "error": "The AI returned no SQL for this table."}, 400
        return {"ok": True, "model": model, "targetTable": target_table,
                "procedure": proc, "sql": sql}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = str(exc) or (exc.__class__.__name__ + " (see server log)")
        return {"ok": False, "error": msg}, 400


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


def generate_ddl(body: dict):
    """AI-assisted CREATE TABLE DDL for ONE target table.

    Applies the user's instruction to a deterministic baseline DDL while keeping
    the real columns accurate. Body: {database, targetTable, columns:[{name,
    dataType,length,mandatory,pk,fk,fkReference}], baselineDdl, instructions}.
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
        col_lines.append("- " + bits[0] + " " + bits[1] + ("  [" + ", ".join(attrs) + "]" if attrs else ""))
    cols_block = "\n".join(col_lines)

    system = (
        "You are a senior SQL Server (T-SQL) engineer. Produce ONE CREATE TABLE statement "
        "for the given target table. Use the BASELINE DDL as the default and apply the "
        "user's ADDITIONAL INSTRUCTIONS.\n\n"
        "HARD RULES (cannot be overridden):\n"
        "- Use ONLY the columns listed in COLUMNS. Do NOT invent, rename, or drop columns "
        "unless an instruction explicitly says to. Keep each column's real name and data "
        "type accurate to the schema.\n"
        "- Target dialect is Microsoft SQL Server (T-SQL): bracket identifiers like "
        "[dbo].[Table] and [column]; use SQL Server types.\n\n"
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
        base_kwargs = dict(model=model, max_tokens=3000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("ETL Code Generator - Create Table", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
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
