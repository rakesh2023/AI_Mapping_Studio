# Codebase Context — AI Mapping Studio

A reference for future sessions: how this app is built, so a new feature can follow the existing patterns. Derived from a read of the actual source (no files were modified during exploration). For deep detail, see the full technical docs in [`../`](../00-README.md) (especially [07 Backend](../07-backend.md), [06 Frontend](../06-frontend.md), [08 API](../08-api-documentation.md), [09 Database](../09-database.md), [16 Security](../16-security.md), [27 Source Index](../27-source-reference-index.md)).

> **App in one line:** a PwC‑themed, AI‑assisted **source‑to‑target data conversion mapping** tool — static vanilla‑JS frontend + a single Flask service, multi‑tenant, data isolated per user + client.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| **Frontend framework** | **None** — static HTML + **vanilla JavaScript** (ES2017+). No React/Vue/build step/bundler. Bootstrap 5.3.3 + Bootstrap Icons + SheetJS (xlsx) loaded via CDN. |
| **Backend framework** | **Flask 3** (Python), app‑factory pattern. Serves both the static site and `/api/*` on one origin (no CORS). |
| **Language** | Python (backend), JavaScript + HTML + CSS (frontend). |
| **App database** | **SQLite** (stdlib `sqlite3`) — two files: `aims_app.db` (identity + per‑tenant data) and `aims_usage.db` (AI usage telemetry). |
| **External data** | **Microsoft SQL Server** via `pyodbc` — this is the *source/target of the conversion*, accessed per‑request, **not** the app's own store. |
| **LLM** | Anthropic **Claude** (`anthropic` SDK) via a corporate gateway (`ANTHROPIC_BASE_URL`). |

Dependencies (`server/requirements.txt`): `Flask`, `pyodbc`, `anthropic`, `openpyxl`, `pypdf`, `python-docx`, `pytest` (dev). `pyodbc`/`anthropic`/`openpyxl`/`pypdf`/`python-docx` are optional‑guarded (`server/app/core/capabilities.py`) — missing ones only disable their features.

---

## 2. Folder structure & naming conventions

```
ai-mapping-studio/
├── index.html                 # Splash → SPA shell
├── pages/<name>.html          # One HTML file per screen
├── js/<name>.js               # One controller per page + shared common.js, navigation.js
│   └── target-schema.js       # a shared helper (no page of its own)
├── css/*.css                  # common.css (design tokens/theme) + per-area sheets
├── assets/images/             # PwC logos/marks (SVG)
├── data/*.json                # sample/seed data (mostly legacy)
├── docs/                      # technical documentation (this folder's parent)
└── server/
    ├── main.py                # entry point (app.run)
    ├── requirements.txt
    ├── .env.example           # env template (committed, placeholders only)
    └── app/
        ├── __init__.py        # create_app(): config, blueprints, guards, table init
        ├── core/              # config.py (env + tuning), capabilities.py (optional imports)
        ├── db/                # app_db.py (connect/write_lock/ensure_app_tables) + schema.sql
        ├── parsers/           # PURE helpers: sql_ddl_parser, file_parsers, text_chunking, sql_batches
        ├── schemas/           # ai_schemas.py (LLM JSON Schemas)
        ├── services/          # business logic (one file per domain)
        └── api/               # thin Flask blueprints (one file per domain)
    └── tests/                 # pytest (test_<area>.py) + conftest.py
```

**Naming conventions**
- **Backend layering (strict, downward only):** `api → services → parsers/schemas → core`. API blueprints are *thin* (parse request → call service → jsonify); services hold the logic and return `(payload_dict, http_status)`; parsers are pure (no Flask/Anthropic).
- Blueprints: `<domain>_routes.py` with `url_prefix="/api/<domain>"` (e.g. `client_routes.py` → `/api/clients`). Services: `<domain>_service.py`.
- Frontend: each `pages/<x>.html` pairs with `js/<x>.js`; the controller calls `initShell("<x>.html")` on `DOMContentLoaded`.
- CSS: use design tokens (`var(--token)`) from `css/common.css`, not literal colors, so light/dark themes flip automatically.
- **Cache‑busting (required):** every css/js link carries `?v=YYYYMMDD<letter>`; after editing any `.css`/`.js`, bump the version across all HTML (see `CLAUDE.md`) or browsers serve stale assets.

---

## 3. How existing features are structured (the pattern)

### Canonical CRUD example: **Clients** (a user owns many clients)

