# AI Mapping Studio — Session Summary

_Last updated: 2026-08-12_

A PwC-themed, AI-assisted **source-to-target data migration mapping** tool
(insurance / Guidewire-inspired). Static HTML/CSS/vanilla-JS frontend + a
Python/Flask backend that talks to a live SQL Server and the Claude API.

---

## Latest changes (most recent first)

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
