"""/api/ai-usage/* routes — read the local AI usage log for the report page.

Thin: parse query params -> call ai_usage_logger -> jsonify. Read-only; the
rows themselves are written by ai_client_service.call_ai on every model call.
"""
from flask import Blueprint, request, jsonify

from app.services import ai_usage_logger

bp = Blueprint("ai_usage_api", __name__, url_prefix="/api/ai-usage")


@bp.route("/logs")
def logs():
    """Paginated log rows, newest first. Filters: start_date, end_date, feature, limit, offset."""
    payload = ai_usage_logger.query_logs(
        start_date=request.args.get("start_date") or None,
        end_date=request.args.get("end_date") or None,
        feature=request.args.get("feature") or None,
        limit=request.args.get("limit", 100, type=int),
        offset=request.args.get("offset", 0, type=int),
    )
    return jsonify(payload), (200 if payload.get("ok") else 500)


@bp.route("/logs", methods=["DELETE"])
def clear_logs():
    """Permanently delete ALL usage log rows (irreversible)."""
    payload = ai_usage_logger.clear_logs()
    return jsonify(payload), (200 if payload.get("ok") else 500)


@bp.route("/summary")
def summary():
    """Overall totals + per-feature breakdown. Filters: start_date, end_date."""
    payload = ai_usage_logger.summary(
        start_date=request.args.get("start_date") or None,
        end_date=request.args.get("end_date") or None,
    )
    return jsonify(payload), (200 if payload.get("ok") else 500)
