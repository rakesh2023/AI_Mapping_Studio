"""/api/ai/* routes — status, mapping generation/regeneration, file extraction.

Thin: parse the request, call the service, jsonify the (payload, status) result.
The extract-source-stream endpoint wraps the service's NDJSON generator in a
streaming Response (application/x-ndjson), exactly as before.
"""
from flask import Blueprint, request, jsonify, Response

from app.services import (ai_client, mapping_service, extraction_service, etl_service,
                          schema_service, target_meta_service)

bp = Blueprint("ai_api", __name__, url_prefix="/api/ai")


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
