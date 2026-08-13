"""File System source extraction (Excel / PDF / Word / SQL -> source schema).

Turns an uploaded file into the standard source shape
  { tables:[{name, columns:[{name,dataType,length,businessTerm,description,sample}]}] }
so File System sources plug into the same mapping pipeline as live DBs.

Two entry points:
  - extract_source(filename, raw) -> (payload_dict, http_status)
  - extract_source_stream(filename, raw) -> generator of NDJSON lines (the route
    wraps it in a streaming Response). Event shapes/order are unchanged.

Strategy: fast-path structured Excel dictionaries and SQL DDL with deterministic
parsers (no AI, no truncation), otherwise chunk the file and run one AI call per
chunk, merging tables by name so large files don't lose tables.
"""
import json
from typing import Any, Dict, Iterator, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model, EXTRACT_TEXT_BUDGET, EXTRACT_MAX_CHUNKS
from app.parsers.file_parsers import extract_file_chunks, parse_xlsx_dictionary
from app.parsers.sql_ddl_parser import parse_sql_ddl
from app.schemas.ai_schemas import SOURCE_EXTRACT_SCHEMA, TARGET_EXTRACT_SCHEMA
from app.services.ai_client import (
    anthropic_client, schema_attempts, parse_mapping_json,
)
from app.services.ai_client_service import call_ai

Payload = Dict[str, Any]
Result = Tuple[Payload, int]


def _merge_part_into(part: List[Dict[str, Any]], merged: Dict[str, Any], order: List[str]) -> None:
    """Union a chunk's tables into the running merge (by name), dedup columns."""
    for t in part:
        key = (t.get("name") or "").strip().lower()
        if not key:
            continue
        if key not in merged:
            merged[key] = {"name": t["name"], "columns": [], "_cols": set()}
            order.append(key)
        bucket = merged[key]
        for c in t.get("columns", []):
            cn = (c.get("name") or "").strip().lower()
            if not cn or cn in bucket["_cols"]:
                continue   # dedup columns across chunks (e.g. repeated header)
            bucket["_cols"].add(cn)
            bucket["columns"].append(c)


def extract_source(filename: str, raw: bytes) -> Result:
    """Read an uploaded file and infer the SOURCE tables & columns.

    Returns (payload, status). Fast-paths structured Excel dictionaries and SQL
    DDL; otherwise loops the AI over file chunks and merges the results.
    """
    if not raw:
        return {"ok": False, "error": "The uploaded file is empty."}, 400

    # Fast path #1: a STRUCTURED Excel data dictionary is parsed directly from cells —
    # instant, verbatim, no AI (falls through to AI if the layout isn't recognisable).
    if filename.lower().endswith((".xlsx", ".xlsm", ".xls")):
        xl = parse_xlsx_dictionary(raw)
        if xl:
            cc = sum(len(t["columns"]) for t in xl)
            return {"ok": True, "model": "xlsx-dictionary-parser", "fileName": filename,
                    "tables": xl, "tableCount": len(xl), "columnCount": cc}, 200

    chunks, err = extract_file_chunks(filename, raw)
    if err:
        return {"ok": False, "error": err}, 400
    chunks = [c for c in (chunks or []) if c and c.strip()]
    if not chunks:
        return {"ok": False, "error": "No readable text could be extracted from the file."}, 400
    full_text = "\n".join(chunks)

    # Fast path #2: SQL scripts with CREATE TABLE statements are parsed deterministically
    # so EVERY table is captured (the LLM tends to summarise large DDL). If the script
    # has no parseable CREATE TABLE, fall through to the AI path below.
    if filename.lower().endswith(".sql") or "create table" in full_text.lower():
        ddl_tables = parse_sql_ddl(full_text)
        if ddl_tables:
            col_count = sum(len(t["columns"]) for t in ddl_tables)
            return {"ok": True, "model": "sql-ddl-parser", "fileName": filename,
                    "tables": ddl_tables, "tableCount": len(ddl_tables), "columnCount": col_count}, 200

    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server. Run: pip install anthropic"}, 400

    # Cap the number of chunks (model calls) so a monster file can't run unbounded.
    truncated_chunks = len(chunks) > EXTRACT_MAX_CHUNKS
    if truncated_chunks:
        chunks = chunks[:EXTRACT_MAX_CHUNKS]

    # LOOP: extract from each chunk in its own model call, then MERGE tables by name so
    # neither input nor output truncation drops tables from large files.
    model = ai_model()
    try:
        merged: Dict[str, Any] = {}
        order: List[str] = []
        for idx, chunk in enumerate(chunks):
            # one chunk failing must not abort the whole extraction — retry once, then skip
            try:
                part = _ai_extract_tables_from_text(model, filename, chunk, idx + 1, len(chunks))
            except Exception:  # noqa: BLE001
                try:
                    part = _ai_extract_tables_from_text(model, filename, chunk, idx + 1, len(chunks))
                except Exception:  # noqa: BLE001
                    part = []
            _merge_part_into(part, merged, order)

        tables = []
        col_count = 0
        for key in order:
            b = merged[key]
            if b["columns"]:
                tables.append({"name": b["name"], "columns": b["columns"]})
                col_count += len(b["columns"])

        if not tables:
            return {"ok": False, "error": "The AI could not identify any source tables/columns in this file."}, 400

        return {"ok": True, "model": model, "fileName": filename,
                "tables": tables, "tableCount": len(tables), "columnCount": col_count,
                "chunks": len(chunks), "truncatedChunks": truncated_chunks}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = str(exc) or (exc.__class__.__name__ + " (see server log)")
        return {"ok": False, "error": msg}, 400


