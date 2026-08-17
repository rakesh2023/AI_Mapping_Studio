"""/api/clients/* — list / create / update the logged-in user's clients.

Every handler derives the owner from the SESSION uid (never the request body),
so a user can only ever see or change their own clients. Creating a client also
makes it the session's active client.
"""
from flask import Blueprint, request, jsonify, session

from app.services import client_service
from app.services.admin_service import is_admin

bp = Blueprint("client_api", __name__, url_prefix="/api/clients")


def _uid():
    return session.get("uid")


@bp.route("", methods=["GET"])
def list_clients():
    uid = _uid()
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    return jsonify({"ok": True, "clients": client_service.list_clients(uid),
                    "activeClientId": session.get("cid")}), 200


@bp.route("", methods=["POST"])
def create_client():
    uid = _uid()
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    # Admins manage users only — they do not own clients or mapping data.
    if is_admin(uid):
        return jsonify({"ok": False, "error": "Administrators cannot create clients."}), 403
    body = request.get_json(silent=True) or {}
    payload, status = client_service.create_client(
        uid, body.get("name", ""), body.get("industry", ""), body.get("config") or {})
    if status == 201 and payload.get("ok"):
        session["cid"] = payload["client"]["id"]      # new client becomes active
        payload["activeClientId"] = payload["client"]["id"]
    return jsonify(payload), status


@bp.route("/<int:client_id>", methods=["PUT"])
def update_client(client_id):
    uid = _uid()
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    body = request.get_json(silent=True) or {}
    payload, status = client_service.update_client(
        uid, client_id, body.get("name", ""), body.get("industry", ""), body.get("config") or {})
    return jsonify(payload), status


@bp.route("/<int:client_id>", methods=["DELETE"])
def delete_client(client_id):
    uid = _uid()
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    payload, status = client_service.delete_client(uid, client_id)
    if status == 200 and payload.get("ok"):
        # If the active client was the one deleted, fall back to the most-recent
        # remaining client (or clear it -> the app sends the user to onboarding).
        remaining = client_service.list_clients(uid)
        if session.get("cid") == client_id:
            if remaining:
                session["cid"] = remaining[0]["id"]
            else:
                session.pop("cid", None)
        payload["clients"] = remaining
        payload["activeClientId"] = session.get("cid")
    return jsonify(payload), status
