# 08 — API Documentation

All endpoints are same‑origin under one Flask process. **Auth**: unless noted public, a valid session (`session["uid"]`) is required (unauthenticated `/api/*` → 401). **CSRF**: mutating methods (`POST/PUT/PATCH/DELETE`) under `/api/` **except** `/api/auth/*` require the `X-CSRF-Token` header to match the `csrf_token` cookie (else 403). Standard error shape: `{"ok": false, "error": "..."}` with an appropriate status.

## Endpoint matrix

| Method | URL | Controller (blueprint) | Service | Auth | CSRF |
|---|---|---|---|---|---|
| GET | `/` | `index` (static_routes) | — | public | — |
| GET | `/login` | `login_page` | — | public | — |
| GET | `/onboarding` | `onboarding_page` | — | session* | — |
| GET | `/<path:path>` | `static_proxy` | — | mixed** | — |
| POST | `/api/auth/signup` | `signup` (auth_routes) | `auth_service.signup` | public | exempt |
| POST | `/api/auth/login` | `login` | `auth_service.authenticate_result` | public | exempt |
| POST | `/api/auth/logout` | `logout` | — | public | exempt |
| GET | `/api/auth/me` | `me` | `auth_service.get_user`, `client_service.list_clients` | public path (401 if no session) | — |
| POST | `/api/auth/select-client` | `select_client` | `client_service.owns_client` | session | exempt |
| GET | `/api/clients` | `list_clients` (client_routes) | `client_service.list_clients` | session | — |
| POST | `/api/clients` | `create_client` | `client_service.create_client` (blocks admins) | session | yes |
| PUT | `/api/clients/<int:client_id>` | `update_client` | `client_service.update_client` | session | yes |
| GET | `/api/state` | `get_bundle` (state_routes) | `tenant_store_service.get_bundle` | session + active client | — |
| DELETE | `/api/state` | `delete_all` | `tenant_store_service.delete_all` | session + active client | yes |
| GET | `/api/state/<doc_key>` | `get_doc` | `tenant_store_service.get_doc` | session + active client | — |
| PUT | `/api/state/<doc_key>` | `put_doc` | `tenant_store_service.set_doc` | session + active client | yes |
| GET | `/api/db/drivers` | `list_drivers` (db_routes) | `db_service.list_drivers` | session | — |
| POST | `/api/db/test` | `test_connection` | `connection_guard.check_rate`, `db_service.test_connection` | session | yes |
| POST | `/api/db/metadata` | `get_metadata` | `db_service.get_metadata` | session | yes |
| POST | `/api/db/profile` | `profile_table` | `db_service.profile_table` | session | yes |
| GET | `/api/ai/status` | `ai_status` (ai_routes) | `ai_client.ai_status` | session | — |
| GET | `/api/ai/mapping-prompt` | `mapping_prompt` | `mapping_service.default_mapping_system_prompt` | session | — |
| POST | `/api/ai/generate-mappings` | `generate_mappings` | `mapping_service.generate_mappings` | session | yes |
| POST | `/api/ai/regenerate-mapping` | `regenerate_mapping` | `mapping_service.regenerate_mapping` | session | yes |
| POST | `/api/ai/generate-etl` | `generate_etl` | `etl_service.generate_etl` | session | yes |
| POST | `/api/ai/generate-ddl` | `generate_ddl` | `etl_service.generate_ddl` | session | yes |
| POST | `/api/ai/parse-column` | `parse_column` | `schema_service.parse_column` | session | yes |
| POST | `/api/ai/parse-entity` | `parse_entity` | `schema_service.parse_entity` | session | yes |
| POST | `/api/ai/extract-source` | `extract_source` | `extraction_service.extract_source` | session | yes |
| POST | `/api/ai/extract-source-stream` | `extract_source_stream` | `extraction_service.extract_source_stream` | session | yes |
| POST | `/api/deploy` | `start_deploy` (deploy_routes) | `deployment_service.start_deploy` | session + active client | yes |
| GET | `/api/deploy/status/<job_id>` | `deploy_status` | `deployment_service.get_status` | session + active client | — |
| GET | `/api/ai-usage/logs` | `logs` (ai_usage) | `ai_usage_logger.query_logs` | session + active client | — |
| DELETE | `/api/ai-usage/logs` | `clear_logs` | `ai_usage_logger.clear_logs` | session + active client | yes |
| GET | `/api/ai-usage/summary` | `summary` | `ai_usage_logger.summary` | session + active client | — |
| GET | `/api/admin/users` | `list_users` (admin_routes) | `admin_service.list_users` | admin | — |
| POST | `/api/admin/users` | `create_user` | `admin_service.create_user` | admin | yes |
| DELETE | `/api/admin/users/<int:target_id>` | `delete_user` | `admin_service.delete_user` | admin | yes |

