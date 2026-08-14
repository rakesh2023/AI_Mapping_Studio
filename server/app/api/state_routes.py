"""/api/state/* — per-client working data (mappings, connections, history, ...).

Scoped ENTIRELY by the session: user_id = session['uid'], client_id = session['cid'].
The client never supplies a user or client id here, so the store can't be addressed
across tenants. Requires both a logged-in user and an active client.
"""
from flask import Blueprint, request, jsonify, session

from app.services import tenant_store_service as store

bp = Blueprint("state_api", __name__, url_prefix="/api/state")


def _scope():
    """(user_id, client_id) from the session, or (None, error_response)."""
    uid = session.get("uid")
    cid = session.get("cid")
    if not uid:
        return None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    if not cid:
        return None, (jsonify({"ok": False, "error": "No active client selected."}), 409)
    return (uid, cid), None


@bp.route("", methods=["GET"])
def get_bundle():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    return jsonify({"ok": True, "state": store.get_bundle(uid, cid)}), 200


@bp.route("", methods=["DELETE"])
def delete_all():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = store.delete_all(uid, cid)
    return jsonify(payload), status


@bp.route("/<doc_key>", methods=["GET"])
def get_doc(doc_key):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = store.get_doc(uid, cid, doc_key)
    return jsonify(payload), status


@bp.route("/<doc_key>", methods=["PUT"])
def put_doc(doc_key):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or "value" not in body:
        return jsonify({"ok": False, "error": "Body must be {\"value\": ...}."}), 400
    payload, status = store.set_doc(uid, cid, doc_key, body["value"])
    return jsonify(payload), status
