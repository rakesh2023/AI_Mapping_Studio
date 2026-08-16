# 22 — Business Rules

Important, non‑obvious logic that governs correctness. Many are load‑bearing — changing them silently breaks behavior.

| Rule | Description | File | Function/where |
|---|---|---|---|
| **`null` vs `[]` for mappings** | For `aims_ai_mappings`, `null` = never generated; `[]` = explicitly cleared → must stay empty (no sample fallback). Every reader preserves the distinction (`aiRows !== null ? aiRows : []`). | `js/mapping-workspace.js`, `dashboard.js`, `etl-code.js`, `validation.js`, `export.js` | readers + `clearAllMappings` / `resetApplication` write `[]` |
| **Tenant isolation** | All per‑client data, usage logs, and deploy jobs are scoped to `(user_id, client_id)` from the **signed session**, never client input. | `tenant_store_service`, `ai_usage_logger`, `client_service`, `deployment_service` | scoped WHERE clauses; `owns_client` |
| **doc_key allowlist** | Only 12 keys are accepted for per‑client documents; unknown → 400; doc ≤ 6,000,000 chars. | `tenant_store_service` | `ALLOWED_DOC_KEYS`, `_MAX_DOC_CHARS` |
| **Admin cannot create clients** | Admins manage users only; `POST /api/clients` by an admin → 403; admins confined to the admin page. | `client_routes`, auth guard | `create_client`, `_auth_guard` |
| **Admin delete guards** | Cannot delete self (400) or another admin (400); deleting a standard user cascades clients+documents and purges usage rows. | `admin_routes`, `admin_service` | `delete_user` |
| **Self‑signup disabled** | `AIMS_SIGNUP_ENABLED` default OFF → signup returns 403; users created by admin; admin seeded from env. | `auth_routes`, `auth_service` | `signup`, `ensure_admin` |
| **Connection passwords not persisted server‑side** | DB creds arrive per request, used to open a short‑lived connection, never stored/logged; deploy job records + AI‑fix prompts contain no credentials. | `db_service`, `deployment_service`, `ai_fix_service`; frontend `ensureConnPassword` | `build_connection_string`; sessionStorage cache |
| **Deploy = all‑or‑nothing** | GO‑split batches run in ONE transaction; any failure rolls back the whole script and reports the failing batch + SQL error number. | `sql_execution_service` | `execute_batches` |
| **AI fix is human‑gated** | On a failed batch, Claude proposes a fix; the deploy **stops in `needs_review`** — the fix is loaded into the editor and never auto‑deployed. | `deployment_service`, `ai_fix_service`; `etl-code.js` | `needs_review`, `loadFixedSqlIntoEditor` |
| **ETL default: no `USE [db]`** | Generated procs must not hard‑code a database (chosen at deploy); a leading `USE` is stripped unless instructions ask to keep it. | `etl_service` | `_strip_leading_use` |
| **AI anti‑hallucination** | Regeneration/DDL use only verbatim supplied tables/columns; DDL hallucinations flagged; parse‑column/entity flag duplicates and coerce unsupported types. | `mapping_service`, `etl_service`, `schema_service` | prompts + `_ddl_hallucination_warnings` |
| **Model ID `[1m]` strip** | `ai_model()` strips a context‑window suffix (e.g. `[1m]`) before calling the gateway. | `core/config.py` | `ai_model()` |
| **Extraction determinism** | `.sql` DDL and structured Excel dictionaries are parsed with NO AI (`model=sql-ddl-parser`/`xlsx-dictionary-parser`); irregular content → AI loop; `rich=True` bypasses the xlsx fast‑path for PK/FK detection. | `extraction_service`, `parsers` | fast‑paths |
| **Confidence thresholds** | High/Medium (from Settings) classify a mapping's 0–100 confidence into High/Medium/Low; below Medium always needs review. | `js/common.js` | `confidenceLevel` |
| **Validation status = High‑gated, live** | Workspace "Validation Status" shows "Approved/Passed" only when confidence ≥ **High** threshold, derived live; an explicit Validation‑engine/user result wins. | `js/common.js`, `js/mapping-workspace.js` | `autoValidationStatus`, `displayValidationStatus` |
| **Row tint follows status** | A manual reviewStatus (Approved/Rejected/Needs Review) sets the row color; otherwise AI rows are tinted from the confidence‑vs‑threshold status (green ≥ High, orange below). | `js/mapping-workspace.js` | `rowStatusClass` |
| **Active target drives the app** | Exactly one target connection is active; `getTargetSchema()` derives the app‑wide schema from it (not double‑stored). | `js/target-schema.js` | `setActiveTarget`, `connToTargetSchema` |
| **Data Profiling is SQL‑only** | File System sources are excluded from profiling. | `js/profiling.js` | `buildSourceOptions` |
| **Login throttle** | 5 failures / 15‑min window → 15‑min lockout (429); reset on success. | `auth_service` | `record_login_result` |
| **SSRF hardening** | DB/deploy connect failures return one opaque error + per‑user rate limit (30/60s → 429). | `connection_guard`, `db_service` | `check_rate`, `GENERIC_CONNECTION_ERROR` |
| **Cache‑busting** | After any `.css`/`.js` edit, bump `?v=YYYYMMDD<letter>` across all HTML or browsers serve stale assets. | `pages/*.html`, `index.html` | see `CLAUDE.md` |
