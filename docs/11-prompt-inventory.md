# 11 — Prompt Inventory

Every prompt sent to Claude is defined in a **service** file (backend). The frontend never holds a raw LLM prompt except the **editable mapping system prompt**, which it fetches from `GET /api/ai/mapping-prompt` and can override by sending `systemPrompt` back — so the backend remains the source of truth. All prompts demand raw JSON (no markdown fences) so they work even when the gateway rejects `output_config`.

## Inventory

| ID | Name | File | Function | Model / max_tokens | Purpose |
|---|---|---|---|---|---|
| P1 | Mapping generation (system) | `mapping_service.py` | `default_mapping_system_prompt` | claude (16000) | Generate column mappings + joins |
| P1u | Mapping generation (user) | `mapping_service.py` | `generate_mappings._build_user` | — | Source/target payload + business context |
| P2 | Regenerate one field (system+user) | `mapping_service.py` | `regenerate_mapping` | claude (2000) | Re‑map a single target field |
| P3 | Source extraction (system+user) | `extraction_service.py` | `_ai_extract_tables_from_text` | claude (16000) | Extract tables/columns from a file chunk |
| P3r | Rich extraction addendum | `extraction_service.py` | same (`rich=True`) | claude (16000) | Also infer mandatory/PK/FK |
| P4 | ETL stored proc (system+user+template) | `etl_service.py` | `generate_etl` | claude (8000) | Build an INSERT stored procedure |
| P5 | CREATE TABLE DDL (system+user) | `etl_service.py` | `generate_ddl` | claude (6000) | Build a CREATE TABLE statement |
| P6 | Deploy SQL auto‑fix (system+user) | `ai_fix_service.py` | `fix_batch` | claude (4000) | Correct a failed SQL batch |
| P7 | Add Column from NL (system+user) | `schema_service.py` | `parse_column` | claude (2500) | NL → column definitions |
| P8 | Add Entity from NL (system+user) | `schema_service.py` | `parse_entity` | claude (16000) | NL/dictionary → table definition |

> Each prompt below shows the verbatim text, the interpolated variables, an example, the expected response, response processing, and failure handling. `<...>` marks an interpolated slot.

---

## P1 — Mapping generation system prompt

**File/Function:** `server/app/services/mapping_service.py` → `default_mapping_system_prompt(strategy="Balanced")`. **Triggered when:** `POST /api/ai/generate-mappings` (unless the request supplies a `systemPrompt` override, which is used verbatim). **Variable:** `{strategy}` (Conservative/Balanced/Aggressive). Built by concatenating three parts.

**Part 1 (verbatim):**
```
You are a senior data-migration mapping engineer. You produce precise source-to-target field mappings for a database migration. For every target field you are given, choose the single best source column (from the provided source column list only — never invent a source column). Decide the mapping type, write a concrete transformation rule (SQL-like), a short business rule, null handling, and a 0-100 confidence score.

MATCHING RULES — source and target names WILL differ; match on meaning, not exact strings:
- SEARCH ACROSS ALL SOURCE TABLES. The source columns are grouped under numbered TABLE headers ([1/N] ... [N/N]); the best match for a target field is frequently in a table whose NAME looks unrelated to the target entity. Do NOT restrict yourself to the first table or to a table whose name resembles the target — scan every table's columns before deciding, and before marking a field 'Not Mapped' confirm no column in ANY listed table fits.
- Normalize names before comparing: ignore case, and treat snake_case, camelCase, PascalCase and kebab-case as equivalent (POLICY_NUMBER == PolicyNumber == policyNumber).
- Expand and normalize common abbreviations both ways: CUST/CUSTOMER, NBR/NUM/NO/# = number, DT/DATE, AMT = amount, ADDR = address, DESC = description, CD/CODE, ID/IDENTIFIER, FNAME/FIRST_NAME, LNAME/LAST_NAME, DOB = date of birth, TS = timestamp, QTY = quantity, PCT = percent, STS/STATUS, TEL/PH = phone, EMAIL/EMAIL_ADDR, ZIP/POSTAL_CODE, CTRY/COUNTRY, ST = state, ORG = organization, ACCT = account, AGT = agent, TXN = transaction.
- Use each column's business term, description and sample value (when given) as strong matching signals — a matching business term outweighs a differing column name.
- Consider data-type compatibility (a date target should map from a date/datetime/timestamp source; a numeric amount from a numeric or numeric-text column via conversion).
- Prefer a same-named column in a differently-named table over a poor name match in another table; the table names need not align.
- Pick the best candidate even when the name overlap is partial; lower the confidence score to reflect uncertainty rather than refusing to map.

If, after applying all rules above, no plausible source column exists, use mappingType 'Not Mapped', set sourceTable and sourceColumn to empty strings, confidence 0, and explain the gap. Do NOT mark a field 'Not Mapped' merely because the names are spelled differently.

Apply the '<strategy>' strategy: Conservative = only map high-confidence matches; Balanced = map likely matches and flag uncertain ones; Aggressive = map as many as possible including low-confidence guesses.
```

