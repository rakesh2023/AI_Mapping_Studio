"""/api/ai/* routes — status, mapping generation/regeneration, file extraction.

Thin: parse the request, call the service, jsonify the (payload, status) result.
The extract-source-stream endpoint wraps the service's NDJSON generator in a
streaming Response (application/x-ndjson), exactly as before.
"""
from flask import Blueprint, request, jsonify, Response

from app.services import (ai_client, mapping_service, extraction_service, etl_service,
                          schema_service, final_mapping_service)

bp = Blueprint("ai_api", __name__, url_prefix="/api/ai")


@bp.route("/status")
def ai_status():
    return jsonify(ai_client.ai_status())


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


@bp.route("/final-map-instruction")
def final_map_instruction():
    return jsonify(ok=True, instruction=final_mapping_service.base_instruction())


@bp.route("/suggest-final-mappings", methods=["POST"])
def suggest_final_mappings():
    body = request.get_json(force=True) or {}
    payload, status = final_mapping_service.suggest(body)
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
    payload, status = extraction_service.extract_source(filename, raw)
    return jsonify(payload), status


@bp.route("/extract-source-stream", methods=["POST"])
def extract_source_stream():
    up = request.files.get("file")
    if up is None:
        return jsonify(ok=False, error="No file uploaded."), 400
    filename = up.filename or "upload"
    raw = up.read()
    return Response(extraction_service.extract_source_stream(filename, raw),
                    mimetype="application/x-ndjson")


@bp.route("/extract-target", methods=["POST"])
def extract_target():
    up = request.files.get("file")
    if up is None:
        return jsonify(ok=False, error="No file uploaded. Attach a file in the 'file' field."), 400
    raw = up.read()
    payload, status = extraction_service.extract_target(up.filename or "upload", raw)
    return jsonify(payload), status


@bp.route("/extract-target-stream", methods=["POST"])
def extract_target_stream():
    up = request.files.get("file")
    if up is None:
        return jsonify(ok=False, error="No file uploaded."), 400
    filename = up.filename or "upload"
    raw = up.read()
    return Response(extraction_service.extract_target_stream(filename, raw),
                    mimetype="application/x-ndjson")
