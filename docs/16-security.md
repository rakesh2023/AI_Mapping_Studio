# 16 — Security Review

This review reflects only mechanisms verified in the code. It separates **Currently Implemented Controls** from **Gaps / Recommendations**.

## Authentication & Authorization

**Currently Implemented**
- **Passwords** hashed with `werkzeug.security.generate_password_hash` / `check_password_hash` (`auth_service`, `admin_service`); hashes never returned (`_row_to_user` omits `password_hash`). Emails stored lowercased.
- **Sessions:** Flask signed cookie; `SESSION_COOKIE_HTTPONLY=True`, `SESSION_COOKIE_SAMESITE="Lax"`; lifetime `AIMS_SESSION_HOURS` (default 12). Key from `AIMS_SECRET_KEY`.
- **Auth guard** (`_auth_guard`, before_request): allowlist for public paths/prefixes and `/api/auth/*`; everything else needs a session. Unauth `/api/*` → 401; unauth HTML → redirect `/login`.
- **Role/authorization:** `is_admin` flag; `/api/admin/*` require admin (403 otherwise); admins confined to the admin page; **admins cannot create clients** (403). Standard users created via admin only; self‑signup disabled by default.
- **Login throttling:** 5 failures / 15‑min window → 15‑min lockout (429), reset on success (`auth_service`).
- **Tenant isolation:** every per‑client query is scoped by the **session** `(uid, cid)`, never client input; `owns_client` validates ownership; state/usage/deploy require an active client (409) and 404 on cross‑tenant ids. Regression‑tested (SEC‑001…003, `test_*_isolation.py`, `test_state_routes.py`, `test_auth_flow.py`).

**Gaps / Recommendations**
- **User enumeration (by design):** login returns distinct reasons `no_account` vs `bad_password` (different messages), so an attacker can enumerate valid emails. Timing is equalized (always hashes a placeholder) but the response text still leaks existence. *Recommendation:* collapse to a single generic message if enumeration matters for the threat model. **Observed Limitation** (intentional UX choice).
- **Login throttle is in‑memory & per‑process** — not distributed; resets on restart. *Recommendation:* move to a shared store for multi‑worker deploys.

## Secret Management

**Currently Implemented:** secrets via env / `server/.env` (gitignored); `.env.example` has placeholders only; connection passwords are per‑request and never persisted/logged; deploy job records and AI‑fix prompts are verified to contain no credentials.
**Gaps / Recommendations:** `AIMS_SECRET_KEY` falls back to a random per‑process key with only a warning (silent session invalidation on restart if unset). *Recommendation:* fail fast in production if unset; use a secret manager.

## Input Validation

**Currently Implemented:** email regex + length (`_MAX_EMAIL=254`), password `_MIN_PASSWORD=8`/max 200, name `_MAX_NAME=120`, industry `_MAX_INDUSTRY=80`, `config_json` must be a dict ≤ `_MAX_CONFIG_CHARS=20000`; `doc_key` allowlist (12) + body must be `{"value":...}` JSON‑serializable ≤ `_MAX_DOC_CHARS=6_000_000` (413). Confidence thresholds validated client‑side.

## SQL Injection

**Currently Implemented:** app store uses parameterized `sqlite3` queries throughout. `db_service._quote` bracket‑escapes SQL Server identifiers for metadata/profile queries.
**Gaps / Recommendations:** the **ETL/DDL SQL is model‑generated and user‑editable, then executed** against the target DB on deploy. This is the intended feature (the user authors migration SQL), but it is effectively arbitrary SQL execution — treat deploy targets as trusted and least‑privileged. *Recommendation:* run deploy under a constrained DB account; keep the human review gate (already present). **Observed Limitation** (inherent to the feature).

## XSS

**Currently Implemented:** `escapeHtml()` applied to user/AI‑derived text in render functions across the frontend (string‑concatenated HTML). *Recommendation:* audit any new render path to keep using `escapeHtml`.

