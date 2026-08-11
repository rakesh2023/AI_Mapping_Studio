"""AI mapping generation & regeneration (real LLM via the Anthropic API).

Two operations, both returning a (payload_dict, http_status) tuple so the API
layer stays thin:
  - generate_mappings(body): map an uploaded target schema to live source columns,
    per-entity and per-field-chunk to beat output-token truncation, plus infer a
    JOIN per entity.
  - regenerate_mapping(body): re-map ONE target field honoring a user instruction,
    grounded strictly on the supplied source columns (never invents tables).

Shares the client, retry ladder, and JSON parser from ai_client.
"""
import json
from typing import Any, Dict, List, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import (
    anthropic_client, call_with_fallback, schema_attempts, parse_mapping_json,
)
from app.schemas.ai_schemas import MAPPING_ITEM_SCHEMA, SINGLE_MAPPING_SCHEMA

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

# A single target table can have many columns (100+). One mapping object per field
# is large, so a big table's JSON response can exceed the output token limit and get
# truncated -> parse fails -> 0 mappings for that table. Split a table's fields into
# chunks and call the model per chunk, then aggregate.
FIELD_CHUNK = 40


def generate_mappings(body: Dict[str, Any]) -> Result:
    """Use Claude to map uploaded target-schema fields to live source columns.

    Body: {
      source: {connection, schema, tables:[{name, columns:[{name,dataType,...}]}]},
      targetEntities: [{name, table, fields:[{name,dataType,length,mandatory,pk,fk,
                        fkReference,accepted,description}]}],
      businessContext: str, instructions: str, strategy: str
    }
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server. Run: pip install anthropic"}, 400
    source = body.get("source") or {}
    target_entities = body.get("targetEntities") or []
    if not source.get("tables"):
        return {"ok": False, "error": "No source tables provided. Load a source system first."}, 400
    if not target_entities:
        return {"ok": False, "error": "No target entities provided. Upload a target schema first."}, 400

    # Group the source columns BY TABLE with numbered headers so the model can see and
    # scan every table, instead of anchoring on the first entries of a flat list.
    src_tables = source["tables"]
    blocks = []
    for i, t in enumerate(src_tables, 1):
        col_lines = []
        for c in t.get("columns", []):
            extra_bits = []
            if c.get("businessTerm"):
                extra_bits.append("business term: " + str(c["businessTerm"]))
            if c.get("description"):
                extra_bits.append(str(c["description"]))
            if c.get("sample") not in (None, ""):
                extra_bits.append("e.g. " + str(c["sample"]))
            col_lines.append(f"    {c['name']} ({c.get('dataType','')}"
                             + (f"({c['length']})" if c.get('length') else "") + ")"
                             + (" — " + "; ".join(extra_bits) if extra_bits else ""))
        blocks.append(f"[{i}/{len(src_tables)}] TABLE {t['name']} ({len(t.get('columns', []))} columns):\n"
                      + "\n".join(col_lines))
    source_block = "\n\n".join(blocks)
    src_table_names = ", ".join(t["name"] for t in src_tables)

    def _target_block(entities):
        tgt_blocks = []
        for e in entities:
            rows = []
            for f in e.get("fields", []):
                attrs = []
                if f.get("mandatory"):
                    attrs.append("mandatory")
                if f.get("pk"):
                    attrs.append("PK")
                if f.get("fk"):
                    attrs.append("FK" + (f" -> {f['fkReference']}" if f.get("fkReference") else ""))
                if f.get("accepted"):
                    attrs.append("accepted: " + str(f["accepted"]))
                rows.append(f"  - {f['name']} ({f.get('dataType','')}"
                            + (f"({f['length']})" if f.get('length') else "") + ")"
                            + (" [" + ", ".join(attrs) + "]" if attrs else "")
                            + (f" — {f['description']}" if f.get("description") else ""))
            tgt_blocks.append(f"Entity {e['name']} (table {e.get('table','')}):\n" + "\n".join(rows))
        return "\n\n".join(tgt_blocks)

    strategy = body.get("strategy", "Balanced")
    biz = (body.get("businessContext") or "").strip()
    extra = (body.get("instructions") or "").strip()

    system = (
        "You are a senior data-migration mapping engineer. You produce precise "
        "source-to-target field mappings for a database migration. For every target "
        "field you are given, choose the single best source column (from the provided "
        "source column list only — never invent a source column). Decide the mapping "
        "type, write a concrete transformation rule (SQL-like), a short business rule, "
        "null handling, and a 0-100 confidence score.\n\n"
        "MATCHING RULES — source and target names WILL differ; match on meaning, not "
        "exact strings:\n"
        "- SEARCH ACROSS ALL SOURCE TABLES. The source columns are grouped under "
        "numbered TABLE headers ([1/N] ... [N/N]); the best match for a target field "
        "is frequently in a table whose NAME looks unrelated to the target entity. "
        "Do NOT restrict yourself to the first table or to a table whose name resembles "
        "the target — scan every table's columns before deciding, and before marking a "
        "field 'Not Mapped' confirm no column in ANY listed table fits.\n"
        "- Normalize names before comparing: ignore case, and treat snake_case, "
        "camelCase, PascalCase and kebab-case as equivalent (POLICY_NUMBER == "
        "PolicyNumber == policyNumber).\n"
        "- Expand and normalize common abbreviations both ways: CUST/CUSTOMER, "
        "NBR/NUM/NO/# = number, DT/DATE, AMT = amount, ADDR = address, DESC = "
        "description, CD/CODE, ID/IDENTIFIER, FNAME/FIRST_NAME, LNAME/LAST_NAME, "
        "DOB = date of birth, TS = timestamp, QTY = quantity, PCT = percent, "
        "STS/STATUS, TEL/PH = phone, EMAIL/EMAIL_ADDR, ZIP/POSTAL_CODE, CTRY/COUNTRY, "
        "ST = state, ORG = organization, ACCT = account, AGT = agent, TXN = transaction.\n"
        "- Use each column's business term, description and sample value (when given) "
        "as strong matching signals — a matching business term outweighs a differing "
        "column name.\n"
        "- Consider data-type compatibility (a date target should map from a date/"
        "datetime/timestamp source; a numeric amount from a numeric or numeric-text "
        "column via conversion).\n"
        "- Prefer a same-named column in a differently-named table over a poor name "
        "match in another table; the table names need not align.\n"
        "- Pick the best candidate even when the name overlap is partial; lower the "
        "confidence score to reflect uncertainty rather than refusing to map.\n\n"
        "If, after applying all rules above, no plausible source column exists, use "
        "mappingType 'Not Mapped', set sourceTable and sourceColumn to empty strings, "
        "confidence 0, and explain the gap. Do NOT mark a field 'Not Mapped' merely "
        "because the names are spelled differently.\n\n"
        f"Apply the '{strategy}' strategy: Conservative = only map high-confidence "
        "matches; Balanced = map likely matches and flag uncertain ones; Aggressive = "
        "map as many as possible including low-confidence guesses."
    )
    system += (
        "\n\nJOIN CONDITIONS: A target entity is often populated by combining several "
        "source tables. For EACH target entity, determine the SQL JOIN that assembles "
        "the source rows feeding its fields. Infer join keys from primary/foreign keys, "
        "matching *_ID / *_CD / *_NBR columns, and shared business terms across the "
        "tables you actually used in that entity's mappings. Write a runnable SQL "
        "snippet, e.g. 'FROM CLM_TXN c JOIN PARTY_MST p ON c.PARTY_ID = p.PARTY_ID'. If "
        "the entity draws from a single table, give just its FROM clause "
        "('FROM CLM_TXN'). If no source tables were used, return an empty string."
    )
    # Ask for JSON in the prompt too, so we don't depend on structured-output
    # support (internal/Bedrock gateways may not accept output_config.format).
    system += (" Respond with ONLY a JSON object of the form "
               '{"mappings": [ ... ], "joins": [ ... ]}. Each mappings item has keys '
               "targetEntity, targetColumn, sourceTable, sourceColumn, mappingType, "
               "transformationRule, businessRule, nullHandling, confidence "
               "(integer 0-100), explanation. Each joins item has keys targetEntity and "
               "joinCondition (the SQL FROM/JOIN snippet described above), one per target "
               "entity. No prose, no markdown fences.")

    model = ai_model()

    def _build_user(entities):
        u = ("SOURCE DATABASE: " + str(source.get("connection", "")) + " — "
             + str(len(src_tables)) + " tables to search: " + src_table_names + "\n\n"
             + "SOURCE COLUMNS (grouped by table; search ALL of them):\n" + source_block
             + "\n\nTARGET FIELDS TO MAP:\n" + _target_block(entities))
        if biz:
            u += "\n\nBUSINESS CONTEXT:\n" + biz
        if extra:
            u += "\n\nADDITIONAL INSTRUCTIONS:\n" + extra
        u += ("\n\nReturn one mapping object per target field listed above. For each "
              "field, scan every one of the " + str(len(src_tables)) + " source tables "
              "before choosing the best column or marking it Not Mapped.")
        return u

    def _call_model(entities):
        """One model call for the given target entities. Returns (parsed dict, usage)."""
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=16000, system=system,
                           messages=[{"role": "user", "content": _build_user(entities)}])

        def run(extra_cfg):
            with client.messages.stream(**base_kwargs, **extra_cfg) as stream:
                return stream.get_final_message()

        resp = call_with_fallback(run, schema_attempts(MAPPING_ITEM_SCHEMA))
        if getattr(resp, "stop_reason", None) == "refusal":
            raise RuntimeError("The request was declined by safety classifiers.")
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        usage = getattr(resp, "usage", None)
        return parse_mapping_json(text), usage

    def _chunk_entity(e):
        fields = e.get("fields", []) or []
        if len(fields) <= FIELD_CHUNK:
            return [e]
        chunks = []
        for start in range(0, len(fields), FIELD_CHUNK):
            sub = dict(e)
            sub["fields"] = fields[start:start + FIELD_CHUNK]
            chunks.append(sub)
        return chunks

    try:
        # Process ONE target entity (in field-chunks) per model call. This keeps each
        # request small and fast so neither many tables nor a single wide table overflows
        # the output token limit or times out the gateway.
        by_key: Dict[Tuple[str, str], Any] = {}
        joins_in: Dict[str, str] = {}
        in_tokens = out_tokens = 0
        for e in target_entities:
            for chunk in _chunk_entity(e):
                data, usage = _call_model([chunk])
                for m in (data.get("mappings", []) or []):
                    k = ((m.get("targetEntity") or "").strip(), (m.get("targetColumn") or "").strip())
                    if k not in by_key:
                        by_key[k] = m
                for j in (data.get("joins") or []):
                    if isinstance(j, dict) and (j.get("targetEntity") or "").strip():
                        joins_in.setdefault((j["targetEntity"]).strip(), (j.get("joinCondition") or "").strip())
                if usage:
                    in_tokens += getattr(usage, "input_tokens", 0) or 0
                    out_tokens += getattr(usage, "output_tokens", 0) or 0

        # Guarantee one row per requested target field, so every selected table always
        # shows up in the workspace — even when the AI found no matches at all.
        returned_count = 0
        mappings = []
        for e in target_entities:
            ename = e.get("name", "")
            for f in e.get("fields", []):
                cname = f.get("name", "")
                m = by_key.get((ename, cname))
                if m:
                    m.setdefault("targetEntity", ename)
                    m.setdefault("targetColumn", cname)
                    mappings.append(m)
                    returned_count += 1
                else:
                    mappings.append({
                        "targetEntity": ename, "targetColumn": cname,
                        "sourceTable": "", "sourceColumn": "",
                        "mappingType": "Not Mapped", "transformationRule": "",
                        "businessRule": "No matching source column was found for this field.",
                        "nullHandling": "N/A", "confidence": 0,
                        "explanation": "The AI did not return a mapping for this target field; flagged for manual review.",
                    })

        joins = [{"targetEntity": e.get("name", ""),
                  "joinCondition": joins_in.get((e.get("name", "") or "").strip(), "")}
                 for e in target_entities]

        return {
            "ok": True, "model": model, "mappings": mappings, "joins": joins,
            "returnedCount": returned_count,
            "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
        }, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        msg = str(exc) or (exc.__class__.__name__ + " (see server log)")
        return {"ok": False, "error": msg}, 400


def regenerate_mapping(body: Dict[str, Any]) -> Result:
    """Re-map a SINGLE target field with Claude, honoring the user's instruction
    (e.g. 'hardcode currency as USD'). Body: {mapping:{...current row...},
    sourceColumns:[{table,column,dataType}], instruction:str}.
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}, 400
    m = body.get("mapping") or {}
    src_cols = body.get("sourceColumns") or []
    instruction = (body.get("instruction") or "").strip()
    current_join = (body.get("currentJoin") or "").strip()
    entity_tables = body.get("entitySourceTables") or []   # source tables used by this entity
    if not m.get("targetColumn"):
        return {"ok": False, "error": "No target field provided."}, 400

    src_block = "\n".join(f"{c.get('table','')}.{c.get('column','')} ({c.get('dataType','')})"
                          for c in src_cols) or "(no source columns provided)"
    system = (
        "You are a senior data-migration mapping engineer. Re-map ONE target field, "
        "following the user's instruction exactly. The instruction takes priority over "
        "your default choice — if the user says to hardcode a constant, set mappingType "
        "to 'Constant', put the value in defaultValue, and write transformationRule like "
        "CONSTANT('<value>'). If they specify a lookup, use 'Lookup' and fill lookupTable.\n\n"
        "STRICT SOURCE RULE — do NOT hallucinate: use ONLY tables and columns that appear "
        "verbatim in the AVAILABLE SOURCE COLUMNS list below, for BOTH the mapping and the "
        "join. Never invent a table name, a column name, or a join key that is not in that "
        "list. If the user asks for a value that does not exist in the list, set mappingType "
        "'Not Mapped', leave sourceTable/sourceColumn empty, and say so in explanation — do "
        "NOT fabricate a table/column to satisfy the request. Leave source empty for "
        "Constant/Default/Not Mapped.\n\n"
        "JOIN CONDITION: You are given the entity's CURRENT join and the source tables it "
        "already uses. Only if your chosen sourceTable is NOT already in that FROM/JOIN AND "
        "a valid join key exists (a column present in the list on BOTH tables, e.g. a shared "
        "*_ID / *_CD / *_NBR), add a JOIN using that real key. If no such shared key exists "
        "in the list, DO NOT invent one — keep the current join unchanged and lower "
        "confidence, noting the gap in explanation. If the chosen table is already covered "
        "(or the mapping is Constant/Default/Not Mapped), return the current join unchanged. "
        "Write a runnable snippet, e.g. 'FROM CLM_TXN c JOIN PARTY_MST p ON c.PARTY_ID = p.PARTY_ID'.\n\n"
        "Return the full updated mapping. Respond with ONLY a JSON object with keys "
        "sourceTable, sourceColumn, mappingType, transformationRule, businessRule, "
        "lookupTable, defaultValue, nullHandling, confidence (0-100 integer), explanation, "
        "joinCondition. No prose, no markdown fences."
    )
    user = (
        "TARGET FIELD: " + str(m.get("targetEntity", "")) + "." + str(m.get("targetColumn", ""))
        + " (" + str(m.get("targetDataType", "")) + ")\n"
        + "CURRENT MAPPING: " + json.dumps({k: m.get(k) for k in
            ("sourceTable", "sourceColumn", "mappingType", "transformationRule",
             "businessRule", "lookupTable", "defaultValue", "nullHandling")}, ensure_ascii=False)
        + "\n\nENTITY '" + str(m.get("targetEntity", "")) + "' CURRENT JOIN: "
        + (current_join or "(none yet)")
        + "\nSOURCE TABLES ALREADY USED BY THIS ENTITY: "
        + (", ".join(entity_tables) if entity_tables else "(none)")
        + "\n\nAVAILABLE SOURCE COLUMNS:\n" + src_block
        + "\n\nUSER INSTRUCTION (apply this): " + (instruction or "Improve this mapping.")
    )

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=2000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_with_fallback(run, [
            {"output_config": {"format": {"type": "json_schema", "schema": SINGLE_MAPPING_SCHEMA}}},
            {},
        ])

        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The request was declined by safety classifiers."}, 400
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        parsed = parse_mapping_json(text)
        # parse_mapping_json returns {"mappings":[]} on failure; a single object is what we want.
        if isinstance(parsed, dict) and "mappings" in parsed and not parsed.get("mappingType"):
            parsed = {}
        return {"ok": True, "model": model, "mapping": parsed}, 200
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}, 400