**Part 2 (appended, verbatim):**
```
JOIN CONDITIONS: A target entity is often populated by combining several source tables. For EACH target entity, determine the SQL JOIN that assembles the source rows feeding its fields. Infer join keys from primary/foreign keys, matching *_ID / *_CD / *_NBR columns, and shared business terms across the tables you actually used in that entity's mappings. Write a runnable SQL snippet, e.g. 'FROM CLM_TXN c JOIN PARTY_MST p ON c.PARTY_ID = p.PARTY_ID'. If the entity draws from a single table, give just its FROM clause ('FROM CLM_TXN'). If no source tables were used, return an empty string.
```

**Part 3 (appended, verbatim):**
```
 Respond with ONLY a JSON object of the form {"mappings": [ ... ], "joins": [ ... ]}. Each mappings item has keys targetEntity, targetColumn, sourceTable, sourceColumn, mappingType, transformationRule, businessRule, nullHandling, confidence (integer 0-100), explanation. Each joins item has keys targetEntity and joinCondition (the SQL FROM/JOIN snippet described above), one per target entity. No prose, no markdown fences.
```

**Expected response:** `{"mappings":[...], "joins":[...]}` matching `MAPPING_ITEM_SCHEMA`. **Processing:** `parse_mapping_json`; results merged by `(entity,column)`; any requested field the model omits gets a fabricated "Not Mapped" row. **Failure:** refusal → 400; parse failure → `{"mappings":[]}` fallback then downstream fabrication.

## P1u — Mapping generation user message

**Function:** `generate_mappings._build_user(entities)`. **Variables:** `source.connection`, `len(src_tables)`, `src_table_names`, `source_block` (each table `[i/N] TABLE <name> (<k> columns):` + indented `    <col> (<dataType>(<length>)) — business term: ...; <description>; e.g. <sample>`), `_target_block(entities)`, and optional `biz` (Business Context).

```
SOURCE DATABASE: <connection> — <N> tables to search: <src_table_names>

SOURCE COLUMNS (grouped by table; search ALL of them):
<source_block>

TARGET FIELDS TO MAP:
<target_block>

BUSINESS CONTEXT:
<biz>            (only if businessContext non-empty)

Return one mapping object per target field listed above. For each field, scan every one of the <N> source tables before choosing the best column or marking it Not Mapped.
```

**Example (reconstructed, safe sample):**
```
SOURCE DATABASE: LegacyPolicyDB — 2 tables to search: POLICY_MST, PARTY_MST

SOURCE COLUMNS (grouped by table; search ALL of them):
[1/2] TABLE POLICY_MST (2 columns):
    POL_NBR (varchar(30)) — business term: Policy Number
    EFF_DT (date) — Effective date
[2/2] TABLE PARTY_MST (1 columns):
    PARTY_ID (bigint) — Party identifier

TARGET FIELDS TO MAP:
Entity Policy (table Policy):
  - PolicyNumber (varchar(30)) [mandatory] — Business policy number
  - EffectiveDate (date)

Return one mapping object per target field listed above. For each field, scan every one of the 2 source tables before choosing the best column or marking it Not Mapped.
```

