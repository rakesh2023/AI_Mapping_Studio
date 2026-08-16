# 27 — Source Code Reference Index

## Backend — `server/`

| File | Purpose | Key functions / symbols | Docs |
|---|---|---|---|
| `main.py` | Entry point | `app.run(127.0.0.1:8000, debug=True, use_reloader=False)` | [07](07-backend.md), [19](19-deployment.md) |
| `app/__init__.py` | App factory | `create_app`, `_register_auth_guard`/`_auth_guard`, `_register_csrf`/`_csrf_guard`/`_issue_csrf_cookie`, blueprint registration | [07](07-backend.md), [16](16-security.md) |
| `app/core/config.py` | Config + tuning | `port`, `ai_model`, `ca_bundle`, `secret_key`, `session_hours`, `csrf_enabled`, `signup_enabled`, `admin_email/password`, `app_db_path`, `usage_db_path`, `_load_dotenv`, `EXTRACT_*` | [15](15-configuration.md) |
| `app/core/capabilities.py` | Optional imports | `pyodbc`, `anthropic`, `openpyxl`, `PdfReader`, `docx`, `capability_report` | [07](07-backend.md) |
| `app/db/app_db.py` | App SQLite access | `connect`, `write_lock`, `ensure_app_tables`, `_ensure_user_columns` | [09](09-database.md) |
| `app/db/schema.sql` | App schema | `users`, `clients`, `tenant_documents` + indexes | [09](09-database.md) |
| `app/schemas/ai_schemas.py` | LLM JSON Schemas | `MAPPING_ITEM_SCHEMA`, `SINGLE_MAPPING_SCHEMA`, `SOURCE_EXTRACT_SCHEMA`, `RICH_EXTRACT_SCHEMA`, `ENTITY_SCHEMA`, `COLUMN_SCHEMA`, `COLUMNS_SCHEMA` | [11](11-prompt-inventory.md) |
| `app/parsers/sql_ddl_parser.py` | Deterministic DDL parse | `parse_sql_ddl` | [10](10-ai-genai-architecture.md), [11](11-prompt-inventory.md) |
| `app/parsers/file_parsers.py` | File/Excel parse | `parse_xlsx_dictionary`, `extract_file_chunks`, `xlsx_sheet_chunks`, `extract_file_text` | [10](10-ai-genai-architecture.md) |
| `app/parsers/text_chunking.py` | Chunking | `split_text_chunks`, `split_by_tables`, `table_marker` | [10](10-ai-genai-architecture.md) |
| `app/parsers/sql_batches.py` | GO splitting | `split_sql_batches` | [17](17-error-handling.md) |
| `app/services/auth_service.py` | Auth | `signup`, `authenticate_result`, `authenticate`, `login_locked_seconds`, `record_login_result`, `get_user`, `ensure_admin`, `_row_to_user` | [16](16-security.md) |
| `app/services/client_service.py` | Clients | `create_client`, `list_clients`, `update_client`, `owns_client`, `get_client` | [09](09-database.md) |
| `app/services/tenant_store_service.py` | Per‑tenant docs | `get_doc`, `set_doc`, `get_bundle`, `delete_all`, `ALLOWED_DOC_KEYS`, `_MAX_DOC_CHARS` | [09](09-database.md) |
| `app/services/admin_service.py` | User admin | `is_admin`, `list_users`, `create_user`, `delete_user` | [08](08-api-documentation.md) |
| `app/services/db_service.py` | SQL Server | `build_connection_string`, `_quote`, `test_connection`, `get_metadata`, `profile_table`, `list_drivers` | [14](14-external-integrations.md) |
| `app/services/connection_guard.py` | Rate limit / SSRF | `check_rate`, `GENERIC_CONNECTION_ERROR`, `ConnectionAttemptError` | [16](16-security.md) |
| `app/services/mapping_service.py` | Mapping AI | `generate_mappings`, `_call_model`, `_build_user`, `regenerate_mapping`, `default_mapping_system_prompt`, `FIELD_CHUNK` | [10](10-ai-genai-architecture.md), [11](11-prompt-inventory.md) |
| `app/services/extraction_service.py` | Extraction AI | `extract_source`, `extract_source_stream`, `_ai_extract_tables_from_text` | [10](10-ai-genai-architecture.md), [11](11-prompt-inventory.md) |
| `app/services/etl_service.py` | ETL/DDL AI | `generate_etl`, `generate_ddl`, `_generate_with_continuation`, `_strip_fences`, `_strip_leading_use`, `_ddl_hallucination_warnings` | [10](10-ai-genai-architecture.md), [11](11-prompt-inventory.md) |
| `app/services/ai_fix_service.py` | Deploy SQL fix | `fix_batch`, `_extract_sql`, `_REFUSAL` | [10](10-ai-genai-architecture.md), [11](11-prompt-inventory.md) |
| `app/services/deployment_service.py` | Deploy orchestration | `start_deploy`, `get_status` (in‑memory job store; `needs_review` gate) | [05](05-end-to-end-flow.md) |
| `app/services/sql_execution_service.py` | Batch execution | `execute_batches` (one transaction, rollback‑on‑failure), dry‑run probe | [17](17-error-handling.md) |
| `app/services/schema_service.py` | NL → schema | `parse_column`, `parse_entity`, `SUPPORTED_TYPES`, `LENGTH_TYPES` | [11](11-prompt-inventory.md) |
| `app/services/ai_client.py` | LLM plumbing | `anthropic_client`, `call_with_fallback`, `schema_attempts`, `parse_mapping_json`, `ai_status` | [10](10-ai-genai-architecture.md) |
| `app/services/ai_client_service.py` | LLM + logging | `call_ai`, `log_ai_call` | [10](10-ai-genai-architecture.md), [18](18-logging-monitoring.md) |
| `app/services/ai_usage_logger.py` | Usage telemetry | `ensure_usage_table`, `log_ai_call`, `query_logs`, `summary`, `clear_logs`, `delete_user_logs`, `_session_owner` | [18](18-logging-monitoring.md) |
| `app/api/static_routes.py` | Static + pages | `index`, `login_page`, `onboarding_page`, `static_proxy` | [08](08-api-documentation.md) |
| `app/api/auth_routes.py` | `/api/auth` | `signup`, `login`, `logout`, `me`, `select_client`, `_set_login`, `_me_payload` | [08](08-api-documentation.md) |
| `app/api/client_routes.py` | `/api/clients` | `list_clients`, `create_client`, `update_client` | [08](08-api-documentation.md) |
| `app/api/state_routes.py` | `/api/state` | `get_bundle`, `delete_all`, `get_doc`, `put_doc`, `_scope` | [08](08-api-documentation.md) |
| `app/api/db_routes.py` | `/api/db` | `list_drivers`, `test_connection`, `get_metadata`, `profile_table` | [08](08-api-documentation.md) |
| `app/api/ai_routes.py` | `/api/ai` | `ai_status`, `mapping_prompt`, `generate_mappings`, `regenerate_mapping`, `generate_etl`, `generate_ddl`, `parse_column`, `parse_entity`, `extract_source`, `extract_source_stream` | [08](08-api-documentation.md) |
| `app/api/deploy_routes.py` | `/api/deploy` | `start_deploy`, `deploy_status` | [08](08-api-documentation.md) |
| `app/api/ai_usage.py` | `/api/ai-usage` | `logs`, `clear_logs`, `summary` | [08](08-api-documentation.md) |
| `app/api/admin_routes.py` | `/api/admin` | `list_users`, `create_user`, `delete_user`, `_require_admin` | [08](08-api-documentation.md) |
| `tests/` | pytest suite (30 files) | see [21](21-testing.md) | [21](21-testing.md) |

