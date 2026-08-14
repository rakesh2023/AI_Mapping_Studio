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
    from app.core.config import secret_key, session_hours, csrf_enabled, signup_enabled
    sk = secret_key()
    if not sk:
        sk = secrets.token_hex(32)
        print("[auth] WARNING: AIMS_SECRET_KEY is not set — using a random per-process key. "
              "Sessions will NOT survive a restart. Set AIMS_SECRET_KEY for deployment.")
    application.secret_key = sk
    application.permanent_session_lifetime = timedelta(hours=session_hours())
    application.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")
    application.config["CSRF_ENABLED"] = csrf_enabled()
    application.config["SIGNUP_ENABLED"] = signup_enabled()

    from app.api.static_routes import bp as static_bp
    from app.api.auth_routes import bp as auth_bp
    from app.api.client_routes import bp as client_bp
    from app.api.state_routes import bp as state_bp
    from app.api.db_routes import bp as db_bp
    from app.api.ai_routes import bp as ai_bp
    from app.api.deploy_routes import bp as deploy_bp
    from app.api.ai_usage import bp as ai_usage_bp
    from app.api.admin_routes import bp as admin_bp

    application.register_blueprint(static_bp)
    application.register_blueprint(auth_bp)
    application.register_blueprint(client_bp)
    application.register_blueprint(state_bp)
    application.register_blueprint(db_bp)
    application.register_blueprint(ai_bp)
    application.register_blueprint(deploy_bp)
    application.register_blueprint(ai_usage_bp)
    application.register_blueprint(admin_bp)

    _register_auth_guard(application)
    _register_csrf(application)

    # Create local SQLite tables if missing (idempotent, non-fatal), then ensure the
    # env-configured admin account exists (self-signup is disabled).
    from app.services.ai_usage_logger import ensure_usage_table
    from app.db.app_db import ensure_app_tables
    from app.services.auth_service import ensure_admin
    ensure_usage_table()
    ensure_app_tables()
    ensure_admin()
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
        # Admins never onboard (they don't own clients) — bounce them to their console.
        if p == "/onboarding" and session.get("uid"):
            from app.services.admin_service import is_admin
            if is_admin(session.get("uid")):
                return redirect("/pages/admin.html")
        if p in PUBLIC_PATHS or p.startswith(PUBLIC_PREFIXES) or p.startswith("/api/auth/"):
            return None
        if not session.get("uid"):
            if p.startswith("/api/"):
                return jsonify({"ok": False, "error": "Not authenticated."}), 401
            return redirect("/login")
        # App pages: admins manage users only. Confine them to the Admin page (which
        # needs no active client / no onboarding); send non-admins away from it. The
        # /api/admin/* endpoints are guarded inside their blueprint (403).
        if p.startswith("/pages/"):
            from app.services.admin_service import is_admin
            if is_admin(session.get("uid")):
                return None if p == "/pages/admin.html" else redirect("/pages/admin.html")
            if p == "/pages/admin.html":
                return redirect("/pages/dashboard.html")
            # Non-admin with no active client yet -> onboarding.
            if not session.get("cid"):
                return redirect("/onboarding")
        return None


def _register_csrf(application: Flask) -> None:
    """SEC-005: double-submit CSRF token for state-changing /api/* requests.

    A readable (non-HttpOnly) `csrf_token` cookie is issued on any response that
    lacks one; the browser echoes it back in the X-CSRF-Token header on mutating
    requests (POST/PUT/PATCH/DELETE), and we require header == cookie. This is
    defense-in-depth on top of SameSite=Lax for this same-origin app.

    Exempt: the auth bootstrap endpoints under /api/auth/ (login/signup/logout/
    select-client/me) — they run before the app shell's fetch wrapper is in play,
    and their CSRF impact is negligible (session establishment / switching among
    one's own clients). Disabled under AUTH_DISABLED or when CSRF_ENABLED is false
    (pure routing/unit tests that drive the API without a browser-issued token).
    """
    MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

    @application.before_request
    def _csrf_guard():
        if application.config.get("AUTH_DISABLED") or not application.config.get("CSRF_ENABLED"):
            return None
        if request.method not in MUTATING:
            return None
        p = request.path or "/"
        if not p.startswith("/api/") or p.startswith("/api/auth/"):
            return None
        cookie = request.cookies.get("csrf_token")
        header = request.headers.get("X-CSRF-Token")
        if not cookie or not header or not secrets.compare_digest(str(cookie), str(header)):
            return jsonify({"ok": False, "error": "CSRF token missing or invalid."}), 403
        return None

    @application.after_request
    def _issue_csrf_cookie(response):
        if not application.config.get("CSRF_ENABLED"):
            return response
        if not request.cookies.get("csrf_token"):
            # Non-HttpOnly so the app shell can echo it back in the header.
            # (Secure is left off to work over http in dev, matching the session cookie.)
            response.set_cookie("csrf_token", secrets.token_urlsafe(32),
                                samesite="Lax", httponly=False, secure=False, path="/")
        return response


app = create_app()