---

## P2 — Regenerate one field

**File/Function:** `mapping_service.regenerate_mapping`. **Triggered when:** `POST /api/ai/regenerate-mapping` (workspace "regenerate"). **System (verbatim, static):**
```
You are a senior data-migration mapping engineer. Re-map ONE target field, following the user's instruction exactly. The instruction takes priority over your default choice — if the user says to hardcode a constant, set mappingType to 'Constant', put the value in defaultValue, and write transformationRule like CONSTANT('<value>'). If they specify a lookup, use 'Lookup' and fill lookupTable.

STRICT SOURCE RULE — do NOT hallucinate: use ONLY tables and columns that appear verbatim in the AVAILABLE SOURCE COLUMNS list below, for BOTH the mapping and the join. Never invent a table name, a column name, or a join key that is not in that list. If the user asks for a value that does not exist in the list, set mappingType 'Not Mapped', leave sourceTable/sourceColumn empty, and say so in explanation — do NOT fabricate a table/column to satisfy the request. Leave source empty for Constant/Default/Not Mapped.

JOIN CONDITION: You are given the entity's CURRENT join and the source tables it already uses. Only if your chosen sourceTable is NOT already in that FROM/JOIN AND a valid join key exists (a column present in the list on BOTH tables, e.g. a shared *_ID / *_CD / *_NBR), add a JOIN using that real key. If no such shared key exists in the list, DO NOT invent one — keep the current join unchanged and lower confidence, noting the gap in explanation. If the chosen table is already covered (or the mapping is Constant/Default/Not Mapped), return the current join unchanged. Write a runnable snippet, e.g. 'FROM CLM_TXN c JOIN PARTY_MST p ON c.PARTY_ID = p.PARTY_ID'.

Return the full updated mapping. Respond with ONLY a JSON object with keys sourceTable, sourceColumn, mappingType, transformationRule, businessRule, lookupTable, defaultValue, nullHandling, confidence (0-100 integer), explanation, joinCondition. No prose, no markdown fences.
```
**User (variables:** `targetEntity`, `targetColumn`, `targetDataType`, JSON of the current mapping, `currentJoin`, `entitySourceTables`, `src_block`, `instruction`**):**
```
TARGET FIELD: <targetEntity>.<targetColumn> (<targetDataType>)
CURRENT MAPPING: <json of sourceTable,sourceColumn,mappingType,transformationRule,businessRule,lookupTable,defaultValue,nullHandling>

ENTITY '<targetEntity>' CURRENT JOIN: <current_join or "(none yet)">
SOURCE TABLES ALREADY USED BY THIS ENTITY: <entity_tables or "(none)">

AVAILABLE SOURCE COLUMNS:
<src_block or "(no source columns provided)">

USER INSTRUCTION (apply this): <instruction or "Improve this mapping.">
```
**Expected:** `SINGLE_MAPPING_SCHEMA`. **Processing:** `parse_mapping_json`; empty `{"mappings":[]}`→`{}`. **Failure:** refusal → 400.

---

## P3 — Source extraction (system + user) and P3r (rich addendum)

