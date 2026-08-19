"""/api/feedback — submit a suggestion / bug / other (any logged-in user).

Thin: derive the submitter from the SESSION uid (never client-supplied), capture
the browser User-Agent, and delegate to feedback_service. Mutating, but under
/api/ (not /api/auth/), so the global CSRF guard applies — the in-shell modal
sends the token automatically via the common.js fetch wrapper. Admins review and
progress feedback via /api/admin/feedback (see admin_routes).
"""
from flask import Blueprint, request, jsonify, session

from app.services import feedback_service

bp = Blueprint("feedback_api", __name__, url_prefix="/api/feedback")


@bp.route("", methods=["POST"])
def submit_feedback():
    uid = session.get("uid")
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    body = request.get_json(silent=True) or {}
    payload, status = feedback_service.create_feedback(
        uid,
        body.get("type", "other"),
        body.get("message", ""),
        body.get("page", ""),
        request.headers.get("User-Agent", ""),
    )
    return jsonify(payload), status
