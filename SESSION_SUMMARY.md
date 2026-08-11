# AI Mapping Studio — Session Summary

_Last updated: 2026-08-11_

A PwC-themed, AI-assisted **source-to-target data migration mapping** tool
(insurance / Guidewire-inspired). Static HTML/CSS/vanilla-JS frontend + a
Python/Flask backend that talks to a live SQL Server and the Claude API.

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
  - Excel → chunk by **sheet**; **wide** sheets chunk by **columns** (≤150/slice);
    **data-dictionary** sheets (a TABLE/ENTITY column) **group rows by table**.
  - PDF/Word/text → **table-boundary** chunking (batch ~6–8 tables per AI call).
  - **Loop + merge**: one model call per chunk, union tables by name, dedup columns.
  - **Resilience**: a single chunk failure retries once then skips (never aborts all);
    client falls back to the non-streaming endpoint if the stream drops.
- Corporate gateway plumbing: `_ai_model()` strips `[1m]` suffix; `_ca_bundle()` +
  `_anthropic_client()` trust the TLS-intercepting proxy via `win-ca-bundle.pem`.

### Git
- Repo initialized; pushed to **https://github.com/rakesh2023/AI_Mapping_Studio** (`main`).
- `.gitignore` excludes `server/win-ca-bundle.pem`, `server/server.log`,
  `__pycache__/`, `.claude/`, `.env`. No secrets committed (API creds via env vars).
- Latest commit: `9dd620e` (extraction resilience).

---

## Current state
- **Working & pushed.** Backend runs at `http://127.0.0.1:8000` via `python server/app.py`
  (debug reload on). Frontend is static; cache-busting via `?v=YYYYMMDD<letter>` on
  css/js — currently `?v=20260811u`.
- File extraction verified end-to-end: SQL (deterministic), wide Excel (800 cols → all),
  tall data-dictionary Excel (100 tables × 40 cols → all), 125-table PDF → all.

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
- **Speed**: large-file extraction & multi-table generation run sequentially (slow).
  Could **parallelize chunk/table calls** to cut wall-clock time.
- **localStorage quota**: very large schemas (thousands of columns) may approach ~5MB;
  consider IndexedDB or server-side persistence if this becomes a real limit.
- **Validation Summary panel** (lower Dashboard section) — confirm fully live; the KPI
  tiles are done.
- **Verify the user's `CMT_Schema.xlsx`** extracts fully now (the resilience fix targets
  the "Connection error" they hit on that large file).
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