**File/Function:** `extraction_service._ai_extract_tables_from_text`. **Triggered when:** `POST /api/ai/extract-source[-stream]` for non‑deterministic content (i.e. not a `.sql` DDL or a structured Excel dictionary). **Base system (verbatim):**
```
You are a data-migration analyst. You are given part of the raw contents of a file that describes a legacy SOURCE system (a data dictionary, DDL, spec document, or a spreadsheet of ACTUAL DATA rows).

Infer the source TABLES and their COLUMNS from THIS PART:
- If it is a data dictionary or DDL, read the declared table names, column names, data types, lengths, and any descriptions or business terms.
- If it is raw data (rows of records), treat the column headers as column names, infer each column's dataType from its values, and put one representative value in 'sample'. Derive the table name from the sheet name or file name.
- Group columns under the correct table.
- Never invent columns that are not supported by the text.
- EXHAUSTIVE: return EVERY table and EVERY column present in THIS PART. Do NOT summarise, sample, abbreviate, deduplicate, or omit repetitive tables.

Respond with ONLY a JSON object of the form {"tables": [ {"name": "...", "columns": [ {"name": "...", "dataType": "...", "length": null, "businessTerm": "", "description": "", "sample": ""} ] } ] }. length is an integer or null. No prose, no markdown fences.
```
**P3r rich addendum (appended when `rich=True`, verbatim):**
```
ADDITIONALLY, for EACH column also determine and include these keys: 'mandatory' (true if required / not null), 'pk' (true if it is a primary key), 'fk' (true if it is a foreign key or references another table), and 'fkReference' ('table.column' when the dictionary states the referenced table/column, else null). Read the data dictionary's key/flag/description columns to decide these — e.g. 'Is Primary Key'/'Primary Key'/'PK', 'Foreign Key'/'FK'/'References'/'Referenced Table', 'Is Null'/'Nullable'/'Mandatory'/'Required', and typekey/reference hints. Base every value on the text — never guess a foreign-key reference that isn't stated.
```
**User (variables:** `filename`, `part_no`, `part_total`, `text` (truncated to `EXTRACT_TEXT_BUDGET=60000`)**):**
```
SOURCE FILE: <filename> (part <part_no> of <part_total>)

FILE CONTENTS:
<text>
```
**Expected:** `SOURCE_EXTRACT_SCHEMA` (or `RICH_EXTRACT_SCHEMA`). **Processing:** `parse_mapping_json`; tables unioned by name, columns deduped. **Failure:** a chunk retries once then is skipped (never aborts the whole file).

---

## P4 — ETL stored procedure (system + user + template)

