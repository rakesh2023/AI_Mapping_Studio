# 02 — Application Overview

## What the application does (feature by feature)

1. **Dashboard** (`pages/dashboard.html` / `js/dashboard.js`) — KPIs, a workflow stepper, progress bars, recent activity, mappings by type/status, low‑confidence list, and a validation summary. Reads entirely from the hydrated client state; no direct API calls beyond the shell.

2. **Source Systems** (`js/source-systems.js`) — manage source connections. Each is **SQL Server** (tested/read live via `/api/db/*`) or **File System** (a file is uploaded and AI‑extracted into tables/columns stored on the connection).

3. **Target System** (`js/target-system.js` + helper `js/target-schema.js`) — manage target connections (multiple saved, exactly one **active**). Supports SQL Server (`/api/db/metadata`) or File System (in‑browser Excel parse via SheetJS, or AI extraction). Provides an active‑target browser and modals to **Add Column**, **Edit Column**, and **Add Entity** (manual or AI‑assisted).

4. **Metadata Explorer** (`js/metadata.js`) — browse source tables/columns from a live SQL connection, an uploaded file, or bundled sample metadata.

5. **Data Profiling** (`js/profiling.js`) — column profiling (row counts, distinct, min/max) for **SQL Server sources only** (File System sources are excluded).

6. **AI Mapping Generator** (`js/ai-mapping.js`) — pick target tables/columns, optionally edit the **system prompt**, the **Business Context**, and the **strategy** (Conservative/Balanced/Aggressive), then generate mappings. Runs one AI call per target entity.

7. **Mapping Workspace** (`js/mapping-workspace.js`) — the review grid. Filter by "mapping set" (source→target hop), inspect confidence, approve/reject, edit cells inline, regenerate a single field, view a detail drawer, and export CSV.

8. **Validation** (`js/validation.js`) — a client‑side rules engine (7 rules) that flags issues (e.g. confidence below the medium threshold, unmapped mandatory fields).

9. **ETL Code** (`js/etl-code.js`) — generate a SQL Server **stored procedure** per target table and **CREATE TABLE** DDL. Output is editable; it can be **deployed** to a SQL Server with a per‑batch AI **auto‑fix** that is surfaced for review.

10. **Mapping History** (`js/mapping-history.js`) — global audit trail of every change (approvals, edits, regenerations), with CSV export.

11. **Export** (`js/export.js`) — export the mapping document (CSV/JSON real; XLSX/PDF simulated).

12. **AI Usage Report** (`js/ai-usage-report.js`) — token‑usage summary and paginated call log.

13. **Settings** (`js/settings.js`) — confidence thresholds, default page size, default strategy, theme (device‑local prefs).

14. **Admin** (`js/admin.js`) — user administration (admins only): list/create/delete users.

15. **Auth & Onboarding** (`js/auth.js`, `js/onboarding.js`) — login and first‑run client creation.

## Technology stack

| Layer | Technology | Version | Purpose | Source / Configuration |
|---|---|---|---|---|
| Frontend markup/style | HTML5 + CSS | — | Static UI, token‑based theming (light/dark) | `pages/*.html`, `css/*.css` |
| Frontend logic | Vanilla JavaScript | ES2017+ | Page controllers, shared shell | `js/*.js` |
| UI kit | Bootstrap | 5.3.3 (CDN) | Layout, modals, components | `cdn.jsdelivr.net` in `pages/*.html` |
| Icons | Bootstrap Icons | 1.11.3 (CDN) | Iconography | CDN |
| Spreadsheet parse (client) | SheetJS (xlsx) | 0.18.5 (CDN) | In‑browser `.xlsx` target parsing | `pages/target-system.html` |
| Web framework | Flask | `>=3.0` | App factory, static + `/api/*`, sessions | `server/requirements.txt`, `server/app/__init__.py` |
| SQL Server driver | pyodbc | `>=5.1` | Live source/target DB access | `server/app/services/db_service.py` (optional) |
| LLM SDK | anthropic | `>=0.40` | Claude calls via gateway | `server/app/services/ai_client.py` (optional) |
| Excel parse (server) | openpyxl | `>=3.1` | Dictionary parser + AI‑path chunking | `server/app/parsers/file_parsers.py` (optional) |
| PDF parse | pypdf | `>=4.0` | PDF text extraction | `file_parsers.py` (optional) |
| Word parse | python-docx | `>=1.1` | `.docx` extraction | `file_parsers.py` (optional) |
| App datastore | SQLite (stdlib `sqlite3`) | — | Users, clients, tenant documents | `server/app/db/` → `aims_app.db` |
| Usage datastore | SQLite (stdlib `sqlite3`) | — | AI usage telemetry | `ai_usage_logger.py` → `aims_usage.db` |
| Password hashing | Werkzeug security | (bundled with Flask) | scrypt/pbkdf2 hashing | `auth_service.py` |
| HTTP client (LLM) | httpx | (transitive via anthropic) | CA‑bundle‑aware client | `ai_client.py` |
| Test framework | pytest | `>=8.0` (dev only) | Backend unit/integration tests | `server/tests/` |

**Current Implementation:** there is **no build step**, no bundler, no `package.json`, and no containerization/CI. The frontend is served as‑is by Flask.

## Glossary

| Term | Meaning |
|---|---|
| **STTM** | Source‑to‑Target Mapping — the column‑level plan mapping source columns to target columns. |
| **Mapping set / hop** | A distinct Source system → Target system pairing; the workspace filters one at a time (`targetSystem`). |
| **Entity** | A target table (logical name + physical `table`) with `fields[]`. |
| **Active target** | The one target connection whose schema drives the whole app (`aims_active_target`). |
| **Tenant** | The `(user_id, client_id)` scope; all working data is isolated to it. |
| **Client** | An engagement workspace owned by a user (SQLite `clients` row). |
| **doc_key** | One of the 12 allow‑listed per‑client JSON documents stored server‑side (e.g. `ai_mappings`). |
| **CLIENT_STATE** | The browser in‑memory cache of the tenant's documents, hydrated from `GET /api/state`. |
| **Confidence level** | High/Medium/Low derived by comparing a mapping's 0–100 confidence to the Settings thresholds. |
| **Validation status** | Passed/Warning/Critical — a confidence‑derived (or engine‑derived) status shown in the workspace. |
| **Review status** | Workflow state: AI Generated / Needs Review / Approved / Rejected / Modified by User / Approved After Modification. |
| **Rich extraction** | Extraction mode that also infers mandatory/PK/FK/fkReference from a data dictionary. |
| **Deploy job** | A background SQL‑execution task keyed by `job_id`, scoped to the tenant, with an AI auto‑fix step. |
| **Loop + merge** | The core AI pattern: many small bounded calls whose results are merged, to avoid output truncation. |
| **`[1m]` suffix** | A Bedrock‑style context‑window suffix on model IDs, stripped by `ai_model()` before calling the gateway. |
