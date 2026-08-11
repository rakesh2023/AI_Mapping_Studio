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
from app.services.ai_client import anthropic_client, call_with_fallback

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
        "USE [" + db + "]\n"
        "GO\n"
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
        "inserts into a target table from mapped source columns. You MUST follow the "
        "EXACT template given by the user — keep every line of the boilerplate (USE, GO, "
        "SET options, DECLARE block, BEGIN TRANSACTION, BEGIN TRY / END TRY, BEGIN CATCH, "
        "the two CLAIM_CONVERSION_EXECUTION_LOG inserts, RAISERROR, END) verbatim. Only "
        "fill the three placeholders:\n"
        "  <target columns>            -> the INSERT column list (the target columns)\n"
        "  <source expr AS target column, one per line> -> the SELECT list\n"
        "  <FROM / JOIN>               -> the FROM / JOIN clause\n\n"
        "RULES:\n"
        "- One SELECT line per target column, in the SAME order as the INSERT list, as "
        "'<expr> AS <TargetColumn>'.\n"
        "- Direct -> sourceTable.sourceColumn. Data Type Conversion / Format Conversion -> "
        "CAST(sourceTable.sourceColumn AS <targetType>). Lookup -> select the looked-up "
        "column and JOIN its lookup table. Constant/Default -> the literal value (no source). "
        "Not Mapped or missing source -> NULL with a trailing comment '-- Not Mapped'.\n"
        "- Use ONLY the source tables/columns present in the mapping list and the provided "
        "FROM/JOIN. Do NOT invent tables or columns. If a needed lookup table is not in the "
        "join, add it only if a mapping row names it.\n"
        "- Use the provided FROM/JOIN clause as the basis; you MAY adjust join type (e.g. "
        "LEFT JOIN) only if the user's ADDITIONAL INSTRUCTIONS ask for it.\n"
        "- Apply the user's ADDITIONAL INSTRUCTIONS (e.g. TRY_CONVERT instead of CAST, WHERE "
        "filters, LEFT JOIN for lookups) — they take priority for the SELECT/FROM body, but "
        "never change the surrounding boilerplate or the procedure name.\n\n"
        "Return ONLY the SQL. No prose, no markdown fences."
    )

    user = (
        "TARGET TABLE: " + target_table + "  (log TableName = '" + short + "', procedure = " + proc + ")\n\n"
        "COLUMN MAPPINGS (targetColumn <= source [attributes]):\n" + _mapping_lines(rows) + "\n\n"
        "FROM / JOIN CLAUSE TO USE:\n" + (join if join else "(none provided — infer a single-table FROM from the source tables above)") + "\n\n"
        "ADDITIONAL INSTRUCTIONS (apply to the SELECT/FROM body only):\n" +
        (instructions if instructions else "(none)") + "\n\n"
        "FILL THIS EXACT TEMPLATE (keep all boilerplate verbatim):\n\n" + template
    )

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=4000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_with_fallback(run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        sql = _strip_fences(text)
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
