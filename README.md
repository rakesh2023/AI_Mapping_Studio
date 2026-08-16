# AI Mapping Studio

A PwC‑themed, AI‑assisted **source‑to‑target data‑migration mapping** tool (insurance / Guidewire‑inspired). A static HTML/CSS/vanilla‑JS frontend is served by a single Python/Flask service that talks to live **Microsoft SQL Server** (via `pyodbc`) and **Anthropic Claude** (via a corporate gateway), and persists per‑tenant working data in **SQLite**.

It is **multi‑tenant**: email/password auth, admin‑managed users, per‑user Clients, and server‑side data isolation scoped by `(user_id, client_id)`.

## What it does

- Ingest **source** and **target** schemas from a live SQL Server or from uploaded data dictionaries / DDL / spreadsheets (AI extraction, with deterministic fast‑paths for SQL DDL and structured Excel).
- Use Claude to **generate column‑level mappings** (mapping type, transformation rule, business rule, null handling, confidence, and per‑entity SQL JOINs).
- **Review** mappings (approve/reject/edit/regenerate, confidence scoring, a client‑side validation engine).
- Generate **ETL stored procedures** and **CREATE TABLE DDL**, edit them, and **deploy** to SQL Server with an AI **auto‑fix** step for syntax errors (human‑gated — never auto‑deployed).
- **Export** the mapping document (CSV/JSON) and track **AI token usage**.

## Quick start

```bash
pip install -r server/requirements.txt
cp server/.env.example server/.env        # then fill in real values (never commit this)
cd server && python main.py               # serves the whole app at http://127.0.0.1:8000
```

Minimum env for a useful session: `AIMS_SECRET_KEY`, `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`), and `AIMS_ADMIN_EMAIL`/`AIMS_ADMIN_PASSWORD` to seed an admin. See [docs/20 — Local Development](docs/20-local-development.md) and [docs/15 — Configuration](docs/15-configuration.md).

Run the backend tests:

```bash
cd server && python -m pytest -q
```

> **After editing any `.css`/`.js`,** bump the cache‑busting version `?v=YYYYMMDD<letter>` across all HTML, or browsers serve stale assets (see `CLAUDE.md`).

## Tech at a glance

- **Frontend:** static HTML + vanilla JS (no framework/build); Bootstrap 5.3 + SheetJS via CDN.
- **Backend:** Flask 3 app factory; layered `api → services → parsers/schemas → core`.
- **Datastores:** SQLite (`aims_app.db`, `aims_usage.db`); live SQL Server is a source/target, not the app store.
- **AI:** Anthropic Claude (default `claude-opus-5`) via `ANTHROPIC_BASE_URL`. **No RAG, no vector DB, no agents.**

## Documentation

Full technical documentation lives in [`docs/`](docs/00-README.md) (start at the index):

| Area | Doc |
|---|---|
| Executive summary & overview | [01](docs/01-executive-summary.md), [02](docs/02-application-overview.md) |
| Architecture & repo structure | [03](docs/03-system-architecture.md), [04](docs/04-repository-structure.md) |
| End‑to‑end flow | [05](docs/05-end-to-end-flow.md) |
| Frontend / Backend / API / Database | [06](docs/06-frontend.md), [07](docs/07-backend.md), [08](docs/08-api-documentation.md), [09](docs/09-database.md) |
| AI, prompts, RAG, agents | [10](docs/10-ai-genai-architecture.md), [11](docs/11-prompt-inventory.md), [12](docs/12-rag-architecture.md), [13](docs/13-agentic-ai.md) |
| Integrations, config, security | [14](docs/14-external-integrations.md), [15](docs/15-configuration.md), [16](docs/16-security.md) |
| Errors, logging, deployment | [17](docs/17-error-handling.md), [18](docs/18-logging-monitoring.md), [19](docs/19-deployment.md) |
| Local dev, testing, business rules | [20](docs/20-local-development.md), [21](docs/21-testing.md), [22](docs/22-business-rules.md) |
| Performance, tech debt, troubleshooting | [23](docs/23-performance-scalability.md), [24](docs/24-technical-debt.md), [25](docs/25-troubleshooting.md) |
| Modification guide & source index | [26](docs/26-developer-modification-guide.md), [27](docs/27-source-reference-index.md) |

## Repository layout

```
├── index.html                 # Splash → SPA shell (pages/app.html)
├── pages/  js/  css/  assets/  # Static frontend
├── data/                      # Sample/seed JSON (mostly legacy)
├── docs/                      # Technical documentation
├── CLAUDE.md  SESSION_SUMMARY.md
└── server/                    # Flask backend (app factory + layered app/)
```

## License / repo

Repository: https://github.com/rakesh2023/AI_Mapping_Studio (branch `main`). Secrets (`.env`), databases (`*.db`), and the CA bundle (`win-ca-bundle.pem`) are gitignored — no credentials are committed.
