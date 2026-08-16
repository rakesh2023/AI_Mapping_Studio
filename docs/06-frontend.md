# 06 — Frontend

Static HTML + vanilla JS, **no framework, no build step**. Bootstrap 5.3.3 + Bootstrap Icons via CDN; SheetJS (`xlsx@0.18.5`) only on `pages/target-system.html`. Every CSS/JS link is cache‑busted with `?v=YYYYMMDD<letter>` (see [22 — Business Rules](22-business-rules.md) and `CLAUDE.md`).

## Entry & shell

- **Splash:** `index.html` — static, no JS/auth; a link into `pages/app.html#dashboard.html`.
- **SPA shell:** `pages/app.html` + `js/app-shell.js`. `app.html` has `#sidebar-container`, `#header-container`, and `<iframe id="appFrame">`. `app-shell.js`:
  - `DEFAULT_PAGE="dashboard.html"`; `NON_FRAMED=["app.html","login.html","onboarding.html","admin.html"]`.
  - `routeFromHash()` parses `location.hash` → page (keeps `?query`), rejects non‑framed/non‑`.html`.
  - On load: `await initShell(...)` builds shell + gates auth in the **top** window, then `navigateTo(initial,false)` sets the iframe `src`.
  - **Sidebar clicks** are intercepted (delegated handler on `#sidebar-container`): `preventDefault` + `navigateTo(href,true)` → swaps only the iframe (no shell reload). `hashchange` and the iframe `load` event keep the active link + hash in sync.

- **Shared shell:** `js/common.js` `initShell(activeHref)` (called by every page controller on `DOMContentLoaded`):
  1. `applyTheme(getTheme())`.
  2. `inAppFrame()` (`window.self !== window.top`) → framed mode; `go(url)` navigates `window.top` so redirects move the whole browser.
  3. **Auth gate:** `AUTH = await fetchAuth()` → `GET /api/auth/me`; 401/error → `AUTH=null` → `go("/login")`.
  4. Admin → confined to admin page; no active client (non‑admin) → `go("/onboarding")`.
  5. `await hydrateClientState()` → `GET /api/state` into `CLIENT_STATE` **before** any controller reads storage.
  6. Framed → add `body.in-frame`, `wireShellEvents()`, return. Non‑framed → inject `buildSidebarHTML` + `buildHeaderHTML`, wire events, apply sidebar‑collapsed state, inject client modal, offer legacy import.

- **CSRF fetch wrapper** `installCsrfFetch()` (`common.js`, runs before controllers): monkey‑patches `window.fetch`; for mutating same‑origin methods it copies the readable `csrf_token` cookie into the `X-CSRF-Token` header. Standalone pages that don't load `common.js` attach the token themselves (`onboarding.js` `csrfToken()`); login needs none (exempt).

## State & storage (two‑tier)

