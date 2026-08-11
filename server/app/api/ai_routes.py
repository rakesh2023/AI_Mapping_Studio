"""/api/ai/* routes — status, mapping generation/regeneration, file extraction.

Thin: parse the request, call the service, jsonify the (payload, status) result.
The extract-source-stream endpoint wraps the service's NDJSON generator in a
streaming Response (application/x-ndjson), exactly as before.
"""
from flask import Blueprint, request, jsonify, Response

from app.services import ai_client, mapping_service, extraction_service, etl_service

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
