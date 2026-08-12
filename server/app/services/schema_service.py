"""Target-schema editing helpers (AI-assisted).

parse_column() turns a natural-language instruction (e.g. "add a nullable
varchar(100) column called external_ref after publicid") into a structured
column definition matching the app's target-field shape. It is grounded on the
table's EXISTING columns so it enforces uniqueness, casing consistency, and
valid FK references, and reports low confidence when the request is ambiguous.

Returns (payload_dict, http_status) so the API layer stays thin. Reuses the
shared Anthropic client + retry ladder from ai_client.
"""
import json
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client, parse_mapping_json
from app.services.ai_client_service import call_ai
from app.schemas.ai_schemas import COLUMN_SCHEMA

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

# Data types the UI dropdown supports; the model must pick one of these.
SUPPORTED_TYPES = [
    "varchar", "nvarchar", "char", "text", "int", "bigint", "smallint", "tinyint",
    "decimal", "numeric", "money", "float", "bit", "boolean", "date", "datetime",
    "datetime2", "time", "uniqueidentifier",
]
# Types that carry a length/precision (others should have length null).
LENGTH_TYPES = {"varchar", "nvarchar", "char", "decimal", "numeric"}


def parse_column(body: Dict[str, Any]) -> Result:
    """Parse an add-a-column instruction into a structured column definition.

    Body: {
      instruction: str,
      tableName: str,
      existingColumns: [ {name, dataType, pk, fk} ]  # for uniqueness/casing/FK checks
    }
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server. Run: pip install anthropic"}, 400

    instruction = (body.get("instruction") or "").strip()
    table_name = (body.get("tableName") or "").strip() or "the target table"
    existing = body.get("existingColumns") or []
    if not instruction:
        return {"ok": False, "error": "No instruction provided."}, 400

    existing_names = [str(c.get("name", "")).strip() for c in existing if c.get("name")]
    cols_block = "\n".join(
        "- " + str(c.get("name", "")) + " (" + str(c.get("dataType", "")) + ")"
        + (" PK" if c.get("pk") else "") + (" FK" if c.get("fk") else "")
        for c in existing
    ) or "(the table currently has no columns)"

    system = (
        "You convert a short natural-language request into ONE new database column "
        "definition for a target table. Return a single JSON object with keys: column, "
        "dataType, length, mandatory, pk, fk, fkReference, afterColumn, description, "
        "confidence, note.\n\n"
        "RULES:\n"
        "- dataType MUST be one of: " + ", ".join(SUPPORTED_TYPES) + ".\n"
        "- length: an integer for length/precision types (" + ", ".join(sorted(LENGTH_TYPES)) +
        "); otherwise null.\n"
        "- column: a valid identifier (letters, digits, underscore; no spaces). Match the "
        "casing/naming convention of the EXISTING columns (e.g. snake_case if they use it). "
        "It MUST NOT duplicate an existing column name (case-insensitive).\n"
        "- mandatory: true if the request says required/mandatory/not null; else false.\n"
        "- pk: true only if explicitly asked to be a primary key.\n"
        "- fk: true only if the request says it's a foreign key / references another table. "
        "If fk is true, set fkReference to 'table.column'; else null. Do NOT invent a "
        "reference that isn't stated in the request.\n"
        "- afterColumn: if the request says 'after <col>', put that existing column name; "
        "else null.\n"
        "- confidence: 0-100. Use a LOW value (<=40) and explain in 'note' if the request is "
        "ambiguous, missing a name, or asks for something unsupported. NEVER guess a column "
        "name the user did not give.\n"
        "Respond with ONLY the JSON object. No prose, no markdown fences."
    )
    user = (
        "TABLE: " + table_name + "\n"
        "EXISTING COLUMNS:\n" + cols_block + "\n\n"
        "REQUEST: " + instruction
    )

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=800, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Target System - Add Column (AI)", run, [
            {"output_config": {"format": {"type": "json_schema", "schema": COLUMN_SCHEMA}}},
            {},
        ])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        parsed = parse_mapping_json(text)
        if not isinstance(parsed, dict) or not parsed.get("column"):
            return {"ok": False, "error": "Could not understand that instruction. Try naming the column and its type, or use the Manual tab."}, 200

        col = _normalise(parsed, existing_names)
        return {"ok": True, "model": model, "column": col}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400


def _normalise(parsed: Dict[str, Any], existing_names: List[str]) -> Dict[str, Any]:
    """Coerce the model output into the exact shape the UI form expects, and flag
    a duplicate name (the frontend still validates, but we help it here)."""
    dtype = str(parsed.get("dataType") or "varchar").lower().strip()
    if dtype not in SUPPORTED_TYPES:
        dtype = "varchar"
    length = parsed.get("length")
    if dtype in LENGTH_TYPES:
        try:
            length = int(length) if length not in (None, "") else (100 if dtype in ("varchar", "nvarchar", "char") else 18)
        except (TypeError, ValueError):
            length = 100 if dtype in ("varchar", "nvarchar", "char") else 18
    else:
        length = None

    name = str(parsed.get("column") or "").strip()
    dup = name.lower() in {n.lower() for n in existing_names}

    return {
        "column": name,
        "dataType": dtype,
        "length": length,
        "mandatory": bool(parsed.get("mandatory")),
        "pk": bool(parsed.get("pk")),
        "fk": bool(parsed.get("fk")),
        "fkReference": (parsed.get("fkReference") or None) if parsed.get("fk") else None,
        "afterColumn": parsed.get("afterColumn") or None,
        "description": str(parsed.get("description") or ""),
        "confidence": int(parsed.get("confidence") or 0),
        "note": str(parsed.get("note") or ""),
        "duplicate": dup,
    }
