"""/api/auth/* — signup, login, logout, me, select-client.

Thin: parse JSON -> call auth_service/client_service -> set the Flask session ->
jsonify. The session (signed cookie) is the ONLY source of the logged-in user id;
no endpoint trusts a client-supplied user_id.
"""
from flask import Blueprint, request, jsonify, session, current_app

from app.services import auth_service, client_service

bp = Blueprint("auth_api", __name__, url_prefix="/api/auth")


def _set_login(user):
    """Record the authenticated user in the session (permanent -> honors lifetime)."""
    session.permanent = True
    session["uid"] = user["id"]
    session["name"] = user.get("name") or ""
    session["role"] = user.get("role") or ""
    session.pop("cid", None)


def _me_payload():
    """Current user + their clients + the active client id (or None)."""
    uid = session.get("uid")
    user = auth_service.get_user(uid) if uid else None
    if not user:
        return None
    clients = client_service.list_clients(uid)
    cid = session.get("cid")
    # Drop a stale active-client id that no longer belongs to the user.
    if cid and not any(c["id"] == cid for c in clients):
        cid = None
        session.pop("cid", None)
    return {"ok": True, "user": user, "clients": clients, "activeClientId": cid}


@bp.route("/signup", methods=["POST"])
def signup():
    # The tool is closed: users are created by an admin, not by self-registration.
    if not current_app.config.get("SIGNUP_ENABLED"):
        return jsonify({"ok": False,
                        "error": "Self-registration is disabled. Contact your administrator."}), 403
    body = request.get_json(silent=True) or {}
    payload, status = auth_service.signup(
        body.get("email", ""), body.get("password", ""), body.get("name", ""))
    if status == 201 and payload.get("ok"):
        _set_login(payload["user"])
        payload["needsOnboarding"] = True
    return jsonify(payload), status


@bp.route("/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    email = body.get("email", "")
    locked = auth_service.login_locked_seconds(email)
    if locked:
        mins = max(1, locked // 60)
        return jsonify({"ok": False, "error": "Too many failed attempts. Try again in about %d minute(s)." % mins}), 429
    user = auth_service.authenticate(email, body.get("password", ""))
    auth_service.record_login_result(email, bool(user))
    if not user:
        return jsonify({"ok": False, "error": "Invalid email or password."}), 401
    _set_login(user)
    clients = client_service.list_clients(user["id"])
    active = clients[0]["id"] if clients else None   # most-recent (list is DESC)
    if active:
        session["cid"] = active
    return jsonify({"ok": True, "user": user, "clients": clients,
                    "activeClientId": active, "needsOnboarding": not clients}), 200


@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True}), 200


@bp.route("/me")
def me():
    payload = _me_payload()
    if not payload:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    return jsonify(payload), 200


@bp.route("/select-client", methods=["POST"])
def select_client():
    uid = session.get("uid")
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated."}), 401
    body = request.get_json(silent=True) or {}
    cid = body.get("clientId") or body.get("client_id")
    try:
        cid = int(cid)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "A valid clientId is required."}), 400
    if not client_service.owns_client(uid, cid):
        return jsonify({"ok": False, "error": "Client not found."}), 403
    session["cid"] = cid
    return jsonify({"ok": True, "activeClientId": cid}), 200
