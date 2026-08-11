# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AI Mapping Studio** — a PwC-themed, AI-assisted **source-to-target data migration mapping** tool
(insurance / Guidewire-inspired). A static HTML/CSS/vanilla-JS frontend backed by a single-file
Python/Flask service that talks to a live SQL Server (via pyodbc) and the Claude API (via a corporate
gateway). There is **no build step** — the frontend is served as-is.

## Run

```
pip install -r server/requirements.txt
cd server && python main.py     # serves the whole app at http://127.0.0.1:8000
```

Flask runs with `debug=True` (auto-reload on save). It serves **both** the static site and the
`/api/*` endpoints on one origin, so the frontend calls `/api/...` with no CORS. Entry point is
`index.html` (splash) → `pages/dashboard.html`.

There are **no tests, linter, or build tooling** in this repo. "Verify" means running the backend and
exercising the flow in the browser. Backend endpoints can also be smoke-tested directly with `curl`
against `http://127.0.0.1:8000/api/...`.

### Backend requires (for full functionality)
- **Claude gateway** env vars: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`).
  Without these, AI endpoints fail but DB/static serving still works.
- **Microsoft ODBC Driver for SQL Server** (17 or 18) for live SQL connections.
- `server/win-ca-bundle.pem` — corporate CA bundle for the TLS-intercepting proxy; **gitignored**,
  must be rebuilt locally. `ca_bundle()` (in `app/core/config.py`) / `anthropic_client()` (in
  `app/services/ai_client.py`) wire it into httpx.

## Cache-busting — REQUIRED after any css/js edit

The frontend links every css/js asset with `?v=YYYYMMDD<letter>` (e.g. `?v=20260812a`). Browsers
cache aggressively, so **after editing any `.css` or `.js` you must bump the version across all HTML
pages**, or changes won't appear. Bump with:

```powershell
Get-ChildItem -Path "pages\*.html","index.html" | ForEach-Object {
  (Get-Content $_.FullName -Raw) -replace '\?v=\d{8}[a-z]', '?v=20260812b' | Set-Content $_.FullName -Encoding utf8
}
```

Use the next unused letter for today's date. This is easy to forget and is the #1 cause of "my change
didn't work."

## Architecture

### Data lives in the browser, not a database
The app has **no server-side persistence**. All working state is in browser `localStorage` under
`aims_*` keys. The Flask backend is stateless — it opens short-lived DB connections per request and
proxies AI calls. The `data/*.json` files are **sample/seed data only** (fallbacks), not the live
store.

Key localStorage keys (see `LS_KEYS` in `js/common.js`, plus scattered literals):
- `aims_ai_mappings` — the generated mapping rows. **`null` vs `[]` is load-bearing**: `null` = never
  generated → fall back to sample; `[]` = explicitly cleared → stay empty. Every reader
  (workspace/dashboard/history/validation) must preserve this distinction.
- `aims_ai_joins` — per-entity FROM/JOIN clauses (keyed by target entity name).
- `aims_db_connections` — source connections (`LS_DB_CONNECTIONS`); each is SQL Server **or**
  File System (`type`).
- `aims_target_connections` / `aims_active_target` — target connections; the **active** one drives
  the whole app (`getTargetSchema()` in `js/target-schema.js` derives the schema from it rather than
  double-storing).
- `aims_settings` (user profile, theme, confidence thresholds), `aims_mapping_scope`,
  `aims_mapping_overrides`, `aims_mapping_history`, `aims_current_project`, `aims_sidebar_collapsed`.

The **~5MB localStorage quota is the main scaling limit** — very large schemas can overflow it
(`lsSet` surfaces a quota warning).

### Frontend page model
Each page under `pages/` is a standalone HTML file with a matching `js/*.js` controller. `js/common.js`
is the **shared shell** loaded by every page: `initShell(activeHref)` injects the sidebar + header,
applies the persisted theme, and wires global controls; it also holds the localStorage helpers
(`lsGet`/`lsSet`), connection/history stores, `resetApplication()`, and `streamExtractFile()`. When
adding a page, follow the existing pattern: include `common.js` + `navigation.js` + the page's own
controller, and call `initShell()` on `DOMContentLoaded`.

Theming is **token-based**: `css/common.css :root` defines design tokens; `body.theme-dark` redefines
them plus a set of hardcoded-surface overrides. Prefer `var(--token)` over literal colors so surfaces
flip automatically in dark mode.

### Backend layout (layered package under `server/app/`)
The backend is a Flask app factory (`app/__init__.py` `create_app()`), launched by `server/main.py`.
Layers, strict import direction `api → services → parsers/schemas → core`:
- `core/` — `config.py` (paths, `port()`, `ai_model()`, `ca_bundle()`, `EXTRACT_*` tuning) and
  `capabilities.py` (the optional-import guards: `pyodbc`, `anthropic`, `openpyxl`, `PdfReader`,
  `docx` — `None` when absent). **Import these from here; don't re-write try/except blocks.**
- `parsers/` — **pure** (no Flask/Anthropic): `text_chunking.py`, `sql_ddl_parser.py`, `file_parsers.py`.
- `schemas/ai_schemas.py` — the three Claude structured-output JSON schemas.
- `services/` — business logic, each returning `(payload_dict, http_status)`: `ai_client.py`,
  `db_service.py`, `mapping_service.py`, `extraction_service.py`.
- `api/` — **thin** blueprints (`static_routes`, `db_routes`, `ai_routes`): parse request → call
  service → jsonify. No business logic.

**Shared AI plumbing** (`services/ai_client.py`): `anthropic_client()` builds the httpx client trusting
the CA bundle; `call_with_fallback(run, attempts)` + `schema_attempts(schema)` unify the "try
structured-output configs, degrade to a bare call" ladder used by generation, regeneration, and
extraction; `parse_mapping_json()` is the shared best-effort JSON extractor.

### Backend AI patterns
The two hard problems are **output-token truncation** and **models summarizing long input**. The
consistent solution is **loop + merge** — never one big call:

- **Mapping generation** (`/api/ai/generate-mappings`, `mapping_service.py`): loops **per target
  entity**, and within a wide entity splits columns into field-chunks (`FIELD_CHUNK`) so output never
  truncates. Results merged by column (upsert).
- **File extraction** (`/api/ai/extract-source` + `/api/ai/extract-source-stream`,
  `extraction_service.py`): chunks the input, one AI call per chunk, unions tables by name / dedups
  columns. Chunking strategy depends on file:
  - **SQL scripts** → deterministic `CREATE TABLE` parser (`parse_sql_ddl`), **no AI**.
  - **Structured Excel dictionaries** → direct cell parser (`parse_xlsx_dictionary`), **no AI**,
    verbatim, instant. Returns `None` for raw/irregular sheets → falls back to AI.
  - Excel (AI path) → by sheet; **wide** sheets by columns; **dictionary** sheets group rows by their
    TABLE/ENTITY column (`xlsx_sheet_chunks`).
  - PDF/Word/text → table-boundary chunking (`split_by_tables`).
  - The `-stream` variant emits **NDJSON progress events** for the UI progress bar; the client
    (`streamExtractFile` in `common.js`) **falls back to the non-streaming endpoint** if the stream
    drops, and per-chunk failures retry once then skip (never abort the whole file).
- **Regenerate one field** (`/api/ai/regenerate-mapping`): grounded on the **full** source schema
  (all *saved* sources, preferred source first), returns an updated `joinCondition`. Prompt is
  hardened to **use only tables/columns present verbatim in the supplied list — never invent**
  (prevents hallucinating non-existent tables/columns). First-time generation stays scoped to the
  single selected source.

`ai_model()` (in `core/config.py`) strips the `[1m]` suffix from Bedrock-style model IDs before
calling the gateway. Extraction tuning constants live in `core/config.py`: `EXTRACT_TEXT_BUDGET`,
`EXTRACT_AI_CHUNK`, `EXTRACT_XLSX_ROW_CAP`, `EXTRACT_XLSX_COL_CAP`, `EXTRACT_MAX_CHUNKS`.

### Source vs Target symmetry
Both source (`js/source-systems.js`) and target (`js/target-system.js` + `js/target-schema.js`) are
connection managers supporting **SQL Server** (read live via `/api/db/metadata`) or **File System**
(upload → AI-extract tables/columns → stored on the connection object). Data Profiling
(`js/profiling.js`) is **SQL-only** — it needs a live DB and excludes File System sources.

## Conventions

- **Match the existing style**: vanilla JS (no framework), string-concatenated HTML in render
  functions, Bootstrap 5.3 + Bootstrap Icons via CDN, `escapeHtml()` for any user/AI-derived text.
- Keep `SESSION_SUMMARY.md` updated when making notable changes — it's the running project log
  (most-recent-first) and doubles as the handoff doc.
- Git: repo is `https://github.com/rakesh2023/AI_Mapping_Studio` (`main`). `win-ca-bundle.pem`,
  `server.log`, `__pycache__/`, `.claude/`, `.env` are gitignored — no secrets are committed
  (all credentials come from env vars / per-request payloads).
