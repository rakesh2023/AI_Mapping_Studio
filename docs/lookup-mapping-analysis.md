# Lookup / Typelist Data Support + Two-Pass AI Mapping — Phase 0 Analysis

> Status: **analysis only — no implementation code written.** This is the Phase 0
> deliverable. Please review before I start Phase 6 step 2.

---

## 0. TL;DR — the three findings that reshape this feature

1. **There is no relational "mapping table."** Field mappings are a **single JSON blob** per client
   stored under the `tenant_documents` doc key **`ai_mappings`** (routed through `clientGet/clientSet` →
   `PUT /api/state/ai_mappings`). So Phase-2's "extend the existing field-mapping table" becomes
   "extend the `ai_mappings` **row shape**", not an `ALTER TABLE`.
2. **There is no migrations framework and no down-migrations.** Schema is `CREATE TABLE IF NOT EXISTS`
   in `server/app/db/schema.sql` (run at startup) plus additive `ALTER TABLE … ADD COLUMN` in
   `app_db.py::_ensure_user_columns`. So "forward + rollback migrations" becomes "idempotent
   `CREATE TABLE IF NOT EXISTS` + additive `ALTER`" — SQLite can't cleanly drop columns and the repo
   has no rollback tooling. New **relational** tables (LookupSet/LookupValue/…) mirror the **KYD tables**.
