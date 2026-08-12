"""/api/deploy/* routes — deploy generated SQL to SQL Server in the background.

Thin: parse request -> start/poll the deployment_service. Credentials arrive in
the request body (same per-request pattern as /api/db/*) and are passed straight
to the service; they are never logged or echoed back.
"""
from flask import Blueprint, request, jsonify

from app.services import deployment_service

bp = Blueprint("deploy_api", __name__, url_prefix="/api/deploy")


@bp.route("", methods=["POST"])
def start_deploy():
    body = request.get_json(force=True) or {}
    cfg = body.get("connection") or {}
    sql = body.get("sql") or ""
    dry_run = bool(body.get("dryRun"))

    if not sql.strip():
        return jsonify(ok=False, error="No SQL to deploy."), 400
    if not (cfg.get("server") or cfg.get("host")) or not (cfg.get("database") or cfg.get("db")):
        return jsonify(ok=False, error="A SQL Server connection (server + database) is required."), 400

    started = deployment_service.start_deploy(cfg, sql, dry_run)
    return jsonify(ok=True, **started), 202   # 202 Accepted — running in background


@bp.route("/status/<job_id>")
def deploy_status(job_id):
    job = deployment_service.get_status(job_id)
    if not job:
        return jsonify(ok=False, error="Unknown job id."), 404
    return jsonify(ok=True, job=job)