## Frontend — `js/`

| File | Purpose | Key functions |
|---|---|---|
| `common.js` | Shared shell/state/helpers | `initShell`, `installCsrfFetch`, `fetchAuth`, `hydrateClientState`, `clientGet/clientSet`, `lsGet/lsSet`, `getSettings`, `applyTheme`, `confidenceLevel`, `autoValidationStatus`, `displayValidationStatus`, `showNotification`, `confirmDialog`, `resetApplication`, `streamExtractFile`, `ensureConnPassword`, connection‑store helpers |
| `app-shell.js` | SPA iframe shell | `routeFromHash`, `navigateTo`, `setActive`, `NON_FRAMED` |
| `navigation.js` | Nav util | `getQueryParam` |
| `target-schema.js` | Target schema source of truth | `getTargetSchema`, `setActiveTarget`, `connToTargetSchema`, `dbMetadataToEntities`, `extractedToEntities`, `parseTargetWorkbook`, `migrateLegacyTargetSchema`, `HEADER_MAP` |
| `dashboard.js` | Dashboard | `computeStats`, `renderKPIs`, `deriveValidationIssues` |
| `source-systems.js` | Source connections | `saveConnectionForm`, `extractSourceFile`, `testConnection`, `quickTest` |
| `target-system.js` | Target connections + editors | `loadSqlTables`, `loadFileTarget`, `activateConn`, `openEditColModal`/`ecSave`/`persistFieldEdit`, `acParse`/`persistColumn`, `aeParse`/`persistEntity` |
| `metadata.js` | Metadata explorer | `loadLiveObjects`, `loadSampleMetadata`, `renderTree` |
| `profiling.js` | Data profiling (SQL only) | `buildSourceOptions`, `runProfiling`, `renderLiveProfile` |
| `ai-mapping.js` | Mapping generator | `generateMappings`, `buildMappingRows`, `initSystemPrompt`, `initBizContext`, `seedStrategyFromSettings`, `renderTablePicker`, `checkAiStatus` |
| `mapping-workspace.js` | Review grid | `applyPipeline`, `renderTable`, `rowStatusClass`, `approveMapping`, `rejectMapping`, `regenerateMapping`, `makeCellEditable`, `showMappingDetails`, `downloadMappingCsv` |
| `validation.js` | Validation engine | `VALIDATION_RULES`, `evaluateMapping`, `runEvaluation` |
| `mapping-history.js` | Audit trail | `loadHistory`, `renderHistory`, `exportHistoryCSV` |
| `export.js` | Export | `generateExport`, `buildCSV`, `buildJSON` |
| `etl-code.js` | ETL/DDL + deploy | `buildProc`/`selectLine`, `aiGenerateProc`, `buildCreateTable`, `runDeploy`/`startDeployPolling`, `loadFixedSqlIntoEditor`, `lineDiffHtml` |
| `ai-usage-report.js` | Usage report | `loadSummary`, `loadLogs`, `renderPager` |
| `settings.js` | Settings | `loadIntoForm`, `saveForm`, `SETTINGS_DEFAULTS` |
| `auth.js` | Login | submit handler, `showErr` |
| `onboarding.js` | Onboarding | `ensureAuthed`, `csrfToken` |
| `admin.js` | User admin | `loadUsers`, create/delete |

## Other

| Path | Purpose |
|---|---|
| `pages/*.html` | One page per screen (see [04](04-repository-structure.md)) |
| `css/*.css` | `common.css` (tokens/theme), `mapping.css` (grid/row tints), `tables.css`, `sidebar.css`, `forms.css`, `responsive.css` |
| `data/*.json` | Sample/seed data (only `source-metadata.json` still used) |
| `CLAUDE.md` | Conventions (cache‑busting, layering, AI patterns) |
| `SESSION_SUMMARY.md` | Running project log |
| `server/README.md` | Backend run/architecture notes |
| `server/.env.example` | Env var template |
