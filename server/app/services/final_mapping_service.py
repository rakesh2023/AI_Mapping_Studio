"""AI auto-suggest for Staging Area -> Target column mappings (Visual Mapping page).

Given the Staging Area columns and the Target columns, propose the best link(s)
for each Target column (by name / data type / business meaning), each with a
mapping type and optional transformation note. Grounded: only columns present in
the supplied lists are allowed — hallucinated names are dropped server-side.

Chunks by TARGET entity (loop-and-merge, like mapping_service) so a large Target
never truncates the model output. Every call is logged via call_ai.
"""
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client, parse_mapping_json, schema_attempts
from app.services.ai_client_service import call_ai
from app.schemas.ai_schemas import FINAL_MAP_SCHEMA

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

MAPPING_TYPES = [
    "Direct", "Derived", "Lookup", "Conditional", "Constant", "Default",
    "Concatenation", "Split", "Format Conversion", "Data Type Conversion",
    "Calculation", "Aggregation", "Reference", "Custom", "Not Mapped",
]

# Target columns per AI call — keeps each response small enough to never truncate.
TARGET_COL_CHUNK = 40

_SYSTEM = (
    "You map columns from a Staging Area schema to a Target table for a data migration. "
    "For each Target column, choose the best matching Staging Area column(s) by name, data "
    "type, and business meaning. Return a JSON object "
    "{links:[{stagingEntity, stagingColumn, targetEntity, targetColumn, mappingType, "
    "transformationRule, confidence}]}.\n"
    "RULES:\n"
    "- Use ONLY entity.column names present VERBATIM in the provided lists — NEVER invent a "
    "column or entity.\n"
    "- A Staging column may map to several Target columns and vice-versa; prefer a 1:1 exact or "
    "renamed-name match.\n"
    "- OMIT a Target column entirely if there is no reasonable Staging match — do not force one.\n"
    "- mappingType is one of: " + ", ".join(t for t in MAPPING_TYPES if t != "Not Mapped") + ". "
    "Use Direct for a straight copy.\n"
    "- transformationRule: a short note ONLY when a transform is needed (CAST, UPPER, a lookup, "
    "concatenation, …); otherwise empty.\n"
    "- confidence: 0-100.\n"
    "Return ONLY the JSON object."
)


def base_instruction() -> str:
    """The base instruction the auto-map AI follows (shown read-only in the UI)."""
    return _SYSTEM


def _cols_block(entities: List[Dict[str, Any]]) -> str:
    lines = []
    for e in entities:
        ent = e.get("entity", "")
        for c in e.get("columns", []):
            bt = c.get("businessTerm")
            lines.append("- " + ent + "." + str(c.get("name", "")) + " (" + str(c.get("dataType") or "") + ")"
                         + ((" — " + str(bt)) if bt else ""))
    return "\n".join(lines) or "(none)"


def suggest(body: Dict[str, Any]) -> Result:
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    staging = body.get("staging") or []
    target = body.get("target") or []
    if not staging or not target:
        return {"ok": False, "error": "Both a Staging Area and a Target are required."}, 400

    staging_set = {(e.get("entity", ""), c.get("name", "")) for e in staging for c in e.get("columns", [])}
    target_set = {(e.get("entity", ""), c.get("name", "")) for e in target for c in e.get("columns", [])}
    staging_block = _cols_block(staging)

    # Base instruction can be overridden by the user (editable in the UI); fall back
    # to the built-in default. Additional instructions are layered on top. Integrity
    # is enforced server-side regardless (only supplied columns are accepted below).
    base = (body.get("baseInstruction") or "").strip() or _SYSTEM
    extra_instr = (body.get("instructions") or "").strip()
    system_prompt = base
    if extra_instr:
        system_prompt = base + ("\n\nADDITIONAL USER INSTRUCTIONS (apply these; they refine "
                                "the rules above):\n" + extra_instr)

    model = ai_model()
    try:
        client = anthropic_client()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400

    links: List[Dict[str, Any]] = []
    seen = set()

    # Chunk target columns so a wide table (100+ cols) never truncates the model
    # output — otherwise the single big call returns cut-off JSON and NO links.
    for tent in target:
        tname = tent.get("entity", "")
        tcols = tent.get("columns", [])
        if not tcols:
            continue
        for i in range(0, len(tcols), TARGET_COL_CHUNK):
            sub = tcols[i:i + TARGET_COL_CHUNK]
            target_block = _cols_block([{"entity": tname, "columns": sub}])
            user = ("STAGING AREA COLUMNS (source side):\n" + staging_block +
                    "\n\nTARGET TABLE '" + tname + "' COLUMNS (destination side):\n" + target_block +
                    "\n\nReturn the best Staging Area match(es) for the Target columns above.")
            base_kwargs = dict(model=model, max_tokens=8000, system=system_prompt,
                               messages=[{"role": "user", "content": user}])

            def run(extra):
                with client.messages.stream(**base_kwargs, **extra) as stream:
                    return stream.get_final_message()

            try:
                resp = call_ai("Staging->Target Auto-map", run, schema_attempts(FINAL_MAP_SCHEMA))
            except Exception:  # noqa: BLE001 - skip this chunk, keep going
                continue
            if getattr(resp, "stop_reason", None) == "refusal":
                continue
            text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
            parsed = parse_mapping_json(text)
            raw = parsed.get("links") if isinstance(parsed, dict) else None
            for l in (raw or []):
                se = str(l.get("stagingEntity") or "").strip()
                sc = str(l.get("stagingColumn") or "").strip()
                te = str(l.get("targetEntity") or tname).strip()
                tc = str(l.get("targetColumn") or "").strip()
                if (se, sc) not in staging_set or (te, tc) not in target_set:
                    continue   # drop hallucinated / mismatched names
                key = (se, sc, te, tc)
                if key in seen:
                    continue
                seen.add(key)
                mt = str(l.get("mappingType") or "Direct")
                if mt not in MAPPING_TYPES:
                    mt = "Direct"
                links.append({
                    "stagingEntity": se, "stagingColumn": sc,
                    "targetEntity": te, "targetColumn": tc,
                    "mappingType": mt,
                    "transformationRule": str(l.get("transformationRule") or ""),
                    "confidence": int(l.get("confidence") or 0),
                })

    return {"ok": True, "links": links, "model": model}, 200
