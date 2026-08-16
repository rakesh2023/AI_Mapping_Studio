# 20 — Local Development Guide

All commands are the ones actually used in this repo (`server/README.md`, `CLAUDE.md`).

## 1. Prerequisites

- **Python 3.10+** (developed/tested on 3.12).
- **pip**.
- **Microsoft ODBC Driver for SQL Server 17 or 18** — required only for live SQL Server features (test/metadata/profile/deploy). Without it, the app still runs; DB endpoints report the missing driver.
- **Claude gateway access** — `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`). Without these, AI endpoints fail but DB/static serving works.
- **`server/win-ca-bundle.pem`** — corporate CA bundle for the TLS‑intercepting proxy (gitignored; rebuild locally). Optional if your gateway uses a public CA.
- A modern browser.

## 2. Get the code

```bash
git clone https://github.com/rakesh2023/AI_Mapping_Studio
cd ai-mapping-studio
```

## 3. Install dependencies

```bash
pip install -r server/requirements.txt
```

Installs Flask, pyodbc, anthropic, openpyxl, pypdf, python-docx, pytest. (`openpyxl`/`pypdf`/`python-docx`/`pyodbc`/`anthropic` are optional‑guarded — missing ones only disable their features.)

## 4. Configure environment

Copy the template and fill in real values (never commit the result):

```bash
cp server/.env.example server/.env
```

Minimum for a useful dev session (see [15](15-configuration.md) for the full list):

```
AIMS_SECRET_KEY=<a long random string>
ANTHROPIC_BASE_URL=<gateway base url>
ANTHROPIC_AUTH_TOKEN=<gateway token>     # or ANTHROPIC_API_KEY=<key>
AIMS_ADMIN_EMAIL=<admin@example.com>     # to seed an admin on first run
AIMS_ADMIN_PASSWORD=<admin password>
# AIMS_SIGNUP_ENABLED=1                   # optional: allow self-signup in dev
```

`server/.env` is auto‑loaded on startup; real environment variables take precedence.

## 5. Configure the database

**Nothing to do** — the SQLite files are created automatically on first startup:
- `aims_app.db` (users/clients/tenant_documents) via `ensure_app_tables()`.
- `aims_usage.db` (AI usage log) via `ensure_usage_table()`.
- The admin account is created/promoted from `AIMS_ADMIN_EMAIL`/`AIMS_ADMIN_PASSWORD` by `ensure_admin()`.

Live SQL Server databases are configured **in the UI** (Source/Target System pages) at runtime — they are not part of app setup.

## 6. Start the backend (serves the whole app)

```bash
cd server
python main.py
```

Serves both the static site and `/api/*` at **http://127.0.0.1:8000** (`debug=True`, reloader off).

> **Note:** `use_reloader=False`, so **restart the process manually after backend (`.py`) changes**.

## 7. Start the frontend

No separate step — the same Flask server serves the frontend. Open:

```
http://127.0.0.1:8000/
```

`index.html` (splash) → **Enter Application** → `pages/app.html` (SPA shell) → login.

> **After editing any `.css`/`.js`,** bump the cache‑busting version across all HTML or the browser will serve stale assets (see [22](22-business-rules.md) and `CLAUDE.md`):
> ```powershell
> Get-ChildItem -Path "pages\*.html","index.html" | ForEach-Object {
>   (Get-Content $_.FullName -Raw) -replace '\?v=\d{8}[a-z]+', '?v=YYYYMMDD<letter>' | Set-Content $_.FullName -Encoding utf8
> }
> ```

## 8. Run the application

Log in with the seeded admin (to create users) or, with `AIMS_SIGNUP_ENABLED=1`, sign up. Create a Client (onboarding), then configure a Source and a Target, generate mappings, review, and export.

## 9. Run tests

```bash
cd server
python -m pytest -q
```

Backend only (there is no frontend test tooling). The suite isolates its own temp DB and disables `.env` loading (see [21](21-testing.md)).

## 10. Stop the application

`Ctrl+C` in the terminal running `python main.py`.

## Smoke‑testing the API directly

```bash
curl -s http://127.0.0.1:8000/api/ai/status        # requires a session in normal mode
```

Most `/api/*` calls require a logged‑in session cookie + CSRF token, so browser testing is usually easiest.
