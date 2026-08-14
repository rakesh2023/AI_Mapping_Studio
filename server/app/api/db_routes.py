"""/api/db/* routes — live SQL Server metadata & profiling.

Thin: parse the request body, call db_service, jsonify the (payload, status)
result. No business logic here.
"""
from flask import Blueprint, request, jsonify, session

from app.services import db_service
from app.services.connection_guard import check_rate

bp = Blueprint("db_api", __name__, url_prefix="/api/db")


def _throttle():
    """SEC-004: rate-limit connection attempts per logged-in user (blunts internal
    port-scanning). Returns a 429 response tuple when exceeded, else None."""
    allowed, retry = check_rate(session.get("uid"))
    if allowed:
        return None
    resp = jsonify(ok=False, error="Too many connection attempts. Please wait a moment and try again.")
    resp.headers["Retry-After"] = str(retry)
    return resp, 429


@bp.route("/drivers")
def list_drivers():
    return jsonify(db_service.list_drivers())   # local enumeration — not a connection attempt


@bp.route("/test", methods=["POST"])
def test_connection():
    blocked = _throttle()
    if blocked:
        return blocked
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.test_connection(cfg)
    return jsonify(payload), status


@bp.route("/metadata", methods=["POST"])
def get_metadata():
    blocked = _throttle()
    if blocked:
        return blocked
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.get_metadata(cfg)
    return jsonify(payload), status


@bp.route("/profile", methods=["POST"])
def profile_table():
    blocked = _throttle()
    if blocked:
        return blocked
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.profile_table(cfg)
    return jsonify(payload), status
