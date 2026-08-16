# 26 — Developer Modification Guide

Where to change things, with the exact files. Golden rules: **match the existing style** (vanilla JS, string‑concatenated HTML, `escapeHtml`, services return `(payload, status)`), keep the import direction `api → services → parsers/schemas → core`, and **bump the cache‑bust version** after any `.css`/`.js` edit.

## Add a page

1. Create `pages/<name>.html` — copy an existing page's `<head>` (CSS links with `?v=`), `#sidebar-container`/`#header-container`, and script includes (`common.js`, `navigation.js`, `<name>.js`, all versioned).
2. Create `js/<name>.js` with a `DOMContentLoaded` handler that calls `await initShell("<name>.html")`.
3. Add the nav entry in `SIDEBAR_SECTIONS` (`js/common.js`).
4. If it should live in the SPA shell, it will be framed automatically (it's not in `NON_FRAMED` in `js/app-shell.js`). Full‑page flows go in `NON_FRAMED`.
5. Bump cache versions across all HTML.

## Add a feature (frontend)

Put page logic in the page's controller; put shared helpers/storage in `js/common.js`. Read/write tenant data via `clientGet/clientSet` (or `lsGet/lsSet`, which auto‑route tenant keys); device prefs via `lsGet/lsSet` on non‑tenant keys. Use `showNotification`/`confirmDialog` for UX.

## Add an API endpoint

1. Add a route in the appropriate blueprint under `server/app/api/` (keep it thin).
2. Implement the logic in a service under `server/app/services/` returning `(payload_dict, http_status)`.
3. Register the blueprint in `create_app()` (`server/app/__init__.py`) if it's a new one.
4. Auth is automatic (guard). For mutating `/api/*` the CSRF guard applies — the frontend's `installCsrfFetch` adds the header automatically.
5. Add a test under `server/tests/`.

## Modify business logic

Change the relevant service (e.g. mapping merge in `mapping_service.generate_mappings`, deploy gating in `deployment_service`). Keep pure parsing in `parsers/`. Update/add tests.

## Modify a prompt

Edit the string in the owning service:
- Mapping system prompt → `mapping_service.default_mapping_system_prompt` (this is what `GET /api/ai/mapping-prompt` returns and what the UI can override).
- Regenerate → `mapping_service.regenerate_mapping`.
- Extraction (+ rich) → `extraction_service._ai_extract_tables_from_text`.
- ETL / DDL → `etl_service.generate_etl` / `generate_ddl` (incl. the embedded template).
- Deploy fix → `ai_fix_service.fix_batch`.
- Add Column / Entity → `schema_service.parse_column` / `parse_entity`.
Keep the "respond with ONLY JSON / no fences" instruction and update the matching JSON Schema if you change the shape. See [11](11-prompt-inventory.md).

## Add a prompt / new AI call

1. Add a JSON Schema (if structured) in `server/app/schemas/ai_schemas.py`.
2. In a service, build `system`/`user`, call `ai_client_service.call_ai(feature_name, run, attempts=schema_attempts(SCHEMA))`, parse with `parse_mapping_json`, handle `stop_reason=="refusal"`.
3. Choose a clear `feature_name` (it becomes the usage‑log label).
4. Expose via an `ai_routes` endpoint.

## Change the LLM model

Set `AIMS_MODEL` (or `ANTHROPIC_DEFAULT_OPUS_MODEL`) in the environment; `core/config.ai_model()` resolves it and strips a `[1m]` suffix. No code change needed.

## Add an agent / tool

None exist today (see [13](13-agentic-ai.md)). To introduce tool‑use you would add `tools=[...]` handling around `ai_client.anthropic_client()` calls and a control loop in a service — currently out of scope for the architecture.

## Change RAG configuration

Not applicable — there is no RAG (see [12](12-rag-architecture.md)).

## Add a database field

- **App store:** add the column to `server/app/db/schema.sql`. For existing DBs, add a guarded `ALTER TABLE` in `ensure_app_tables()`/a `_ensure_*` helper (mirroring how `is_admin` was added). Update the owning service's queries and `_row_to_user`‑style serializers.
- **New per‑client document:** add the key to `tenant_store_service.ALLOWED_DOC_KEYS` **and** to `TENANT_DOC_KEYS`/`TENANT_LS` in `js/common.js` so it hydrates and routes.

## Add an external integration

Add a service that encapsulates the client (mirror `ai_client.py` / `db_service.py`), keep credentials per‑request or in env (never persisted), route the failure path through the generic‑error pattern if it's a network target, and expose a thin endpoint. Document it in [14](14-external-integrations.md).

## Change authentication

Session shape and guard live in `server/app/__init__.py` (`_auth_guard`, `_register_csrf`) and `auth_service`/`auth_routes`. Adjust `PUBLIC_PATHS`/`PUBLIC_PREFIXES` for new public routes. Keep the "auth guard before CSRF guard" order (so unauth mutating → 401).

## Add configuration

Add a reader in `core/config.py` (env with a sensible default), document it in `server/.env.example` and [15](15-configuration.md). Never read `os.environ` directly outside `config.py`.

## After ANY css/js change

Bump `?v=YYYYMMDD<letter>` across `pages/*.html` + `index.html`:
```powershell
Get-ChildItem -Path "pages\*.html","index.html" | ForEach-Object {
  (Get-Content $_.FullName -Raw) -replace '\?v=\d{8}[a-z]+', '?v=YYYYMMDD<letter>' | Set-Content $_.FullName -Encoding utf8
}
```
Then keep `SESSION_SUMMARY.md` updated (project convention).