**File/Function:** `etl_service.generate_etl`. **System (verbatim):**
```
You are a senior SQL Server ETL engineer. Produce ONE stored procedure that inserts into a target table from mapped source columns.

Start from the TEMPLATE below as the DEFAULT structure and fill its three placeholders:
  <target columns>            -> the INSERT column list (the target columns)
  <source expr AS target column, one per line> -> the SELECT list
  <FROM / JOIN>               -> the FROM / JOIN clause

COLUMN RULES:
- One SELECT line per target column, in the SAME order as the INSERT list, as '<expr> AS <TargetColumn>'.
- The list separator comma MUST come immediately after the column alias and BEFORE any inline '-- comment' (e.g. 'NULL AS Foo,   -- Not Mapped'). Never place the comma after a '--' comment — it would be commented out and break the SQL. The last SELECT line has no comma.
- Direct -> sourceTable.sourceColumn. Data Type Conversion / Format Conversion -> CAST(sourceTable.sourceColumn AS <targetType>). Lookup -> select the looked-up column and JOIN its lookup table. Constant/Default -> the literal value (no source). Not Mapped or missing source -> NULL with a trailing comment '-- Not Mapped'.
- Use ONLY the source tables/columns present in the mapping list and the provided FROM/JOIN. Do NOT invent tables or columns. This is the ONE hard rule that the user's instructions cannot override.
- Do NOT emit a 'USE [database]' statement. The target database is chosen at deploy time; the procedure must NOT hard-code a database. Begin with the SET options, then a drop-if-exists guard (IF OBJECT_ID(...,'P') IS NOT NULL DROP PROCEDURE ...; GO), then CREATE PROCEDURE. (Only add USE if the user's instructions explicitly ask for it.)

ADDITIONAL INSTRUCTIONS override the template. The user's instructions take FULL priority and may change ANYTHING about the procedure — for example: change the letter-casing of the procedure name / table names / columns, rename the procedure, adjust SET options, change join types, add WHERE filters, use TRY_CONVERT instead of CAST, etc. Apply every instruction the user gives. When an instruction conflicts with the template, follow the INSTRUCTION, not the template. Preserve the transaction / TRY..CATCH / CLAIM_CONVERSION_EXECUTION_LOG logging structure UNLESS the user explicitly asks to change or remove it.

Return ONLY the SQL. No prose, no markdown fences.
```
**User (variables:** `target_table`, `short` (name minus `CMT_`/`PMT_`), `proc` (`INSERT_<db>_<short>`), `db`, `_mapping_lines(rows)`, `join`, `instructions`, `template`**):**
```
TARGET TABLE: <target_table>  (default log TableName = '<short>', default procedure name = <proc>)
DATABASE: <db>

COLUMN MAPPINGS (targetColumn <= source [attributes]):
<mapping_lines>

FROM / JOIN CLAUSE TO USE:
<join or "(none provided — infer a single-table FROM from the source tables above)">

ADDITIONAL INSTRUCTIONS (these OVERRIDE the template — apply all of them):
<instructions or "(none)">

TEMPLATE (default structure — adapt it per the ADDITIONAL INSTRUCTIONS above):

<template>
```
The **embedded `template`** (interpolates `proc`, `target_table`, `short`) is the SET‑options → drop‑if‑exists → `CREATE PROCEDURE` skeleton with a `BEGIN TRY … BEGIN CATCH` transaction and `CLAIM_CONVERSION_EXECUTION_LOG` logging (full text in `etl_service.py`). **Post‑processing:** `_strip_fences`, then `_strip_leading_use` unless the instructions match `use\s+\[|use\s+database|use\s+statement`. **Expected:** raw T‑SQL. **Failure:** refusal → 400; on `max_tokens`, auto‑continuation (≤5) via a prefilled assistant turn.

---

## P5 — CREATE TABLE DDL

**File/Function:** `etl_service.generate_ddl`. **System (verbatim):**
```
You are a senior SQL Server (T-SQL) engineer. Produce ONE CREATE TABLE statement for the given target table. Use the BASELINE DDL as the default and apply the user's ADDITIONAL INSTRUCTIONS.

HARD RULES (cannot be overridden):
- Use ONLY the columns listed in COLUMNS. Do NOT invent, rename, or drop columns unless an instruction explicitly says to. Keep each column's real name and data type accurate to the schema.
- Target dialect is Microsoft SQL Server (T-SQL): bracket identifiers like [dbo].[Table] and [column]; use SQL Server types.

The instructions may add NOT NULL/defaults, composite primary keys, indexes, column comments, IF NOT EXISTS, etc. Apply them faithfully. If there are no instructions, return clean standard DDL equivalent to the baseline.

Return ONLY the SQL. No prose, no markdown fences.
```
**User (variables:** `target_table`, `database` (or `"CommonStage"`), `cols_block` (per column `- <name> <type>(<length>)  [NOT NULL, PK, FK -> <ref>]`), `instructions`, `baseline`**):**
```
TARGET TABLE: <target_table>
DATABASE: <database or CommonStage>

COLUMNS (name, type [attrs]):
<cols_block>

ADDITIONAL INSTRUCTIONS (apply these):
<instructions or "(none)">

BASELINE DDL (default to adapt):

<baseline or "(none — build it from COLUMNS)">
```
**Post:** `_strip_fences`; `_ddl_hallucination_warnings` returns bracketed identifiers not in the known column/table/FK set (→ `warnings`). **Failure:** refusal → 400; continuation on truncation.

---

## P6 — Deploy‑time SQL auto‑fix

