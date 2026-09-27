"""/api/ai/* routes — status, mapping generation/regeneration, file extraction.

Thin: parse the request, call the service, jsonify the (payload, status) result.
The extract-source-stream endpoint wraps the service's NDJSON generator in a
streaming Response (application/x-ndjson), exactly as before.
"""
from flask import Blueprint, request, jsonify, Response, session

from app.services import (ai_client, mapping_service, extraction_service, etl_service,
                          schema_service, target_meta_service, validation_ai_service,
                          cc_sql_service, source_filter_service, source_filter_store_service,
                          artifact_version_service)

_ETL_FEATURE = "etl_code"
_COMPARE_FEATURE = "reconcile_compare"   # IN vs OUT comparison stored-procedure versions
_NONFIN_FEATURE = "reconcile_nonfin"     # Non-Financial reconciliation script versions

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


@bp.route("/reconcile-compare-sql", methods=["POST"])
def reconcile_compare_sql():
    """Generate an IN-vs-OUT comparison stored procedure for a migration-tool schema (CMT/PMT/BMT).
    Both databases share the client's uploaded migration schema; the proc takes the IN/OUT database
    names as parameters and compares them with dynamic SQL. Body:
    {source(cmt|pmt|bmt), prompt?, tableIds?[], compareTypes?[], history?[]}."""
    uid, cid, err = _scope()
    if err:
        return err
    body = request.get_json(force=True) or {}
    payload, status = cc_sql_service.generate_compare_sql(uid, cid, body)
    return jsonify(payload), status


@bp.route("/reconcile-nonfin-sql", methods=["POST"])
def reconcile_nonfin_sql():
    """Non-Financial Reconciliation: deterministically build DDL for two staging tables
    ([<ReconName>_CMT], [<ReconName>_Legacy]) from the selected migration-schema columns plus a
    compare procedure that diffs them on the user's common key. No AI. Body:
    {source(cmt|pmt|bmt), tableIds[], columns:{table:[cols]}, reconName, keyCols}."""
    uid, cid, err = _scope()
    if err:
        return err
    body = request.get_json(force=True) or {}
    payload, status = cc_sql_service.generate_nonfin_recon_sql(uid, cid, body)
    return jsonify(payload), status


@bp.route("/reconcile-nonfin/versions", methods=["GET", "POST"])
def reconcile_nonfin_versions():
    """GET: list saved Non-Financial reconciliation versions (newest first). POST: save the
    current (possibly edited) script as a new version."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        payload, status = artifact_version_service.save_version(uid, cid, _NONFIN_FEATURE, body)
    else:
        payload, status = artifact_version_service.list_versions(uid, cid, _NONFIN_FEATURE)
    return jsonify(payload), status


@bp.route("/reconcile-nonfin/versions/<int:run_id>", methods=["GET", "DELETE"])
def reconcile_nonfin_version(run_id):
    """GET one saved Non-Financial reconciliation version's full SQL, or DELETE it."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "DELETE":
        payload, status = artifact_version_service.delete_version(uid, cid, _NONFIN_FEATURE, run_id)
    else:
        payload, status = artifact_version_service.get_version(uid, cid, _NONFIN_FEATURE, run_id)
    return jsonify(payload), status


@bp.route("/reconcile-compare-columns")
def reconcile_compare_columns():
    """The comparable (non-PK) columns of one migration table, for the IN-vs-OUT column picker.
    ?source=cmt|pmt|bmt&table=<TableName>."""
    uid, cid, err = _scope()
    if err:
        return err
    payload, status = cc_sql_service.list_compare_columns(
        uid, cid, request.args.get("source", ""), request.args.get("table", ""))
    return jsonify(payload), status


@bp.route("/reconcile-compare/versions", methods=["GET", "POST"])
def reconcile_compare_versions():
    """GET: list saved IN-vs-OUT comparison versions (newest first). POST: save the current
    (possibly edited) stored procedure as a new version."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        payload, status = artifact_version_service.save_version(uid, cid, _COMPARE_FEATURE, body)
    else:
        payload, status = artifact_version_service.list_versions(uid, cid, _COMPARE_FEATURE)
    return jsonify(payload), status


@bp.route("/reconcile-compare/versions/<int:run_id>", methods=["GET", "DELETE"])
def reconcile_compare_version(run_id):
    """GET one saved comparison version's full SQL, or DELETE it."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "DELETE":
        payload, status = artifact_version_service.delete_version(uid, cid, _COMPARE_FEATURE, run_id)
    else:
        payload, status = artifact_version_service.get_version(uid, cid, _COMPARE_FEATURE, run_id)
    return jsonify(payload), status


@bp.route("/source-filter-sql", methods=["POST"])
def source_filter_sql():
    """Generate filtered legacy→prestage extraction SQL (one SELECT per table) from a chosen
    source's extracted schema + a main table/key + a population (key values or a condition).
    The schema itself arrives in the body; _scope() gates auth + AI-usage ownership."""
    uid, cid, err = _scope()
    if err:
        return err
    body = request.get_json(force=True) or {}
    payload, status = source_filter_service.generate(body)
    # No auto-save — the user saves a version explicitly (see POST /source-filter/versions).
    return jsonify(payload), status


@bp.route("/source-filter/versions", methods=["GET", "POST"])
def source_filter_versions():
    """GET: list this tenant's saved Source Data Filter versions (newest first).
    POST: save the current queries (with edits) as a new version."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        # The client sends metadata + queries flat; save_version reads config from `body` and the
        # query set from `result`, so pass the same dict for both.
        payload, status = source_filter_store_service.save_version(uid, cid, body, body)
    else:
        payload, status = source_filter_store_service.list_versions(uid, cid)
    return jsonify(payload), status


@bp.route("/source-filter/versions/<int:run_id>", methods=["GET", "DELETE"])
def source_filter_version(run_id):
    """GET one saved version's full queries + metadata, or DELETE it."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "DELETE":
        payload, status = source_filter_store_service.delete_version(uid, cid, run_id)
    else:
        payload, status = source_filter_store_service.get_version(uid, cid, run_id)
    return jsonify(payload), status


@bp.route("/etl/versions", methods=["GET", "POST"])
def etl_versions():
    """GET: list saved ETL versions (newest first). POST: save the generated SQL as a new version."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        payload, status = artifact_version_service.save_version(uid, cid, _ETL_FEATURE, body)
    else:
        payload, status = artifact_version_service.list_versions(uid, cid, _ETL_FEATURE)
    return jsonify(payload), status


@bp.route("/etl/versions/<int:run_id>", methods=["GET", "DELETE"])
def etl_version(run_id):
    """GET one saved ETL version's full SQL, or DELETE it."""
    uid, cid, err = _scope()
    if err:
        return err
    if request.method == "DELETE":
        payload, status = artifact_version_service.delete_version(uid, cid, _ETL_FEATURE, run_id)
    else:
        payload, status = artifact_version_service.get_version(uid, cid, _ETL_FEATURE, run_id)
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
