"""/api/ai/* routes — status, mapping generation/regeneration, file extraction.

Thin: parse the request, call the service, jsonify the (payload, status) result.
The extract-source-stream endpoint wraps the service's NDJSON generator in a
streaming Response (application/x-ndjson), exactly as before.
"""
from flask import Blueprint, request, jsonify, Response, session

from app.services import (ai_client, mapping_service, extraction_service, etl_service,
                          schema_service, target_meta_service, validation_ai_service,
                          cc_sql_service)

bp = Blueprint("ai_api", __name__, url_prefix="/api/ai")


def _scope():
    """(uid, cid, None) from the signed session, else (None, None, error_response)."""
    uid = session.get("uid")
    if not uid:
        return None, None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    cid = session.get("cid")
    if not cid:
        return None, None, (jsonify({"ok": False, "error": "No active client selected."}), 400)
    return uid, cid, None


@bp.route("/status")
def ai_status():
    return jsonify(ai_client.ai_status())


@bp.route("/mapping-prompt")
def mapping_prompt():
    """Return the default system prompt used by generate-mappings, so the UI can
    show it, let the user edit it, and reset to this canonical default."""
    strategy = request.args.get("strategy", "Balanced")
    return jsonify({"ok": True, "strategy": strategy,
                    "prompt": mapping_service.default_mapping_system_prompt(strategy)})


@bp.route("/generate-mappings", methods=["POST"])
def generate_mappings():
    body = request.get_json(force=True) or {}
    payload, status = mapping_service.generate_mappings(body)
    return jsonify(payload), status


@bp.route("/regenerate-mapping", methods=["POST"])
def regenerate_mapping():
    body = request.get_json(force=True) or {}
    payload, status = mapping_service.regenerate_mapping(body)
    return jsonify(payload), status


@bp.route("/infer-target-metadata", methods=["POST"])
def infer_target_metadata():
    body = request.get_json(force=True) or {}
    payload, status = target_meta_service.infer_target_metadata(body)
    return jsonify(payload), status


@bp.route("/match-tables", methods=["POST"])
def match_tables():
    body = request.get_json(force=True) or {}
    payload, status = target_meta_service.match_tables(body)
    return jsonify(payload), status


@bp.route("/generate-etl", methods=["POST"])
def generate_etl():
    body = request.get_json(force=True) or {}
    payload, status = etl_service.generate_etl(body)
    return jsonify(payload), status


@bp.route("/validation-suggest", methods=["POST"])
def validation_suggest():
    body = request.get_json(force=True) or {}
    payload, status = validation_ai_service.suggest_checks(body)
    return jsonify(payload), status


@bp.route("/validation-sql", methods=["POST"])
def validation_sql():
    body = request.get_json(force=True) or {}
    payload, status = validation_ai_service.generate_validation_sql(body)
    return jsonify(payload), status


@bp.route("/custom-rule", methods=["POST"])
def custom_rule():
    body = request.get_json(force=True) or {}
    payload, status = validation_ai_service.author_custom_rule(body)
    return jsonify(payload), status


@bp.route("/reconcile-context")
def reconcile_context():
    """Data Reconciliation banner: does this client have the chosen schema source, and its counts.
    ?source=claimcenter|cmt|pmt."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = cc_sql_service.context_status(uid, cid, request.args.get("source", "claimcenter"))
    return jsonify(payload), status


@bp.route("/reconcile-sources")
def reconcile_sources():
    """Which schema sources this client has (ClaimCenter dictionary + its one product schema),
    for the Data Reconciliation source picker."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = cc_sql_service.list_sources(uid, cid)
    return jsonify(payload), status


@bp.route("/reconcile-tables")
def reconcile_tables():
    """Searchable table list for the Data Reconciliation picker (from the chosen source)."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = cc_sql_service.list_tables(uid, cid, request.args.get("source", "claimcenter"),
                                                 request.args.get("q", ""))
    return jsonify(payload), status


@bp.route("/reconcile-sql", methods=["POST"])
def reconcile_sql():
    """Generate a read-only ClaimCenter SQL SELECT from a plain-English prompt, grounded on
    this client's dictionary index + the conventions doc."""
    uid, cid, err = _scope()
    if err:
        return err
    body = request.get_json(force=True) or {}
    payload, status = cc_sql_service.generate_sql(uid, cid, body)
    return jsonify(payload), status


@bp.route("/parse-column", methods=["POST"])
def parse_column():
    body = request.get_json(force=True) or {}
    payload, status = schema_service.parse_column(body)
    return jsonify(payload), status


@bp.route("/parse-entity", methods=["POST"])
def parse_entity():
    body = request.get_json(force=True) or {}
    payload, status = schema_service.parse_entity(body)
    return jsonify(payload), status


@bp.route("/generate-ddl", methods=["POST"])
def generate_ddl():
    body = request.get_json(force=True) or {}
    payload, status = etl_service.generate_ddl(body)
    return jsonify(payload), status


@bp.route("/extract-source", methods=["POST"])
def extract_source():
    up = request.files.get("file")
    if up is None:
        return jsonify(ok=False, error="No file uploaded. Attach a file in the 'file' field."), 400
    filename = up.filename or "upload"
    raw = up.read()
    rich = (request.form.get("mode") or "").lower() == "rich"
    payload, status = extraction_service.extract_source(filename, raw, rich=rich)
    return jsonify(payload), status


@bp.route("/extract-source-stream", methods=["POST"])
def extract_source_stream():
    up = request.files.get("file")
    if up is None:
        return jsonify(ok=False, error="No file uploaded."), 400
    filename = up.filename or "upload"
    raw = up.read()
    rich = (request.form.get("mode") or "").lower() == "rich"
    return Response(extraction_service.extract_source_stream(filename, raw, rich=rich),
                    mimetype="application/x-ndjson")