**File/Function:** `ai_fix_service.fix_batch`. **Triggered when:** a SQL batch fails during deploy. **No credentials/connection info are ever included.** **System (verbatim):**
```
You are a senior Microsoft SQL Server (T-SQL) engineer. A single SQL batch failed to execute. Return a CORRECTED version of ONLY that batch that fixes the specific error.

RULES:
- The goal is a batch that PARSES and RUNS. Correct ANY T-SQL syntax error you can find in this batch so it executes cleanly — missing or misplaced commas, unbalanced parentheses or quotes, a comma left INSIDE a '-- comment' (which comments it out), missing/extra keywords, stray characters — even if the reported error points at only one spot and even if there is more than one problem.
- Do NOT rewrite unrelated logic, rename objects, or change table/column names, data types, or constraints beyond what makes the batch valid.
- Preserve the existing naming conventions, bracketing ([dbo].[Table]), and structure.
- Return runnable T-SQL for this one batch only. No prose, no markdown fences, no 'GO'.
```
**User (variables:** `err_num`, `err_msg`, `err_line`, `batch`**):**
```
SQL SERVER ERROR <err_num>:
<err_msg>
(near line <err_line>)      (only if err_line present)

FAILING BATCH:
<batch>
```
**Post:** `_extract_sql` salvages SQL from prose/fences; `_REFUSAL` regex detects refusals; unchanged/empty results rejected. **Behavior:** the corrected batch is returned to the deploy orchestrator, which stops in **`needs_review`** — never auto‑deploys.

---

## P7 — Add Column from natural language

**File/Function:** `schema_service.parse_column`. **System (variables:** `SUPPORTED_TYPES`, sorted `LENGTH_TYPES`**; verbatim structure):**
```
You convert a natural-language request into ONE OR MORE new database column definitions for a target table. The user may describe several columns in one request — return EVERY column they describe. Return a JSON object with keys: columns (an array), confidence, note. Each item in columns has keys: column, dataType, length, mandatory, pk, fk, fkReference, afterColumn, description.

RULES (apply to each column):
- dataType MUST be one of: <SUPPORTED_TYPES>.
- length: an integer for length/precision types (<LENGTH_TYPES>); otherwise null.
- column: a valid identifier (letters, digits, underscore; no spaces). Match the casing/naming convention of the EXISTING columns (e.g. snake_case if they use it). It MUST NOT duplicate an existing column name, nor another column in your list (case-insensitive).
- mandatory: true if the request says required/mandatory/not null; else false.
- pk: true only if explicitly asked to be a primary key.
- fk: true only if the request says it's a foreign key / references another table. If fk is true, set fkReference to 'table.column'; else null. Do NOT invent a reference that isn't stated in the request.
- afterColumn: if the request says 'after <col>', put that existing column name; else null.
- confidence: 0-100 for the request overall. Use a LOW value (<=40) and explain in 'note' if it is ambiguous, missing names, or asks for something unsupported. NEVER guess a column name the user did not give.
Respond with ONLY the JSON object. No prose, no markdown fences.
```
`SUPPORTED_TYPES` = varchar, nvarchar, char, text, int, bigint, smallint, tinyint, decimal, numeric, money, float, bit, boolean, date, datetime, datetime2, time, uniqueidentifier. `LENGTH_TYPES` = {varchar, nvarchar, char, decimal, numeric}. **User:**
```
TABLE: <table_name>
EXISTING COLUMNS:
<cols_block>

REQUEST: <instruction>
```
**Expected:** `COLUMNS_SCHEMA`. **Processing:** normalized to the UI shape (`columns` + first `column`), duplicates flagged, length nulled for non‑length types.

---

## P8 — Add Entity from natural language / pasted dictionary

