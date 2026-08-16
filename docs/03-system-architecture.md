# 03 — System Architecture

## Overview

AI Mapping Studio is a **single‑origin** app: one Flask process serves both the static frontend and the `/api/*` endpoints, so the browser calls the API with no CORS. The frontend holds no long‑lived secrets; all privileged work (DB access, LLM calls, persistence) happens server‑side.

Three external/data systems are involved:
- **SQLite** (two files) — the application's own persistence: identity + per‑tenant working documents (`aims_app.db`) and AI usage telemetry (`aims_usage.db`).
- **Live Microsoft SQL Server** — the *subject* of the migration (a source and/or a target), accessed per‑request via `pyodbc`. Never the app's own store.
- **Anthropic Claude** — via a corporate gateway (`ANTHROPIC_BASE_URL`), using the `anthropic` SDK.

## Layered backend

Strict downward import direction — **`api → services → parsers/schemas → core`** (documented in `server/README.md`):

- **`api/`** — thin Flask blueprints. Parse request → call a service → `jsonify((payload, status))`. No business logic.
- **`services/`** — business logic. Each returns `(payload_dict, http_status)` or raises; owns DB/LLM/pyodbc calls.
- **`parsers/`** — pure functions (no Flask/Anthropic): SQL DDL parsing, file/Excel parsing, text chunking, SQL batch splitting.
- **`schemas/`** — the JSON Schemas for Claude structured output.
- **`core/`** — `config.py` (env + tuning constants) and `capabilities.py` (optional‑import guards).

## Component diagram

```mermaid
flowchart TB
  subgraph Browser
    IDX[index.html splash]
    SHELL[app.html + app-shell.js<br/>persistent SPA shell]
    PAGES[pages/*.html + js/*.js controllers]
    COMMON[common.js shell:<br/>auth gate, CLIENT_STATE, CSRF fetch]
  end

  subgraph Flask["Flask process (server/main.py → create_app)"]
    GUARD[before_request:<br/>auth guard → CSRF guard]
    subgraph api[api/ blueprints]
      SR[static_routes]
      AR[auth_routes]
      CR[client_routes]
      STR[state_routes]
      DBR[db_routes]
      AIR[ai_routes]
      DR[deploy_routes]
      UR[ai_usage]
      ADR[admin_routes]
    end
    subgraph svc[services/]
      AUTH[auth_service]
      CLI[client_service]
      TEN[tenant_store_service]
      ADM[admin_service]
      DBS[db_service]
      MAP[mapping_service]
      EXT[extraction_service]
      ETL[etl_service]
      FIX[ai_fix_service]
      DEP[deployment_service]
      SQLE[sql_execution_service]
      SCH[schema_service]
      AIC[ai_client + ai_client_service]
      LOG[ai_usage_logger]
      CG[connection_guard]
    end
    subgraph low[parsers / schemas / core]
      PARSE[parsers/*]
      SCHEMA[schemas/ai_schemas]
      CFG[core/config]
      CAP[core/capabilities]
    end
  end

  APPDB[(aims_app.db<br/>users, clients, tenant_documents)]
  USGDB[(aims_usage.db<br/>ai_usage_log)]
  MSSQL[(Live SQL Server)]
  CLAUDE[Anthropic Gateway → Claude]

  COMMON -->|fetch /api/*| GUARD --> api
  api --> svc --> low
  AUTH --> APPDB
  CLI --> APPDB
  TEN --> APPDB
  ADM --> APPDB
  LOG --> USGDB
  DBS -->|pyodbc| MSSQL
  DEP --> SQLE -->|pyodbc| MSSQL
  AIC -->|anthropic SDK / httpx| CLAUDE
  MAP --> AIC
  EXT --> AIC
  ETL --> AIC
  FIX --> AIC
  SCH --> AIC
```

## Frontend architecture

- **Splash** `index.html` → link into the **SPA shell** `pages/app.html`.
- **SPA shell** (`js/app-shell.js`) hosts an `<iframe>`; sidebar clicks swap only the iframe `src` (hash routing) so the sidebar/header persist and don't reload. `NON_FRAMED` flows (login, onboarding, admin, the shell itself) navigate full‑page.
- **Shared shell** `js/common.js` `initShell()`: applies theme, gates auth (`GET /api/auth/me`), hydrates `CLIENT_STATE` (`GET /api/state`), and — when not framed — injects the sidebar/header. It also installs a **CSRF fetch wrapper** that adds `X-CSRF-Token` to mutating same‑origin requests.
- **State model:** per‑client (tenant) data lives **server‑side**; the browser keeps an in‑memory `CLIENT_STATE` cache and reads it synchronously via `clientGet`; writes go through a debounced `PUT /api/state/<doc_key>`. Device/UI prefs stay in `localStorage`.

See [06 — Frontend](06-frontend.md) for full detail.

## Data‑flow diagram (mapping generation as the canonical path)

```mermaid
flowchart LR
  UI[AI Mapping Generator UI] -->|select tables, edit prompt/context/strategy| GEN[generateMappings loop per entity]
  GEN -->|POST /api/ai/generate-mappings| MAPSVC[mapping_service.generate_mappings]
  MAPSVC -->|build system+user prompt| CLAUDE[Claude via ai_client_service.call_ai]
  CLAUDE --> MAPSVC
  MAPSVC -->|parse_mapping_json, merge by column, fabricate Not Mapped| RESP[(payload: mappings, joins, usage)]
  RESP --> GEN
  GEN -->|clientSet ai_mappings/ai_joins debounced| STATE[PUT /api/state/*]
  STATE --> TEN[tenant_store_service.set_doc]
  TEN --> APPDB[(aims_app.db tenant_documents)]
  MAPSVC -.->|log tokens| LOG[ai_usage_logger] --> USGDB[(aims_usage.db)]
  GEN --> WS[Mapping Workspace reads CLIENT_STATE]
```

## Deployment topology

**Current Implementation:** a single Flask **development** server (`app.run(host="127.0.0.1", port=8000, debug=True, use_reloader=False)`), no containerization, no reverse proxy, no CI/CD. See [19 — Deployment](19-deployment.md).
