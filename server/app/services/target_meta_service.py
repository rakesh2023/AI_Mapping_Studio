"""AI inference of TARGET column metadata (pk / fk / list-table / description).

Given a target table's columns plus a REFERENCE (the uploaded Product schema file,
which states PK / FK / Type Key per column) and any KNOWN descriptions (from a data
dictionary), determine each column's keys and a description:
  - keys/list-table are COPIED from the reference (matched by name; the AI only
    reconciles a name that isn't an exact match),
  - description comes from the KNOWN map, else the AI writes a concise one.

Loops one AI call per table and merges — mirrors the mapping/extraction services.
Returns (payload, status). Grounded: never invent tables/columns.
"""
import json
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.schemas.ai_schemas import INFER_TARGET_META_SCHEMA, MATCH_TABLES_SCHEMA
from app.services.ai_client import anthropic_client, schema_attempts, parse_mapping_json
from app.services.ai_client_service import call_ai

Result = Tuple[Dict[str, Any], int]

_MATCH_SYSTEM = (
    "You match each TARGET table name to the CANDIDATE table that refers to the SAME "
    "real-world entity, judged by ENGLISH meaning. Ignore leading system prefixes "
    "(cs_, cc_, pc_, bc_, ab_, am_, cmt_, pmt_, tbl_, t_), case, underscores/spaces, and "
    "singular/plural. Examples: 'cs_activity', 'Am_activity', 'Activity' all match the "
    "candidate 'activity'. For each target return the EXACT candidate string it matches and "
    "a confidence from 0 to 1 (how certain the two names denote the SAME entity). If NO "
    "candidate clearly denotes the same entity, return match=\"\" with a low confidence — "
    "never force a match. Return ONLY JSON {\"matches\":[{\"target\",\"match\",\"confidence\"}]}."
)


def match_tables(body: Dict[str, Any]) -> Result:
    """AI-match target table names to candidate (schema-file) table names by meaning.
    body: {targets:[str], candidates:[str]} -> {ok, model, matches:[{target,match,confidence}]}."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    targets = [str(t) for t in (body.get("targets") or []) if str(t).strip()]
    candidates = [str(c) for c in (body.get("candidates") or []) if str(c).strip()]
    if not targets or not candidates:
        return {"ok": False, "error": "Both targets and candidates are required."}, 400
    model = ai_model()
    user = ("CANDIDATE TABLES:\n" + json.dumps(candidates, ensure_ascii=False) +
            "\n\nTARGET TABLES (match each to one candidate, or \"\" if none):\n" +
            json.dumps(targets, ensure_ascii=False))
    client = anthropic_client()
    kw = dict(model=model, max_tokens=4000, system=_MATCH_SYSTEM,
              messages=[{"role": "user", "content": user}])

    def run(extra):
        with client.messages.stream(**kw, **extra) as stream:
            return stream.get_final_message()

    try:
        resp = call_ai("Table Name Matching", run, schema_attempts(MATCH_TABLES_SCHEMA))
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(exc) or exc.__class__.__name__}, 400
    if getattr(resp, "stop_reason", None) == "refusal":
        return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
    txt = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    data = parse_mapping_json(txt)
    raw = data.get("matches") if isinstance(data, dict) else None
    matches = []
    if isinstance(raw, list):
        for m in raw:
            if isinstance(m, dict) and m.get("target"):
                try:
                    conf = float(m.get("confidence", 0) or 0)
                except (TypeError, ValueError):
                    conf = 0.0
                matches.append({"target": str(m["target"]), "match": str(m.get("match", "") or ""),
                                "confidence": max(0.0, min(1.0, conf))})
    return {"ok": True, "model": model, "matches": matches}, 200

_SYSTEM = (
    "You are a data-migration analyst determining column metadata for ONE target table. "
    "You are given the target COLUMNS, a REFERENCE list of fields from the product schema "
    "(each with pk/fk/fkReference/isListTable), and optional KNOWN descriptions.\n\n"
    "For EACH target column return: pk, fk, fkReference, isListTable, description.\n"
    "- KEYS: find the reference field whose name matches the column (exact, or an obvious "
    "normalisation such as case / underscores / a trailing 'ID'). COPY that field's pk, fk, "
    "fkReference and isListTable verbatim. If NO reference field matches, set pk=false, "
    "fk=false, fkReference=\"\", isListTable=false — do NOT guess a foreign-key table.\n"
    "- DESCRIPTION: if a KNOWN description is supplied for the column, use it verbatim; "
    "otherwise write ONE concise, factual sentence from the column name, data type and table. "
    "Never leave description empty.\n"
    "Use ONLY the supplied reference for keys; never invent tables, columns or references. "
    "Return ONLY a JSON object {\"columns\": [ {name, pk, fk, fkReference, isListTable, "
    "description} ]}. No prose, no fences."
)


def _infer_one(model: str, table: Dict[str, Any]) -> List[Dict[str, Any]]:
    cols = table.get("columns") or []
    if not cols:
        return []
    user = (
        "TARGET TABLE: " + str(table.get("name") or table.get("table") or "") + "\n\n"
        "COLUMNS (determine metadata for each):\n" + json.dumps(cols, ensure_ascii=False) + "\n\n"
        "REFERENCE FIELDS (product schema — authoritative for keys):\n" +
        json.dumps(table.get("reference") or [], ensure_ascii=False) + "\n\n"
        "KNOWN DESCRIPTIONS (column -> description; may be empty):\n" +
        json.dumps(table.get("known") or {}, ensure_ascii=False)
    )
    client = anthropic_client()
    kw = dict(model=model, max_tokens=8000, system=_SYSTEM,
              messages=[{"role": "user", "content": user}])

    def run(extra):
        with client.messages.stream(**kw, **extra) as stream:
            return stream.get_final_message()

    resp = call_ai("Target Metadata Inference", run, schema_attempts(INFER_TARGET_META_SCHEMA))
    if getattr(resp, "stop_reason", None) == "refusal":
        return []
    txt = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    data = parse_mapping_json(txt)
    out = data.get("columns") if isinstance(data, dict) else None
    if not isinstance(out, list):
        return []
    result = []
    for c in out:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        result.append({
            "name": str(c.get("name", "")),
            "pk": bool(c.get("pk")),
            "fk": bool(c.get("fk")),
            "fkReference": str(c.get("fkReference", "") or ""),
            "isListTable": bool(c.get("isListTable")),
            "description": str(c.get("description", "") or ""),
        })
    return result


def infer_target_metadata(body: Dict[str, Any]) -> Result:
    """body: {tables:[{name, table, columns:[{name,dataType}], reference:[...], known:{}}]}
    -> {ok, model, tables:[{name, columns:[{name,pk,fk,fkReference,isListTable,description}]}]}."""
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    tables = body.get("tables") or []
    if not tables:
        return {"ok": False, "error": "No tables provided."}, 400
    model = ai_model()
    out = []
    try:
        for t in tables:
            cols = _infer_one(model, t)
            out.append({"name": t.get("name") or t.get("table") or "", "columns": cols})
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(exc) or exc.__class__.__name__}, 400
    return {"ok": True, "model": model, "tables": out}, 200
