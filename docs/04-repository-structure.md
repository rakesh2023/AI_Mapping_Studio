# 04 — Repository Structure

Repo root: `ai-mapping-studio/`. Only meaningful files/folders are documented (generated files, caches, and gitignored artifacts are omitted).

```
ai-mapping-studio/
├── index.html                 # Splash → links into pages/app.html (SPA shell)
├── CLAUDE.md                  # Project instructions/conventions (cache-busting, layering, AI patterns)
├── SESSION_SUMMARY.md         # Running project log (handoff doc; may lag git history)
├── pages/                     # One standalone HTML page per screen
├── js/                        # One vanilla-JS controller per page + shared common.js/navigation.js
├── css/                       # Token-based theming + per-area stylesheets
├── assets/images/             # PwC logos/marks (SVG)
├── data/                      # Sample/seed JSON (mostly legacy; see below)
├── docs/                      # THIS documentation
└── server/                    # Flask backend
    ├── main.py                # Entry point: app.run(...)
    ├── requirements.txt       # Python deps (Flask, pyodbc, anthropic, openpyxl, pypdf, python-docx, pytest)
    ├── .env.example           # Env var template (committed; no secrets)
    ├── README.md              # Backend-focused run/architecture doc
    ├── app/
    │   ├── __init__.py        # create_app(): config, blueprints, guards, table init, admin bootstrap
    │   ├── core/
    │   │   ├── config.py       # Env vars, ai_model(), ca_bundle(), EXTRACT_* constants
    │   │   └── capabilities.py # Optional-import guards (pyodbc, anthropic, openpyxl, PdfReader, docx)
    │   ├── db/
    │   │   ├── app_db.py        # connect(), write_lock(), ensure_app_tables()
    │   │   └── schema.sql       # users / clients / tenant_documents (CREATE IF NOT EXISTS)
    │   ├── parsers/            # PURE: sql_ddl_parser, file_parsers, text_chunking, sql_batches
    │   ├── schemas/
    │   │   └── ai_schemas.py    # JSON Schemas for Claude structured output
    │   ├── services/          # Business logic (see table)
    │   └── api/               # Thin blueprints (see table)
    └── tests/                 # pytest suite (30 test files) + conftest.py
```

## `pages/` (screens)

| File | Screen |
|---|---|
| `app.html` | Persistent SPA shell (iframe host) |
| `dashboard.html` | Dashboard / KPIs |
| `source-systems.html` | Source connection manager |
| `target-system.html` | Target connection manager + schema browser (loads SheetJS) |
| `metadata-explorer.html` | Source metadata browser |
| `data-profiling.html` | Column profiling (SQL only) |
| `ai-mapping-generator.html` | Mapping generation config + console |
| `mapping-workspace.html` | Review grid |
| `validation.html` | Validation issues |
| `mapping-history.html` | Audit trail |
| `export.html` | Export document |
| `etl-code.html` | ETL/DDL generation + deploy |
| `ai-usage-report.html` | AI usage report |
| `settings.html` | Settings (thresholds/pageSize/strategy/theme) |
| `login.html` | Login (standalone, no shell) |
| `onboarding.html` | First-run client creation (standalone) |
| `admin.html` | User administration (admins only) |
| `introduction.html` | Static getting-started page |

## `js/` (controllers)

`common.js` (shared shell/state/helpers) and `navigation.js` (`getQueryParam`) load on every shell page; each page also loads its own controller. `target-schema.js` is a **helper** (no page) that is the single source of truth for the target schema. See [06 — Frontend](06-frontend.md) and [27 — Source Reference Index](27-source-reference-index.md).

## `server/app/services/` responsibilities

| Service | Responsibility |
|---|---|
| `auth_service.py` | Signup/login/verify, password hashing, login throttling, admin bootstrap (`ensure_admin`) |
| `client_service.py` | Create/list/update clients; ownership checks (`owns_client`) |
| `tenant_store_service.py` | Per‑tenant document store: `get_doc/set_doc/get_bundle/delete_all`; `doc_key` allowlist |
| `admin_service.py` | `is_admin`, list/create/delete users (cascade + usage purge) |
| `db_service.py` | Connection‑string builder, `test_connection`, `get_metadata`, `profile_table`, `list_drivers` |
| `connection_guard.py` | Per‑user rate limit + generic connection error (SSRF hardening) |
| `mapping_service.py` | `generate_mappings` (loop+merge), `regenerate_mapping`, `default_mapping_system_prompt` |
| `extraction_service.py` | `extract_source` / `extract_source_stream`; deterministic fast‑paths + AI loop |
| `etl_service.py` | `generate_etl` (stored proc), `generate_ddl`; continuation on truncation |
| `ai_fix_service.py` | `fix_batch` — deploy‑time AI SQL correction |
| `deployment_service.py` | Background deploy job orchestration; AI‑fix gate (`needs_review`) |
| `sql_execution_service.py` | `execute_batches` (GO‑split, single transaction, rollback‑on‑failure), dry‑run probe |
| `schema_service.py` | `parse_column` / `parse_entity` (NL → column/entity definitions) |
| `ai_client.py` | `anthropic_client()`, `call_with_fallback`, `schema_attempts`, `parse_mapping_json`, `ai_status` |
| `ai_client_service.py` | `call_ai(feature, run, attempts)` — wraps fallback + usage logging |
| `ai_usage_logger.py` | SQLite usage telemetry (`ai_usage_log`), tenant‑scoped reads |

## `server/app/api/` blueprints

| Blueprint file | url_prefix | Endpoints |
|---|---|---|
| `static_routes.py` | `/` | `/`, `/login`, `/onboarding`, `/<path>` |
| `auth_routes.py` | `/api/auth` | signup, login, logout, me, select-client |
| `client_routes.py` | `/api/clients` | list, create, update |
| `state_routes.py` | `/api/state` | bundle GET/DELETE, per‑key GET/PUT |
| `db_routes.py` | `/api/db` | drivers, test, metadata, profile |
| `ai_routes.py` | `/api/ai` | status, mapping-prompt, generate-mappings, regenerate-mapping, generate-etl, generate-ddl, parse-column, parse-entity, extract-source, extract-source-stream |
| `deploy_routes.py` | `/api/deploy` | start deploy, status/<job_id> |
| `ai_usage.py` | `/api/ai-usage` | logs GET/DELETE, summary |
| `admin_routes.py` | `/api/admin` | users list/create/delete |

## `data/` (sample JSON)

| File | Status |
|---|---|
| `source-metadata.json` | **Used** — fetched by Metadata Explorer "Load Sample Metadata". |
| `target-metadata.json` | Effectively unused (schema now derived from the active target connection). |
| `mappings.json` | Unused (no sample fallback in the multi‑tenant model). |
| `validation-results.json` | Unused. |
| `sample-documents.json` | Unused. |

**Observed Limitation:** four of the five sample files are orphaned seed data. **Recommended Improvement:** delete the unused ones to avoid confusion (they are not served).
