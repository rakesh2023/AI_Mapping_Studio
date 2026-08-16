"""/api/kyd/* — Know Your Data (insurance) documents.

Scoped ENTIRELY by the session (user_id = session['uid'], client_id =
session['cid']); the client never supplies a user/client id, so documents can't
be addressed across tenants. Requires a logged-in user AND an active client
(mirrors /api/state). Thin: parse request -> call service -> jsonify(payload),
status. Mutating methods (POST/DELETE) are CSRF-protected by the global guard.
"""
from flask import Blueprint, request, jsonify, session

from app.services import kyd_document_service as docs
from app.services import kyd_chat_service as chat

bp = Blueprint("kyd_api", __name__, url_prefix="/api/kyd")


def _scope():
    """(user_id, client_id) from the session, or (None, error_response)."""
    uid = session.get("uid")
    cid = session.get("cid")
    if not uid:
        return None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    if not cid:
        return None, (jsonify({"ok": False, "error": "No active client selected."}), 409)
    return (uid, cid), None


@bp.route("/documents", methods=["POST"])
def upload_document():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    up = request.files.get("file")
    if up is None:
        return jsonify({"ok": False, "error": "No file uploaded. Attach a file in the 'file' field."}), 400
    raw = up.read()
    payload, status = docs.create_and_enqueue(uid, cid, up.filename or "", raw, up.mimetype)
    return jsonify(payload), status


@bp.route("/documents", methods=["GET"])
def list_documents():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = docs.list_documents(uid, cid)
    return jsonify(payload), status


@bp.route("/documents/<int:document_id>/status", methods=["GET"])
def document_status(document_id):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = docs.get_status(uid, cid, document_id)
    return jsonify(payload), status


@bp.route("/documents/<int:document_id>/force-ingest", methods=["POST"])
def force_ingest(document_id):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = docs.force_ingest(uid, cid, document_id)
    return jsonify(payload), status


@bp.route("/documents/<int:document_id>", methods=["DELETE"])
def delete_document(document_id):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = docs.delete_document(uid, cid, document_id)
    return jsonify(payload), status


# ---- Chat: sessions + messages ---- #
@bp.route("/chat/sessions", methods=["POST"])
def create_session():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    body = request.get_json(silent=True) or {}
    scope_ids = body.get("documentScope") if isinstance(body.get("documentScope"), list) else None
    payload, status = chat.create_session(uid, cid, (body.get("title") or None), scope_ids)
    return jsonify(payload), status


@bp.route("/chat/sessions", methods=["GET"])
def list_sessions():
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = chat.list_sessions(uid, cid)
    return jsonify(payload), status


@bp.route("/chat/sessions/<int:session_id>/messages", methods=["GET"])
def get_messages(session_id):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload, status = chat.get_messages(uid, cid, session_id)
    return jsonify(payload), status


@bp.route("/chat/sessions/<int:session_id>/messages", methods=["POST"])
def send_message(session_id):
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    body = request.get_json(silent=True) or {}
    payload, status = chat.send_message(
        uid, cid, session_id,
        body.get("message") or body.get("question") or "",
        mode=body.get("mode") or "rag")
    return jsonify(payload), status
