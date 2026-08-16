# AI Mapping Studio — Technical Documentation

This documentation was produced by analyzing the actual source code of the repository. It is intended to let a new engineer understand, run, extend, and maintain the application without depending on the original author.

> **Conventions used throughout**
> - **Current Implementation** — what the code actually does today.
> - **Observed Limitation** — a real gap/weakness verified in the code.
> - **Recommended Improvement** — a suggestion (not yet implemented).
> - File references use repo‑relative paths, e.g. `server/app/services/mapping_service.py`.
> - No secrets are printed anywhere; credentials appear only as placeholders (`<SECRET>`).

## Index

| # | Document | What it covers |
|---|----------|----------------|
| 00 | [README (this file)](00-README.md) | Master index |
| 01 | [Executive Summary](01-executive-summary.md) | Purpose, business problem, users, capabilities, stack |
| 02 | [Application Overview](02-application-overview.md) | Features, technology stack table, glossary |
| 03 | [System Architecture](03-system-architecture.md) | Layers, component + data‑flow diagrams |
| 04 | [Repository Structure](04-repository-structure.md) | Folder/file responsibilities |
| 05 | [End‑to‑End Flow](05-end-to-end-flow.md) | Sequence diagrams + a full user journey |
| 06 | [Frontend](06-frontend.md) | Pages, shell, state, SPA, workflows |
| 07 | [Backend](07-backend.md) | App factory, startup, layers, services |
| 08 | [API Documentation](08-api-documentation.md) | Every endpoint |
| 09 | [Database](09-database.md) | SQLite schemas, ER diagram, isolation |
| 10 | [AI / GenAI Architecture](10-ai-genai-architecture.md) | Every LLM call, params, fallback ladder |
| 11 | [Prompt Inventory](11-prompt-inventory.md) | Every prompt, verbatim, with construction |
| 12 | [RAG Architecture](12-rag-architecture.md) | RAG status |
| 13 | [Agentic AI](13-agentic-ai.md) | Agent/tool status |
| 14 | [External Integrations](14-external-integrations.md) | Anthropic gateway, SQL Server, CDNs |
| 15 | [Configuration & Environment](15-configuration.md) | Env vars, tuning constants |
| 16 | [Security Review](16-security.md) | Controls implemented + gaps |
| 17 | [Error Handling](17-error-handling.md) | Frontend/backend/LLM failure handling |
| 18 | [Logging & Monitoring](18-logging-monitoring.md) | Usage telemetry, logs |
| 19 | [Deployment](19-deployment.md) | How it runs; gaps |
| 20 | [Local Development](20-local-development.md) | Setup & run instructions |
| 21 | [Testing](21-testing.md) | Test suite + gaps |
| 22 | [Business Rules](22-business-rules.md) | Load‑bearing rules |
| 23 | [Performance & Scalability](23-performance-scalability.md) | Current behavior + recommendations |
| 24 | [Technical Debt](24-technical-debt.md) | Evidence‑based issues |
| 25 | [Troubleshooting](25-troubleshooting.md) | Common problems |
| 26 | [Developer Modification Guide](26-developer-modification-guide.md) | Where to change what |
| 27 | [Source Reference Index](27-source-reference-index.md) | File → purpose → key symbols |

> **Stakeholder brief:** [`stakeholder-brief.html`](stakeholder-brief.html) — a self‑contained, styled one‑page executive overview (purpose, capabilities, architecture, AI usage, security posture). Open it in a browser or print it to PDF.

## One‑paragraph summary

**AI Mapping Studio** is a PwC‑themed, AI‑assisted **source‑to‑target data‑migration mapping** tool (insurance / Guidewire‑inspired). A static HTML/CSS/vanilla‑JS frontend is served by a single Python/Flask service that (a) talks to live **Microsoft SQL Server** databases via `pyodbc`, (b) calls **Anthropic Claude** through a corporate gateway for mapping generation, schema extraction, ETL/DDL generation, and SQL auto‑fix, and (c) persists per‑tenant working data in **SQLite**. It is **multi‑tenant**: email/password auth, admin‑managed users, per‑user Clients, and server‑side data isolation scoped by `(user_id, client_id)`.

## Quick facts

- **Frontend:** static HTML + vanilla JS (no framework, no build step), Bootstrap 5.3 + SheetJS via CDN.
- **Backend:** Flask 3 app factory; layered `api → services → parsers/schemas → core`.
- **Datastores:** two SQLite files — `aims_app.db` (users/clients/tenant documents) and `aims_usage.db` (AI usage telemetry). Live SQL Server is a *source/target*, not the app store.
- **AI provider:** Anthropic Claude (default model `claude-opus-5`) via `ANTHROPIC_BASE_URL` gateway.
- **RAG / vector DB / agents:** none (see [12](12-rag-architecture.md) and [13](13-agentic-ai.md)).
