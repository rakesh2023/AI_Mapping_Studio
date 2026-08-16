# 18 — Logging & Monitoring

There is **no structured logging framework** and no `logging` configuration. Three distinct channels exist.

## 1. Werkzeug request log (`server.log`)

The app runs on the Flask/Werkzeug dev server with `debug=True`, so access/error lines go to stdout/stderr. When launched with redirection they are captured to `server/server.log` (and historically a root `server.log`). All `*.log` files are gitignored. **Log levels:** Werkzeug defaults (INFO access lines, tracebacks on error). No custom logger, no rotation.

## 2. AI usage telemetry (`aims_usage.db` via `ai_usage_logger.py`)

The primary monitoring signal for AI usage. One row per Claude call in the `ai_usage_log` table (schema in [09](09-database.md)).

- **What is logged:** `call_timestamp` (UTC ISO), `feature_name`, `model`, `input_tokens`, `output_tokens`, `total_tokens`, `duration_ms`, `status` (`success`/`failed`), `error_message` (≤1000 chars), and the tenant owner `user_id`/`client_id`.
- **What is NOT logged:** **no prompt or response content, no cost/pricing** — by explicit design.
- **When:** written by `log_ai_call(...)` from `ai_client_service.call_ai` on both success and failure, on a **short‑lived background daemon thread** (zero added latency); a logging failure is caught, printed, and **never raised** (logging can't break an AI feature). Writes are serialized by a process‑wide `_WRITE_LOCK`.
- **Feature labels** (the `feature_name` values): "AI Mapping Generator", "AI Mapping Generator - Regenerate Field", "Source Metadata Extraction" (+ " (rich)"), "Target System - Add Column (AI)", "Target System - Add Entity (AI)", "ETL Code Generator - Stored Procedure", "ETL Code Generator - Create Table", "ETL Deploy - AI SQL Fix".
- **Owner derivation:** `_session_owner()` reads `session["uid"]`/`session["cid"]` on the request thread (server‑side, never client input); outside a request context → `(None, None)` (NULL owner, excluded from tenant‑scoped reads).
- **Read side:** `query_logs` (paginated, newest‑first, tenant‑scoped, optional date/feature filters) and `summary` (overall + by‑feature token totals) — surfaced by `/api/ai-usage/logs` and `/api/ai-usage/summary` and the **AI Usage Report** page (`js/ai-usage-report.js`). `clear_logs(uid,cid)` and `delete_user_logs(uid)` scope deletes; the latter runs on admin account deletion.

## 3. Guarded `print` statements (fallback channel)

Non‑fatal diagnostics printed to stdout: `[config] .env load skipped`; `[auth] WARNING: AIMS_SECRET_KEY not set — random per-process key`; `[ai_usage_logger] ... failed` (+ traceback); `[app_db] ensure_app_tables failed`. The connection guard prints the **real** DB error server‑side while returning the generic message to the client.

## Metrics / monitoring / tracing

**Current Implementation:** the only first‑class metric is **AI token usage** (via the usage DB + report). There is **no** APM, request‑tracing, error‑aggregation, health endpoint, or dashboards.

**Observed Limitations & Recommended Improvements**
- No `/health` or readiness endpoint (`capabilities.capability_report()` exists but is unused). *Add one for uptime checks.*
- No log rotation and no structured (JSON) logs. *Adopt the stdlib `logging` module with rotation and levels; ship to a log aggregator in production.*
- No error tracking (e.g. Sentry) and no per‑request correlation id. *Add for production observability.*
- DB/deploy errors are intentionally opaque to clients but only `print`‑ed server‑side — *route them through a real logger for retention.*