def extract_source_stream(filename: str, raw: bytes) -> Iterator[str]:
    """Same as extract_source but STREAMS newline-delimited JSON progress events so
    the UI can show a progress bar. Yields NDJSON lines. Events:
      {"type":"start","chunks":N,"fileName":..,"unit":"chunks|sheet-slices|pages"}
      {"type":"progress","done":i,"total":N,"tables":T,"columns":C,"label":"..."}
      {"type":"done","ok":true,"tables":[...],"tableCount":T,"columnCount":C,...}
      {"type":"error","error":".."}
    """
    def ev(obj: Dict[str, Any]) -> str:
        return json.dumps(obj) + "\n"

    if not raw:
        yield ev({"type": "error", "error": "The uploaded file is empty."})
        return

    # Fast path #1: structured Excel dictionary — parsed directly from cells, instant.
    if filename.lower().endswith((".xlsx", ".xlsm", ".xls")):
        xl = parse_xlsx_dictionary(raw)
        if xl:
            cc = sum(len(t["columns"]) for t in xl)
            yield ev({"type": "start", "chunks": 1, "fileName": filename, "unit": "workbook"})
            yield ev({"type": "progress", "done": 1, "total": 1, "tables": len(xl),
                      "columns": cc, "label": "Parsed Excel dictionary (direct, no AI)"})
            yield ev({"type": "done", "ok": True, "model": "xlsx-dictionary-parser",
                      "fileName": filename, "tables": xl, "tableCount": len(xl),
                      "columnCount": cc, "chunks": 1})
            return

    chunks, err = extract_file_chunks(filename, raw)
    if err:
        yield ev({"type": "error", "error": err})
        return
    chunks = [c for c in (chunks or []) if c and c.strip()]
    if not chunks:
        yield ev({"type": "error", "error": "No readable text could be extracted from the file."})
        return
    full_text = "\n".join(chunks)

    # SQL fast-path (deterministic, instant) — report as a single step.
    if filename.lower().endswith(".sql") or "create table" in full_text.lower():
        ddl = parse_sql_ddl(full_text)
        if ddl:
            cc = sum(len(t["columns"]) for t in ddl)
            yield ev({"type": "start", "chunks": 1, "fileName": filename, "unit": "script"})
            yield ev({"type": "progress", "done": 1, "total": 1, "tables": len(ddl),
                      "columns": cc, "label": "Parsed SQL DDL"})
            yield ev({"type": "done", "ok": True, "model": "sql-ddl-parser", "fileName": filename,
                      "tables": ddl, "tableCount": len(ddl), "columnCount": cc, "chunks": 1})
            return

    if anthropic is None:
        yield ev({"type": "error", "error": "The 'anthropic' SDK is not installed on the server."})
        return

    truncated = len(chunks) > EXTRACT_MAX_CHUNKS
    if truncated:
        chunks = chunks[:EXTRACT_MAX_CHUNKS]

    # infer a friendly unit label from the first chunk's header
    unit = "parts"
    head = (chunks[0].split("\n", 1)[0] if chunks else "").lower()
    if "columns " in head:
        unit = "column-slices"
    elif "rows " in head:
        unit = "row-slices"
    elif filename.lower().endswith(".pdf"):
        unit = "page-groups"

    yield ev({"type": "start", "chunks": len(chunks), "fileName": filename, "unit": unit})

    model = ai_model()
    merged: Dict[str, Any] = {}
    order: List[str] = []
    try:
        failed = 0
        for idx, chunk in enumerate(chunks):
            label = chunk.split("\n", 1)[0][:80]
            # A single chunk failing (transient gateway error, etc.) must NOT abort
            # the whole extraction — retry once, then skip and keep going.
            part: List[Dict[str, Any]] = []
            try:
                part = _ai_extract_tables_from_text(model, filename, chunk, idx + 1, len(chunks))
            except Exception:  # noqa: BLE001
                try:
                    part = _ai_extract_tables_from_text(model, filename, chunk, idx + 1, len(chunks))
                except Exception:  # noqa: BLE001
                    failed += 1
                    part = []
            _merge_part_into(part, merged, order)
            tcount = sum(1 for k in order if merged[k]["columns"])
            ccount = sum(len(merged[k]["columns"]) for k in order)
            yield ev({"type": "progress", "done": idx + 1, "total": len(chunks),
                      "tables": tcount, "columns": ccount, "label": label})

        tables, col_count = [], 0
        for key in order:
            b = merged[key]
            if b["columns"]:
                tables.append({"name": b["name"], "columns": b["columns"]})
                col_count += len(b["columns"])
        if not tables:
            yield ev({"type": "error", "error": "The AI could not identify any tables/columns in this file."})
            return
        yield ev({"type": "done", "ok": True, "model": model, "fileName": filename,
                  "tables": tables, "tableCount": len(tables), "columnCount": col_count,
                  "chunks": len(chunks), "truncatedChunks": truncated})
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        yield ev({"type": "error", "error": (str(exc) or exc.__class__.__name__)})


