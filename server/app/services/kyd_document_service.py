"""Know Your Data — document CRUD + status, scoped to the session's tenant.

Every function takes (user_id, client_id) from the ROUTE (which reads them from
the signed session) and scopes every query by both, so documents can't be
addressed across tenants. Returns (payload_dict, http_status) like the other
services. Uploaded bytes go through kyd_storage_service (DB BLOB); ingestion is
enqueued via kyd_ingestion_service (daemon-thread queue). Deleting a document
removes its file, its vector entries (document_chunks) and structured registry
(FK ON DELETE CASCADE), and drops any physical structured data tables.
"""
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from app.db.app_db import connect, write_lock
from app.db import kyd_models as M
from app.core.config import KYD_ACCEPT_EXTS, kyd_max_upload_bytes
from app.services import kyd_storage_service as storage
from app.services import kyd_ingestion_service as ingest

Payload = Dict[str, Any]
Result = Tuple[Payload, int]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ext(filename: str) -> str:
    name = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def create_and_enqueue(user_id: int, client_id: int, filename: str,
                       raw: bytes, mime_type: Optional[str] = None) -> Result:
    """Validate type/size, store the file, create an 'uploaded' row, enqueue ingest."""
    filename = (filename or "").strip()
    if not filename:
        return {"ok": False, "error": "No file uploaded."}, 400
    raw = raw or b""
    if not raw:
        return {"ok": False, "error": "The uploaded file is empty."}, 400

    ext = _ext(filename)
    if ext not in KYD_ACCEPT_EXTS:
        return {"ok": False,
                "error": "Unsupported file type '." + (ext or "?") + "'. Allowed: "
                         + ", ".join("." + e for e in KYD_ACCEPT_EXTS) + "."}, 400

    cap = kyd_max_upload_bytes()
    if len(raw) > cap:
        return {"ok": False,
                "error": "File too large (" + _mb(len(raw)) + "). Maximum is " + _mb(cap) + "."}, 413

    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO documents (user_id, client_id, filename, file_ext, mime_type, "
                "size_bytes, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (user_id, client_id, filename, ext, mime_type, len(raw),
                 M.STATUS_UPLOADED, _now()),
            )
            doc_id = cur.lastrowid
            storage.save_file(conn, doc_id, mime_type, raw)   # same txn as the row
            conn.commit()
            row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        finally:
            conn.close()

    # Enqueue ingestion (daemon-thread queue). Failure to enqueue must not lose the
    # upload — the row stays 'uploaded' and the startup reconciler / a retry can pick
    # it up.
    try:
        ingest.start_ingest(doc_id)
    except Exception:  # noqa: BLE001
        pass

    return {"ok": True, "document": M.Document.from_row(row).public_dict()}, 201


def list_documents(user_id: int, client_id: int) -> Result:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM documents WHERE user_id=? AND client_id=? ORDER BY id DESC",
            (user_id, client_id),
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "documents": [M.Document.from_row(r).public_dict() for r in rows]}, 200


def get_status(user_id: int, client_id: int, document_id: int) -> Result:
    """Ingestion status for one document. 404 (not 403) if it isn't the tenant's,
    so the endpoint never confirms another tenant's ids exist."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM documents WHERE id=? AND user_id=? AND client_id=?",
            (document_id, user_id, client_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {"ok": False, "error": "Document not found."}, 404
    d = M.Document.from_row(row)
    return {"ok": True, "id": d.id, "status": d.status, "statusDetail": d.status_detail,
            "contentKind": d.content_kind, "chunkCount": d.chunk_count,
            "tableCount": d.table_count, "detectedTopics": d.detected_topics,
            "domainCheckConfidence": d.domain_check_confidence,
            "domainCheckReasoning": d.domain_check_reasoning,
            "updatedAt": d.updated_at}, 200


def force_ingest(user_id: int, client_id: int, document_id: int) -> Result:
    """User override: bypass the insurance-domain gate and re-run ingestion so the
    document is chunked/embedded anyway. Records the override (domain_override=1) and
    writes an audit line. Scoped so only the owner can override."""
    with write_lock():
        conn = connect()
        try:
            row = conn.execute(
                "SELECT id FROM documents WHERE id=? AND user_id=? AND client_id=?",
                (document_id, user_id, client_id),
            ).fetchone()
            if not row:
                return {"ok": False, "error": "Document not found."}, 404
            conn.execute(
                "UPDATE documents SET domain_override=1, status='processing', "
                "status_detail='Force-ingest requested (domain check overridden).', "
                "updated_at=? WHERE id=?",
                (_now(), document_id),
            )
            conn.commit()
        finally:
            conn.close()

    # Audit the override (server log is the app's fallback audit channel; the
    # domain_override=1 flag on the row is the durable record).
    print(f"[kyd-audit] force-ingest override: doc={document_id} user={user_id} "
          f"client={client_id} at {_now()}")

    try:
        ingest.start_ingest(document_id, force=True)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "id": document_id, "status": "processing", "domainOverride": True}, 200


def delete_document(user_id: int, client_id: int, document_id: int) -> Result:
    """Remove the file, DB rows (documents + cascaded chunks/structured registry),
    and any physical structured data tables. Scoped so only the owner can delete."""
    with write_lock():
        conn = connect()
        try:
            owned = conn.execute(
                "SELECT id FROM documents WHERE id=? AND user_id=? AND client_id=?",
                (document_id, user_id, client_id),
            ).fetchone()
            if not owned:
                return {"ok": False, "error": "Document not found."}, 404

            # Drop any physical per-document structured tables before deleting the
            # registry rows (which cascade with the document).
            for r in conn.execute(
                "SELECT physical_table FROM structured_tables WHERE document_id=?",
                (document_id,),
            ).fetchall():
                pt = r["physical_table"]
                if _safe_table_name(pt):
                    conn.execute(f'DROP TABLE IF EXISTS "{pt}"')

            # documents delete cascades: document_files (bytes), document_chunks
            # (vector entries), structured_tables (registry).
            conn.execute("DELETE FROM documents WHERE id=?", (document_id,))
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "deletedId": document_id}, 200


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


def _safe_table_name(name: str) -> bool:
    """Guard the dynamic DROP: only our namespaced identifiers (kyd_d<digits>_...)."""
    import re
    return bool(name) and re.match(r"^kyd_d\d+_[A-Za-z0-9_]+$", name) is not None
