"""/api/db/* routes — live SQL Server metadata & profiling.

Thin: parse the request body, call db_service, jsonify the (payload, status)
result. No business logic here.
"""
from flask import Blueprint, request, jsonify

from app.services import db_service

bp = Blueprint("db_api", __name__, url_prefix="/api/db")


@bp.route("/drivers")
def list_drivers():
    return jsonify(db_service.list_drivers())


@bp.route("/test", methods=["POST"])
def test_connection():
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.test_connection(cfg)
    return jsonify(payload), status


@bp.route("/metadata", methods=["POST"])
def get_metadata():
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.get_metadata(cfg)
    return jsonify(payload), status


@bp.route("/profile", methods=["POST"])
def profile_table():
    cfg = request.get_json(force=True) or {}
    payload, status = db_service.profile_table(cfg)
    return jsonify(payload), status