- **Model / schema:** table `clients` in `server/app/db/schema.sql` (`id, user_id FK, name, industry, config_json, created_at, updated_at`, `UNIQUE(user_id, name)`). No ORM — plain parameterized `sqlite3`.
- **Service:** `server/app/services/client_service.py` — `create_client`, `list_clients`, `update_client`, `owns_client`, `get_client`. Every query filters by `user_id`; `owns_client(uid, cid)` gates access. Returns `(payload, status)`.
- **Routes/controller:** `server/app/api/client_routes.py` — `GET /api/clients` (list), `POST /api/clients` (create; **blocks admins**), `PUT /api/clients/<id>` (update). Reads the user id from the **session**, never the body.
- **Frontend:** the client switcher + modal live in the shared shell (`js/common.js`: `buildClientSwitcherHTML`, `injectClientModal`, `saveClientFromModal`), calling those endpoints via `fetch`.

### Per‑client working data: the **tenant document store** (the pattern you'll most likely reuse)

Instead of a table per feature, per‑client working data is stored as **whole‑JSON blobs**, one row per `doc_key`, in `tenant_documents (user_id, client_id, doc_key, json)`.

- **Service:** `server/app/services/tenant_store_service.py` — `get_doc`, `set_doc`, `get_bundle`, `delete_all`. A **12‑value allowlist** `ALLOWED_DOC_KEYS` restricts which keys are valid; per‑doc cap `_MAX_DOC_CHARS = 6_000_000`.
- **Routes:** `server/app/api/state_routes.py` — `GET /api/state` (bundle), `GET/PUT /api/state/<doc_key>`, `DELETE /api/state`. All scoped to the session's `(user_id, client_id)`; require an active client (409 otherwise).
- **Frontend state management:** `js/common.js` hydrates all docs once per page into an in‑memory `CLIENT_STATE` cache (`hydrateClientState()` → `GET /api/state`). Then:
  - `clientGet(docKey, fallback)` — **synchronous** read from the cache.
  - `clientSet(docKey, value)` — updates the cache + a **debounced (300 ms)** `PUT /api/state/<docKey>`; flushed on `pagehide`/`visibilitychange` with `keepalive`.
  - `lsGet`/`lsSet` auto‑route: tenant keys (`aims_<docKey>`) go through `clientGet/clientSet`; everything else (device prefs like theme, page size) stays in real `localStorage`.

### Frontend page pattern

`DOMContentLoaded` → `await initShell("<page>.html")` (applies theme, gates auth, hydrates `CLIENT_STATE`, injects sidebar/header) → the page renders from `CLIENT_STATE`/`getSettings()` and wires its own controls. HTML is built by **string concatenation** in render functions; **all user/AI‑derived text is passed through `escapeHtml()`** (XSS defense). The app is an **SPA shell** (`pages/app.html` + `js/app-shell.js`): sidebar clicks swap an `<iframe>` via hash routing so the shell persists; `NON_FRAMED` flows (login, onboarding, admin) are full‑page.

### API client & CSRF

There's no dedicated API client class — pages call `fetch("/api/...")` directly. `js/common.js` installs a **global `fetch` wrapper** (`installCsrfFetch`) that automatically adds the `X-CSRF-Token` header (from the readable `csrf_token` cookie) to mutating same‑origin requests. Errors are surfaced via `showNotification()` toasts and `confirmDialog()` modals.

### Styling approach

Token‑based theming in `css/common.css :root` (light) with dark overrides via `@media (prefers-color-scheme: dark)` and `body.theme-dark`. Bootstrap 5.3 for layout/components; per‑area sheets (`mapping.css`, `tables.css`, `sidebar.css`, `forms.css`, `responsive.css`). Prefer `var(--token)` over literals.

### AI feature pattern (if your feature calls Claude)

Build `system`/`user` strings in a service → `ai_client_service.call_ai(feature_name, run, attempts=schema_attempts(SCHEMA))` (handles a structured‑output fallback ladder + fire‑and‑forget usage logging) → parse with `parse_mapping_json` → handle `stop_reason=="refusal"`. Schemas live in `server/app/schemas/ai_schemas.py`. See [10](../10-ai-genai-architecture.md)/[11](../11-prompt-inventory.md).

---

## 4. Authentication / session (for user‑scoped data)

- **Mechanism:** Flask **signed‑cookie session** (`SESSION_COOKIE_HTTPONLY=True`, `SameSite=Lax`, lifetime `AIMS_SESSION_HOURS`, default 12). Signed with `AIMS_SECRET_KEY`. **No JWT, no sessions table.**
- **Passwords:** hashed with `werkzeug.security` (scrypt/pbkdf2); never returned. Login throttling (5 fails / 15 min → lockout).
- **Accounts:** admin‑managed; **self‑signup disabled by default** (`AIMS_SIGNUP_ENABLED`). An admin is env‑seeded on startup (`ensure_admin`).
- **The session holds:** `uid` (user id), `cid` (active client id), and cached `name`/`role`. **These are the only trusted identity — never read a user/client id from a request body or query.**
- **Guards** (`server/app/__init__.py`, `@before_request`, in order):
  1. **Auth guard** — allowlist for public paths (`/`, `/login`, `/onboarding`, `/css|/js|/assets`, `/api/auth/*`); everything else needs `session["uid"]`. Unauth `/api/*` → 401; unauth HTML → redirect `/login`. Admins confined to `/pages/admin.html`; non‑admin without an active client → `/onboarding`.
  2. **CSRF guard** — double‑submit token on mutating `/api/*` except `/api/auth/*`.
