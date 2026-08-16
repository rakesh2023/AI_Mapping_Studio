# 25 — Troubleshooting Guide

| Problem | Possible cause | Diagnosis | Resolution |
|---|---|---|---|
| **"My CSS/JS change didn't show up"** | Browser served a cached asset (version not bumped) | View source: the `?v=...` on the changed file is unchanged | Bump `?v=YYYYMMDD<letter>` across all HTML (see [20](20-local-development.md)/`CLAUDE.md`), hard‑refresh (Ctrl+F5) |
| **Backend `.py` change had no effect** | Reloader is off (`use_reloader=False`) | Behavior matches old code | Restart `python main.py` manually |
| **Every page redirects to `/login`** | No/expired session, or `GET /api/auth/me` 401 | Network tab shows 401 on `/api/auth/me` | Log in; check `AIMS_SECRET_KEY` is set and stable (a random per‑process key invalidates sessions on restart) |
| **Logged in but bounced to `/onboarding`** | No active client for a non‑admin | `/api/auth/me` returns `activeClientId: null` | Create a client (onboarding); admins are intentionally sent to the admin page instead |
| **Can't create a user (admin)** | Password < 8 chars, or duplicate email, or not an admin | Error box shows the reason; 400/409/403 | Use an 8+ char password / unique email; ensure the account has `is_admin=1` |
| **Login says "No account found" / "Incorrect password"** | Wrong email vs wrong password (distinct messages) | The reason text/`reason` field distinguishes them | Correct the field; after 5 failures you're locked ~15 min (429) |
| **Mutating request returns 403** | Missing/mismatched CSRF token | Response `{"error":"CSRF token missing or invalid."}` | Ensure `common.js` loaded (it attaches `X-CSRF-Token`); standalone pages attach it themselves; reload to refresh the `csrf_token` cookie |
| **AI feature fails: "not installed"** | `anthropic` SDK missing | `GET /api/ai/status` shows not ready | `pip install -r server/requirements.txt` |
| **AI feature fails: no key / auth error** | `ANTHROPIC_*` env not set/loaded | `/api/ai/status` shows `hasKey:false`; server restarted without env | Set `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`API_KEY` in `server/.env`; restart |
| **AI TLS/cert error to the gateway** | Corporate CA bundle missing | Server error mentions certificate verification | Provide `server/win-ca-bundle.pem` (or `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`); restart |
| **AI output truncated / incomplete** | Model hit `max_tokens` | Result shorter than expected | Handled automatically (field‑chunking / continuation); for extraction, per‑chunk retry‑once‑then‑skip — re‑run if a chunk was skipped |
| **DB connect fails with a vague error** | By design: opaque `GENERIC_CONNECTION_ERROR` (SSRF hardening) | Client shows one generic message; **real** error is in the server console | Read the server log for the true cause (wrong server/db/driver/creds); verify the ODBC driver is installed |
| **DB endpoints return 429** | Connection rate limit (30/60s per user) | `Retry-After` header present | Wait and retry; avoid rapid repeated Test/Metadata clicks |
| **"Backend not reachable" toast** | Flask not running / wrong port | `curl http://127.0.0.1:8000/` fails | Start `cd server && python main.py`; check `PORT` |
| **File upload extracts nothing / wrong tables** | Irregular sheet fell back to AI; or a chunk was skipped | Extraction console/stream shows chunk activity | Use a structured dictionary (deterministic parser), or enable "rich" extraction; re‑run |
| **Target schema seems empty across the app** | No **active** target connection | `getTargetSchema()` returns null; ai‑mapping shows no tables | Activate a target connection (Target System) |
| **Deploy stuck at "needs review"** | AI proposed a fix; human gate (by design) | Status `needs_review`, corrected SQL loaded in the editor | Review the highlighted diff, then click Deploy again to run the corrected SQL |
| **Deploy failed, nothing changed** | Any batch failed → whole‑script rollback | Status `failed` with batch index + SQL error number | Fix the SQL (or accept the AI fix), re‑deploy; deploy is all‑or‑nothing |
| **Data missing after switching clients** | Data is per‑client by design | Other client's docs aren't shown | Switch back to the owning client; data is isolated per `(user, client)` |
| **Reset didn't clear another client / device prefs** | Reset is scoped to the active client; device prefs stay local | Only the active client's docs are cleared | Expected; switch client to reset another; device prefs (theme, page size) are local |
| **Workspace "Approved/Warning" not matching thresholds** | Grid re‑reads Settings only on reload | Changed Settings in another tab | Hard‑refresh the workspace after changing thresholds |
| **Tests fail to find the DB / pick up your `.env`** | — | — | The suite isolates a temp DB and sets `AIMS_DISABLE_DOTENV`; just run `cd server && python -m pytest -q` |
