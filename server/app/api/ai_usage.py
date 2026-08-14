"""/api/ai-usage/* routes — read/clear the local AI usage log for the report page.

Thin: parse query params -> call ai_usage_logger -> jsonify. Every endpoint is
scoped to the session's tenant; the rows themselves are written by
ai_client_service.call_ai on every model call.
"""
from flask import Blueprint, request, jsonify, session

from app.services import ai_usage_logger

bp = Blueprint("ai_usage_api", __name__, url_prefix="/api/ai-usage")


def _scope():
    """(user_id, client_id) from the session, or (None, error_response).

    SEC-001 / SEC-002: the tenant is derived server-side from the signed session —
    the client never supplies a user/client id — so neither a read nor a
    destructive action can be addressed across tenants. Mirrors state_routes._scope.
    """
    uid = session.get("uid")
    cid = session.get("cid")
    if not uid:
        return None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    if not cid:
        return None, (jsonify({"ok": False, "error": "No active client selected."}), 409)
    return (uid, cid), None


@bp.route("/logs")
def logs():
    """This tenant's paginated log rows, newest first. Filters: start_date, end_date, feature, limit, offset."""
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload = ai_usage_logger.query_logs(
        uid, cid,
        start_date=request.args.get("start_date") or None,
        end_date=request.args.get("end_date") or None,
        feature=request.args.get("feature") or None,
        limit=request.args.get("limit", 100, type=int),
        offset=request.args.get("offset", 0, type=int),
    )
    return jsonify(payload), (200 if payload.get("ok") else 500)


@bp.route("/logs", methods=["DELETE"])
def clear_logs():
    """Permanently delete THIS tenant's usage log rows (irreversible).

    SEC-001: scoped to the caller's own (user_id, client_id) from the session, so
    one account can never wipe another tenant's log.
    """
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload = ai_usage_logger.clear_logs(uid, cid)
    return jsonify(payload), (200 if payload.get("ok") else 500)


@bp.route("/summary")
def summary():
    """This tenant's overall totals + per-feature breakdown. Filters: start_date, end_date."""
    scope, err = _scope()
    if err:
        return err
    uid, cid = scope
    payload = ai_usage_logger.summary(
        uid, cid,
        start_date=request.args.get("start_date") or None,
        end_date=request.args.get("end_date") or None,
    )
    return jsonify(payload), (200 if payload.get("ok") else 500)
