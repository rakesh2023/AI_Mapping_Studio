# 15 — Configuration & Environment Variables

All configuration is read from `os.environ` in `server/app/core/config.py`. On startup, `config._load_dotenv()` loads `server/.env` (unless `AIMS_DISABLE_DOTENV` is set); **real environment variables always take precedence**. `server/.env.example` is the committed template (placeholders only). `.env` and `*.env` are gitignored — **never commit real secrets**.

## Environment variables

| Variable | Purpose | Required? | Default | Used in |
|---|---|---|---|---|
| `AIMS_SECRET_KEY` | Signs Flask session cookies | **Yes for real deploys** (else random per‑process key + warning; logins won't survive restart) | `""` | `config.secret_key()` → `create_app` |
| `ANTHROPIC_BASE_URL` | Claude gateway base URL | For AI features | SDK default | `ai_client` / SDK, `ai_status` |
| `ANTHROPIC_AUTH_TOKEN` | Gateway auth token | One of token/key for AI | `<TOKEN>` | SDK, `ai_status` |
| `ANTHROPIC_API_KEY` | API key (alternative) | One of token/key for AI | `<API_KEY>` | SDK, `ai_status` |
| `AIMS_ADMIN_EMAIL` | Bootstrap admin email (lowercased) | To seed an admin | `""` | `config.admin_email()` → `ensure_admin` |
| `AIMS_ADMIN_PASSWORD` | Password used only when **creating** a new admin | Only to create (not to promote) | `<PASSWORD>` | `config.admin_password()` → `ensure_admin` |
| `AIMS_SIGNUP_ENABLED` | Allow self‑service signup | No | **OFF** (`0`) | `config.signup_enabled()` |
| `AIMS_CSRF_ENABLED` | Toggle CSRF double‑submit guard | No | **ON** (`1`) | `config.csrf_enabled()` |
| `AIMS_SESSION_HOURS` | Session lifetime (hours) | No | `12` (min 1) | `config.session_hours()` |
| `AIMS_APP_DB` | Path to the app SQLite DB | No | `server/aims_app.db` | `config.app_db_path()` |
| `AIMS_USAGE_DB` | Path to the AI‑usage SQLite DB | No | `server/aims_usage.db` | `config.usage_db_path()` |
| `AIMS_MODEL` | Primary model id override | No | falls through | `config.ai_model()` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Secondary model id source | No | falls through | `config.ai_model()` |
| (model literal) | Final fallback model id | — | `claude-opus-5` | `config.ai_model()` (`[1m]` stripped) |
| `PORT` | Dev server TCP port | No | `8000` | `config.port()` → `main.py` |
| `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` | CA‑bundle fallbacks | No | — | `config.ca_bundle()` |
| `AIMS_DISABLE_DOTENV` | Skip loading `server/.env` (tests) | No (test only) | unset | `config._load_dotenv()` |

> Test‑only config flags set by the suite: `AUTH_DISABLED` (app.config; bypasses auth + CSRF guards, `test_api_routes.py` only), and `conftest.py` sets `AIMS_DISABLE_DOTENV=1`, a temp `AIMS_APP_DB`, `AIMS_SECRET_KEY=test-secret-key`, `AIMS_CSRF_ENABLED=0`, `AIMS_SIGNUP_ENABLED=1`.

## Tuning constants (module‑level in `config.py`, not env)

| Constant | Value | Purpose |
|---|---|---|
| `EXTRACT_TEXT_BUDGET` | 60000 | Max chars of file text sent per AI extraction call |
| `EXTRACT_AI_CHUNK` | 6000 | Target chars per extraction chunk |
| `EXTRACT_XLSX_COL_CAP` | 150 | "Wide sheet" column threshold (column‑slice chunking) |
| `EXTRACT_XLSX_SAMPLE_ROWS` | 8 | Sample rows per wide‑sheet column slice |
| `EXTRACT_XLSX_ROW_CAP` | 500 | Defined but **unused** by the parsers read |
| `EXTRACT_MAX_CHUNKS` | 200 | Safety cap on chunk count |
| `DEPLOY_MAX_ATTEMPTS` | 3 | Defined but the deploy service currently hardcodes `maxAttempts=1` |

**Observed Limitations:** `EXTRACT_XLSX_ROW_CAP` and `DEPLOY_MAX_ATTEMPTS` are defined but not wired to the code paths that would use them. **Recommended Improvement:** either wire them in or remove them to avoid confusion.

## Gitignored artifacts (never committed)

`.env` / `*.env`, `*.db` (both SQLite files), `server/win-ca-bundle.pem`, `server/server.log` / `*.log`, `__pycache__/`, `.venv`/`venv`/`env`, `.vscode`/`.idea`, `.claude/`, `*.tmp`/`*.bak`. `server/.env.example` is intentionally committed.

## Secrets handling

- No secret values appear in source, docs, or logs. Connection passwords are per‑request only.
- **Recommended Improvement (deploy):** inject env vars via a platform secret manager (e.g. Azure Key Vault) rather than shipping a `.env` file.
