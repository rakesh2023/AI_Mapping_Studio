"""AI helpers for the Data Validation page.

Two operations, both returning a (payload_dict, http_status) tuple so the API
layer stays thin, and both grounded strictly on the supplied schema so the model
never invents tables, columns, or values:

  - suggest_checks(body): for each supplied target column, decide which data-quality
    checks apply — pk (uniqueness key), mandatory (not-null), typelist (coded-domain
    membership), fk (foreign key) — from the column's name, datatype, description and
    whether a typelist/accepted domain exists. Pre-ticks the grid checkboxes.
  - generate_validation_sql(body): from the ticked selections, produce ONE combined
    T-SQL script the user runs on SQL Server to find the offending records.

Shares the client, retry ladder, JSON parser and usage logging from ai_client.
"""
import json
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import (
    anthropic_client, schema_attempts, parse_mapping_json,
)
from app.services.ai_client_service import call_ai
from app.schemas.ai_schemas import VALIDATION_SUGGEST_SCHEMA

Payload = Dict[str, Any]
Result = Tuple[Payload, int]


def suggest_checks(body: Dict[str, Any]) -> Result:
    """Suggest which validation checks apply to each supplied column.

    Body: {columns: [{table, name, dataType, description, typeKey, accepted,
                      pk, fk, fkReference, mandatory}]}.
    Returns {ok, model, columns:[{table, name, pk, mandatory, typelist, fk}]}.
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    cols = body.get("columns") or []
    if not cols:
        return {"ok": False, "error": "No columns provided."}, 400

    # Compact, grounded column list — exactly the columns the model may return.
    def line(c):
        parts = [
            f"table={c.get('table','')}",
            f"name={c.get('name','')}",
            f"type={c.get('dataType','')}",
        ]
        if c.get("typeKey"): parts.append(f"typeKey={c.get('typeKey')}")
        if c.get("accepted"): parts.append(f"accepted={str(c.get('accepted'))[:120]}")
        if c.get("fkReference"): parts.append(f"fkRef={c.get('fkReference')}")
        if c.get("pk"): parts.append("schemaPK=yes")
        if c.get("fk"): parts.append("schemaFK=yes")
        if c.get("mandatory"): parts.append("schemaMandatory=yes")
        if c.get("description"): parts.append(f"desc={str(c.get('description'))[:160]}")
        return " | ".join(parts)

    col_block = "\n".join(line(c) for c in cols)

    system = (
        "You are a data-quality analyst preparing validation for an insurance "
        "(Guidewire-style) data-migration target schema. For EACH column decide which "
        "of four checks should run:\n"
        "- pk: the column is (part of) the table's primary/uniqueness key. Duplicates on "
        "the key are errors. Use the schema PK flag and identifier-style names "
        "(publicid, id, *_id primary identifiers).\n"
        "- mandatory: the column must always be populated (not null). Use the schema "
        "mandatory flag, NOT NULL semantics, keys, and descriptions that imply required.\n"
        "- typelist: the column's value must belong to a fixed coded domain / Guidewire "
        "typelist. True when a typeKey or accepted-values domain is present, or the name/"
        "description clearly denotes a coded status/type/category (Subtype, Status, Type, "
        "Category, Code). Free text, ids, dates, amounts are NOT typelist.\n"
        "- fk: the column references another table's key. Use the schema FK flag / fkRef "
        "and *_id names that clearly point at another entity.\n\n"
        "STRICT: return EXACTLY the columns given, identified by their table + name "
        "verbatim. Do NOT add, drop, rename, or invent columns. Each flag is a boolean.\n"
        "Respond with ONLY a JSON object: {\"columns\":[{\"table\",\"name\",\"pk\",\"mandatory\",\"typelist\",\"fk\"}]}. "
        "No prose, no markdown fences."
    )
    user = "COLUMNS (one per line):\n" + col_block

    model = ai_model()
    # Output is small per column (2 ids + 4 booleans); scale the budget with count.
    max_tokens = min(16000, 800 + len(cols) * 60)
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=max_tokens, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Data Validation - Suggest Checks", run,
                       schema_attempts(VALIDATION_SUGGEST_SCHEMA))

        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        parsed = parse_mapping_json(text)
        out_cols = parsed.get("columns") if isinstance(parsed, dict) else None
        if not isinstance(out_cols, list):
            out_cols = []
        return {"ok": True, "model": model, "columns": out_cols}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400


def _strip_sql_fences(text: str) -> str:
    """Drop a leading ```sql / ``` fence and trailing ``` if the model added them."""
    t = (text or "").strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def generate_validation_sql(body: Dict[str, Any]) -> Result:
    """Generate ONE combined T-SQL validation script from the ticked selections.

    Body: {schema, tables:[{table, keyColumns:[], mandatoryColumns:[],
           typelistChecks:[{column, allowedValues:[]}],
           fkChecks:[{column, parentTable, parentColumn}]}]}.
    Returns {ok, model, sql}.
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    schema = body.get("schema") or "dbo"
    tables = body.get("tables") or []
    # keep only tables that actually have at least one check selected
    tables = [t for t in tables if (t.get("keyColumns") or t.get("mandatoryColumns")
                                     or t.get("typelistChecks") or t.get("fkChecks"))]
    if not tables:
        return {"ok": False, "error": "No checks selected — tick at least one box first."}, 400

    system = (
        "You are a senior SQL Server (T-SQL) engineer. Generate ONE combined script a "
        "user will run to FIND data-quality problems in the tables described. Produce a "
        "clearly-commented section per table, and within it a labeled query per requested "
        "check:\n"
        "- Duplicates (keyColumns): SELECT the key columns and COUNT(*) AS dup_count, "
        "GROUP BY the key columns, HAVING COUNT(*) > 1, ORDER BY dup_count DESC.\n"
        "- Mandatory (mandatoryColumns): find rows where the column IS NULL (a COUNT per "
        "column, and/or a SELECT of offending rows).\n"
        "- Typelist (typelistChecks): find DISTINCT values that are NOT IN the provided "
        "allowedValues list (with a count each). Embed the allowed values as string "
        "literals exactly as given.\n"
        "- Foreign keys (fkChecks): find orphans via LEFT JOIN from the table to the "
        "parent (parentTable.parentColumn) WHERE the child value IS NOT NULL AND the "
        "parent key IS NULL.\n\n"
        "STRICT GROUNDING — do NOT hallucinate: use ONLY the exact schema, table, column "
        "names and allowed values provided. Never invent a table, column, or value. "
        "Qualify every table as [schema].[table] using the given schema. Quote all "
        "identifiers with square brackets. Escape single quotes in string literals by "
        "doubling them. Add a short header comment per table. "
        "Return ONLY the raw T-SQL script — no explanation, no markdown fences."
    )
    user = "SCHEMA: " + str(schema) + "\n\nTABLES + CHECKS (JSON):\n" + json.dumps(tables, ensure_ascii=False)

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=16000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        # Plain text output (SQL), so degrade effort-only -> bare (no json_schema).
        resp = call_ai("Data Validation - Generate SQL", run,
                       [{"output_config": {"effort": "medium"}}, {}])

        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        return {"ok": True, "model": model, "sql": _strip_sql_fences(text)}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400
