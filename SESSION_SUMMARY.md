# AI Mapping Studio — Session Summary

_Last updated: 2026-08-11_

A PwC-themed, AI-assisted **source-to-target data migration mapping** tool
(insurance / Guidewire-inspired). Static HTML/CSS/vanilla-JS frontend + a
Python/Flask backend that talks to a live SQL Server and the Claude API.

---

## Latest changes (most recent first)

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
- **Header** — PwC logo before the "AI Mapping Studio" title; compact search box;
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
- **Working & pushed.** Backend runs at `http://127.0.0.1:8000` via `python server/app.py`
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
   ├─ app.py             # Flask: DB + AI + file extraction (streaming)
   ├─ requirements.txt   # Flask, pyodbc, anthropic, openpyxl, pypdf, python-docx
   ├─ README.md
   └─ win-ca-bundle.pem  # (gitignored) corporate CA bundle — rebuild locally
```

### Run
```
pip install -r server/requirements.txt
python server/app.py            # serves the app at http://127.0.0.1:8000
```
Requires env vars for the Claude gateway (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN/API_KEY)
and the Microsoft ODBC Driver for live SQL Server connections.
