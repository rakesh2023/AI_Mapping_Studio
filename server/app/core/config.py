"""Central configuration: paths, ports, the AI model id, the corporate CA
bundle, and file-extraction tuning constants.

Everything environment- or path-derived lives here so the rest of the app
reads it from one place. This module has no Flask or Anthropic dependency.

Path note: this file sits at server/app/core/config.py, i.e. THREE levels
below the repository root (core -> app -> server -> <root>). ROOT and the
CA-bundle lookup are computed relative to __file__ so they keep resolving no
matter the current working directory.
"""
import os
from typing import Optional

# server/app/core/config.py -> up 3 -> server/ ; up 4 -> repository root that
# holds index.html and the static site.
_HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(_HERE, "..", ".."))
ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))


def _load_dotenv() -> None:
    """Load simple KEY=VALUE lines from server/.env into the environment.

    A tiny, dependency-free loader (no python-dotenv). Real environment variables
    ALWAYS win — we only fill keys that aren't already set. Supports blank lines,
    '#' comments, an optional 'export ' prefix, and surrounding quotes. The file
    is gitignored, so secrets (AIMS_ADMIN_EMAIL/PASSWORD, AIMS_SECRET_KEY, …) live
    only on the machine. Tests set AIMS_DISABLE_DOTENV to stay isolated from it.
    """
    if os.environ.get("AIMS_DISABLE_DOTENV"):
        return
    path = os.path.join(SERVER_DIR, ".env")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001 - a bad .env must never block startup
        print("[config] .env load skipped: " + repr(exc))


_load_dotenv()


def port() -> int:
    """TCP port for the dev server (env PORT, default 8000)."""
    return int(os.environ.get("PORT", 8000))


def ai_model() -> str:
    """Model id for the active endpoint.

    Corporate/Bedrock gateways expect their own ids (e.g.
    bedrock.anthropic.claude-opus-4-8). Read from env, but strip any
    context-window suffix like '[1m]' — this key rejects the suffixed variant.
    """
    m = (os.environ.get("AIMS_MODEL")
         or os.environ.get("ANTHROPIC_DEFAULT_OPUS_MODEL")
         or "bedrock.anthropic.claude-opus-4-8")   # allowed by the corporate key; override via AIMS_MODEL
    return m.split("[", 1)[0]