- **Tenant data → server.** `TENANT_DOC_KEYS` (12): `db_connections, target_connections, active_target, target_schema, ai_mappings, ai_joins, mapping_overrides, mapping_history, deploy_history, exports, business_context, etl_instructions`. `hydrateClientState()` loads them into `CLIENT_STATE`; `clientGet(key,fallback)` reads the cache synchronously; `clientSet(key,value)` updates the cache and schedules a **debounced (300 ms)** `PUT /api/state/<key>`; pending writes flush on `pagehide`/`visibilitychange→hidden` with `keepalive`.
- **Routing:** `lsGet`/`lsSet`/`lsRemove` check `isTenantKey(key)` — tenant keys route to `clientGet/Set/Remove`; everything else uses `localStorage`.
- **Device prefs (stay local):** `aims_settings`, `aims_sidebar_collapsed`, `aims_gen_system_prompt`, `aims_console_hidden`, `aims_ws_hidden_cols`, `aims_workspace_set`, `aims_ws_panel_hidden`, `aims_etl_panel_hidden`, `aims_import_done_<clientId>`, etc. **Not** wiped by reset or client switch.
- **Connection passwords:** never persisted to server/localStorage. Cached in memory (`RUNTIME_PW`) + `sessionStorage` (`aims_pw_<connId>`) for the tab session only; `ensureConnPassword`/`rememberConnPassword`/`clearConnPasswords` (cleared on logout/reset).
- **`null` vs `[]` rule** for `aims_ai_mappings`: `null` = never generated; `[]` = explicitly cleared → stays empty. Every reader does `lsGet("aims_ai_mappings", null); aiRows !== null ? aiRows : []`.
- **`resetApplication()`:** confirm → `DELETE /api/state` (server clears the active client's docs) + `PUT /api/state/ai_mappings {value:[]}` + `clearConnPasswords()` + reload. Other clients/device prefs untouched.

## Page inventory

| Page | Controller | Key functions |
|---|---|---|
| dashboard | `dashboard.js` | `computeStats`, `renderKPIs`, `deriveValidationIssues`, `renderLowConfidence` |
| source-systems | `source-systems.js` | `renderConnections`, `extractSourceFile`, `saveConnectionForm`, `testConnection`, `quickTest` |
| target-system | `target-system.js` (+`target-schema.js`, XLSX) | `loadSqlTables`, `loadFileTarget`, `activateConn`, `renderTargetFields`, `openEditColModal`/`ecSave`/`persistFieldEdit`, `openAddColumnModal`/`acParse`/`persistColumn`, `aeParse`/`persistEntity` |
| (helper, no page) | `target-schema.js` | `getTargetSchema`, `setActiveTarget`, `connToTargetSchema`, `dbMetadataToEntities`, `extractedToEntities`, `parseTargetWorkbook`, `HEADER_MAP` |
| metadata-explorer | `metadata.js` | `loadLiveObjects`, `loadFileObjects`, `loadSampleMetadata`, `renderTree`, `renderColumns` |
| data-profiling | `profiling.js` | `buildSourceOptions` (SQL‑only), `loadLiveTables`, `runProfiling`, `renderLiveProfile` |
| ai-mapping-generator | `ai-mapping.js` | `renderTablePicker`, `initBizContext`, `initSystemPrompt`, `seedStrategyFromSettings`, `generateMappings`, `buildMappingRows`, `renderResult`, `checkAiStatus` |
| mapping-workspace | `mapping-workspace.js` | `mappingSets`, `entityGroups`, `applyPipeline`, `renderTable`, `rowStatusClass`, `approveMapping`, `rejectMapping`, `regenerateMapping`, `makeCellEditable`, `showMappingDetails`, `downloadMappingCsv` |
| validation | `validation.js` | `VALIDATION_RULES`, `evaluateMapping`, `runEvaluation`, `renderIssues` |
| mapping-history | `mapping-history.js` | `loadHistory`, `applyHistoryPipeline`, `renderHistory`, `exportHistoryCSV` |
| export | `export.js` | `generateExport`, `buildCSV`, `buildJSON`, `renderExportsTable` |
| etl-code | `etl-code.js` | `buildProc`/`selectLine`, `aiGenerateProc`, `buildCreateTable`, `aiGenerateDdl`, `runDeploy`/`startDeployPolling`, `loadFixedSqlIntoEditor`, `lineDiffHtml` |
| ai-usage-report | `ai-usage-report.js` | `loadSummary`, `loadLogs`, `renderRows`, `renderPager` |
| settings | `settings.js` | `loadIntoForm`, `saveForm`, `SETTINGS_DEFAULTS` |
| login | `auth.js` | submit handler, `showErr` |
| onboarding | `onboarding.js` | `ensureAuthed`, submit, `csrfToken` |
| admin | `admin.js` | `loadUsers`, create/delete handlers |
| app (shell) | `app-shell.js` | routing/navigation |
| — | `navigation.js` | `getQueryParam` |

## Frontend → API map (summary)

Shell/common: `GET /api/auth/me`, `GET /api/state`, `PUT /api/state/<key>`, `DELETE /api/state`, `POST /api/auth/logout`, `POST /api/auth/select-client`, `GET/POST/PUT /api/clients`. Per‑page calls are listed in [08 — API Documentation](08-api-documentation.md).

## Routing, forms, validation, error handling

- **Routing:** hash‑based inside the SPA shell (`app-shell.js`); standalone flows are full pages.
- **State management:** module‑level page state objects (e.g. `state` in workspace, `vState` in validation) + `CLIENT_STATE` for tenant data + `getSettings()` for prefs. No framework state.
- **Forms/validation:** settings threshold checks (medium < high, 0–100); target Add/Edit column (`ecSave`/`acValidate`: identifier regex `^[A-Za-z_][A-Za-z0-9_]*$`, uniqueness, integer length, FK‑ref existence as a non‑blocking warning); deploy form (`validateDeployForm`).
- **Error surfaces:** `showNotification(msg,type)` toasts; `confirmDialog(msg,label)` Bootstrap modals; inline `#authErr`/`#obErr`/`#createErr`/`#cmErr` boxes; `okNote`/`failNote`/`infoNote` hint blocks. `escapeHtml()` on all user/AI‑derived text (XSS defense).
- **Extraction resilience:** `streamExtractFile` NDJSON with fallback to non‑streaming (see [05](05-end-to-end-flow.md) B).

## Source/Target symmetry

Both are connection managers over `aims_db_connections` / `aims_target_connections`, each supporting **SQL Server** and **File System**. The **target** additionally supports multiple saved connections with exactly one **active**; `getTargetSchema()` (`target-schema.js`) **derives** the app‑wide schema from the active connection's `entities[]` (`connToTargetSchema`) rather than double‑storing, falling back to the legacy `aims_target_schema` blob. Any target edit re‑calls `setActiveTarget` to re‑materialize the schema. **Data Profiling is SQL‑only** (`profiling.js` excludes File System sources).