# ============================ TARGET (rich) extraction ============================
# The Target System always uses AI (no deterministic fast-paths) so it can reason
# about relationships: PK, FK + reference, descriptions/rules, and POLYMORPHIC FKs.

def extract_target(filename: str, raw: bytes) -> Result:
    """Non-streaming rich TARGET extraction (fallback for the streaming endpoint)."""
    if not raw:
        return {"ok": False, "error": "The uploaded file is empty."}, 400
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    chunks, err = extract_file_chunks(filename, raw)
    if err:
        return {"ok": False, "error": err}, 400
    chunks = [c for c in (chunks or []) if c and c.strip()]
    if not chunks:
        return {"ok": False, "error": "No readable text could be extracted from the file."}, 400
    truncated = len(chunks) > EXTRACT_MAX_CHUNKS
    if truncated:
        chunks = chunks[:EXTRACT_MAX_CHUNKS]
    model = ai_model()
    merged: Dict[str, Any] = {}
    order: List[str] = []
    for idx, chunk in enumerate(chunks):
        try:
            part = _ai_extract_target(model, filename, chunk, idx + 1, len(chunks))
        except Exception:  # noqa: BLE001
            try:
                part = _ai_extract_target(model, filename, chunk, idx + 1, len(chunks))
            except Exception:  # noqa: BLE001
                part = []
        _merge_part_into(part, merged, order)
    tables, col_count = [], 0
    for key in order:
        b = merged[key]
        if b["columns"]:
            tables.append({"name": b["name"], "columns": b["columns"]})
            col_count += len(b["columns"])
    if not tables:
        return {"ok": False, "error": "The AI could not identify any target tables/columns in this file."}, 400
    return {"ok": True, "model": model, "fileName": filename, "tables": tables,
            "tableCount": len(tables), "columnCount": col_count,
            "chunks": len(chunks), "truncatedChunks": truncated}, 200