- **User‑scoped data rule (important for you):** every per‑client query is scoped by the **session** `(uid, cid)` at the service layer. To add user‑scoped data, prefer the tenant document store (§3): add your key to `ALLOWED_DOC_KEYS` (`tenant_store_service.py`) **and** to `TENANT_DOC_KEYS`/`TENANT_LS` in `js/common.js`, then read/write via `clientGet/clientSet`. If you need a real table instead, add it to `schema.sql` with `user_id`/`client_id` FKs and always filter by the session scope.
- Frontend auth: `initShell` calls `GET /api/auth/me` (401 → `/login`); `AUTH` holds `{user, clients, activeClientId}`.

---

## 5. Databases & migrations

- **App store:** `aims_app.db` (SQLite) — tables `users`, `clients`, `tenant_documents` (schema in `server/app/db/schema.sql`). Access via `server/app/db/app_db.py`: `connect()` sets `row_factory=Row` + `PRAGMA foreign_keys=ON`; a process‑wide `write_lock()` serializes writes (SQLite is single‑writer).
- **Usage store:** `aims_usage.db` (separate SQLite file) — table `ai_usage_log`, via `ai_usage_logger.py`.
- **Live SQL Server:** connected per‑request for the conversion's source/target only (`db_service.py`, `sql_execution_service.py`). Not the app store.
- **Migrations:** **no migration framework** (no Alembic/Flask‑Migrate). The schema is applied idempotently at startup: `ensure_app_tables()` runs `schema.sql` (`CREATE TABLE IF NOT EXISTS`) via `executescript`, then does **in‑place migrations** with guarded `ALTER TABLE` (e.g. `_ensure_user_columns` adds `is_admin` when missing). **To evolve the schema:** edit `schema.sql` for new installs **and** add an idempotent `ALTER TABLE ... ADD COLUMN` (guarded by a "column exists?" check) for existing DBs, mirroring `_ensure_user_columns`. Both DBs are gitignored (`*.db`).
- **Portability note:** the SQL is intentionally standard/portable to ease a future move to Postgres.

---

## 6. File storage

- **No dedicated file‑storage mechanism** — no local uploads directory, no S3/`boto3`, no Azure Blob.
- Uploaded files (Excel/PDF/Word/SQL/text) are received in‑memory at `POST /api/ai/extract-source[-stream]` (`ai_routes.py`), read as bytes, parsed by `parsers/file_parsers.py` (openpyxl/pypdf/python‑docx) or sent to Claude in chunks, and **discarded** — nothing is written to disk. Only the *parsed result* (tables/columns) is persisted, as JSON in `tenant_documents` (on the source/target connection object). `up.filename` is used only as a label.
- **If your feature needs to persist files:** none of that exists yet — you'd introduce it (e.g. a local `uploads/` dir or object storage) and a table/column to reference them, scoped by `(user_id, client_id)`.

---

## 7. Background jobs / queue

- **No queue system** — no Celery, RQ, Redis, or scheduler (APScheduler, etc.).
- The only background work uses raw **Python daemon threads**:
  - `ai_usage_logger.py` — a fire‑and‑forget `threading.Thread(daemon=True)` writes each usage row (zero added latency; failures swallowed).
  - `deployment_service.py` — SQL **deploy jobs** run on a `threading.Thread(daemon=True)`, tracked in an **in‑memory job store** keyed by `job_id` and bound to `(uid, cid)`; the frontend polls `GET /api/deploy/status/<job_id>`. (The Flask reloader is deliberately off — `use_reloader=False` — so these threads survive.)
- **Implication for you:** background work is per‑process and **lost on restart**; there's no durable/distributed queue. For anything that must survive restarts or scale across processes, you'd add one (and likely move the job store out of memory).

---

## Notes for future sessions

- **Run:** `pip install -r server/requirements.txt` then `cd server && python main.py` → http://127.0.0.1:8000 (dev server, `debug=True`, reloader off — **restart manually after backend changes**).
- **Tests:** `cd server && python -m pytest -q` (backend only; **no frontend tests exist**).
- **Newly present, not yet documented:** `server/app/services/final_mapping_service.py` exists but is not covered by the main docs (likely in‑progress work) — inspect it before relying on it.
- **Convention reminders:** bump cache‑bust versions after css/js edits; keep `SESSION_SUMMARY.md` updated; read the session's `CLAUDE.md` for the authoritative conventions.