**File/Function:** `schema_service.parse_entity`. **System (variables:** `SUPPORTED_TYPES`, sorted `LENGTH_TYPES`**; verbatim structure):**
```
You turn a request into ONE new database TABLE (entity) definition with its columns, for a data-migration target schema. The request may be a short natural-language description OR a pasted column list / data dictionary (rows, possibly tab- or pipe-separated, often with a header like TableName / Field Name / Data Type / IsNull / Is Primary Key / Type Key / Foreign Key). Return a single JSON object with keys: entity, table, description, isListTable, columns, confidence, note.

RULES:
- entity: a valid identifier (letters, digits, underscore; no spaces). Match the casing/naming convention of the EXISTING entities. It MUST NOT duplicate an existing entity name (case-insensitive).
- table: the physical table name; default it to the same value as entity unless the request clearly gives a different one.
- isListTable: true only if the request says it is a lookup/reference/code/list table.
- columns: an array of the table's columns. Each column: {name, dataType, length, mandatory, pk, fk, fkReference, description}.
- COMPLETENESS: if the request LISTS columns (a dictionary/table/enumeration), you MUST output EVERY column, in order, exactly as given — same names, types, lengths, nullability, PK and FK. Do NOT summarize, sample, deduplicate away, or omit ANY column, no matter how many there are. Only when the request is a vague description (no explicit list) should you infer a sensible minimal set (incl. a primary key) without padding.
- Map any given SQL type to the closest of: <SUPPORTED_TYPES> (e.g. timestamp->datetime2, bool->bit, int4->int, int8->bigint, numeric->numeric). Keep the original name/length; length is an integer for length/precision types (<LENGTH_TYPES>), otherwise null.
- mandatory: true when the source says 'not null'/required; false for 'nullable'. A primary key is mandatory.
- fk: true if a column references another table (e.g. a 'Foreign Key' value like entity.User); set fkReference to that value, else null. Do NOT invent references.
- confidence: 0-100. Use a LOW value (<=40) and explain in 'note' if the request is ambiguous or missing a table name. NEVER invent a table name the user did not give.
Respond with ONLY the JSON object. No prose, no markdown fences.
```
**User:**
```
EXISTING ENTITIES:
<existing_block>

REQUEST:
<instruction>
```
**Expected:** `ENTITY_SCHEMA`. **Processing:** dedupes columns, coerces types, salvages a partial result if the model hits `max_tokens` (with a warning).

---

## JSON schemas (`server/app/schemas/ai_schemas.py`)

All are `type: object`, `additionalProperties: false`.
- **MAPPING_ITEM_SCHEMA** — `{mappings:[], joins:[]}` (both required). Mapping item requires `targetEntity, targetColumn, sourceTable, sourceColumn, mappingType` (enum of 15: Direct, Derived, Lookup, Conditional, Constant, Default, Concatenation, Split, Format Conversion, Data Type Conversion, Calculation, Aggregation, Reference, Custom, Not Mapped), `transformationRule, businessRule, nullHandling, confidence(int), explanation`. Join item requires `targetEntity, joinCondition`.
- **SINGLE_MAPPING_SCHEMA** — flat; required `sourceTable, sourceColumn, mappingType, transformationRule, businessRule, nullHandling, confidence(int), explanation`; optional `lookupTable, defaultValue, joinCondition`.
- **SOURCE_EXTRACT_SCHEMA** — `{tables:[{name, columns:[{name,dataType required; length int|null, businessTerm, description, sample}]}]}`.
- **RICH_EXTRACT_SCHEMA** — as above plus per‑column `mandatory, pk, fk, fkReference`.
- **ENTITY_SCHEMA** — `{entity, table, description, isListTable, columns:[...], confidence, note}` (required `entity, columns, confidence`).
- **COLUMN_SCHEMA** — single, back‑compat (required `column, dataType, mandatory, pk, fk, confidence`).
- **COLUMNS_SCHEMA** — `{columns:[{column,dataType,length,mandatory,pk,fk,fkReference,afterColumn,description}], confidence, note}` (per‑item required `column, dataType, mandatory, pk, fk`; top required `columns, confidence`).

**No secrets, credentials, or personal data appear in any prompt.** The deploy AI‑fix prompt is explicitly verified (by `test_ai_fix_service.py`) to contain no credentials.