def extract_target_stream(filename: str, raw: bytes) -> Iterator[str]:
    """Streaming rich TARGET extraction (always AI). Same NDJSON event shape as source."""
    def ev(obj: Dict[str, Any]) -> str:
        return json.dumps(obj) + "\n"

    if not raw:
        yield ev({"type": "error", "error": "The uploaded file is empty."}); return
    if anthropic is None:
        yield ev({"type": "error", "error": "The 'anthropic' SDK is not installed on the server."}); return
    chunks, err = extract_file_chunks(filename, raw)
    if err:
        yield ev({"type": "error", "error": err}); return
    chunks = [c for c in (chunks or []) if c and c.strip()]
    if not chunks:
        yield ev({"type": "error", "error": "No readable text could be extracted from the file."}); return
    truncated = len(chunks) > EXTRACT_MAX_CHUNKS
    if truncated:
        chunks = chunks[:EXTRACT_MAX_CHUNKS]
    unit = "parts"
    head = (chunks[0].split("\n", 1)[0] if chunks else "").lower()
    if "columns " in head: unit = "column-slices"
    elif "rows " in head: unit = "row-slices"
    elif filename.lower().endswith(".pdf"): unit = "page-groups"
    yield ev({"type": "start", "chunks": len(chunks), "fileName": filename, "unit": unit})

    model = ai_model()
    merged: Dict[str, Any] = {}
    order: List[str] = []
    try:
        for idx, chunk in enumerate(chunks):
            label = chunk.split("\n", 1)[0][:80]
            part: List[Dict[str, Any]] = []
            try:
                part = _ai_extract_target(model, filename, chunk, idx + 1, len(chunks))
            except Exception:  # noqa: BLE001
                try:
                    part = _ai_extract_target(model, filename, chunk, idx + 1, len(chunks))
                except Exception:  # noqa: BLE001
                    part = []
            _merge_part_into(part, merged, order)
            tcount = sum(1 for k in order if merged[k]["columns"])
            ccount = sum(len(merged[k]["columns"]) for k in order)
            yield ev({"type": "progress", "done": idx + 1, "total": len(chunks),
                      "tables": tcount, "columns": ccount, "label": label})
        tables, col_count = [], 0
        for key in order:
            b = merged[key]
            if b["columns"]:
                tables.append({"name": b["name"], "columns": b["columns"]})
                col_count += len(b["columns"])
        if not tables:
            yield ev({"type": "error", "error": "The AI could not identify any target tables/columns in this file."}); return
        yield ev({"type": "done", "ok": True, "model": model, "fileName": filename,
                  "tables": tables, "tableCount": len(tables), "columnCount": col_count,
                  "chunks": len(chunks), "truncatedChunks": truncated})
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        yield ev({"type": "error", "error": (str(exc) or exc.__class__.__name__)})


def _ai_extract_target(model: str, filename: str, text: str,
                       part_no: int, part_total: int) -> List[Dict[str, Any]]:
    """One model call: rich TARGET extraction incl. PK/FK/description/polymorphic FK."""
    if len(text) > EXTRACT_TEXT_BUDGET:
        text = text[:EXTRACT_TEXT_BUDGET] + "\n... (truncated)"

    system = (
        "You are a data-migration analyst reading part of a TARGET data dictionary (the final "
        "destination schema). Extract EVERY table and column in THIS PART and capture their "
        "RELATIONSHIPS and rules:\n"
        "- pk: true if the column is (part of) the primary key.\n"
        "- fk: true if the column is a foreign key to another table. Put the referenced target "
        "in fkReference EXACTLY as written (e.g. 'entity.User', 'Policy', or 'Policy.id').\n"
        "- description: any definition / rule / comment given for the column (include FK rules).\n"
        "- businessTerm: a business/glossary term if present.\n"
        "- POLYMORPHIC FOREIGN KEYS: some FK columns do NOT point to a fixed table — the target "
        "table is decided by a sibling DISCRIMINATOR column (often named <Column>_Type or a "
        "'type'/'Multiple FK Type' column) whose values enumerate the possible target entities. "
        "When you detect this, set polymorphic=true, fk=true, typeColumn=<the discriminator "
        "column name>, and possibleTypes=[the list of possible target entities/tables from that "
        "discriminator's values]. ALSO output the discriminator column itself as a normal column "
        "(its enumerated values in description).\n"
        "  Example: column 'ClaimantDenorm' has a sibling 'ClaimantDenorm_Type' with values "
        "Person, Company, Doctor, Attorney → for ClaimantDenorm: fk=true, polymorphic=true, "
        "typeColumn='ClaimantDenorm_Type', possibleTypes=['Person','Company','Doctor','Attorney'].\n"
        "- length: integer or null. Never invent columns. Do NOT summarise/omit — return EVERY "
        "column in THIS PART.\n"
        "Respond with ONLY JSON: {\"tables\":[{\"name\":\"...\",\"columns\":[{\"name\":\"...\","
        "\"dataType\":\"...\",\"length\":null,\"businessTerm\":\"\",\"description\":\"\",\"pk\":false,"
        "\"fk\":false,\"fkReference\":\"\",\"polymorphic\":false,\"typeColumn\":\"\","
        "\"possibleTypes\":[]}]}]}. No prose, no markdown fences."
    )
    user = ("TARGET FILE: " + filename + " (part " + str(part_no) + " of " + str(part_total) +
            ")\n\nFILE CONTENTS:\n" + text)

    client = anthropic_client()
    base_kwargs = dict(model=model, max_tokens=16000, system=system,
                       messages=[{"role": "user", "content": user}])

    def run(extra):
        with client.messages.stream(**base_kwargs, **extra) as stream:
            return stream.get_final_message()

    resp = call_ai("Target Dictionary Extraction", run, schema_attempts(TARGET_EXTRACT_SCHEMA))
    if getattr(resp, "stop_reason", None) == "refusal":
        return []
    out = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    data = parse_mapping_json(out)
    raw_tables = data.get("tables") if isinstance(data, dict) else data
    if not isinstance(raw_tables, list):
        return []
    result = []
    for t in raw_tables:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        cols = []
        for c in (t.get("columns") or []):
            if not isinstance(c, dict) or not c.get("name"):
                continue
            pt = c.get("possibleTypes")
            cols.append({
                "name": str(c.get("name", "")),
                "dataType": str(c.get("dataType", "") or ""),
                "length": c.get("length"),
                "businessTerm": str(c.get("businessTerm", "") or ""),
                "description": str(c.get("description", "") or ""),
                "pk": bool(c.get("pk")),
                "fk": bool(c.get("fk")),
                "fkReference": str(c.get("fkReference", "") or ""),
                "polymorphic": bool(c.get("polymorphic")),
                "typeColumn": str(c.get("typeColumn", "") or ""),
                "possibleTypes": [str(x) for x in pt] if isinstance(pt, list) else [],
            })
        if cols:
            result.append({"name": str(t["name"]), "columns": cols})
    return result