\* `/onboarding` is public but the guard redirects a logged‑in admin to `/pages/admin.html`.
\*\* `/css/*`, `/js/*`, `/assets/*` are public; `/pages/*` requires a session.

## Selected endpoints in detail

### POST `/api/auth/login`
- **Body:** `{"email": "<EMAIL>", "password": "<PASSWORD>"}`
- **Responses:** `200 {ok,user,clients,activeClientId,needsOnboarding}` (sets session cookie); `400 {ok:false,error,reason:"empty"|"empty_email"|"empty_password"}`; `401 {ok:false,error,reason:"no_account"|"bad_password"}`; `429 {ok:false,error,reason:"locked"}` after 5 failures within the window.
- **Notes:** password hashed via Werkzeug; always runs a hash check to reduce timing leaks (but returns distinct reasons — a deliberate UX tradeoff, see [16](16-security.md)).

### GET `/api/auth/me`
- **200** `{ok:true, user:{id,email,name,role,isAdmin,createdAt,lastLoginAt}, clients:[...], activeClientId}`; **401** if no session. Never returns `password_hash`.

### GET `/api/state` · GET/PUT `/api/state/<doc_key>` · DELETE `/api/state`
- **`<doc_key>` allowlist (12):** `db_connections, target_connections, active_target, target_schema, ai_mappings, ai_joins, mapping_overrides, mapping_history, deploy_history, exports, business_context, etl_instructions`. Unknown key → **400**.
- **GET `/api/state`** → `{ok:true, state:{<docKey>:<json>...}}` for the session's active client.
- **PUT** body `{"value": <json>}`; size cap `_MAX_DOC_CHARS = 6_000_000` → **413** if exceeded. Upsert scoped to `(uid,cid)`.
- **DELETE `/api/state`** deletes all docs for the active client only.
- **401** if no session; **409** if no active client selected.

### POST `/api/db/test` · `/api/db/metadata` · `/api/db/profile`
- **Body (shared shape):** `{server, database, schema?, trusted?, username?, password?, driver?}` (plus `table` for profile/metadata‑of‑one). Credentials are used only to build a pyodbc connection string; never persisted or logged.
- **Rate limited** per user (`connection_guard`, 30/60s → **429 + Retry‑After**). On failure returns a **single generic connection error** (no host/port/driver/SQL number) — SSRF/port‑probe hardening.
- **metadata → 200** `{ok, tables:[{name, columns:[{name,dataType,length,nullable,pk,fk,fkReference,...}]}]}`. **profile → 200** column stats (count/distinct/min/max/TOP samples). **test → 200** `{ok:true, version:...}`.

### GET `/api/ai/status`
- **200** `{ok, ready, model, baseUrl, hasKey, sdk}` — reflects whether the `anthropic` SDK and gateway credentials are present. Reads env only; no LLM call.

### GET `/api/ai/mapping-prompt?strategy=Balanced`
- **200** `{ok:true, strategy, prompt}` — the default mapping **system prompt** for that strategy (single source of truth for the editable prompt UI). See [11](11-prompt-inventory.md).