3. **Target values come from the user, as free text (RESOLVED — no target dictionary).** Per your Q1
   decision: only **source** lookup sets are uploaded; for each, the user records the **target column**
   it feeds and the **expected target values as free text** (e.g. *"1 → open, 2 → closed"*). That
   free-text spec **is** the target authority for Pass 2 — so the `target_typelists`/
   `target_typelist_values` tables are **dropped** from the design, and Pass-2 "no invented code"
   validation checks against the **candidate set parsed from that free text** (soft-flag outsiders,
   since it's prose). This removes the earlier blocker.

Everything else (LLM wrapper, structured-output ladder, per-call usage audit, feature-flag pattern)
already exists and maps cleanly onto the request.

---

## 1. End-to-end flow trace (file → responsibility)

| Stage | Frontend | Backend | Persistence |
|---|---|---|---|
| **Upload (source)** | `js/source-systems.js:158-208` `extractSourceFile()` → `streamExtractFile()` | — | staged in memory (`extractedTables`) |
| **Upload (target)** | `js/target-system.js:206-242` `loadFileTarget()` (xlsx in-browser via `ingestTargetSchemaFile`, else AI `{rich:true}`) | — | staged (`stagedEntities`) |
| **Stream/extract** | `js/common.js:247-306` `streamExtractFile()` (NDJSON, falls back to non-stream) | `ai_routes.py:70-91` `/api/ai/extract-source[-stream]` → `extraction_service.py` (fast-paths: `parse_xlsx_dictionary`, `parse_sql_ddl`; else chunked AI loop `_ai_extract_tables_from_text`) | — |
| **Persist schema** | `saveConnectionForm()` → `upsertDbConnection`/`upsertTargetConnection` | — | **tenant blob** `db_connections` (`conn.tables`) / `target_connections` (`conn.entities`); active target materialized to `target_schema` by `getTargetSchema()` (`js/target-schema.js:17-92`) |
| **Mapping generation** | `js/ai-mapping.js` (`generateMappings` → payload `{source,targetEntities,strategy,businessContext,systemPrompt}`) → `POST /api/ai/generate-mappings` | `mapping_service.py:143` `generate_mappings()` — per-entity, field-chunked (`FIELD_CHUNK=40`), one `call_ai("AI Mapping Generator", …)` per chunk; merges/dedupes by `(targetEntity,targetColumn)`; synthesizes `Not Mapped` for any missing field | — |
| **Persist mappings** | `js/ai-mapping.js:603-692` `buildMappingRows` → `lsSet("aims_ai_mappings", merged)` | — | **tenant blob** `ai_mappings` (JSON array; `null`=never generated, `[]`=cleared — load-bearing) |
| **Review UI** | `js/mapping-workspace.js` (grid, drawer, per-row edit, regenerate one field via `POST /api/ai/regenerate-mapping`); overrides in `mapping_overrides`, history in `mapping_history` | `mapping_service.py:315` `regenerate_mapping()` | tenant blobs |
| **Export** | `js/export.js:40-116` — **client-side only**; CSV/JSON real, XLSX/PDF **simulated** | *(no export endpoint; a `POST /api/exports/generate` is a TODO comment)* | logged to `exports` blob |

LLM plumbing (shared): `ai_client.py::anthropic_client()` (httpx + corporate CA), `call_with_fallback(run, attempts)` + `schema_attempts(schema)` (4-step ladder: json_schema+effort → json_schema → effort → bare), `ai_client_service.py::call_ai(feature, run, attempts)` (the single logging choke point → `ai_usage_logger.log_ai_call`). Model from `config.py::ai_model()`. Calls use **streaming** `client.messages.stream(...).get_final_message()`; structured output via `output_config.format={"type":"json_schema","schema":…}` **and** an in-prompt JSON contract as a fallback; recovery via `parse_mapping_json`. **No tool-use, no explicit max_tokens continuation** (defended by `max_tokens=16000` + field chunking).

---

## 2. Current mapping schema + prompts (recorded verbatim)

### 2a. `ai_mappings` row shape (the de-facto "mapping entity") — `js/ai-mapping.js:669-690`
```
id, targetSystem, targetEntity, targetTable, targetColumn, targetDataType, targetLength,
targetDescription, sourceSystem, sourceSchema, sourceTable, sourceColumn, sourceDataType,
sourceLength, sampleSourceValue, mappingType, transformationRule, businessRule,
defaultValue, lookupTable, nullHandling, confidence, aiExplanation[], validationStatus,
reviewStatus, createdBy, updatedBy, lastUpdated, comments[]
```
Notes: `defaultValue` seeded from the **target field's** `default` (not the model); `lookupTable` **always `""`** at bulk generation (only `regenerate` ever fills it); rows are **re-ID'd `AI-0001…` on every generation** (so the string `id` is *not* a stable key — see §6 design note).

### 2b. Structured-output schemas — `server/app/schemas/ai_schemas.py`
- `MAPPING_ITEM_SCHEMA` (bulk): each mapping requires `targetEntity, targetColumn, sourceTable, sourceColumn, mappingType, transformationRule, businessRule, nullHandling, confidence(int), explanation`; plus `joins[]` of `{targetEntity, joinCondition}`. **No** `lookupTable/defaultValue/targetDataType`.
- `SINGLE_MAPPING_SCHEMA` (regenerate): adds optional `lookupTable`, `defaultValue`, `joinCondition`.
- `mappingType` enum (15): `Direct, Derived, Lookup, Conditional, Constant, Default, Concatenation, Split, Format Conversion, Data Type Conversion, Calculation, Aggregation, Reference, Custom, Not Mapped`.

### 2c. Pass-1 (bulk) system prompt — `mapping_service.py::default_mapping_system_prompt` (34-140), verbatim base + contract
```
You are a senior data-migration mapping engineer. You produce precise source-to-target field
mappings for a database migration. For every target field you are given, choose the single best
source column (from the provided source column list only — never invent a source column). Decide the
mapping type, write a concrete transformation rule (SQL-like), a short business rule, null handling,
and a 0-100 confidence score.
… [MATCHING RULES: cross-table search, name normalization, abbreviation expansion, business-term
   signals, data-type compatibility, prefer meaning over names] …
If, after applying all rules above, no plausible source column exists, use mappingType 'Not Mapped',
set sourceTable and sourceColumn to empty strings, confidence 0, and explain the gap. …
Apply the '{strategy}' strategy: Conservative = only map high-confidence matches; Balanced = map
likely matches and flag uncertain ones; Aggressive = map as many as possible …
```
Appended blocks (verbatim in source): **JOIN CONDITIONS** (`:85-94`), **KEYS & LINEAGE** (`:95-101`),
**POLYMORPHIC COLUMNS** (`:102-115`), **TARGET-ONLY GROUPING / PAYLOAD ID** (`:116-130`). Final
in-prompt JSON contract (`:131-139`):
```
Respond with ONLY a JSON object of the form {"mappings": [ ... ], "joins": [ ... ]}. Each mappings
item has keys targetEntity, targetColumn, sourceTable, sourceColumn, mappingType, transformationRule,
businessRule, nullHandling, confidence (integer 0-100), explanation. Each joins item has keys
targetEntity and joinCondition …. No prose, no markdown fences.
```
User message assembly (`_build_user`, `:214-224`) = source connection + numbered per-table source
columns + `TARGET FIELDS TO MAP` (`_target_block`, tags `mandatory/PK/FK->ref/accepted:…`) + optional
`BUSINESS CONTEXT`. **The UI's edited `systemPrompt` is used verbatim when present** (`:207-210`).

### 2d. Regenerate system prompt — `mapping_service.py:332-357` (verbatim)
```
You are a senior data-migration mapping engineer. Re-map ONE target field, following the user's
instruction exactly. … If they specify a lookup, use 'Lookup' and fill lookupTable.
STRICT SOURCE RULE — do NOT hallucinate: use ONLY tables and columns that appear verbatim in the
AVAILABLE SOURCE COLUMNS list … Return the full updated mapping. Respond with ONLY a JSON object with
keys sourceTable, sourceColumn, mappingType, transformationRule, businessRule, lookupTable,
defaultValue, nullHandling, confidence (0-100 integer), explanation, joinCondition. …
```

### 2e. Confidence / status (already exists)
Thresholds from Settings (`highConfidence:90`, `mediumConfidence:70`). `autoValidationStatus`
(common.js:462): Not Mapped→`Critical`, ≥high→`Passed`, else `Warning`. `confidenceLevel`
high/medium/low. This is the pattern value-level confidence/review will reuse.

### 2f. AI usage audit (already exists) — `ai_usage_logger.py:30-45`
`ai_usage_log(id, call_timestamp, feature_name, model, input_tokens, output_tokens, total_tokens,
duration_ms, status, error_message, user_id, client_id)`. One row **per LLM call** (not per run),
written fire-and-forget on a daemon thread, tenant-scoped from the session.

---

## 3. Conventions I will follow (discovered, not invented)

- **Backend layering** `api → services → parsers/schemas → core` (strict). Services return
  `(payload_dict, http_status)`. Thin blueprints parse → call service → `jsonify`.
- **DB**: stdlib `sqlite3` via `app_db.connect()` + process-wide `write_lock()`; **new tables** via
  `CREATE TABLE IF NOT EXISTS` in `schema.sql`; **new columns on existing tables** via additive
  `ALTER` in `_ensure_user_columns`. Every tenant-scoped table carries `user_id` + `client_id`, both
  `REFERENCES … ON DELETE CASCADE`, with `UNIQUE(scope…)` + a scope index — **mirroring the KYD tables**
  (`schema.sql:54-151`) and their services (`kyd_document_service.py`, `kyd_storage_service.py`).
- **Blob store** for per-client working data: doc keys in `TENANT_DOC_KEYS` (`common.js:103-105`) +
  the server allowlist (`tenant_store_service.py:19-24`); read/write via `lsGet/lsSet` (→ `clientGet/
  clientSet` → `/api/state/<key>`). Preserve `null` vs `[]` semantics.
- **LLM**: reuse `call_ai(feature, run, attempts)` + `schema_attempts(SCHEMA)` + streaming +
  `parse_mapping_json`; every call auto-logged. Feature tags like the existing
  `"AI Mapping Generator"` (e.g. `"Lookup Mapping - Pass 2"`).
- **Prompts today are inline Python string builders** (`default_mapping_system_prompt`). Phase 3 asks
  for versioned template files under `prompts/` — that is a **new convention** (see §7 Q4).
- **Frontend**: vanilla JS, string-concatenated HTML, `escapeHtml()` on all data, Bootstrap 5 +
  Bootstrap Icons, modals via the `injectXModal/openXModal` pattern, and the **mandatory `?v=` cache
  bump** across `pages/*.html`+`index.html` after any css/js edit.
- **Config / feature flag**: env flag in `core/config.py` (mirror `csrf_enabled`/`signup_enabled`),
  read once into `application.config` in `__init__.py`, surfaced to the UI via `GET /api/auth/me`
  (→ `AUTH`) — the established server→client channel (no `features.*` mechanism exists yet).
- **Tests**: `pytest` in `server/tests/` with the conftest temp-DB; **mock the LLM** by
  `monkeypatch.setattr` on `anthropic_client` (see `test_etl_ddl.py`); assert `(payload, status)`.
  **No JS test harness exists** — frontend is verified in the browser.
- **Docs/log**: keep `SESSION_SUMMARY.md`/`CLAUDE.md` updated; commit style = concise subject +
  bullet body + the `Co-Authored-By` trailer.

---

## 4. Feature touch points (every file the feature will require)

**New relational store (mirror KYD):** `schema.sql` — `lookup_sets` (incl. `target_column` +
`target_values_spec`), `lookup_values`, `lookup_value_mappings`, plus `ai_mapping_runs`.
*(No target-value tables — per Q1 the target authority is the set's free-text spec.)*
New services `lookup_service.py` (sets/values CRUD + parsers glue),
`lookup_matcher.py` (deterministic pre-matcher), `lookup_mapping_service.py` (Pass-2 orchestration +
validator). New routes `lookup_routes.py` (`/api/lookups…`) + additions to `ai_routes.py`
(`/api/ai/generate-mappings` gets a `pass`/`force`; new `/api/ai/map-lookup-values`).

**Extend blob row shape (not a table):** add to each `ai_mappings` row — `isLookup`, `lookupSetId`,
`targetTypelist`, `lookupStatus` — set in `js/ai-mapping.js` (bulk build) and read in
`js/mapping-workspace.js` (grid/badges/nested value grid). Pass-1 prompt + `MAPPING_ITEM_SCHEMA` +
in-prompt JSON contract extended to carry `isLookup`/`targetTypelist`.

**Parsers:** new `parsers/lookup_parsers.py` for Shapes A/B/C + normalization (reuse the
`openpyxl`/`_XLSX_HDR` idioms from `file_parsers.py`).

**Prompts:** Pass-1 additions in `default_mapping_system_prompt`; a new Pass-2 prompt builder
(location TBD per §7 Q4).

**Upload UI:** a **required Yes/No "Is this Lookup Data?"** with per-sheet override + parse preview —
attached to **a dedicated Lookup Data manager** (new page, mirroring the KYD upload UX) rather than
the source/target connection forms (rationale in §7 Q3). New `pages/lookup-data.html` + `js/lookup-data.js`,
sidebar entry in `common.js` `SIDEBAR_SECTIONS`.

**Mapping UI:** `Lookup` badge + expandable nested value grid + status chips + `Run Pass 1/2/Both`
controls + review dropdown restricted to typelist values — in `js/mapping-workspace.js` + `css/mapping.css`.

**Export:** extend `js/export.js` to emit `FieldMappings` + `LookupValueMappings` + `Unmapped`
sections (CSV/JSON now; true multi-sheet XLSX still simulated unless we add SheetJS export — §7 Q5).

**Config/flag:** `config.py` `lookup_mapping_enabled()` + `__init__.py` `application.config` +
`/api/auth/me` exposure + `common.js` `AUTH.features`.

**Tests:** `server/tests/` — parser shapes/normalization, Pass-1 `isLookup` detection+binding, Pass-2
validator (reject invented codes; reject missing/duplicate source codes), pre-matcher, mocked-LLM
golden example (`1→open,2→closed,3→draft,9→UNMAPPED`), idempotency + `MANUAL_OVERRIDE` preservation,
`NO_LOOKUP_DATA`→zero LLM calls, and a **regression that the existing non-lookup flow is byte-for-byte
unchanged**.

---

## 5. Conceptual model → repo naming (intent renamed to fit)

| Phase-2 intent | This repo | Where |
|---|---|---|
| `documentType SOURCE_SCHEMA\|LOOKUP_DATA` | not a field on connections; **LOOKUP_DATA becomes its own relational store**, SOURCE_SCHEMA stays the existing (implicit) connection-upload path | new `lookup_sets` etc. |
| `LookupSet` | table `lookup_sets(id, user_id, client_id, lookup_name, source_table, source_column, **target_column**, **target_values_spec** (free text — the target authority), source_document, version, value_count, created_at, …)` | `schema.sql` |
| `LookupValue` | table `lookup_values(id, lookup_set_id FK CASCADE, user_id, client_id, code, description, sort_order, is_active, parent_code, effective_from, effective_to, created_at)`, `UNIQUE(lookup_set_id, code)` | `schema.sql` |
| extend field-mapping table | **extend the `ai_mappings` JSON row**: `isLookup`, `lookupSetId`, `targetTypelist`, `lookupStatus` (`not_applicable\|pending\|in_progress\|complete\|partial\|no_lookup_data`) | `js/ai-mapping.js`, prompt+schema |
| `LookupValueMapping` | table `lookup_value_mappings(id, user_id, client_id, lookup_set_id FK, source_code, source_description, target_code, target_description, confidence, rationale, mapping_type, is_reviewed, reviewed_by, reviewed_at, ai_run_id, created_at)`, **`UNIQUE(lookup_set_id, source_code)`** (target authority is the set's `target_values_spec`; keying by the set + source code solves reuse across every column bound to that set) | `schema.sql` |
| value `mappingType` enum | TEXT + CHECK: `exact\|semantic\|defaulted\|unmapped\|manual_override\|ignored` (lowercase, matching the KYD `status`/`content_kind` convention) | `schema.sql` |
| Target typelist dictionary | **REMOVED per Q1** — no target-value tables; the set's free-text `target_values_spec` is the authority, parsed into a candidate set for validation | — |
| `AiMappingRun` | new `ai_mapping_runs(id, user_id, client_id, pass_no, prompt_version, model, input_tokens, output_tokens, duration_ms, counts_json, status, error, created_at)` — the per-call `ai_usage_log` stays as-is | `schema.sql` |

---

## 6. Design notes / risks discovered

- **Value mappings must NOT be keyed by a field-mapping id.** `ai_mappings` rows are re-IDed
  (`AI-0001…`) on every generation and live in a blob. Keying `lookup_value_mappings` by
  **`(lookup_set_id, target_typelist, source_code)`** is both stable and *is* the "map a shared
  lookup once, reuse everywhere" requirement — a field mapping just stores `lookupSetId` +
  `targetTypelist` and looks the values up.
- **Pass 2 is relational; Pass 1 stays blob.** This hybrid is deliberate and matches the repo (KYD is
  relational, mappings are blob). It keeps the existing non-lookup flow untouched.
- **Structured output is supported** (`output_config.format` json_schema + the ladder), so the Phase-3
  "schema-enforced output + repair-retry (max 2)" is achievable; the repair-retry is a small addition
  on top of `parse_mapping_json` (today it returns `{"mappings":[]}` on failure rather than retrying).
- **Idempotency & `MANUAL_OVERRIDE`**: the relational store makes "never overwrite reviewed rows unless
  `force`" a simple `WHERE is_reviewed=0 AND mapping_type<>'manual_override'` guard — cleaner than it
  would be in the blob.

---

## 6b. Recommended resolutions (my pick for each open point)

- **Q1 (target values) — DECIDED by you:** upload **source lookup sets only**; the user records each
  set's **target column** + **expected target values as free text** (e.g. *"1 → open, 2 → closed"*),
  which is the Pass-2 target authority. **No** target-value tables. Pass-2 validation parses that free
  text into a candidate set and soft-flags anything outside it.
- **Q2 (upload home):** a **dedicated "Lookup Data" page** (mirror KYD).
- **Q3 (prompts):** **inline builders + `PROMPT_VERSION` constant** (conform to repo convention; no
  new templating layer), version recorded in `ai_mapping_runs`.
- **Q4 (run audit):** **new `ai_mapping_runs` table** (per-call `ai_usage_log` lacks pass/counts).
- **Q5 (export):** ship the new data in **real CSV/JSON** now; leave XLSX simulated.
- **Keying:** `lookup_value_mappings` unique on **`(lookup_set_id, source_code)`** (the set's
  `target_values_spec` is the target authority).
- **Lookup detection is target-flag-driven (DECIDED):** the target schema's `isListTable` flag — to be
  **relabelled "List Value?"** in the Target System grid + Edit Column modal — is the **authoritative**
  trigger for `isLookup` on a field mapping. A target column with **List Value = Yes** ⇒ its mapping
  is a lookup and needs Pass 2. The `_CD`/`_CODE`/`_TYPE`/low-cardinality heuristics remain only a
  **secondary suggestion** for columns the user didn't flag (surfaced as a hint, never overriding the
  flag). "Generate lookup value mappings" (Pass 2) is a **separate, independently-run** action from
  structural (Pass 1) mapping.
- **UI touch point (new):** relabel the `LIST TABLE` column header → **"List Value?"** and render it as
  **Yes/No** (currently a `List` badge / `-`) in `js/target-system.js` (grid `renderTargetFields` +
  the Edit Column modal checkbox label). The dictionary-upload header synonyms
  (`typelist/lookup/…` in `js/target-schema.js`) are unchanged — only the display label changes.
- **The two mappings are DECOUPLED (DECIDED — deviation from the original "Pass 2 consumes Pass 1"):**
  because the source lookup upload already carries the **target column + expected target values**, the
  **lookup value mapping is self-contained** and can be generated **before, after, or without** the
  structural field mapping. Lookup mapping = per lookup set (`source code → target code`), driven only
  by the set's source values + free-text spec. The structural mapping merely **links** to the set (by
  target column, flagged via `List Value?`) so the grid can nest the value mappings — it is **not a
  prerequisite**. No implicit triggering in either direction.

## 6c. REVISED flow — AI-driven, no binding-sheet upload (supersedes earlier upload assumptions)

Per the latest decision, the "Lookup Mapping" page's grid (Target table · Target column · Source table ·
Source column · Expected mapping) is **AI-populated**, not uploaded:

1. **Target list columns (automatic, deterministic):** enumerate every active-target column with
   **List Value = Yes** (`isListTable`) → fills *Target table / Target column*.
2. **Source column (AI):** for each such target column, AI finds the best-matching *Source table /
   Source column* from the saved source system(s) — a focused structural match limited to lookup columns
   (reuses the mapping prompt's matching rules, scoped to these columns).
3. **Source lookup values (NEW feature in the Source Systems section):** the user adds a source coded
   column's values (`code → description`) — persisted as a `lookup_set` bound to that source column.
   This is where the source values enter the system (not via a separate lookup-upload page).
4. **Expected mapping (AI):** AI derives `sourceCode → targetValue` pairs **from the source lookup
   values**, where the **target value is the normalized source description** (e.g. `1=Open` → `open`;
   lowercase/trim/spacing) — **no separate target value list required** (DECIDED). Populates the
   Expected mapping column → persisted as `lookup_value_mappings` for review/edit. (If a target
   `accepted` set ever exists it can be layered later, but it is not required.)
5. **Lookup Mapping page:** shows the populated grid; user reviews/edits/approves; deterministic
   pre-match still short-circuits obvious pairs before any LLM call.

**Touch points added by this revision:**
- **Source Systems (`js/source-systems.js` + a new source endpoint/service):** a "Lookup values"
  editor on a source column (add/upload `code → description`) → `lookup_sets`/`lookup_values`, bound to
  `source_table.source_column`.
- **New AI endpoints:** (a) *match source column* for the target list columns; (b) *generate expected
  mapping* from a source lookup set + target column.
- **New Lookup Mapping page** (`pages/lookup-mapping.html` + `js/lookup-mapping.js`) rendering the
  five-column grid, populated by the above; sidebar entry.
- Tables from §5 stay (`lookup_sets`, `lookup_values`, `lookup_value_mappings`, `ai_mapping_runs`);
  `lookup_sets` now binds primarily to a **source** column and to a **target** column.

## 7. Open questions & assumptions

**RESOLVED**

1. ~~Where do the authoritative TARGET typelist values come from?~~ **DECIDED:** they don't come from an
   uploaded dictionary. Only **source** lookup sets are uploaded; the user records each set's
   **target column** and **expected target values as free text** (*"1 → open, 2 → closed"*), which is
   the Pass-2 target authority. No blocker remains; Pass 2 proceeds using the free-text spec (parsed
   into a candidate set for soft validation).

**Decisions I need from you**

2. **Where does the "Is this Lookup Data?" upload live?** My assumption: a **dedicated "Lookup Data"
   page/manager** (mirroring KYD), *not* the Source/Target connection forms — because lookup data is
   neither a source schema nor a target schema, and a relational store + versioning + orphan-binding
   needs its own home. OK to add a new sidebar page?
3. **Prompts as template files vs inline builders.** The repo convention is **inline Python string
   builders**; Phase 3 asks for `prompts/*.v1.md` files. Introducing a `prompts/` dir + loader is a new
   convention. My assumption (honoring "conform to existing conventions"): keep prompt **builders in the
   service** but add an explicit `PROMPT_VERSION` constant recorded in `ai_mapping_runs`. Prefer the
   `.md` files instead? Say so.
4. **`ai_mapping_runs` table vs reuse `ai_usage_log`.** Assumption: add the small per-run table (pass,
   prompt version, counts) since `ai_usage_log` is per-call and has no counts/pass. OK?
5. **XLSX export.** Real multi-sheet XLSX export doesn't exist (simulated today). Assumption: I deliver
   the new `LookupValueMappings`/`Unmapped` data in the **real** CSV/JSON exports now, and leave XLSX as
   the existing simulation unless you want me to wire SheetJS write-side (bigger).

**Assumptions I'm making unless you object**

- Feature is **off by default** behind `AIMS_LOOKUP_MAPPING_ENABLED` (mirrors `signup_enabled`),
  surfaced to the UI via `/api/auth/me`. Legacy flow only ever runs Pass 1; **Pass 2 is never implicit**.
- New relational tables are **tenant-scoped** (`user_id`+`client_id`, cascade) exactly like KYD;
  deleting a client removes its lookup data + value mappings by cascade (I'll extend the existing
  `client_service.delete_client` physical-table cleanup if any dynamic tables are introduced — likely
  none needed here).
- Backfill for existing `ai_mappings` rows = set `isLookup:false`, `lookupStatus:'not_applicable'` lazily
  on next load (blob rows have no migration step; the reader defaults missing keys).
- "Migrations forward+rollback" is satisfied by idempotent `CREATE TABLE IF NOT EXISTS` + additive
  `ALTER`; there is **no rollback tooling** in this repo and I won't invent one.

---

## 8. Proposed delivery order (Phase 6, adjusted to this repo)

1. **This doc** → *stop for approval* (you are here).
2. `schema.sql` tables + `lookup_service` + repository-style accessors + unit tests (mirror KYD).
3. Lookup upload: Yes/No question + Shapes A/B/C parsers + persistence + tests.
4. ~~Target typelist dictionary~~ **(removed per Q1)** — instead, capture `target_column` +
   `target_values_spec` on the lookup set (part of steps 2–3); no separate target-value store.
5. Pass 1: `isLookup` detection + `targetTypelist` + lookup-set binding (prompt+schema+row shape) + tests.
6. Pass 2: deterministic pre-matcher + prompt + validator + orchestrator (grouped by
   `(lookup_set, target_typelist)`) + golden test.
7. API endpoints. 8. UI. 9. Export. 10. Docs (`CLAUDE.md` + `CLAIM_STATUS` walkthrough).

Each step = a small commit, **pausing for your review**, and each keeps the existing non-lookup flow
provably unchanged (regression test in step 5+).
