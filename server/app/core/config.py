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
         or "claude-opus-5")
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
