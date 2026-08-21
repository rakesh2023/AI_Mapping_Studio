"""/api/lookups/* — CRUD for source lookup sets + their values, and value-level
mappings. Thin: derive (uid, cid) from the signed session (never client input),
gate on the feature flag, delegate to lookup_service. Mutating routes are under
/api/ (not /api/auth/) so the global CSRF guard applies; the shell fetch wrapper
sends the token automatically.
"""
from flask import Blueprint, request, jsonify, session, current_app

from app.services import lookup_service

bp = Blueprint("lookup_api", __name__, url_prefix="/api/lookups")


def _scope():
    """(uid, cid, None) when authenticated with an active client + feature on, else
    (None, None, error_response)."""
    if not current_app.config.get("LOOKUP_MAPPING_ENABLED", True):
        return None, None, (jsonify({"ok": False, "error": "Lookup mapping is disabled."}), 404)
    uid = session.get("uid")
    if not uid:
        return None, None, (jsonify({"ok": False, "error": "Not authenticated."}), 401)
    cid = session.get("cid")
    if not cid:
        return None, None, (jsonify({"ok": False, "error": "No active client selected."}), 400)
    return uid, cid, None


@bp.route("", methods=["GET"])
def list_sets():
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.list_sets(uid, cid)
    return jsonify(payload), status


@bp.route("", methods=["POST"])
def create_set():
    uid, cid, err = _scope()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    payload, status = lookup_service.save_lookup_set(
        uid, cid, b.get("lookupName", ""), b.get("values") or [],
        source_table=b.get("sourceTable"), source_column=b.get("sourceColumn"),
        target_table=b.get("targetTable"), target_column=b.get("targetColumn"),
        target_values_spec=b.get("targetValuesSpec"), source_document=b.get("sourceDocument"))
    return jsonify(payload), status


@bp.route("/snapshot", methods=["GET"])
def snapshot():
    """All sets + their values in one call (for the Lookup Data System browser)."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.snapshot_all(uid, cid)
    return jsonify(payload), status


@bp.route("", methods=["DELETE"])
def delete_all_sets():
    """Clear all lookup sets for this tenant (values + value mappings cascade)."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.delete_all_sets(uid, cid)
    return jsonify(payload), status


@bp.route("/upload", methods=["POST"])
def upload_document():
    """Upload a lookup document (Target/Source binding + Code/Description rows) ->
    parsed into lookup sets and saved."""
    uid, cid, err = _scope()
    if err:
        return err
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "No file uploaded."}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    product = request.form.get("product")   # policy | claim | billing (Guidewire zip only)
    payload, status = lookup_service.import_document(uid, cid, f.filename, f.read(), ext, product=product)
    return jsonify(payload), status


@bp.route("/<int:set_id>", methods=["GET"])
def get_set(set_id):
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.get_set(uid, cid, set_id)
    if status == 200:
        vals, _ = lookup_service.get_values(uid, cid, set_id)
        payload["values"] = vals.get("values", [])
    return jsonify(payload), status


@bp.route("/<int:set_id>", methods=["PUT"])
def update_set(set_id):
    uid, cid, err = _scope()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    payload, status = lookup_service.update_set(
        uid, cid, set_id, source_table=b.get("sourceTable"), source_column=b.get("sourceColumn"),
        target_table=b.get("targetTable"), target_column=b.get("targetColumn"),
        target_values_spec=b.get("targetValuesSpec"), legacy_values_spec=b.get("legacyValuesSpec"))
    return jsonify(payload), status


@bp.route("/<int:set_id>/generate-values", methods=["POST"])
def generate_values(set_id):
    """AI-map this set's legacy values (free text) to its target Guidewire typelist codes."""
    uid, cid, err = _scope()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    payload, status = lookup_service.generate_value_mappings(
        uid, cid, set_id, b.get("legacyValues", ""), b.get("targetCodes") or [])
    return jsonify(payload), status


@bp.route("/<int:set_id>", methods=["DELETE"])
def delete_set(set_id):
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.delete_set(uid, cid, set_id)
    return jsonify(payload), status


@bp.route("/<int:set_id>/mappings", methods=["GET"])
def list_value_mappings(set_id):
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = lookup_service.list_value_mappings(uid, cid, set_id)
    return jsonify(payload), status


@bp.route("/mappings/<int:mapping_id>", methods=["PATCH"])
def override_value_mapping(mapping_id):
    """User edit of a single value mapping -> manual_override + reviewed."""
    uid, cid, err = _scope()
    if err:
        return err
    b = request.get_json(silent=True) or {}
    payload, status = lookup_service.set_value_mapping_override(
        uid, cid, mapping_id, b.get("targetCode"), b.get("targetDescription"), reviewed_by=uid)
    return jsonify(payload), status
