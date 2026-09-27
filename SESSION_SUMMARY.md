# AI Data Conversion Studio — Session Summary

_Last updated: 2026-09-26_

A PwC-themed, AI-assisted **source-to-target data migration mapping** tool
(insurance / Guidewire-inspired). Static HTML/CSS/vanilla-JS frontend + a
Python/Flask backend that talks to a live SQL Server and the Claude API.

---

## Latest changes (most recent first)

- **Data Reconciliation — new "Non-Financial Recon" tab (report-table + cursor proc, modeled on the
  client's real SP).** A third item under *Data Reconciliation* (`pages/data-reconciliation-nonfin.html` +
  `js/data-reconciliation-nonfin.js`) that reuses the IN-vs-OUT table/column picker (migration schema
  CMT/PMT/BMT, `reconcile-tables` / `reconcile-compare-columns`) and asks for a **recon base name** +
  **common key** (single or composite, comma-separated). It generates a **deterministic (no-AI)** SQL script:
  `IF OBJECT_ID … CREATE TABLE [dbo].[<Name>_CMT]` and `_Legacy` (real column types from the schema; key
  defaulted NVARCHAR(255)), a **report table** `[dbo].[<Name>_Recon_Report]` (`Recon_RunDate`, key col(s),
  `AttributeName`, `CMTValue`, `LegacyValue`, `Status`), and `CREATE OR ALTER PROCEDURE
  [dbo].[usp_Reconcile_<Name>]` that TRUNCATEs the report, **cursors over `INFORMATION_SCHEMA.COLUMNS`** of
  the CMT table (minus the key), and per column builds dynamic SQL diffing the two tables on the key via
  **FULL OUTER JOIN** (NULL-safe COALESCE), writing only DIFFERING rows with a `Status` of
  `Match` / `Missing in CMT` / `Missing in Legacy` / `Mismatch`, then `SELECT … WHERE Status <> 'Match'`.
  Improvements over the sample SP: FULL OUTER JOIN (the sample's LEFT JOIN can't see target-only rows),
  no hard-coded `USE`/DB, `CREATE OR ALTER`, auto report-table DDL + truncate, inserts only differences.
  Backend: `cc_sql_service.generate_nonfin_recon_sql` + `_tsql_type`/`_safe_ident`, route
  `POST /api/ai/reconcile-nonfin-sql`, `migration_schema_service.column_defs`. Both recon pages' column
  pickers also gained a **column-name search** (filters in place, preserves selection; All/None act on the
  visible/filtered columns). **Versioning** added (reuses `artifact_version_service`, feature
  `reconcile_nonfin`): a **Save version** button (main + fullscreen) and a **Saved Versions** card with
  Load / Download / Delete, via routes `GET/POST /api/ai/reconcile-nonfin/versions` and
  `GET/DELETE /api/ai/reconcile-nonfin/versions/<id>`. Server restart required.

- **IN vs OUT Comparison — match on PK with OUT-prefix stripping; ignore FK key churn.** The OUT database
  regenerates the surrogate key as `<random-number>_<original PMT_ID>` (same id, prefixed). So the proc now
  matches rows on the PK after **stripping a leading `<digits>_` prefix from the OUT key**
  (`CASE WHEN o.[K] LIKE '[0-9]%[_]%' AND SUBSTRING(...) NOT LIKE '%[^0-9]%' THEN STUFF(o.[K],1,CHARINDEX('_',o.[K]),'') ELSE o.[K] END`),
  ANDed across composite keys. The value comparison **excludes the PK column(s) and all FK columns**
  (`migration_schema_service.fk_map`), since FKs also carry the rewritten/prefixed keys and would otherwise
  flood the diff with key churn instead of real data changes. `@tables` now carries
  `(TableName, PkCols, IgnoreCols)`; conventions doc + fallback updated. Backend-only change.

- **IN vs OUT Comparison — simplified to one output + metadata-driven proc (scales to all tables).**
  Dropped the three comparison types; the page now produces a single result set shaped
  `[Table Name] · [Column name] · InValue · OutValue` — one row per column whose value changed between the
  IN and OUT databases (PK-matched rows, NULL-safe diff). **All tables are selected by default** (the table
  list loads and selects-all on open). Fixed the "some tables get dropped" bug: `schema_context` capped
  grounding at 20 tables, so only the first 20 reached the AI. The generated proc is now **metadata-driven**
  — it injects every selected table + its PK into a `@tables` variable, loops with a cursor, discovers each
  table's non-key columns from `INFORMATION_SCHEMA.COLUMNS` (columns common to both DBs) at run time, and
  builds the diff via dynamic SQL into a `#diffs` temp table — so it stays compact (~350 lines) and covers
  **all** selected tables regardless of count. New `migration_schema_service.key_map()` returns each table's
  PK (explicit `pk` flag, else the `PMT_ID`/`_ID1`/`_ID2` convention via `_MIG_PK_RE`), handling composite
  keys. `generate_compare_sql` no longer uses the capped `schema_context`; `max_tokens` raised to 16000 for
  generation + re-validation. Structural check made CASE-aware (a `CASE…END` no longer trips the BEGIN/END
  balance). Verified end-to-end: all 244 test-client tables covered (244/244, none missing).

