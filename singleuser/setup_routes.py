"""First-run setup blueprint for the single-user package.

Serves the /setup wizard page and /api/setup/* endpoints:
  - status        : is a key configured, current model, which optional deps are present
  - api-key       : validate the user's Claude key (tiny live call), persist to singleuser/.env
  - install       : pip-install a bounded optional-dependency group into this venv
  - restart       : re-exec the launcher so freshly-installed deps import cleanly

ADDITIVE — registered by run.py onto the existing app; nothing in server/app is changed.
"""
import os
import sys
import subprocess

from flask import Blueprint, request, jsonify, send_file

import _envfile
from app.core.capabilities import capability_report

setup_bp = Blueprint("singleuser_setup", __name__)

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP_HTML = os.path.join(HERE, "setup.html")

# group key -> (friendly label, pip packages to install, capability keys it provides)
GROUPS = {
    "office":    ("Excel / PDF / Word file extraction", ["openpyxl", "pypdf", "python-docx"],
                  ["openpyxl", "pypdf", "docx"]),
    "profiling": ("Know Your Data & data profiling",     ["pandas"], ["pandas"]),
    "sql":       ("Live SQL Server sources / targets",   ["pyodbc"], ["pyodbc"]),
}


def is_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _odbc_drivers():
    try:
        import pyodbc  # type: ignore
        return list(pyodbc.drivers())
    except Exception:  # noqa: BLE001
        return []


@setup_bp.route("/setup")
def setup_page():
    return send_file(SETUP_HTML)


@setup_bp.route("/api/setup/status")
def setup_status():
    return jsonify({
        "ok": True,
        "configured": is_configured(),
        "model": os.environ.get("AIMS_MODEL", ""),
        "capabilities": capability_report(),
        "odbcDrivers": _odbc_drivers(),
        "groups": {k: {"label": v[0], "caps": v[2]} for k, v in GROUPS.items()},
    })


@setup_bp.route("/api/setup/api-key", methods=["POST"])
def setup_api_key():
    """Configure credentials in one of two modes:
       - public : {apiKey, model}                      -> Anthropic public API (sk-ant key)
       - gateway: {baseUrl, authToken, caBundle?, model} -> a custom/corporate gateway
    Validated with a tiny live call, then persisted to singleuser/.env + set live."""
    body = request.get_json(silent=True) or {}
    model = (body.get("model") or os.environ.get("AIMS_MODEL") or "claude-sonnet-5").strip()
    base_url = (body.get("baseUrl") or "").strip()
    ca = (body.get("caBundle") or "").strip()

    try:
        import anthropic  # type: ignore
        if base_url:
            token = (body.get("authToken") or "").strip()
            if not token:
                return jsonify({"ok": False, "error": "Enter the gateway auth token."}), 400
            if not ca:
                # Auto-detect the app's CA bundle (server/win-ca-bundle.pem or an SSL_CERT_FILE
                # env), so a gateway behind a TLS-intercepting proxy works without typing a path.
                try:
                    from app.core.config import ca_bundle as _detect_ca
                    ca = _detect_ca() or ""
                except Exception:  # noqa: BLE001
                    ca = ""
            if ca and not os.path.isfile(ca):
                return jsonify({"ok": False, "error": "CA bundle file not found: " + ca}), 400
            kwargs = {"auth_token": token, "base_url": base_url}
            if ca:
                import httpx  # type: ignore
                kwargs["http_client"] = httpx.Client(verify=ca, timeout=60.0)
            client = anthropic.Anthropic(**kwargs)
            client.messages.create(model=model, max_tokens=1, messages=[{"role": "user", "content": "hi"}])
            updates = {"ANTHROPIC_AUTH_TOKEN": token, "ANTHROPIC_BASE_URL": base_url, "AIMS_MODEL": model}
            if ca:
                updates["SSL_CERT_FILE"] = ca   # ai_client.ca_bundle() picks this up
            _envfile.upsert(updates)
            os.environ.update({k: v for k, v in updates.items()})
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            key = (body.get("apiKey") or "").strip()
            if not key:
                return jsonify({"ok": False, "error": "Enter your Claude API key."}), 400
            client = anthropic.Anthropic(api_key=key)
            client.messages.create(model=model, max_tokens=1, messages=[{"role": "user", "content": "hi"}])
            _envfile.upsert({"ANTHROPIC_API_KEY": key, "AIMS_MODEL": model})
            os.environ["ANTHROPIC_API_KEY"] = key
            os.environ["AIMS_MODEL"] = model
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
            os.environ.pop("ANTHROPIC_BASE_URL", None)
    except Exception as exc:  # noqa: BLE001
        detail = (str(exc) or exc.__class__.__name__)[:300]
        low = detail.lower()
        hint = ""
        if "connection" in low or "ssl" in low or "certificate" in low or "timed out" in low:
            if base_url:
                hint = (" — can't reach the gateway. If it's behind a TLS-intercepting proxy, set the "
                        "CA bundle file (e.g. win-ca-bundle.pem); also check the base URL and that you're "
                        "on the right network.")
            else:
                hint = (" — can't reach api.anthropic.com. On a restricted network the public API may be "
                        "blocked; use the Corporate gateway option instead, or set HTTPS_PROXY.")
        return jsonify({"ok": False, "error": "Rejected: " + detail + hint}), 400
    return jsonify({"ok": True})


@setup_bp.route("/api/setup/install", methods=["POST"])
def setup_install():
    body = request.get_json(silent=True) or {}
    group = (body.get("group") or "").strip()
    if group not in GROUPS:
        return jsonify({"ok": False, "error": "Unknown dependency group."}), 400
    pkgs = GROUPS[group][1]
    try:
        proc = subprocess.run([sys.executable, "-m", "pip", "install", *pkgs],
                              capture_output=True, text=True, timeout=900)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)[:300]}), 500
    ok = proc.returncode == 0
    log = ((proc.stdout or "")[-1000:] + ("\n" + (proc.stderr or "")[-1000:] if proc.stderr else "")).strip()
    return jsonify({"ok": ok, "log": log, "restartRequired": ok})


@setup_bp.route("/api/setup/restart", methods=["POST"])
def setup_restart():
    """Re-exec the launcher so newly-installed packages are importable."""
    import threading
    import time

    def _reexec():
        time.sleep(0.6)
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_reexec, daemon=True).start()
    return jsonify({"ok": True})
