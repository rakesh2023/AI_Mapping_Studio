# 17 — Error Handling

## Backend

- **Service pattern:** each service catches broad `Exception`, calls `traceback.print_exc()`, and returns `({"ok": False, "error": <message>}, 400)`. Routes are thin and simply `jsonify(payload), status`.
- **AI calls:** `ai_client_service.call_ai` logs a `status="failed"` usage row (0 tokens) and **re‑raises**; the calling service converts it to `{"ok":false,error}, 400`. The structured‑output **fallback ladder** (`schema_attempts`) retries with degraded configs and only fails if every rung fails (raising the last error).
- **Refusals:** any `stop_reason == "refusal"` → `{"ok":false,...}, 400`.
- **Truncation (`max_tokens`):** handled by design — field‑chunking (mapping), per‑chunk extraction, and continuation (ETL/DDL up to 5 extra calls). `parse_entity` salvages a partial result and warns.
- **SDK/credential absence:** `anthropic is None` short‑circuits AI services with a clear "not installed" 400; `GET /api/ai/status` reports readiness.
- **DB/connection failures:** collapsed to a single opaque `GENERIC_CONNECTION_ERROR` (SSRF hardening) and rate‑limited (429 + Retry‑After); the real error is printed server‑side only.
- **Deploy failures:** `sql_execution_service` runs GO‑split batches in **one transaction**; any batch failure **rolls back the whole script** and reports the failing batch index + parsed SQL error number; the orchestrator then requests an AI fix and stops in `needs_review` (never auto‑deploys).
- **Auth failures:** login returns typed reasons (`empty`/`empty_email`/`empty_password` → 400; `no_account`/`bad_password` → 401; `locked` → 429). State/usage/deploy return 401 (no session) / 409 (no active client). Cross‑tenant ids → 403/404.
- **Persistence limits:** `doc_key` unknown → 400; document over `_MAX_DOC_CHARS` → 413.

## Frontend

- **Toasts:** `showNotification(message, type, timeout)` (`common.js`) renders into `#toast-stack` (`primary`/`success`/`danger`/`warning`). Used for successes, failures, and "backend not reachable".
- **Confirm dialogs:** `confirmDialog(message, label)` returns a `Promise<boolean>` (Bootstrap modal) — used by reset, clear‑all, delete, reject, bulk actions, admin delete.
- **Inline error boxes:** login `#authErr`, onboarding `#obErr`, admin create `#createErr`, client modal `#cmErr`, deploy `#deployFormError`; shown/hidden inline. (Note the fixed display bug: `showErr` sets `display="block"` so the styled `.auth-err` box actually appears.)
- **Inline notes:** `okNote`/`failNote`/`infoNote` render colored hint blocks; `failNote` escapes input.
- **Network/JSON guards:** most fetches wrap `res.json()` in try/catch and produce `{ok:false, error:"...HTTP <status>"}`. The mapping‑generation loop distinguishes **network failure** ("backend not reachable") from **model failure** and aborts that table with a clear message.
- **Extraction resilience:** `streamExtractFile` falls back from the NDJSON stream to the non‑streaming endpoint when the stream can't open/drops/ends without a result; per‑chunk server failures retry once then skip (never abort the whole file).
- **Validation messages:** settings threshold checks; target Add/Edit column validation (identifier regex, uniqueness, integer length, FK‑ref existence as a non‑blocking warning); deploy form required fields.

## User‑facing messages (examples)

- "No account found with this email address…" / "Incorrect password. Please try again." (login)
- "Too many failed attempts. Try again in about N minute(s)." (throttle)
- "Backend not reachable…" (network)
- "AI prompt restored to the default." / "Settings saved successfully."
- Deploy: `needs_review` surfaces the AI‑corrected SQL in the editor with a highlighted line‑diff and asks the user to review and re‑deploy.

## Timeouts, retries, fallbacks (summary)

| Concern | Behavior | Where |
|---|---|---|
| LLM HTTP timeout | httpx client `timeout=600.0` | `ai_client.anthropic_client` |
| Structured‑output rejection | 4‑rung fallback ladder | `schema_attempts` / `call_with_fallback` |
| Output truncation | chunk / continue | `mapping_service`, `extraction_service`, `etl_service` |
| Extraction chunk error | retry once, then skip | `extraction_service` |
| Stream drop | fall back to non‑streaming | `streamExtractFile` (frontend) |
| DB connect failure | generic error + rate limit | `connection_guard`, `db_service` |
| Deploy batch failure | rollback all + AI fix + human gate | `sql_execution_service`, `deployment_service` |
| Usage‑log failure | caught, printed, never raised | `ai_usage_logger` |