- **IN vs OUT Comparison — quoting, re-validation, versioning, fullscreen.** Follow-ups on the page below:
  (1) **Identifier quoting** — conventions doc + fallback now require SQL Server bracket format via
  `QUOTENAME(...)` on EVERY identifier (db/schema/table/**and every column**) because CMT/PMT names can be
  reserved keywords or contain spaces. (2) **Re-validation** — after generation a focused second AI pass
  (`_revalidate_compare_sql`) reviews the proc for T-SQL syntax errors / missing QUOTENAME and returns a
  corrected, cleanly-formatted version; a deterministic `_structural_sql_issues` check (balanced
  parens/BEGIN-END, single CREATE PROC) surfaces residual warnings. The garbling `sqlparse` reindent is
  skipped for the proc. Response adds `revalidated`/`issues`; the console shows the outcome. (3) **Editable
  default prompt** — the prompt textarea is pre-filled with an editable `DR_DEFAULT_PROMPT`, persisted per
  source in localStorage, with a **Reset to default** button. (4) **Versioning** (reuses
  `artifact_version_service`, feature `reconcile_compare`): **Save version** (main + fullscreen), a **Saved
  Versions** table with Load / Download / Delete, via new routes `GET/POST /api/ai/reconcile-compare/versions`
  and `GET/DELETE /api/ai/reconcile-compare/versions/<id>`. (5) **Fullscreen editor** modal mirroring the ETL
  page, edits sync back live. No DB migration (artifact_versions already exists).

- **Data Reconciliation — new "IN vs OUT Comparison" page.** A second item under *Data Reconciliation*
  (`pages/data-reconciliation-compare.html` + `js/data-reconciliation-compare.js`) that turns the client's
  uploaded migration schema (CMT/PMT/BMT, from **Product Schema**) into an AI-generated T‑SQL **stored
  procedure** comparing a migration tool's INPUT vs POST‑CONVERSION OUTPUT databases. Both databases are
  assumed to share the same schema on the same instance, so the proc takes the **IN/OUT database names as
  parameters** (`@InDbName`/`@OutDbName`/`@SchemaName`) and diffs them with **dynamic SQL** (`sp_executesql`
  + `QUOTENAME`). User ticks any of three comparison types — row‑count parity, key‑level missing/extra
  (`EXCEPT`/`NOT EXISTS` on the `[PK]`), column value mismatches (NULL‑safe) — plus an optional free‑form
  prompt, and can scope to selected tables (with Select all). Backend is purely additive:
  `cc_sql_service.generate_compare_sql` (reuses `_provider`/`_select_tables`/`_format_sql`/`call_ai`), a new
  route `POST /api/ai/reconcile-compare-sql`, and a new conventions doc
  `server/app/prompts/reconcile_compare_sql.md` (overrides the base "single read‑only SELECT" rule to permit
  the `CREATE OR ALTER PROCEDURE`). Reuses the existing `reconcile-context`/`reconcile-tables` GET routes
  (`source=cmt|pmt|bmt`). No new server-side stores; conversation memory stays in `sessionStorage`. Frontend
  reuses the SQL Assistant's banner/console/copy/download plumbing. Existing SQL Assistant page unchanged.

- **Source Data Filter — scales to any table count (chunk-and-merge join inference).** Removed the
  60-table cap (`MAX_TABLES` is now a high safety ceiling; new `JOIN_CHUNK = 40`). Join inference no longer
  a single call: the OTHER tables are split into chunks of 40, each AI call sees the MAIN table + its chunk,
  and the per-chunk join graphs are merged (dedup by table). The condition→predicate is interpreted once
  (first chunk). Per-chunk retry-once-then-skip (a failed batch doesn't abort the run); if every batch
  fails a clear error is returned. Response adds `batches`/`tableCount`. Also added `sqlparse` formatting of
  every generated SELECT / INSERT…SELECT (multi-line, keywords upper-cased, terminating `;`). Verified: real
  18-table source → 1 batch (unchanged); synthetic 51-table source → 2 batches → 51 queries (nothing
  dropped). Trade-off: ~1 AI call per 40 tables (slower + more cost for huge schemas); rare multi-hop joins
  spanning chunks may be missed.

- **Source Data Filter — manual "Save version" (was auto-save).** Removed the auto-save-on-generate; the
  generate route now just returns the queries. Added `POST /api/ai/source-filter/versions` (route passes the
  flat client payload to `source_filter_store_service.save_version` as both body+result). A **Save version**
  button in the results header saves ALL current queries — capturing edits from each card's textarea (and
  the fullscreen editor) — as a new version with the set's metadata; the version dropdown refreshes and
  selects it. Loading a version stores its metadata so edit→Save records the same context. Also added a
  **per-query fullscreen expand** button on each Source Data Filter query card (mirrors ETL's expand), with
  live sync back to the card.

- **ETL Code versioning — one saved script (and version sequence) PER table.** Even when several tables
  are generated together, **Save version** now stores **one version per table**: the editor is split by the
  per-table delimiter (`\n\nGO\n\n\n`, `ETL_JOIN`) aligned to the generated table list, and each piece is
  saved under its own `group_key` (`<kind>||<table>`). Added a `group_key` column to `artifact_versions`
  (+ `_ensure_artifact_columns` migration in `app_db.py`); `save_version` now increments the version **per
  (tenant, feature, group_key)**, so each table has an independent v1/v2/v3 sequence. The Saved Versions
  table groups by `group_key` (one row per table) with the version dropdown (latest on top) driving
  Load/Download/Delete. (Edited/pasted SQL that no longer matches the delimiter count falls back to a single
  combined version.)

- **ETL Code versioning reworked to manual save + Saved Versions table.** Per feedback: versions are NOT
  auto-saved on generate anymore. A **Save version** button (Generated SQL header) saves the current editor
  SQL as the next version (SQLite); a **Saved Versions** table lists all versions (Version / Type / Tables
  / Saved / Size / actions) with **Load** (into editor), **Download**, **Delete**. Loading a version, editing,
  and clicking Save again creates the NEXT version and toasts "Saved as version N". `artifact_version_service.
  list_versions` now returns `bytes` (size). The old auto-save-on-generate + version dropdown were removed.
  (localStorage "Generated Files" per-table list is still separate/untouched.)

- **ETL Code — generated SQL saved & versioned in SQLite (dropdown + delete).** Added a **generic**
  versioned-artifact store: table `artifact_versions` (feature-scoped, `server/app/db/schema.sql`) +
  `artifact_version_service.py` (save/list/get/delete; version auto-increments per user+client+feature;
  tenant-scoped, `write_lock`). ETL routes on the AI blueprint (`feature="etl_code"`): `GET/POST
  /api/ai/etl/versions`, `GET/DELETE /api/ai/etl/versions/<id>`. Frontend (`etl-code.html` +
  `js/etl-code.js`): each **Generate ETL Code** / **Create Table** now also saves the combined script as
  a new version (best-effort; the existing localStorage "Generated Files" per-table list is untouched); a
  **Version dropdown** (v1/v2/v3, latest first) with a **trash icon** sits in the Generated SQL header —
  on load the latest version's SQL is shown; picking a version loads it into the editor; the trash icon
  deletes the selected version. Schema/backend change ⇒ server restart (see [[dev-server-no-autoreload]]).

- **Source Data Filter — generated queries saved & versioned in SQLite.** New table `source_filter_runs`
  (`server/app/db/schema.sql`) + service `source_filter_store_service.py` (mirrors lookup_service: tenant-
  scoped by `user_id`/`client_id`, `write_lock`). Every successful `POST /api/ai/source-filter-sql` is
  **auto-saved as the next version** (version auto-increments per tenant; best-effort — never fails the
  generate) and the response carries `version`/`versionId`. New read routes `GET /api/ai/source-filter/
  versions` (metadata, newest first) and `GET /api/ai/source-filter/versions/<id>` (full queries). Frontend
  (`source-data-filter.html` + `js/source-data-filter.js`): a **Version dropdown** in the results header —
  on page load the **latest** version's queries are shown; picking an older version redisplays all its
  queries; a new generate refreshes the dropdown and selects the new version. Payload (queries + grounded +
  unrelated + keyPredicate) stored as JSON per row. NOTE: schema/backend change ⇒ server restart required
  (see [[dev-server-no-autoreload]]).

- **Fix — Lookup Mapping grid flooded with imported Guidewire typelists.** For a client whose only
  lookup sets are the imported dictionary typelists (`cctl_/pctl_/bctl_`, `source_document=dictionary.zip`,
  no target), the grid listed all of them (e.g. 492 rows under "(no target table)") because
  `filterToMappedTables` falls back to "show everything" when there are no generated mappings. Those
  typelists are REFERENCE code lists (they feed the **Expected GW Values** via `/api/lookups/snapshot`),
  not mappable rows. Added `_mappableSets()` / `_isImportedTypelist()` in `js/lookup-data.js` (prefix rule
  mirrors the backend's `lookup_service.delete_all_sets`) and applied it to `_allLookupSets` on load, so
  typelists never appear as grid rows while the Expected GW Values column (built from the snapshot index)
  is unaffected. Verified: `/api/lookups` returns 492 typelists → 0 mappable in the grid; `/api/lookups/
  snapshot` still returns all 492 with codes; clear-all keeps the typelists.

- **Fix — Lookup Mapping wrongly forced a live-DB lookup for file/PDF sources.** On the Lookup Mapping
  page (`js/lookup-data.js`), the auto-populate step picked *any* live SQL Server connection
  (`lkPickSource` excluded File System sources) and tried to read Legacy values from it — so when the
  mapping was built on a **File System (DDL/PDF/dictionary) source** but the client also had a live SQL
  connection (e.g. `Legacy_Claim_SQL`/`CommonStage`), it queried the wrong live DB. Replaced with
  `lkResolveSource()`, which infers the mapping's true source and whether it is **live**: it matches the
  **generated mappings' `sourceTable`** (the reliable origin signal — the lookup sets' own `source_table`
  is usually blank) against each **File System connection's extracted tables**; a match ⇒ non-live. For a
  **non-live source** `autoPopulateFromDb` no longer hits the database — it leaves the **Legacy (source)
  values blank**, keeps the **Expected GW Values** (from the dictionary), and shows a clear **non-live
  (file) connection indicator** banner. Live SQL sources keep the existing auto-populate path.
  **Explicit Legacy-source picker** (`#lkSourceSelect` on the page + `populateSourceSelect`/
  `updateSourceKind` in JS): auto-detection is only a default — since the same table name can exist in
  both a file and a live source (so auto-resolution always picks the file source), the user can now
  **choose the source** (live vs file). The choice is persisted per client (`aims_lk_source_<clientId>`),
  wins in `lkResolveSource` (step 0), shows a live / non-live badge, and re-runs the populate flow on
  change — so both scenarios are deliberately testable.

- **New feature — Source Data Filter (legacy → prestage subset extraction).** New sidebar section
  *Source Data › Source Data Filter* (`pages/source-data-filter.html` + `js/source-data-filter.js`).
  Prepares the **filtered extraction SQL** you run against a legacy system (DB2 / Oracle / SQL Server /
  mainframe) to load only a subset into a local **prestage** DB (which then becomes the mapping source).
  The user picks a **source** (its tables/columns come from the DDL/PDF/dictionary extraction, or live
  SQL Server metadata), a **main table + key column**, a **target dialect**, and a **population** — either
  specific **key values** or a plain-English **condition** (e.g. "only open claims") with an optional row
  **cap**. New backend service `server/app/services/source_filter_service.py` + route
  `POST /api/ai/source-filter-sql` (in `ai_routes.py`). **AI does only the intelligent parts** (returns a
  compact JSON *join graph* + an interpreted WHERE predicate — can't truncate); the **server assembles one
  read-only `SELECT` per table deterministically**, every query filtered to the *same* key set (a literal
  `IN (...)` list, or `IN (SELECT <key> FROM <main> WHERE <predicate> <dialect row-cap>)`) so the prestage
  subset stays referentially consistent. Dialect governs only the row-cap syntax (`TOP (n)` vs `FETCH FIRST
  n ROWS ONLY`); identifiers are emitted plain. Grounded strictly on the selected source's schema; hardened
  prompt (use only verbatim tables/columns, never invent). AI usage logged as `Source Data Filter - Join
  Graph`. **v1 = SQL only** (editable per-table cards, Copy all / Download .sql; no execution/prestage-load
  yet). Modeled on the Data Reconciliation SQL Assistant.
  **Control (driver) table option** (`useControlTable` + `controlTable` name, default `CTL_<MAIN>_KEYS`):
  when enabled the output prepends a **control-table setup script** — `CREATE TABLE` (key column typed from
  the source schema) + per-key `INSERT`s (keys mode) or `INSERT … SELECT … <dialect row-cap>` (condition
  mode) — and **every extract JOINs the control table** (`JOIN <ctl> ON ctl.<key> = m.<key>`) instead of an
  inline `IN (...)`, so the population is data-driven, reusable and re-runnable. Hardening from debugging:
  assembly is fully type-safe + wrapped so a malformed AI graph returns a clean error instead of a 500, and
  the client surfaces the real HTTP status/body on failure (the earlier generic "Could not generate SQL"
  masked a 500; a separate 405 turned out to be stale duplicate dev-servers on :8008/:8080, not a code bug).

- **ETL code generation prompt hardened (source-only; no synthetic keys).** Two rules added to the
  stored-proc system prompt in `etl_service.py`: (1) **SOURCE-ONLY** — every expression/FROM/JOIN/subquery
  must reference only SOURCE tables/columns (+ `[LookupData]`); it must **never query the target table**
  to look up a value (the model had emitted `(SELECT PMT_ID FROM Policy WHERE …)`); the target name
  appears only in `INSERT INTO`. (2) **No synthetic keys/batch metadata** — never use HASHBYTES / NEWID /
  CHECKSUM / ROW_NUMBER / a `@BatchId` param for id/PayloadId/key columns unless the user's Additional
  Instructions ask; fill them from the mapped source (or default/NULL). Backend change → server restart.
  **Same two rules applied at the root — the AI *mapping-generation* prompt (`mapping_service.py`)**:
  the "TARGET-ONLY GROUPING / PAYLOAD ID" section no longer defaults to `HASHBYTES(... + BatchId)` (now
  'Not Mapped' unless the user's Business Context explicitly asks); a new SOURCE-ONLY rule forbids target
  sub-selects in transformationRule/joinCondition; the polymorphic "Reference" value column now maps from
  its SOURCE FK (never a `SELECT … FROM <target>` WHERE). The single-field `regenerate_mapping` prompt got
  the same source-only / no-synthetic-keys clause.

- **Removed the single-user / local-signin build and its packaging.** Deleted the entire
  `singleuser/` folder (the additive launcher `run.py` that auto-logged-in a hard-coded local user
  `local@studio.local` + the first-run `/setup` "bring-your-own-key" wizard: `setup_routes.py`,
  `setup.html`, `_envfile.py`, `run.bat`/`run.sh`) and the entire `packaging/` folder (PyInstaller
  `aims.spec` + Inno Setup `installer.iss` + `build.ps1`, which existed only to ship that launcher as
  a Windows `.exe`). The app now supports **one mode: the multi-user Flask service** (`python main.py`
  / WSGI). Safe removal — `singleuser/run.py` was purely additive and nothing under `server/app`, `js`,
  `pages`, `css` imported from either folder. **`server/app/core/config.py` cleaned up**: dropped the
  now-dead `sys.frozen`/`_MEIPASS` bundle branch (and the unused `import sys`); `ROOT`/`SERVER_DIR` are
  plain path logic again. `_load_dotenv()`/`AIMS_DISABLE_DOTENV` untouched (tests use it). `.gitignore`
  lost the moot `singleuser/.venv/` and `packaging/*` build-artifact entries. The `deck/` Tech Stack
  PDF was regenerated to drop the single-user distribution content.

- **Source Metadata Explorer is now editable (table/column descriptions, business terms, PK, FK) and the
  edits feed AI mapping generation.** The page (`pages/metadata-explorer.html` + `js/metadata.js`) was
  read-only; live SQL Server reads come back with blank business term/description and files often lack
  PK/FK. The grid is **always editable**: a leading **pencil** on each row opens an Edit-column **modal**
  (Description textarea, Business Term, PK, FK + autocomplete reference picker of the source's own
  tables/columns), and **PK / FK are also inline click-to-edit** in the grid (FK cell widened for the
  `table.column` ref). **Table & column names are locked** (not editable). Edited values show simply in
  **green text** (no badge/box; forced green via a scoped `#columnTable td.cell-user-text` rule).
  There are **no edit toolbar buttons** — the grid is always editable and autosaves; the search box is
  the only toolbar control. (Earlier "Edit structure" toggle, "Suggest keys", and "Reset my edits"
  buttons were all removed at the user's request; edits still clear via the global Reset Application.)
  - **Storage:** a new non-destructive overlay `aims_source_meta_overrides` (tenant/server-synced,
    modeled on `aims_mapping_overrides`) keyed by `connId → table → column`, applied over the pristine
    base load — never mutates the live DB read; re-extraction keeps edits. Helpers in `js/common.js`:
    `getSourceMetaOverrides`, `saveSourceMetaColOverride`/`saveSourceMetaTableOverride`,
    `clearSourceMetaOverrides`, `hasSourceMetaOverrides`, `applySourceMetaOverrides(meta, connId, {badge})`.
    **`source_meta_overrides` was added to `tenant_store_service.ALLOWED_DOC_KEYS`** — without it the
    server rejects the PUT (400) and edits vanish on refresh. **Server restart required** (`use_reloader=False`).
  - **Downstream:** `js/ai-mapping.js loadSource()` and `js/mapping-workspace.js loadSourceSchema()`
    overlay the same edits (`badge:false`) before sending source schema; business terms/descriptions
    already flowed into the generation prompt, and `mapping_service.py generate_mappings` now also emits
    per-source-column **PK / FK -> ref** hints so join inference uses explicit source keys.
  - Also fixed a latent XSS: the column renderer now escapes name/type/business-term/default.
  - No backend restart strictly required for the prompt tweak on `debug=True`, but restart to be safe.

- **BillingCenter is now a first-class product in Data Reconciliation / the dictionary+schema path.**
  Previously the SQL Assistant treated Product as binary *policy vs. else(=claim)*, so a **billing**
  client fell through to ClaimCenter: the schema source showed "ClaimCenter dictionary", the billing
  entityModel.xml was indexed into the `cc_dict_*` tables, and generation used `claimcenter_sql.md`.
  Billing is now fully symmetric with claim/policy — its own **BillingCenter dictionary** source
  (`bc_dict_*` + `billingcenter_sql.md`) and a **BMT — Billing Migration Tool** schema source
  (mirroring CMT/PMT).
  - **Backend:** new `bc_dict_*` tables (`schema.sql`, idempotent — auto-create on restart); new
    `bc_dictionary_service.py` (thin wrapper, `PREFIX="bc_dict"`); `cc_dictionary_service` learns the
    `bc_dict` prefix and `detect_app` now recognises `bc_/bctl_` → `"billing"`; `lookup_service.import_document`
    routes a billing dictionary → `bc_dict_*` (key `bcDictionary`) and the product-mismatch guard covers
    billing; `cc_sql_service` gains a `billingcenter` provider + `bmt` migration branch, `_BC_PROMPT`/
    `_BC_FALLBACK`, and `list_sources` now lists all six; `migration_schema_service.DOC_KEY` adds
    `bmt→bmt_schema`; new `server/app/prompts/billingcenter_sql.md` (BC ledger/`bc_`/`bctl_` conventions).
  - **Frontend:** `data-reconciliation.js` adds `billingcenter`/`bmt` source meta and `billing →
    [billingcenter, bmt]`; `schema-file-explore.js` adds a `bmt` kind (billing → BMT) with an
    N-way "one product schema per client" clear; `lookup-data-system.js` copy includes Billing.
  - **Operational:** backend edits need a **server restart** (`use_reloader=False`); the client's
    existing billing dictionary sits in the old `cc_dict_*` tables, so the user must **re-upload the
    BillingCenter dictionary `.zip`** to populate `bc_dict_*` (and upload the billing migration template
    for the BMT source). Cache-buster bumped to `?v=20260922a` across all HTML pages.

- **Business overview deck refreshed to match the current feature set** (`deck/build_deck.py` →
  `deck/AI_Data_Conversion_Studio_Overview.pptx`, regenerated). "How it works" now shows **seven**
  phases (added **Reconcile**) in a 4-over-3 layout; Set-up capabilities add **Load the product
  reference** (Guidewire dictionary + product schema); Map-with-AI cards renamed to the real tools
  (AI mapping suggestions, review workspace, lookup / code-value mapping, built-in validation); and
  the Build slide (now "Build, validate, reconcile and deliver") adds **Validation Report** drill-down
  and **Reconcile in plain English** (SQL Assistant). Regenerate with the system Python (has
  `python-pptx`): `python deck/build_deck.py`. Content + `validate.py` pass; visual render QA not run
  (no LibreOffice in env). Deck only — no app code, css/js, or cache-buster changes.

- **AI fill: descriptions now backfilled from `entityModel.xml` for Guidewire subtype entities
  (e.g. AutoRepairShop).** Descriptions were extracted only from the dictionary zip's physical `db/`
  HTML pages, which omit a contact **subtype**'s inherited columns' `<span class="desc">`, so
  `AutoRepairShop` columns stayed blank and "AI fill" (which only *copies* descriptions) had nothing
  to apply. Fix reads the authoritative `entityModel.xml` (subtype columns inlined, each with a
  `<description>`) and unions those descriptions in. **Backend only, deterministic — no AI, and the
  cctl_ typelist paths are untouched.**
  - **New pure reader** (`server/app/parsers/gw_dictionary.py`): `find_entity_model_xml(raw)` locates
    the XML in the zip; `build_desc_index(xml)` returns per-entity/subtype `{names, desc, cols}` where
    a subtype's `cols` = parent entity columns ∪ its own, keyed (normalised) by **both** physical
    `columnName` and logical `name`. Description-only — no typelist/typecode parsing here.
  - **Two description builders enriched, fill-blanks-only (HTML text wins):**
    `extract_gw_zip` + the stream zip path (`extraction_service.py`, new `_enrich_gw_descriptions`)
    feed `aims_cmt_schema` (Product Schema → `_applyRefEntity` / "Add from Product Schema"); and
    `_store_dict_descriptions` (`lookup_service.py`) feeds the `dict_descriptions` tenant doc →
    `aims_dict_descriptions` → AI fill's `_applyDictDescriptions`. A zip without `entityModel.xml`
    behaves exactly as before.
  - **Not refactored:** `cc_dictionary_service._parse_entity_model`, `build_from_zip`, and
    `parse_gw_typelist` — so lookup-set import and the Data-Reconciliation `cc_dict_*` index are
    byte-for-byte unchanged. Tests added in `server/tests/test_gw_dictionary.py` (incl. a typelist
    non-regression assertion). **To apply to an already-added entity: re-upload the dictionary, then
    re-run AI fill (or re-add the entity).** No CSS/JS edits → no cache-buster bump.

- **Target System: add/remove/change highlighting (green/red/orange) restored for manual edits.**
  Row highlights are a diff between a frozen baseline (`activeConn.prevExtract`) and the current
  schema (`renderActiveBrowser`, `js/target-system.js:401`). The baseline was **only** captured on a
  re-extract of an already-saved target, so a target that was loaded once and then hand-edited had
  `activeDiff === null` and nothing highlighted.
  - **New `ensureTargetBaseline(conn)`** (`js/target-system.js`): snapshots the schema the first time
    a target is seen (no-op once a baseline exists). Called at **clean moments only** — page init
    (before the first `renderActiveBrowser`), `activateConn`, and first-save in `saveConnectionForm`
    (new `else if(!conn.prevExtract …)` branch) — never from an edit/render path, so the baseline
    can't absorb the edit it should highlight. Re-extract baseline logic and the **Dismiss**
    (re-baseline) button are unchanged.
  - **Change color wins over the blue AI wash** (`js/target-system.js:674`): a row that is both a
    schema change and AI-populated no longer gets `is-ai` (blue previously overrode green/orange in
    `css/tables.css`). Per-cell `cell-ai` outline + "AI" badge still mark AI-filled attributes.
  - **New-table columns now tint green** (`js/target-schema.js:187`): keyed with `::` (was a space),
    matching the renderer's `tl + "::" + cl` lookup — a latent bug since the feature shipped.
  - Note: edits already persisted before this fix are absorbed into the baseline on first load and
    won't retroactively highlight; new changes do. Cache-buster bumped to `?v=20260917a`.

- **Introduction page refreshed to match the current implementation** (`pages/introduction.html`, HTML-only).
  The end-to-end workflow walkthrough now follows the live sidebar (`SIDEBAR_SECTIONS`) top-to-bottom and
  covers every current page: added **Know Your Data**, **Product Data Dictionary**, **Product Schema**,
  **AI Lookup Mapping**, **Data Validation Configuration**, **Validation Report**, and **Data
  Reconciliation — SQL Assistant**; re-phased into Set up / Discover / Map / Build / Validate / Reconcile
  / Deliver (13 steps). The "Jump to a tool" grid was expanded to the full tool set. Hero + Guidewire
  process diagram left unchanged (still accurate).

- **Lookup Mapping: auto-populate Legacy values from the live source DB + auto-generate (on load).**
  - **New backend endpoint** `POST /api/db/distinct-values` → `db_service.distinct_values(cfg)`
    (`server/app/services/db_service.py`, thin route in `server/app/api/db_routes.py`, behind
    `_throttle()`). Read-only: `SELECT DISTINCT TOP (n) <col> … WHERE <col> IS NOT NULL ORDER BY <col>`,
    identifiers quoted via `_quote`, plus a `COUNT(DISTINCT …)` for `truncated`. Modeled on
    `profile_table`. Returns `{ok, values[], distinctCount, truncated}` (default/max limit 200/1000).
  - **Frontend** (`js/lookup-data.js`): `autoPopulateFromDb()` runs **once per page load** (guarded by
    `_autoPopulateDone`, so the reloads Generate triggers don't re-run it). Auto-picks the first
    **Connected** SQL Server source (`lkPickSource`, File System excluded), builds the profiling-style
    cfg (`lkConnToConfig`), fills **only blank** Legacy cells from `/api/db/distinct-values`, persists
    each via the existing `PUT /api/lookups/<id>` `{legacyValuesSpec}`, then auto-generates only rows
    **not yet generated** via the existing `runValueMappingChunked()`. Progress/fallback banner in the
    new `#lkAutoBanner` (`pages/lookup-mapping.html`).
  - **No password nag on load:** proceeds silently only with `trusted`/stored/cached auth; otherwise
    shows a "Populate from database" button whose click path may prompt (`ensureConnPassword`).
  - Cache-buster bumped to `?v=20260916a` across all HTML pages.

- **Theme toggle now flips the open page too; sidebar reorder; SQL Assistant header trim; reset clears dictionary.**
  - **Theme sync across the SPA shell + iframe:** the header toggle (and the Settings dropdown) only re-themed
    its own document, leaving the other stale. Added a shared `storage`-event listener in `js/common.js` — since
    `aims_settings` is same-origin localStorage shared by both, whichever side changes the theme, the other
    re-applies it (and the shell updates its sun/moon icon). Fixes both directions.
  - **Sidebar:** moved the **Data Reconciliation** section (SQL Assistant) to *after* **Validate** in
    `SIDEBAR_SECTIONS` (`js/common.js`).
  - **SQL Assistant header trim:** the generated SQL comment header (`cc_sql_service.py`) no longer emits the
    `-- Request:` / `-- Purpose:` / `-- Grounded on:` lines (keeps title + Conventions Skill + analysis). The
    UI's Purpose log line and Grounded chips are unaffected (they come from the response payload).
  - **Reset clears the Guidewire dictionary:** `client_service.reset_client_data` now also deletes the
    `cc_dict_*` / `pc_dict_*` tables (they live outside `tenant_documents`), so a reset no longer leaves the
    Data Reconciliation schema source populated. Note: `main.py` runs with `use_reloader=False`, so the server
    must be restarted for backend edits to take effect.
  - Cache-buster bumped to `?v=20260911i` across all HTML pages.

- **Dictionary product-mismatch warning (inform + proceed)** (uncommitted).
  If a client's Product is ClaimCenter but the uploaded dictionary `.zip` is actually PolicyCenter data
  (or vice versa), the app now informs the user and lets them proceed. New `cc_dictionary_service.detect_app(raw)`
  infers the app from the dominant physical table prefix in `entityModel.xml` (pc_/pctl_ → policy, cc_/cctl_
  → claim, else None). `lookup_service.import_document` returns `{ok:false, mismatch:true, detected, product}`
  (importing nothing) when the detected app disagrees with the client Product; `js/lookup-data-system.js`
  `uploadLds` shows a confirm dialog and, on OK, re-imports as the **detected** application (so the import is
  internally consistent). Only the data dictionary is checked (reliably detectable); the Product Schema
  (CMT/PMT Excel) has no reliable prefix to detect, so it's unchanged.

- **Uploads derive application from the client's Product — no more per-upload prompts** (uncommitted).
  The client's **Product** (`getActiveClientProduct()` → claim/policy/billing, set in the client modal) is
  now the single source of truth, so neither upload asks anymore:
  - **Product Data Dictionary** (`js/lookup-data-system.js`): removed the ClaimCenter/PolicyCenter modal —
    a `.zip`/`.html` upload sends `product = getActiveClientProduct()` straight to `/api/lookups/upload`
    (Policy → pctl_/`pc_dict`, else → cctl_/`cc_dict`).
  - **Product Schema** (`js/schema-file-explore.js`): removed the CMT/PMT `askSchemaKind` modal — the tool is
    `sfeKindFromProduct()` (Policy → PMT, else CMT), for both the initial view and upload.
  - If the client has **no Product set**, the upload is blocked with a notification to set it first
    (prevents indexing under the wrong application). Copy on both pages updated to say the app follows Product.
  - This removes the earlier ClaimCenter/PolicyCenter and CMT/PMT upload prompts entirely; the Data
    Reconciliation source radios already keyed off the same Product, so all three are now consistent.

- **PolicyCenter data dictionary + product-aware Data Reconciliation sources** (uncommitted).
  Added a PolicyCenter equivalent of the ClaimCenter dictionary index, and made the SQL Assistant's
  source picker follow the client's **Product** (`getActiveClientProduct()`): **Policy → PolicyCenter +
  PMT**, **Claim → ClaimCenter + CMT**.
  - The PolicyCenter skill's `entityModel.xml` parser is identical to ClaimCenter's, so
    `cc_dictionary_service.py` was **parametrized by a `prefix` arg** (`cc_dict` default | `pc_dict`) —
    every read/write builds table names from it; `build_from_zip` clears BOTH dict prefixes for the client
    (one dictionary per client). New thin `pc_dictionary_service.py` delegates with `prefix="pc_dict"`.
  - New `pc_dict_{entities,columns,typelists,typecodes}` tables in `schema.sql` (mirror `cc_dict_*`;
    auto-created on boot, no migration).
  - `lookup_service.import_document` routes the **existing** Product picker: `product=="policy"` builds the
    PolicyCenter index, else ClaimCenter (the Product Data Dictionary page already asks CC/PC/Billing).
  - `cc_sql_service`: new `policycenter` provider + `_PC_PROMPT`/`_PC_FALLBACK`; `list_sources` now probes
    all four. New `server/app/prompts/policycenter_sql.md` — key divergence: physical soft-delete column is
    **`Retired`** (0=active), NOT `RetiredValue`; typecodes not consistently lowercase; `_amt`/`_cur` money
    pairs; heavy subtypes; `pc_policycontactrole` roles; `pctl_` typelist joins.
  - `js/data-reconciliation.js`: `drProductSources()` picks the pair by product; radios render that pair.
  - Verified in-process (throwaway client): PC build/store/read work; generation emits correct PC SQL
    (`pc_`/`pctl_`, `Retired = 0`, `Status='Bound'`, `Conventions: policycenter_sql.md`); ClaimCenter
    generation unaffected (839 entities via the parametrized default).

- **One product schema per client + SQL Assistant source radios** (uncommitted).
  Revised the model: a client has at most **one** product schema — **CMT or PMT, not both** (plus optionally
  the ClaimCenter dictionary).
  - **Product Schema** page: no tool dropdown — after the user picks a file, a **modal asks CMT or PMT**
    (`askSchemaKind`). The page displays whichever product schema the client already has (badge in the toolbar);
    uploading a schema of the other tool **confirms then replaces** it (clears the other tool's
    `_schema`/`_baseline` tenant docs) so only one is ever kept.
  - **SQL Assistant**: the source `<select>` became **radio buttons** built from a new
    `GET /api/ai/reconcile-sources` (→ `cc_sql_service.list_sources`) — ClaimCenter dictionary is always shown;
    a product source (CMT or PMT) appears **only if it's actually loaded**. Default = first loaded source.
  - Files: `server/app/services/cc_sql_service.py` (`list_sources`), `server/app/api/ai_routes.py`
    (`/reconcile-sources`), `js/data-reconciliation.js` (radios + `loadDrSources`), `js/schema-file-explore.js`
    (single-schema enforcement + confirm), `pages/data-reconciliation.html`.

- **Data Reconciliation SQL Assistant — 3 schema sources (ClaimCenter | CMT | PMT)** (uncommitted).
  The SQL Assistant can now ground on any of a client's loaded schema sources, chosen with a **Schema source**
  selector on the page. A small provider abstraction (`_provider(source)` in `cc_sql_service.py`) binds each
  source to its read API + conventions doc + prompt hints; the AI flow (table-select → grounding → generate)
  is identical across sources.
  - **claimcenter** → the ClaimCenter dictionary index (`cc_dict_*`, from `entityModel.xml`) + `claimcenter_sql.md`.
  - **cmt** / **pmt** → the migration-tool schema uploaded on **Product Schema** (`cmt_schema` / `pmt_schema`
    tenant docs) + `migration_sql.md`. New `migration_schema_service.py` exposes the same read API and surfaces
    migration specifics (PK varies: `PMT_ID`/`_ID1`/`_ID2`; direct + polymorphic FKs with `<col>_Type`
    discriminator; typekeys as plain string columns). Missing column descriptions are enriched from the
    imported data dictionary (`dict_descriptions`).
  - **Product Schema** page gained a **CMT / PMT toggle** (`#sfeKind`, remembered per device) so the same upload
    UI routes the file to the right tenant doc + baseline (`aims_{cmt,pmt}_schema` / `_baseline`).
  - Routes `reconcile-context` / `reconcile-tables` / `reconcile-sql` all take `?source=` (POST body for sql).
  - Registered `pmt_schema` / `pmt_baseline` in `tenant_store_service.ALLOWED_DOC_KEYS` + `common.js TENANT_DOC_KEYS`.
  - Verified in-process (client 30): claimcenter (839 entities) uses `claimcenter_sql.md` + `cc_`/`cctl_` joins;
    cmt (244 tables) uses `migration_sql.md` + `PMT_ID`; pmt correctly reports not-indexed.
  - Files: `server/app/services/cc_sql_service.py`, `migration_schema_service.py`, `tenant_store_service.py`,
    `server/app/api/ai_routes.py`, `server/app/prompts/migration_sql.md`, `js/data-reconciliation.js`,
    `js/schema-file-explore.js`, `js/common.js`, `pages/data-reconciliation.html`, `pages/schema-file-explore.html`.
    (`sqlparse` added for SQL pretty-printing; `extraction_service.py` temporary debug prints removed.)

- **Shareable `.exe` packaging (portable EXE + Windows installer)** (uncommitted).
  New `packaging/` folder builds the whole single-user app into a Windows executable so it can be shared
  with someone who has no Python and no source. Wraps `singleuser/run.py` (existing bring-your-own-key
  launcher). `packaging/aims.spec` (PyInstaller one-file) bundles the `app` backend as bytecode + the
  frontend (`index.html`, `pages/`, `css/`, `js/`, `assets/`, `data/`) + `setup.html` + **all** optional libs
  (openpyxl/pypdf/python-docx/pandas/pyodbc) so every feature works out of the box. `packaging/build.ps1`
  builds in a throwaway venv, then compiles `packaging/installer.iss` (Inno Setup) if `ISCC.exe` is present.
  The installer prompts for the **Anthropic API key during install** and writes it to
  `%LOCALAPPDATA%\AI Data Conversion Studio\.env`; leave it blank → the app's browser wizard asks on first run.
  **Frozen-mode edits (all guarded by `sys.frozen`, so multi-user `python main.py` is unaffected):**
  `server/app/core/config.py` resolves `ROOT`/`SERVER_DIR` to `sys._MEIPASS` when frozen;
  `singleuser/run.py` redirects writable state (`.env`, SQLite DBs) to `%LOCALAPPDATA%\AI Data Conversion Studio\`;
  `singleuser/_envfile.py` honors `AIMS_ENV_FILE`; `singleuser/setup_routes.py` resolves `setup.html` from the
  bundle. Build artifacts gitignored. Caveats: live SQL still needs the OS ODBC driver; frontend JS/HTML is
  still readable in the browser (inherent to web apps) — casual code-hiding, not strong IP protection.

- **Highlighted autocomplete for table/column suggestions (Target System + AI Mapping Workspace)** (uncommitted).
  Replaced the native `<datalist>` (which can't be styled) with a shared custom dropdown that **highlights the
  typed match**. New helper `attachAutocomplete(input, getItems, {onSelect, max})` in `js/common.js` (singleton
  `.ac-menu`, keyboard ↑/↓/Enter/Esc, `mousedown`-before-blur select, dispatches `input`/`change`), styled via
  `.ac-menu`/`.ac-item`/`.ac-mark` in `css/common.css` (token-based, theme-aware; match wrapped in
  `<mark class="ac-mark">`). Wired at **all** table/column suggestion sites: Target System FK — inline cell
  edit **and** the Add/Edit Column modal `#acFkRef`/`#ecFkRef` (attached once at init to avoid stacked
  listeners; `fkRefSuggestions()` replaces `_ensureFkRefDatalist`); AI Mapping Workspace Source Table/Column —
  inline `makeCellEditable` and the Edit-mapping modal (`sourceSuggestions()` replaces `_ensureSourceDatalist`,
  attached once in `injectEditMappingModal`). Files: `js/common.js`, `css/common.css`, `js/target-system.js`,
  `js/mapping-workspace.js`, `pages/target-system.html`.

- **Product Schema upload parser — correct IsNull + embedded-length handling** (uncommitted).
  Root-cause fix in `server/app/parsers/file_parsers.py` (`parse_xlsx_dictionary`). The IsNull/Nullable column
  was read with `_truthy()`, which only knows `yes/1/true`, so both `nullable` **and** `not null` collapsed to
  not-null → every column imported as **Required**. New `_nullable_flag()` reads the descriptive words
  (`nullable`/`null`/`optional`→Optional, `not null`/`required`/`no`→Required; Yes/No still work; blank→unknown).
  New `_split_type_length()` splits an embedded length (`varchar(100)`→`varchar`,`100`; `decimal(10,2)`→`decimal`,`10`)
  so Type/Len are correct at the source. Backend-only; requires a **schema re-upload** (the fix runs at parse
  time — already-stored `aims_cmt_schema` keeps the old values until re-parsed). Verified end-to-end with the
  actual parser.

- **Target System — Add-from-Product-Schema + Entities-panel UX** (uncommitted).
  New third tab (`aeTabProduct`) in the Add Target Entity modal: reads `aims_cmt_schema`, searchable checkbox
  list of tables (col count + PK/FK badges), **Select all**, live count; **Add selected tables** creates a
  target entity per checked table via the existing `persistEntity()` path (columns + `pk`/`fk`), skipping
  duplicates with a summary toast. Column names copied **verbatim** except a column named exactly `PMT_Parent`
  (case-insensitive) → renamed after its FK table via `_fkRefBaseName` (`entity.Claim`→`ClaimId`); the import
  also splits embedded lengths and derives Mandatory from `nullable`. New JS: `aeRenderProductList`,
  `aeProdToggleSelectAll`, `aeMapProductEntity`, `aeAddSelectedFromProduct` (+ `aeProdChecked`); `aeSwitchTab`
  extended to 3 tabs. Same pass: removed the redundant **Table** column from the fields grid (colspan 13→12);
  clicking an entity **name** in the tree now toggles its checkbox; the right-toolbar delete button became
  **Delete tables (N)** — deletes only the checked tables in one confirmed batch (`deleteSelectedEntities`,
  replacing `deleteActiveEntity`), shown only when 1+ ticked; `selectEntity` scrolls the selected table into
  view so a freshly-added table gets focus. Files: `pages/target-system.html`, `js/target-system.js`.

  _Frontend cache-bust for all of the above is at `?v=20260906j`._

- **Validation Report — Issue Details row drill-down to offending records** (uncommitted).
  Each Issue Details row is now clickable (leading **🔍 View** cell + clickable `tr.vr-row`). Clicking runs a
  live read-only query against the active SQL target and shows **all offending records** for that issue in an
  `modal-xl` table: an **ErrorType** badge column + `claimid`/`policyid` (the client's Product FK column, when
  the table has it) + the offending column + `publicid`. New endpoint `POST /api/db/issue-rows` →
  `db_service.issue_rows(cfg)` rebuilds the offending-row `SELECT TOP N` per check type by reusing
  `validate_table`'s exact shapes (FK anti-join, `IS NULL`, `NOT IN`, `GROUP BY/HAVING`, custom query wrapped
  as a derived table). Identifiers `_quote`d, typelist values **bound as params**, read-only single SELECT,
  `TOP` capped at 500 (`ISSUE_ROWS_MAX`), route `_throttle()`d, generic SEC-004 errors, timeout. Product key
  = `getActiveClientProduct()+"id"` (claim→`claimid`, policy→`policyid`, billing→`billingid`), omitted when the
  table lacks it. Replaces the earlier per-sample-value link approach (removed `vrSampleLink` /
  `/api/db/record` / `get_record`). Files: `server/app/services/db_service.py`, `server/app/api/db_routes.py`,
  `js/validation-report.js`, `pages/validation-report.html`. Needs a server restart (route added).

- **Custom validation rules — now multi-table (cross-table)** (uncommitted).
  The Custom Validation Rules editor lets the user pick **one OR more tables** (searchable checklist) and
  describe a rule in plain English (e.g. "if a claim is closed, its exposures must also be closed").
  **Interpret with AI** (`POST /api/ai/custom-rule`, `CUSTOM_RULE_SCHEMA` → `violationQuery`) returns a full
  grounded T-SQL **SELECT** that returns the offending rows (joins across the selected tables, qualified
  `[schema].[table]`, concise select list to keep counts wrappable), plus a plain-English interpretation —
  **editable before saving**. Rules persist in `aims_data_validation_cfg.customRules` as
  `{id, tables[], prompt, title, interpretation, query, enabled}` (legacy single-table `{table, predicate}`
  rules auto-migrate via `normalizeRule`/`ruleFinalQuery`). They flow into: **Generate SQL** (top-level
  `customQueries`, emitted verbatim) and the **Validation Report** (run read-only as
  `SELECT COUNT(*) FROM (<query>) _vr` via new `POST /api/db/validate-query` → `db_service.run_custom_query`,
  shown as the "Custom Rules" category). **Safety:** `_is_safe_query()` — single read-only SELECT/CTE only;
  rejects `;`, comments, DML/DDL, `SELECT INTO`, `xp_`/`waitfor`/`openrowset`; plus the 30s query timeout.
  Cache `20260822u`.

- **New Validation Report page — graphical dashboard** (uncommitted).
  Added **Validate ▸ Validation Report** (`pages/validation-report.html` + `js/validation-report.js`,
  nav entry after Data Validation). It **reuses the Data Validation config** (`aims_data_validation_cfg`):
  reconstructs the per-table checks, resolves typelist allowed-values (typeKey → `/api/lookups/snapshot`,
  fallback `accepted`) and FK parents, then **runs live** against the active SQL Server target
  (`/api/db/validate`, sequential per table) on open and via a **Run & Refresh** button. Renders **KPI
  cards** (tables checked, total issues, duplicate rows, mandatory nulls, invalid typelist, FK orphans),
  a **Chart.js doughnut** (issues by type) and **horizontal bar** (issues by table, worst-first top 15),
  and a **filterable/paginated details table** (type/table/column filters). Chart.js loaded from the same
  jsDelivr CDN as Bootstrap; charts are theme-aware (light/dark text + grid) and degrade gracefully
  (KPIs + table still work) if the CDN is blocked. Shows guidance banners when no config exists or no
  live SQL target is active. No backend change (reuses `/api/db/validate`). Cache-bust `20260822p`.

- **New Data Validation page — two-panel, AI-assisted, SQL-generating** (uncommitted).
  Added a new **Validate ▸ Data Validation** sidebar section (after Build) — a data-quality tool over
  the active **target** schema, distinct from the mapping-`validation.js` (which checks the mapping doc).
  New page `pages/data-validation.html` + controller `js/data-validation.js` (+ `LS_KEYS.dataValidationCfg`
  and the nav entry in `js/common.js`). **Two-panel master–detail:** left = searchable, multi-select
  table list with "select all"; right = per-column grid with **editable checkboxes** for **PK** (=uniqueness
  key), **Mandatory**, **TypeList**, **FK** (FK cell shows the parsed `table.column` reference). Four checks:
  duplicates (`GROUP BY key HAVING COUNT(*)>1`), mandatory NULLs, typelist membership (`NOT IN` domain),
  FK orphans (anti-join). Three actions:
  **AI Suggest Checks** (`POST /api/ai/validation-suggest`) pre-ticks the boxes from each column's
  description/datatype/typelist; **Generate SQL** (`POST /api/ai/validation-sql`) returns one combined,
  grounded T-SQL script (copy + download `.sql`) the user runs on SQL Server themselves; **Run Validation**
  (`POST /api/db/validate`, kept from the first cut) executes live and fills the KPI cards + issues grid —
  enabled only for a live SQL Server target. Backend: new `services/validation_ai_service.py`
  (`suggest_checks` uses `VALIDATION_SUGGEST_SCHEMA` structured output; `generate_validation_sql` returns
  raw SQL, strictly grounded — never invents names/values), two thin routes in `ai_routes.py`, plus the
  earlier `db_service.validate_table` + `/api/db/validate`. Typelist allowed values resolve via `typeKey`
  against `/api/lookups/snapshot`, falling back to the column `accepted` string, and are embedded into the
  generated `NOT IN (…)`. **Provenance coloring:** each grid check cell is tinted by origin — neutral for
  schema defaults, **blue** for AI-suggested (`origin-ai`), **green** for a user's manual toggle
  (`origin-user`), tracked in a `dvOrigin` map and persisted with the config; a small legend explains it.
  Selections persist to device-local `aims_data_validation_cfg`. No other feature touched. Cache-bust
  bumped to `20260822j`.

- **Admin-managed users; self-signup disabled** (uncommitted).
  The tool is now closed: `POST /api/auth/signup` returns 403 unless `AIMS_SIGNUP_ENABLED`
  is set (default OFF; the login page no longer offers signup). Added an `is_admin` column
  to `users` (idempotent migration in `app_db.ensure_app_tables`) and an env-seeded admin:
  `AIMS_ADMIN_EMAIL` + `AIMS_ADMIN_PASSWORD` create/promote the admin on startup
  (`auth_service.ensure_admin`). New **Admin page** (`pages/admin.html` + `js/admin.js`, shown
  via an admins-only sidebar link) backed by `admin_service` + `/api/admin/users`
  (GET/POST/DELETE, admin-only, CSRF-protected). Creating a user makes a STANDARD account;
  **deleting a user is permanent** — the `users` row cascades to their clients + all
  `tenant_documents`, and their `ai_usage_log` rows are purged. Guards: can't delete yourself
  or another admin. `conftest` enables signup so the existing suite still bootstraps users;
  new `test_admin.py`. Suite: 176 passed.

- **Removed the Project Setup page (full cleanup)** (uncommitted).
  Deleted `pages/project-setup.html`, `js/project-setup.js`, and the unused seed `data/projects.json`.
  Stripped the dead project plumbing: sidebar nav link, `loadProject()`/`setCurrentProject()`/
  `LS_KEYS.project` and the `initShell` seed call, and `current_project` from both the frontend
  `TENANT_DOC_KEYS` and the backend `ALLOWED_DOC_KEYS` (now 12 stores). Dashboard workflow stepper
  dropped its "Project Creation" step (`WORKFLOW_STEPS` + `computeWorkflowIndex` signal renumbered).
  Introduction walkthrough lost its Project Setup card (remaining steps renumbered 1–8), and the
  splash label was removed. No core feature depended on `current_project`; existing tenant docs for
  it are simply orphaned and unread. Backend suite still green.

- **SEC-005 fix: double-submit CSRF token on state-changing endpoints** (uncommitted).
  Mutating `/api/*` requests were protected only by `SameSite=Lax`; added an anti-CSRF token as
  defense-in-depth (chosen over risk-acceptance). Centralized guard in the app factory
  (`_register_csrf`): a readable (non-HttpOnly) `csrf_token` cookie is issued on any response
  lacking one, and `POST/PUT/PATCH/DELETE` on `/api/*` must send `X-CSRF-Token` equal to that
  cookie (`secrets.compare_digest`) else **403**. Exempt: the `/api/auth/*` bootstrap
  (login/signup/logout/select-client/me — run before the shell's wrapper; negligible impact).
  Gated by `CSRF_ENABLED` (env `AIMS_CSRF_ENABLED`, default ON; tests set it off via conftest, same
  pattern as `AUTH_DISABLED`) and skipped under `AUTH_DISABLED`. Frontend: a `window.fetch` wrapper
  at the top of `common.js` attaches the header on same-origin mutating calls (covers all app
  pages); `onboarding.js` (standalone, no common.js) attaches it directly on its one `POST
  /api/clients`. Asset cache version bumped `20260815j`→`20260815k`. Regression: `tests/test_csrf.py`
  (T11 — missing/mismatched token → 403; valid token passes; auth endpoints exempt; unauth still 401;
  GET issues the cookie). Full backend suite **167 passed**. **Frontend wrapper needs a manual
  browser pass** (no JS tests in repo) — verify every mutating flow (save mappings, create/switch
  client, extract, generate, deploy, clear usage log) still works and onboarding create-client
  succeeds. Files: `server/app/__init__.py`, `server/app/core/config.py`, `server/tests/conftest.py`,
  `server/tests/test_csrf.py`, `js/common.js`, `js/onboarding.js`, all `pages/*.html` + `index.html`.

- **SEC-004 fix: blunt authenticated SSRF on DB/deploy connect endpoints (normalize + rate-limit)** (uncommitted).
  `/api/db/test|metadata|profile` and `POST /api/deploy` connect to caller-supplied targets, so a
  failed attempt's error text/timing could be used to infer internal host:port reachability
  (blind SSRF / port scan). Policy chosen (of the request's 3 options): **normalize + rate-limit**
  (not an egress allowlist — the product must reach clients' internal DBs by design). New
  `services/connection_guard.py`: `GENERIC_CONNECTION_ERROR` (one opaque message for every failed
  attempt — no host/port/driver/SQL-number) + a per-user `check_rate()` throttle (30 attempts / 60s,
  process-global, mirrors the auth login throttle). `db_service.open_connection` now collapses any
  connect failure into `ConnectionAttemptError(GENERIC_CONNECTION_ERROR)` (real error printed
  server-side); `sql_execution_service` normalizes its connect-failure branch the same way; both DB
  routes and deploy POST enforce the throttle (429 + Retry-After) using the session uid. Post-connect
  query errors are unchanged (not a reachability signal). **Residual limitation (documented):** coarse
  response-timing signal can still leak within the rate budget — full timing normalization was out of
  scope for a Low-severity issue; network egress control remains the backstop. Regression:
  `tests/test_connection_guard.py` (T10 — refused vs auth-fail yield identical generic error; per-user
  throttle; auth required; legit success unaffected). Full suite **161 passed**.
  Files: `server/app/services/connection_guard.py` (new), `server/app/services/db_service.py`,
  `server/app/services/sql_execution_service.py`, `server/app/api/db_routes.py`,
  `server/app/api/deploy_routes.py`, `server/tests/test_connection_guard.py`.

- **SEC-003 fix: bind deploy jobs to their tenant (status IDOR)** (uncommitted).
  `GET /api/deploy/status/<job_id>` returned the job record (server, database, `finalSql`,
  `fixes[].before/after`, `error`, `log`) for **any** id with no owner binding — a cross-tenant
  read (mitigated only by a 48-bit random in-memory id). Fix: `start_deploy(..., owner=(uid,cid))`
  records the creating tenant on the in-memory job; `get_status(job_id, owner=...)` returns `{}`
  (→ route **404**, doesn't confirm id existence) unless the session's `(uid, cid)` matches the
  job's owner; owner ids are stripped from the status payload (never exposed) and credentials stay
  out as before. Both deploy routes now scope via a session `_scope()` → 401 unauth / 409 no active
  client. Credentials-in-cfg handling unchanged. Regression: `tests/test_deploy_isolation.py`
  replicates matrix row **T9** (B gets 404 + no job fields for A's jobId; A still reads its own)
  plus route auth/active-client guards. Optional hardening from the request (widen id to full
  uuid4 hex, TTL-evict finished jobs) intentionally **not** done — non-binding and outside the
  minimal fix; flag for follow-up if wanted. Full suite **153 passed**.
  Files: `server/app/services/deployment_service.py`, `server/app/api/deploy_routes.py`,
  `server/tests/test_deploy_isolation.py`.

- **SEC-002 fix: tenant-scope the AI usage report reads (cross-tenant metadata leak)** (uncommitted).
  `GET /api/ai-usage/logs` and `/summary` filtered only by date/feature, so any authenticated
  user saw **every** tenant's usage rows and per-feature breakdown (incl. `error_message`, which
  can embed SQL table/column names). Fix (reuses the SEC-001 owner columns): `_date_filters` now
  emits a **mandatory** `user_id=? AND client_id=?` predicate first; `query_logs`/`summary` take
  `(user_id, client_id)` as required leading args; both routes derive the tenant via the shared
  `_scope()` (session-only, never a query param) → 401 unauth / 409 no active client. Legacy
  NULL-owner rows are excluded from all tenant-scoped reads (no backfill). Regression:
  `test_usage_reads_are_tenant_scoped` (matrix **T7** — B's /logs & /summary contain only B's
  distinctive rows, both directions) + read-path auth/active-client guards; SEC-001 **T8** delete
  scoping re-confirmed under the shared schema. `tests/test_ai_usage_logger.py` updated for the
  scoped read signature (stubs `_session_owner`). Full suite **150 passed**.
  Files: `server/app/services/ai_usage_logger.py`, `server/app/api/ai_usage.py`,
  `server/tests/test_ai_usage_isolation.py`, `server/tests/test_ai_usage_logger.py`.

- **SEC-001 fix: tenant-scope the AI usage log (cross-tenant destructive delete)** (uncommitted).
  Any authenticated session could wipe **every** tenant's usage/audit log:
  `DELETE /api/ai-usage/logs` → `ai_usage_logger.clear_logs()` ran an unconditional
  `DELETE FROM ai_usage_log`, and the table had no owner column. Fix: added
  `user_id`/`client_id` to `ai_usage_log` (with an in-place ALTER migration for legacy
  DBs + `ix_usage_scope` index); the write path now stamps the owner captured from the
  **session** on the request thread (`_session_owner()`, guarded → NULL outside a request
  context, so logging still never breaks the AI feature); `clear_logs(user_id, client_id)`
  is scoped to the caller's tenant; the route derives `(uid, cid)` from the session
  (`_scope()`, mirroring `state_routes`) → 401 unauth / 409 no active client. Reads
  (`query_logs`/`summary`) intentionally untouched — read scoping is tracked separately as
  SEC-002. Regression: `tests/test_ai_usage_isolation.py` replicates matrix row **T8**
  (cross-tenant delete affects 0 of the other tenant's rows, both directions) plus
  auth/active-client guards, session-owner stamping, and a T7 read-scoping non-regression
  check; `tests/test_ai_usage_logger.py` updated for the scoped signature. Full suite **148 passed**.
  Files: `server/app/services/ai_usage_logger.py`, `server/app/api/ai_usage.py`,
  `server/tests/test_ai_usage_isolation.py`, `server/tests/test_ai_usage_logger.py`.

- **AI Usage Logging & Reporting** (uncommitted). Every Claude API call in the app is
  now logged — feature, model, input/output/total tokens, duration, timestamp, and
  success/failed — to a local **SQLite** file (`server/aims_usage.db`, gitignored; path
  via `config.usage_db_path()` / `AIMS_USAGE_DB`). No SQL Server, no prompt/response
  content, no cost figures. All model calls funnel through a single new wrapper
  `services/ai_client_service.py::call_ai(feature, run, attempts)` (wraps the existing
  `call_with_fallback`; times the call, reads `usage`/`model`, logs via
  `services/ai_usage_logger.py`, re-raises failures after logging `status=failed`).
  Inserts run on a background daemon thread so AI latency is unaffected and a logging
  error can never break a feature. The 7 existing call sites (mapping generate +
  regenerate, source extraction, add-column, ETL proc, ETL create-table, deploy AI-fix)
  were swapped from `call_with_fallback` to `call_ai` — prompts unchanged. New report
  page **Reports → AI Usage Report** (`pages/ai-usage-report.html` + `js/ai-usage-report.js`)
  with summary cards + filterable/paginated table, served by `api/ai_usage.py`
  (`GET /api/ai-usage/logs`, `/summary`). Table auto-created at startup. +10 tests (104 total).

- **Backend refactor: monolith → layered package** (uncommitted). `server/app.py`
  (~1550 lines) split into `server/app/` with layers `api → services → parsers/schemas
  → core` and launched by `server/main.py` (`create_app()` factory). Pure structural
  refactor — **zero behavior change**: same routes, JSON shapes, and SSE event format
  (verified by comparing prompts, payloads, URL maps and NDJSON events against the old
  file). The duplicated model-call retry/fallback pattern (generate / regenerate /
  extract) is unified in `services/ai_client.py` as `call_with_fallback` +
  `schema_attempts`. Also removed the redundant **Analyze Metadata** button from the AI
  Mapping Generator. Run command changed to `cd server && python main.py`.
- **Metadata Explorer: removed the New Connection form** (`6faeacc`). It was a
  SQL-only duplicate of Source Systems (which does SQL + File). The Explorer now only
  lists **Saved Sources** with an **Explore** button + an "Add / Manage Sources" link;
  connection create/edit/delete lives solely on Source Systems. `loadLiveObjects(conn)`
  now takes a connection object; all form-dependent JS was removed.
- **Regenerate: search all saved sources, prefer current, never invent** (`9ad3e89`).
  Fixed the AI hallucinating a table/column not in the user's source (e.g.
  `CLAIM_MASTER.CLM_NO`). Per-field regenerate now loads the schema from ALL *saved*
  source connections (deleted ones already gone), ordering the source the mappings
  came from FIRST. Backend prompt hardened: use ONLY tables/columns present verbatim
  in the list (mapping AND join); add a JOIN only when a real shared key exists on
  both tables; if the requested value isn't in the list → Not Mapped, no fabrication.
  First-time generation is unchanged (already scoped to the single selected source).
- **Regenerate now updates the FROM/JOIN clause** (`8488159`). When a single
  mapping is regenerated to pull from a source table not yet in the entity's join,
  the backend returns an updated `joinCondition` (extends the FROM/JOIN, inferring
  the key from matching `*_ID`/`*_CD`/`*_NBR`; unchanged if same table). The
  workspace applies it to `aims_ai_joins`, refreshes the join box, logs history.
  Verified: new-table → join extended; same-table → unchanged.
- **Regenerate grounded on the FULL source schema** (`8488159` / `20260811v`).
  Previously regenerate only saw columns already in the mapping doc, so it couldn't
  find e.g. POLICY_NUMBER in another table. The workspace now loads every source
  connection's tables (File System = stored tables; SQL = `/api/db/metadata`) and
  passes them all to regenerate.
- **Direct Excel data-dictionary parser** (`dc1f4b4`). Structured `.xlsx`
  dictionaries (a Table/Entity column + a Column column) are parsed DIRECTLY from
  cells — name/dataType/length/description/businessTerm/sample read **verbatim** —
  instead of the multi-minute AI loop. `_parse_xlsx_dictionary()` returns None for
  raw-data/irregular sheets so those still use AI. Wired into both extract endpoints.
  50 tables × 10 cols → ~1s (was minutes); descriptions preserved in full.
- **Extraction resilience** (`9dd620e`). Client falls back to the non-streaming
  endpoint if the NDJSON stream drops mid-file ("Connection error" on big files);
  a single chunk's AI failure retries once then skips instead of aborting all.
- **Excel data-dictionary row grouping** (`2e48fe1`). Tall dictionaries were sliced
  into blind 500-row blocks (model returned ~1 table); now rows are grouped by their
  TABLE/ENTITY column, batching a few tables per chunk. Progress bar shows chunk
  count / tables / columns live as it runs.

Note on chunking: "N parts" = how many slices the file was cut into for AI calls.
Excel dictionaries group ~6 tables (or ≤6000 chars) per chunk; wide sheets split by
columns (≤150); PDFs/text split on table boundaries. SQL uses a deterministic parser.
Excel dictionaries now usually skip AI entirely via the direct parser.

---

## What we've accomplished

### Core app
- **Project Setup** — Migration Type fixed to "Data Conversion", Domain "Insurance"
  (read-only); removed the Environment field.
- **Source Systems** — add/edit/delete **source connections**. Two kinds:
  **SQL Server** (tested/loaded live via the backend) and **File System** (upload
  a file; AI extracts tables/columns). Placeholder text removed from inputs.
- **Target System** — made **dynamic** (previously a single uploaded Excel).
  Now a connection manager like Source Systems: multiple targets (**SQL Server**
  or **File**), one marked **Active**; the active target drives the whole app.
  Moved under **Setup** in the sidebar (below Source Systems).
- **Metadata Explorer** — explore SQL Server **and** File System sources
  (renders AI-extracted tables for files). Connection form collapsed by default.
- **Data Profiling** — dynamic (pick source → table → Run Profiling). File System
  sources are **excluded** (profiling needs live SQL); clear message if selected.
  Removed the hardcoded "Sample Metadata (LegacyPolicyDB)" option.
- **AI Mapping Generator** — real Claude-powered mapping. Key features:
  - **Column-level selection** — expand a table card to pick specific columns.
  - Already-generated columns are **locked** (greyed + checked) and skipped until
    "Clear All"; returning to the page pre-selects what's mapped.
  - **Accumulate-until-Clear-All** merge (column-level upsert).
  - Per-table + **field-chunk** generation (avoids output-token truncation on
    wide tables like 191-column CS_Claim).
  - Live **AI Processing Console** with per-table progress; auto-shows on Generate;
    can be hidden to widen the config area.
  - Default Business Context = the CMT/PMT "Data Conversion Prompt".
- **Mapping Workspace** — review grid. Row tinting (AI/approved = green, etc.),
  join-condition box per entity, editable cells, **Approve/Reject/Delete Selected**
  (PwC-themed buttons), **Columns** show/hide menu, hideable Target Tables panel,
  target-first CSV export with join condition, **Clear All**.
- **Validation** — 7 rules run on the **real** mappings (VR-01..VR-07). Added
  **Clear Validation**; Run button turns blue while running.
- **Mapping History** — dynamic audit trail (approve/reject/regenerate/edit/comment/
  validation/**generate**/**delete**/**clear**). Delete purges + records a
  self-contained entry (no orphan `-.-` rows).
- **Dashboard** — all KPI tiles dynamic from real mappings; Validation Summary +
  Validation Errors derived live (was static `validation-results.json`).
- **Export**, **Settings** (user profile + confidence thresholds; Save fixed).

### Cross-cutting features
- **Dark / light theme** — token-based; header sun/moon toggle + Settings dropdown;
  persisted; date-picker + modals + PwC logo all theme-aware.
- **Reset Application** — header ↺ button clears ALL app data (prefix `aims_*`) and
  reloads; leaves `aims_ai_mappings` as `[]` so it doesn't fall back to sample.
- **Header** — PwC logo before the "AI Data Conversion Studio" title; compact search box;
  removed the project-name chip and the environment chip.
- **PwC theme + logo** across all pages.

### Backend (`server/app.py`)
- Live SQL Server: `/api/db/test`, `/api/db/metadata`, `/api/db/profile` (pyodbc).
- AI: `/api/ai/status`, `/api/ai/generate-mappings` (per-entity + field-chunk loop),
  `/api/ai/regenerate-mapping`.
- **File extraction**: `/api/ai/extract-source` (JSON result) and
  `/api/ai/extract-source-stream` (NDJSON **progress** events for the UI progress bar).
  - SQL scripts → deterministic `CREATE TABLE` parser (no limits, every table).
  - **Structured Excel dictionaries → direct cell parser (`_parse_xlsx_dictionary`),
    NO AI, verbatim, instant**; falls back to AI for raw-data/irregular sheets.
  - Excel (AI path) → chunk by **sheet**; **wide** sheets by **columns** (≤150/slice);
    **data-dictionary** sheets (a TABLE/ENTITY column) **group rows by table**.
  - PDF/Word/text → **table-boundary** chunking (batch ~6–8 tables per AI call).
  - **Loop + merge**: one model call per chunk, union tables by name, dedup columns.
  - **Resilience**: a single chunk failure retries once then skips (never aborts all);
    client falls back to the non-streaming endpoint if the stream drops.
- **Regenerate** (`/api/ai/regenerate-mapping`): re-maps ONE field on the FULL source
  schema and returns an updated `joinCondition` (extends the entity FROM/JOIN when the
  new source is a new table).
- Corporate gateway plumbing: `_ai_model()` strips `[1m]` suffix; `_ca_bundle()` +
  `_anthropic_client()` trust the TLS-intercepting proxy via `win-ca-bundle.pem`.

### Git
- Repo pushed to **https://github.com/rakesh2023/AI_Mapping_Studio** (`main`).
- `.gitignore` excludes `server/win-ca-bundle.pem`, `server/server.log`,
  `__pycache__/`, `.claude/`, `.env`. No secrets committed (API creds via env vars).
- Commit history (newest first):
  - `8488159` regenerate updates the entity FROM/JOIN + full-schema grounding
  - `dc1f4b4` direct Excel data-dictionary parser (skip AI for structured .xlsx)
  - `9dd620e` extraction resilience (dropped streams + per-chunk failures)
  - `3ca3395` add SESSION_SUMMARY.md
  - `2e48fe1` fix Excel data-dictionary extraction dropping tables/rows
  - `2e46ee7` initial commit

---

## Current state
- **Working & pushed.** Backend runs at `http://127.0.0.1:8000` via `cd server && python main.py`
  (debug reload on). Frontend is static; cache-busting via `?v=YYYYMMDD<letter>` on
  css/js — currently `?v=20260811w`.
- Verified end-to-end: SQL (deterministic), structured Excel dictionary (direct parser,
  50 tables × 10 cols → ~1s), wide Excel (800 cols → all), tall data-dictionary Excel
  (100 tables × 40 cols → all via AI), 125-table PDF → all, regenerate join extend/keep.

## Important decisions
- **Local-only data**: everything persists in browser `localStorage` (`aims_*` keys).
  ~5MB quota is the main scaling limit; `getTargetSchema()` derives from the active
  connection to avoid double-storing large schemas.
- **`null` vs `[]`** for `aims_ai_mappings`: `null` = never generated (show sample);
  `[]` = explicitly cleared (stay empty). Applied in workspace/dashboard/history/validation.
- **SQL uses a deterministic parser**, not the LLM (LLMs summarize long DDL).
- **Loop + merge** is the pattern for anything big (mappings and extraction) to beat
  input/output truncation and model summarizing.
- Large files ⇒ **many sequential AI calls** ⇒ minutes-long runs (progress bar shows it).

## Next steps / open items
- **Speed**: the AI extraction path & multi-table generation run sequentially (slow on
  huge files). Could **parallelize chunk/table calls** to cut wall-clock time. (Structured
  Excel now bypasses AI entirely via the direct parser, so this mainly affects PDF/Word
  and non-dictionary sheets.)
- **localStorage quota**: very large schemas (thousands of columns) may approach ~5MB;
  consider IndexedDB or server-side persistence if this becomes a real limit.
- **Re-extract `CMT_Schema.xlsx`** with the new direct parser — should be ~1s and capture
  all tables/columns (the user must Edit the source → Extract → Save to refresh it).
- **Regenerate join edits are per-field**: if a mapping is later changed to a table that
  makes another table's JOIN unused, the stale JOIN is not auto-pruned (minor).
- `reportlab` was pip-installed locally only for test PDF generation — not in
  `requirements.txt` (intentional; not an app dependency).

## Relevant file paths
```
ai-mapping-studio/
├─ index.html
├─ .gitignore
├─ pages/            # dashboard, project-setup, source-systems, target-system,
│                    # metadata-explorer, data-profiling, ai-mapping-generator,
│                    # mapping-workspace, validation, mapping-history, export, settings (.html)
├─ js/
│  ├─ common.js          # shell, sidebar, theme, reset, streamExtractFile, stores, helpers
│  ├─ source-systems.js  # source connection CRUD + file extract (progress)
│  ├─ target-schema.js   # target connections store + active target + converters
│  ├─ target-system.js   # target connection manager + browser
│  ├─ metadata.js        # Metadata Explorer (SQL + File)
│  ├─ profiling.js        # Data Profiling (SQL only)
│  ├─ ai-mapping.js       # AI Mapping Generator (column select, generate loop)
│  ├─ mapping-workspace.js# review grid, columns menu, bulk actions, export
│  ├─ validation.js       # rules engine + clear
│  ├─ dashboard.js        # dynamic KPIs + validation summary
│  ├─ mapping-history.js  # audit trail
│  ├─ settings.js, project-setup.js, export.js, navigation.js
├─ css/  common.css, sidebar.css, tables.css, forms.css, mapping.css, responsive.css
├─ data/ projects.json, mappings.json (sample), source/target-metadata.json,
│        validation-results.json, sample-documents.json
├─ assets/images/  pwc-logo.svg (white wordmark), pwc-logo-dark.svg (dark wordmark), pwc-mark.svg
└─ server/
   ├─ main.py            # entry point (create_app + app.run)
   ├─ app/               # layered Flask package
   │  ├─ __init__.py     #   create_app() factory (registers blueprints)
   │  ├─ core/           #   config.py (paths/port/model/CA/tuning), capabilities.py (import guards)
   │  ├─ schemas/        #   ai_schemas.py (3 Claude structured-output schemas)
   │  ├─ parsers/        #   text_chunking, sql_ddl_parser, file_parsers (PURE — no Flask/Anthropic)
   │  ├─ services/       #   ai_client, db_service, mapping_service, extraction_service
   │  └─ api/            #   static_routes, db_routes, ai_routes (thin blueprints)
   ├─ tests/             # pytest: services + parsers + api routing (mocked)
   ├─ requirements.txt   # Flask, pyodbc, anthropic, openpyxl, pypdf, python-docx
   ├─ README.md
   └─ win-ca-bundle.pem  # (gitignored) corporate CA bundle — rebuild locally
```

### Run
```
pip install -r server/requirements.txt
cd server && python main.py     # serves the app at http://127.0.0.1:8000
```
Requires env vars for the Claude gateway (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN/API_KEY)
and the Microsoft ODBC Driver for live SQL Server connections.
