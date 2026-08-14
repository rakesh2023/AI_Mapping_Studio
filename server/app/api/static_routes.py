"""Static site serving (index.html + pages/, css/, js/, data/, assets/).

Serves the frontend from the repo root so the whole app runs on one origin
(no CORS). Thin — no business logic.
"""
import os

from flask import Blueprint, send_from_directory

from app.core.config import ROOT

bp = Blueprint("static_site", __name__)


@bp.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@bp.route("/login")
def login_page():
    """Clean URL for the login/signup gate (pages/login.html)."""
    return send_from_directory(os.path.join(ROOT, "pages"), "login.html")


@bp.route("/onboarding")
def onboarding_page():
    """Clean URL for first-run client onboarding (pages/onboarding.html)."""
    return send_from_directory(os.path.join(ROOT, "pages"), "onboarding.html")


@bp.route("/<path:path>")
def static_proxy(path):
    full = os.path.join(ROOT, path)
    if os.path.isfile(full):
        directory = os.path.dirname(full)
        return send_from_directory(directory, os.path.basename(full))
    return ("Not found", 404)