### POST `/api/ai/generate-mappings`
- **Body:** `{source:{connection,schema,tables:[{name,columns:[...]}]}, targetEntities:[{name,table,fields:[{name,dataType,length,mandatory,pk,fk,fkReference,accepted,description}]}], businessContext?, strategy?, systemPrompt?}`.
- **200** `{ok:true, mappings:[...], joins:[{targetEntity,joinCondition}], usage:{input_tokens,output_tokens}, returnedCount}`; **400** on missing source/targets, SDK absent, or model refusal. Loops per entity/field‑chunk; fabricates "Not Mapped" for omitted fields. See [10](10-ai-genai-architecture.md).

### POST `/api/ai/regenerate-mapping`
- **Body:** `{mapping:{targetEntity,targetColumn,targetDataType,...}, sourceColumns:[{table,column,dataType}], currentJoin?, entitySourceTables?, instruction?}`.
- **200** `{ok:true, mapping:{...,joinCondition}}`; **400** if no `targetColumn` or refusal. Grounded strictly on the supplied source columns (never invents).

### POST `/api/ai/extract-source` and `/api/ai/extract-source-stream`
- **Request:** `multipart/form-data` with `file` (and optional `mode=rich`).
- **`/extract-source` → 200** `{ok, fileName, model, tableCount, columnCount, tables:[...]}` (`model` = `sql-ddl-parser` / `xlsx-dictionary-parser` for deterministic fast‑paths, else the Claude model). **400** on empty file.
- **`/extract-source-stream`** → `application/x-ndjson`: `{type:"start",chunks}` … `{type:"progress",...}` … `{type:"done", ok, tableCount, tables,...}` or `{type:"error"}`.

### POST `/api/ai/generate-etl` · `/api/ai/generate-ddl`
- **generate‑etl body:** `{targetTable, database?, mappings:[...], join?, instructions?}` → **200** `{ok, sql, model, usage,...}`. **generate‑ddl body:** `{targetTable, database?, columns:[...], baselineDdl?, instructions?}` → **200** `{ok, sql, warnings:[hallucinated columns], ...}`. Both continue automatically if truncated; refusal → 400.

### POST `/api/ai/parse-column` · `/api/ai/parse-entity`
- **parse‑column body:** `{tableName, existingColumns:[...], instruction}` → **200** `{ok, columns:[{column,dataType,length,mandatory,pk,fk,fkReference,afterColumn,description}], column, confidence, note}` (`columns` multi + `column` first for back‑compat).
- **parse‑entity body:** `{existingEntities:[...], instruction}` → **200** `{ok, entity, table, description, isListTable, columns:[...], confidence, note}`.

### POST `/api/deploy` · GET `/api/deploy/status/<job_id>`
- **deploy body:** `{connection:{server,database,username?,password?,trusted?}, sql, dryRun?}` → **202/200** `{ok, jobId}`; runs on a background thread. Credentials are **not** stored in the job record or logs or AI prompts.
- **status → 200** `{ok, status:"running"|"succeeded"|"failed"|"needs_review", log:[...], fixedSql?, ...}`. Reading another tenant's `job_id` → **404** (IDOR‑hardened). **401** no session; **409** no active client.

### GET/DELETE `/api/ai-usage/logs` · GET `/api/ai-usage/summary`
- **logs** query params: `limit` (1–1000), `offset`, `feature?`, `start_date?`, `end_date?` → `{ok, logs:[...], total}` (newest‑first, tenant‑scoped). **summary** → overall + by‑feature token totals. **DELETE logs** clears only the caller's rows. Never stores prompt/response content.

### GET/POST/DELETE `/api/admin/users`
- **Admin only** (403 otherwise). **POST** `{email,password,name}` creates a **standard** user (`is_admin=0`); duplicate → 409; password < 8 → 400. **DELETE `/users/<id>`** cascades the user's clients + tenant_documents and purges usage rows; guards: cannot delete self (400) or another admin (400).
