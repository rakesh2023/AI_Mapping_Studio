"""/api/admin/* — admin-only user management (list / create / delete).

Every handler requires a logged-in admin (is_admin=1, derived from the session
uid — never client-supplied). Mutating routes are CSRF-protected by the global
guard (this is /api/, not /api/auth/). Creating a user makes a STANDARD account;
deleting one permanently removes all their data.
"""
from flask import Blueprint, request, jsonify, session

from app.services import admin_service, feedback_service

bp = Blueprint("admin_api", __name__, url_prefix="/api/admin")


def _require_admin():
    """(uid, None) for an admin caller, else (None, error_response)."""
    uid = session.get("uid")
    if not uid:
        return None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    if not admin_service.is_admin(uid):
        return None, (jsonify({"ok": False, "error": "Admin access required."}), 403)
    return uid, None


@bp.route("/users", methods=["GET"])
def list_users():
    uid, err = _require_admin()
    if err:
        return err
    return jsonify({"ok": True, "users": admin_service.list_users()}), 200


@bp.route("/users", methods=["POST"])
def create_user():
    uid, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    payload, status = admin_service.create_user(
        body.get("email", ""), body.get("password", ""), body.get("name", ""))
    return jsonify(payload), status


@bp.route("/users/<int:target_id>", methods=["DELETE"])
def delete_user(target_id):
    uid, err = _require_admin()
    if err:
        return err
    if target_id == uid:
        return jsonify({"ok": False, "error": "You cannot delete your own account."}), 400
    if admin_service.is_admin(target_id):
        return jsonify({"ok": False, "error": "Admin accounts cannot be deleted here."}), 400
    payload, status = admin_service.delete_user(target_id)
    return jsonify(payload), status


@bp.route("/feedback", methods=["GET"])
def list_feedback():
    uid, err = _require_admin()
    if err:
        return err
    return jsonify({"ok": True, "feedback": feedback_service.list_feedback()}), 200


@bp.route("/feedback/<int:fid>/status", methods=["POST"])
def set_feedback_status(fid):
    uid, err = _require_admin()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    payload, status = feedback_service.set_status(fid, body.get("status", ""))
    return jsonify(payload), status
