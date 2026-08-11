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