## CSRF

**Currently Implemented (SEC‑005):** double‑submit token — readable `csrf_token` cookie (SameSite=Lax) echoed in `X-CSRF-Token`, compared with `secrets.compare_digest`; enforced on mutating `/api/*` except `/api/auth/*`; auth guard runs first (unauth mutating → 401). Frontend `installCsrfFetch()` attaches it automatically; onboarding attaches it manually. Default ON.
**Gaps:** cookie `secure=False` (dev over HTTP). *Recommendation:* set `Secure` and serve over HTTPS in production.

## CORS

**Currently Implemented:** none needed — single origin (frontend + API same host). No CORS headers are set. *Recommendation:* keep same‑origin; if an external client is ever added, add explicit CORS.

## File Uploads

**Currently Implemented:** uploads go to AI extraction / deterministic parsers; parsing is in‑memory (`openpyxl`/`pypdf`/`python-docx`), not written to disk or executed. Text truncated to `EXTRACT_TEXT_BUDGET`.
**Gaps / Recommendations:** no explicit file‑size limit or MIME allowlist at the route. *Recommendation:* add a max upload size and an extension allowlist.

## API Security / SSRF

**Currently Implemented (SEC‑004):** DB/deploy connection failures collapse to one opaque `GENERIC_CONNECTION_ERROR` (no host/port/driver/SQL‑number — open vs closed indistinguishable), and are rate‑limited per user (30/60s → 429 + Retry‑After) via `connection_guard`. Real errors printed server‑side only.
**Gaps / Recommendations:** the server will still attempt a connection to any host/port the user supplies (SSRF surface is bounded by the opaque error + rate limit, not eliminated). *Recommendation:* if deployed in a sensitive network, restrict outbound targets (allowlist) and coarsen timing further. Documented residual: coarse timing signal within the rate budget.

## Sensitive Data & Logging

**Currently Implemented:** the AI usage log stores **token counts + metadata only** — never prompt/response content, never cost. Passwords/hashes never logged. Server logs are Werkzeug's default access/error output.
**Gaps / Recommendations:** `debug=True` exposes the interactive debugger and stack traces on errors — **must not** run in production. *Recommendation:* `debug=False` behind a WSGI server (see [19](19-deployment.md)).

## Prompt Injection & LLM Output Validation

**Currently Implemented:** prompts forbid inventing tables/columns; regeneration/DDL are grounded strictly on supplied lists; DDL hallucinations flagged; AI‑fix rejects refusals/unchanged batches; deploy AI‑fix is **never auto‑deployed** (human gate). Structured output (JSON Schema) constrains shape.
**Gaps / Recommendations:** uploaded file content and business context are passed to the model and could contain injected instructions; the impact is bounded because outputs are parsed as data (JSON/SQL) and SQL is human‑reviewed before deploy. *Recommendation:* continue treating LLM output as untrusted data (already done) and keep the deploy review gate.

## Dependency Risks

**Currently Implemented:** minimal dependency set, all lower‑bound pinned (`>=`); optional packages are import‑guarded so absence degrades gracefully.
**Gaps / Recommendations:** lower‑bound pins allow unexpected major upgrades; three CDN libs are loaded without Subresource Integrity (SRI). *Recommendation:* pin exact versions (or a lockfile), add SRI to CDN `<script>`/`<link>` (or vendor them), and run periodic dependency audits.

## Summary of the most material observations

1. `debug=True` + Flask dev server is **not** production‑safe (RCE via debugger, verbose errors). — **High**
2. CSRF cookie `Secure` off / no HTTPS enforcement in‑repo. — **Medium** (deploy concern)
3. Login user‑enumeration via distinct messages. — **Low/Medium** (intentional)
4. No upload size/MIME limit; CDN libs without SRI; lower‑bound dependency pins. — **Low/Medium**
5. Deploy executes user/model‑authored SQL — inherent; mitigated by the human gate + least privilege. — **Informational**