def ca_bundle() -> Optional[str]:
    """Locate a CA bundle that trusts the corporate TLS-intercepting proxy.

    Prefer the Windows-trust-store bundle generated next to the backend (built
    by the setup step), then fall back to the env-configured bundles. Returns
    the first path that exists, or None.
    """
    candidates = [
        os.path.join(SERVER_DIR, "win-ca-bundle.pem"),
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        os.environ.get("CURL_CA_BUNDLE"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


# --- File-extraction tuning knobs (used by parsers + extraction_service) --- #
EXTRACT_TEXT_BUDGET = 60000   # hard cap chars per chunk (avoids input truncation)
EXTRACT_AI_CHUNK = 6000       # target chars per AI text-chunk — small enough that the
                              # model returns EVERY table in the slice instead of
                              # summarising a long list into a few tables.
EXTRACT_XLSX_ROW_CAP = 500     # rows per sheet-slice (tall sheets)
EXTRACT_XLSX_COL_CAP = 150     # columns per sheet-slice (WIDE sheets)
EXTRACT_XLSX_SAMPLE_ROWS = 8   # sample data rows per column-slice (wide sheets)
EXTRACT_MAX_CHUNKS = 200       # safety cap on total model calls per file

# --- Deployment (Deploy to SQL Server) --- #
DEPLOY_MAX_ATTEMPTS = 3        # total execute attempts before giving up (incl. AI fixes)


def usage_db_path() -> str:
    """Path to the local SQLite file that stores the AI usage log.

    App-owned telemetry only (token counts + metadata for every Claude call) —
    NOT a customer/target database. Defaults to server/aims_usage.db; override
    with AIMS_USAGE_DB. The file is created on first use and is gitignored.
    """
    return os.environ.get("AIMS_USAGE_DB") or os.path.join(SERVER_DIR, "aims_usage.db")


# --- Multi-tenant app store (users / clients / per-client data) --- #

def app_db_path() -> str:
    """Path to the SQLite file holding users, clients and tenant documents.

    App-owned identity + per-client working data. Defaults to server/aims_app.db;
    override with AIMS_APP_DB. Created on first use and gitignored.
    """
    return os.environ.get("AIMS_APP_DB") or os.path.join(SERVER_DIR, "aims_app.db")


# --- Know Your Data (KYD) feature --- #
# Uploaded file bytes are stored as a BLOB in the app DB (document_files), NOT on
# disk: static_routes serves the whole repo root, so an on-disk path under the repo
# would be cross-tenant readable. DB storage keeps files scoped by our queries.
KYD_ACCEPT_EXTS = ("pdf", "xml", "json", "sql", "xlsx", "xls", "csv")


def kyd_max_upload_bytes() -> int:
    """Max size of a single Know Your Data upload (env AIMS_KYD_MAX_UPLOAD_MB, default 25 MB)."""
    try:
        mb = int(os.environ.get("AIMS_KYD_MAX_UPLOAD_MB", "25"))
    except (TypeError, ValueError):
        mb = 25
    return max(1, mb) * 1024 * 1024


def secret_key() -> str:
    """Secret used to sign Flask session cookies (env AIMS_SECRET_KEY).

    REQUIRED in any real/multi-user deployment. If unset we fall back to a random
    per-process key so the app still runs in dev — but every restart invalidates
    all sessions, so set AIMS_SECRET_KEY to a long random value for deployment.
    """
    return os.environ.get("AIMS_SECRET_KEY") or ""


def session_hours() -> int:
    """Signed-cookie session lifetime in hours (env AIMS_SESSION_HOURS, default 12)."""
    try:
        return max(1, int(os.environ.get("AIMS_SESSION_HOURS", 12)))
    except (TypeError, ValueError):
        return 12


def csrf_enabled() -> bool:
    """Whether the double-submit CSRF guard is active (env AIMS_CSRF_ENABLED, default ON).

    SEC-005: defense-in-depth over SameSite=Lax for state-changing /api/* requests.
    Pure routing/unit tests disable it (they drive the API without a browser-issued
    token); it defaults ON so real deployments are protected.
    """
    return os.environ.get("AIMS_CSRF_ENABLED", "1").strip().lower() not in ("0", "false", "no", "")


def signup_enabled() -> bool:
    """Whether self-service signup is allowed (env AIMS_SIGNUP_ENABLED, default OFF).

    The tool is closed: users are created by an admin, not by self-registration.
    Defaults OFF so real deployments reject POST /api/auth/signup; tests enable it
    to bootstrap users through the signup endpoint.
    """
    return os.environ.get("AIMS_SIGNUP_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")


def lookup_mapping_enabled() -> bool:
    """Whether the lookup / typelist value-mapping feature is active
    (env AIMS_LOOKUP_MAPPING_ENABLED, default ON).

    Gates the /api/lookups endpoints and the UI feature. Defaults ON so the feature
    is usable out of the box; set to 0/false to hide it in a deployment.
    """
    return os.environ.get("AIMS_LOOKUP_MAPPING_ENABLED", "1").strip().lower() not in ("0", "false", "no", "")


def admin_email() -> str:
    """Email of the bootstrap admin, created/promoted on startup (env AIMS_ADMIN_EMAIL)."""
    return (os.environ.get("AIMS_ADMIN_EMAIL") or "").strip().lower()


def admin_password() -> str:
    """Password for the bootstrap admin when it must be created (env AIMS_ADMIN_PASSWORD)."""
    return os.environ.get("AIMS_ADMIN_PASSWORD") or ""
