"""AI Mapping Studio backend package.

Layered architecture:
    core/       env & path config, optional-import capability guards
    db/         multi-tenant app store (users, clients, tenant_documents)
    schemas/    JSON schemas for Claude structured output
    parsers/    pure text/file parsing & chunking (no Flask, no Anthropic)
    services/   business logic (auth, clients, db, ai client, mapping, extraction)
    api/        thin Flask blueprints (parse request -> call service -> jsonify)

create_app() builds the Flask app, wires session auth + the multi-tenant guard,
and registers all blueprints. A module-level `app` instance is exposed so
main.py / WSGI can import it.
"""
import secrets
from datetime import timedelta

from flask import Flask, request, session, redirect, jsonify


def create_app() -> Flask:
    """Application factory: build the Flask app, wire auth, register blueprints."""
    application = Flask(__name__, static_folder=None)

    # --- Session signing key (required for auth) --- #
    from app.core.config import secret_key, session_hours
    sk = secret_key()
    if not sk:
        sk = secrets.token_hex(32)
        print("[auth] WARNING: AIMS_SECRET_KEY is not set — using a random per-process key. "
              "Sessions will NOT survive a restart. Set AIMS_SECRET_KEY for deployment.")
    application.secret_key = sk
    application.permanent_session_lifetime = timedelta(hours=session_hours())
    application.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

    from app.api.static_routes import bp as static_bp
    from app.api.auth_routes import bp as auth_bp
    from app.api.client_routes import bp as client_bp
    from app.api.state_routes import bp as state_bp
    from app.api.db_routes import bp as db_bp
    from app.api.ai_routes import bp as ai_bp
    from app.api.deploy_routes import bp as deploy_bp
    from app.api.ai_usage import bp as ai_usage_bp

    application.register_blueprint(static_bp)
    application.register_blueprint(auth_bp)
    application.register_blueprint(client_bp)
    application.register_blueprint(state_bp)
    application.register_blueprint(db_bp)
    application.register_blueprint(ai_bp)
    application.register_blueprint(deploy_bp)
    application.register_blueprint(ai_usage_bp)

    _register_auth_guard(application)

    # Create local SQLite tables if missing (idempotent, non-fatal).
    from app.services.ai_usage_logger import ensure_usage_table
    from app.db.app_db import ensure_app_tables
    ensure_usage_table()
    ensure_app_tables()
    return application


def _register_auth_guard(application: Flask) -> None:
    """Gate every page and API behind a logged-in session (closes the open catch-all).

    Public: the splash, the login/onboarding pages, the auth API, and the static
    assets those pages need. Unauthenticated HTML -> redirect to /login;
    unauthenticated /api/* -> 401 JSON. Logged in but no active client -> the app
    pages redirect to /onboarding until a client is chosen.
    """
    PUBLIC_PATHS = {"/", "/index.html", "/login", "/onboarding", "/favicon.ico"}
    PUBLIC_PREFIXES = ("/css/", "/js/", "/assets/")

    @application.before_request
    def _auth_guard():
        if application.config.get("AUTH_DISABLED"):
            return None   # pure routing/unit tests opt out of the session gate
        p = request.path or "/"
        if p in PUBLIC_PATHS or p.startswith(PUBLIC_PREFIXES) or p.startswith("/api/auth/"):
            return None
        if not session.get("uid"):
            if p.startswith("/api/"):
                return jsonify({"ok": False, "error": "Not authenticated."}), 401
            return redirect("/login")
        # Logged in but hasn't picked/created a client yet -> force onboarding for app pages.
        if not session.get("cid") and p.startswith("/pages/"):
            return redirect("/onboarding")
        return None


app = create_app()
