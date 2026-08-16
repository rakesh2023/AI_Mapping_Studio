# 21 — Testing

## Framework & how to run

- **pytest** (`pytest>=8.0`, dev‑only). Location: `server/tests/`. No `pytest.ini`; default discovery (`test_*.py`).
```bash
cd server
python -m pytest -q
```
- **Isolation (`conftest.py`, autouse/session):** sets `AIMS_DISABLE_DOTENV=1` (so a local `server/.env` can't leak in), points `AIMS_APP_DB` at a fresh temp SQLite file and runs `ensure_app_tables()`, sets `AIMS_SECRET_KEY="test-secret-key"`, `AIMS_CSRF_ENABLED=0`, `AIMS_SIGNUP_ENABLED=1`. The usage DB is isolated per‑test via monkeypatching `usage_db_path`.
- **Config escapes:** `AUTH_DISABLED` (app.config, `test_api_routes.py` only) bypasses auth + CSRF; `test_csrf.py` re‑enables CSRF per‑file; `test_admin.py` toggles signup off to verify closed signup.

## Test files (30) and coverage

| File | Covers |
|---|---|
| `test_admin.py` | Closed signup (403); admin bootstrap; admin‑only guards (403/401); create standard user + login; duplicate 409; delete cascade (clients+documents+usage); can't delete self/other admin |
| `test_ai_client.py` | `call_with_fallback` (first success / last error); `schema_attempts` 4‑rung order; `parse_mapping_json` (raw/fenced/embedded/fallback) |
| `test_ai_client_service.py` | `call_ai` logs usage on success/failure; fallback‑then‑success logged once; missing `usage` → 0 |
| `test_ai_fix_service.py` | `fix_batch`: corrects batch, strips fences, **no credentials in prompt**, refusal/empty/unchanged rejected, salvages SQL from prose/fences |
| `test_ai_usage_isolation.py` | SEC‑001/002 cross‑tenant isolation over HTTP (delete/read scoping; auth 401 / active‑client 409; NULL owner outside request ctx) |
| `test_ai_usage_logger.py` | Logger unit: total computed, failed row keeps error, summary overall+by_feature, feature filter, pagination, scoped clear, safe pre‑table query |
| `test_api_routes.py` | Routing only (`AUTH_DISABLED`): url_map, `/` served, unknown static 404, db/ai delegation, extract no‑file 400, stream mimetype + events |
| `test_auth_flow.py` | Real gate: unauth page→302, unauth API→401; signup→onboarding→pages; login reason codes; logout; admin can't create client; can't select another user's client |
| `test_auth_service.py` | Signup validation; authenticate roundtrip (case‑insensitive, no hash leak, lastLogin); wrong pw→None; duplicate 409; **login throttle** (5→lock, reset on success); hashed not plaintext |
| `test_client_service.py` | Create/list/update; name required; cross‑user isolation; duplicate name 409 |
| `test_connection_guard.py` | SEC‑004: generic error regardless of cause; no host/port leak; per‑identity rate limit; `/api/db/test` auth 401 + 429 over HTTP |
| `test_csrf.py` | SEC‑005: GET issues cookie; missing/mismatched token→403; valid passes; `/api/auth/*` exempt; unauth mutating→401 |
| `test_db_service.py` | Connection‑string builder (driver default, TrustServerCertificate, trusted vs SQL auth, legacy driver); `_quote`; `list_drivers`; test/profile mocked |
| `test_deploy_isolation.py` | SEC‑003 deploy IDOR: Tenant B reading A's job→404; auth 401 / active‑client 409 |
| `test_deployment_service.py` | Orchestration (mocked): success; fix → `needs_review` (not auto‑deployed); fail when no fix; **no credentials in job**; dry‑run skips fix |
| `test_etl_ddl.py` | `generate_ddl` requires table+cols, flags hallucinated column, strips fences, refusal→400; `generate_etl` strips leading `USE` (keeps if instructed); `_strip_leading_use` |
| `test_extraction_service.py` | Fast‑paths + AI loop (mocked): empty→400, SQL DDL fast‑path, xlsx‑dictionary fast‑path, AI union, stream events, rich PK/FK + bypasses fast‑path |
| `test_mapping_service.py` | generate requires source+targets; happy path w/ joins+usage; fabricates Not Mapped; default prompt interpolates strategy; custom vs default systemPrompt; regenerate requires targetColumn, refusal→400 |
| `test_parsers.py` | `parse_sql_ddl` (length, `decimal(18,2)`, skip constraints, strip brackets); chunkers; `parse_xlsx_dictionary`/`norm_hdr`/`xlsx_sheet_chunks` |
| `test_schema_service.py` | `parse_column` (length‑nulling, duplicate flag, unsupported→varchar, multi‑column); `parse_entity` (defaults, dedupe, dup flag, refusal→400) |
| `test_sql_batches.py` | `split_sql_batches` (lone `GO`, whitespace, blanks, GO‑in‑line not a separator) |
| `test_sql_execution_service.py` | Empty→error idx ‑1; all commit; failure rolls back whole script + parses error number; dry‑run probe; pyodbc missing |
| `test_state_routes.py` | `/api/state` over HTTP: auth 401 / active‑client 409; put/get/bundle/delete roundtrip; unknown key 400; reset scoped; cross‑user cannot read |
| `test_tenant_store_service.py` | set/get/bundle; unknown key 400; unset→None; delete_all scoped; cross‑tenant isolation |
| (others) | supporting fixtures / helpers |

The suite emphasizes **security regressions** (SEC‑001…005), **tenant isolation**, **auth**, **parsers**, and **AI service behavior with a mocked client**. Historical pass counts recorded in `SESSION_SUMMARY.md` (e.g. 176) are snapshots; run pytest for the current number.

## Testing gaps

**Frontend: no automated tests at all** — no `package.json`, no jest/playwright/cypress. Every `js/*.js` controller and `common.js` (shell, `CLIENT_STATE`, `clientGet/lsSet`, CSRF wrapper, `streamExtractFile`, theme, confidence/validation display helpers) is exercised only by manual browser passes. **This is the single largest gap.**

**Backend paths with little/no direct coverage:**
- `db_service.get_metadata` / `profile_table` full SQL shaping (only mocked happy/fail paths).
- `ai_client.ai_status` / `GET /api/ai/status` return logic.
- `anthropic_client()` CA‑bundle wiring (network‑bound).
- `extraction_service` **PDF/Word** paths (`pypdf`, `python-docx`) on real bytes.
- `config._load_dotenv` parser.
- `static_routes` path‑traversal safety (only "index served"/"unknown→404").
- `ai_usage` HTTP‑layer date‑range filtering.
- `etl_service.generate_etl` multi‑segment continuation merge.
- Deploy retry ladder end‑to‑end (`DEPLOY_MAX_ATTEMPTS` vs the hardcoded `maxAttempts=1`).

**Recommended Improvements:** add a lightweight frontend test harness (at minimum smoke tests for the shell/auth gate and `streamExtractFile` fallback), and unit tests for the untested backend paths above; wire pytest into CI.
