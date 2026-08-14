"""/api/deploy/* routes — deploy generated SQL to SQL Server in the background.

Thin: parse request -> start/poll the deployment_service. Credentials arrive in
the request body (same per-request pattern as /api/db/*) and are passed straight
to the service; they are never logged or echoed back.
"""
from flask import Blueprint, request, jsonify, session

from app.services import deployment_service
from app.services.connection_guard import check_rate

bp = Blueprint("deploy_api", __name__, url_prefix="/api/deploy")


def _scope():
    """(user_id, client_id) from the session, or (None, error_response).

    SEC-003: deploy jobs are bound to the creating tenant. The owner is derived
    server-side from the signed session — never client-supplied — so one tenant
    can't read another's job status. Mirrors state_routes._scope.
    """
    uid = session.get("uid")
    cid = session.get("cid")
    if not uid:
        return None, (jsonify(ok=False, error="Not authenticated."), 401)
    if not cid:
        return None, (jsonify(ok=False, error="No active client selected."), 409)
    return (uid, cid), None


@bp.route("", methods=["POST"])
def start_deploy():
    scope, err = _scope()
    if err:
        return err
    # SEC-004: a deploy opens a connection to a caller-supplied target — count it
    # against the same per-user connection-attempt budget as /api/db/*.
    allowed, retry = check_rate(scope[0])
    if not allowed:
        resp = jsonify(ok=False, error="Too many connection attempts. Please wait a moment and try again.")
        resp.headers["Retry-After"] = str(retry)
        return resp, 429
    body = request.get_json(force=True) or {}
    cfg = body.get("connection") or {}
    sql = body.get("sql") or ""
    dry_run = bool(body.get("dryRun"))

    if not sql.strip():
        return jsonify(ok=False, error="No SQL to deploy."), 400
    if not (cfg.get("server") or cfg.get("host")) or not (cfg.get("database") or cfg.get("db")):
        return jsonify(ok=False, error="A SQL Server connection (server + database) is required."), 400

    started = deployment_service.start_deploy(cfg, sql, dry_run, owner=scope)
    return jsonify(ok=True, **started), 202   # 202 Accepted — running in background


@bp.route("/status/<job_id>")
def deploy_status(job_id):
    scope, err = _scope()
    if err:
        return err
    job = deployment_service.get_status(job_id, owner=scope)
    if not job:
        return jsonify(ok=False, error="Unknown job id."), 404
    return jsonify(ok=True, job=job)