def _ai_extract_tables_from_text(model: str, filename: str, text: str,
                                 part_no: int, part_total: int) -> List[Dict[str, Any]]:
    """One model call: infer source tables/columns from a single text chunk.
    Returns a normalised list of {name, columns:[...]} (empty on failure)."""
    if len(text) > EXTRACT_TEXT_BUDGET:
        text = text[:EXTRACT_TEXT_BUDGET] + "\n... (truncated)"

    system = (
        "You are a data-migration analyst. You are given part of the raw contents of a file "
        "that describes a legacy SOURCE system (a data dictionary, DDL, spec document, or a "
        "spreadsheet of ACTUAL DATA rows).\n\n"
        "Infer the source TABLES and their COLUMNS from THIS PART:\n"
        "- If it is a data dictionary or DDL, read the declared table names, column names, "
        "data types, lengths, and any descriptions or business terms.\n"
        "- If it is raw data (rows of records), treat the column headers as column names, "
        "infer each column's dataType from its values, and put one representative value in "
        "'sample'. Derive the table name from the sheet name or file name.\n"
        "- Group columns under the correct table.\n"
        "- Never invent columns that are not supported by the text.\n"
        "- EXHAUSTIVE: return EVERY table and EVERY column present in THIS PART. Do NOT "
        "summarise, sample, abbreviate, deduplicate, or omit repetitive tables.\n\n"
        "Respond with ONLY a JSON object of the form "
        '{"tables": [ {"name": "...", "columns": [ {"name": "...", "dataType": "...", '
        '"length": null, "businessTerm": "", "description": "", "sample": ""} ] } ] }. '
        "length is an integer or null. No prose, no markdown fences."
    )
    user = ("SOURCE FILE: " + filename + " (part " + str(part_no) + " of " + str(part_total) +
            ")\n\nFILE CONTENTS:\n" + text)

    client = anthropic_client()
    base_kwargs = dict(model=model, max_tokens=16000, system=system,
                       messages=[{"role": "user", "content": user}])

    def run(extra):
        with client.messages.stream(**base_kwargs, **extra) as stream:
            return stream.get_final_message()

    resp = call_ai("Source Metadata Extraction", run, schema_attempts(SOURCE_EXTRACT_SCHEMA))
    if getattr(resp, "stop_reason", None) == "refusal":
        return []
    out = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
    data = parse_mapping_json(out)
    raw_tables = data.get("tables") if isinstance(data, dict) else data
    if not isinstance(raw_tables, list):
        return []
    result = []
    for t in raw_tables:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        cols = []
        for c in (t.get("columns") or []):
            if not isinstance(c, dict) or not c.get("name"):
                continue
            cols.append({
                "name": str(c.get("name", "")),
                "dataType": str(c.get("dataType", "") or ""),
                "length": c.get("length"),
                "businessTerm": str(c.get("businessTerm", "") or ""),
                "description": str(c.get("description", "") or ""),
                "sample": c.get("sample", ""),
            })
        if cols:
            result.append({"name": str(t["name"]), "columns": cols})
    return result
