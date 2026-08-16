"""Ingestion job runner for Know Your Data documents.

The app has no queue system (see docs/know-your-data/CODEBASE_CONTEXT.md §7); the
established pattern is a daemon thread with state tracked out-of-band. Unlike the
deploy job store (in-memory), ingestion status is PERSISTED on the ``documents``
row (status/status_detail/updated_at) so it survives a page reload and a restart
can reconcile orphaned 'processing' rows.

State machine:  uploaded -> processing -> ready | failed        (rejected is set
by the domain check once implemented). ``start_ingest`` is the enqueue seam the
upload route calls; tests monkeypatch it to avoid spawning a thread.

NOTE: the actual pipeline (parse -> domain check -> chunk+embed / structured load)
is not built yet — this runner establishes the queue + status plumbing and marks
the document 'ready' with a detected content_kind. The pipeline steps are TODOs.
"""
import json
import threading
from datetime import datetime, timezone
from typing import Optional

from app.db.app_db import connect, write_lock
from app.services import document_parser
from app.services import kyd_domain_service
from app.services import kyd_storage_service
from app.services import kyd_chunker
from app.services import kyd_vector_store
from app.services import kyd_structured_loader

# Minimum classifier confidence to accept a document as insurance-domain.
DOMAIN_MIN_CONFIDENCE = 0.6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_status(document_id: int, status: str, detail: Optional[str] = None, **extra) -> None:
    """Persist a status transition on the documents row (scoped by id only — the
    worker already knows the row is owned by the enqueuing tenant)."""
    cols = ["status=?", "status_detail=?", "updated_at=?"]
    vals = [status, detail, _now()]
    for k, v in extra.items():
        cols.append(f"{k}=?")
        vals.append(v)
    vals.append(document_id)
    with write_lock():
        conn = connect()
        try:
            conn.execute("UPDATE documents SET " + ", ".join(cols) + " WHERE id=?", vals)
            conn.commit()
        finally:
            conn.close()


def start_ingest(document_id: int, force: bool = False) -> None:
    """Enqueue ingestion for a document. Spawns a daemon worker (fire-and-forget).

    This is the seam the upload route calls right after creating the 'uploaded' row.
    `force=True` (from force-ingest) skips the insurance-domain gate.
    Tests replace this with a no-op so the endpoint can be asserted without a thread.
    """
    t = threading.Thread(target=_run_ingest, args=(document_id, force), daemon=True)
    t.start()


def reconcile_orphans() -> int:
    """Startup safety net: any row left 'processing' (or 'uploaded') by a previous
    process is marked 'failed' so it never hangs forever. Returns the count fixed."""
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "UPDATE documents SET status='failed', "
                "status_detail='Ingestion was interrupted by a server restart. Please retry.', "
                "updated_at=? WHERE status IN ('processing','uploaded')",
                (_now(),),
            )
            conn.commit()
            return cur.rowcount or 0
        finally:
            conn.close()


def _reject(document_id: int, dc: dict) -> None:
    """Persist a domain rejection: status='rejected' + detected_topics/reasoning/confidence."""
    _set_status(
        document_id, "rejected",
        "Not recognized as insurance data.",
        detected_topics=json.dumps(dc.get("detected_topics") or []),
        domain_check_reasoning=(dc.get("reasoning") or "")[:2000],
        # store as 0-100 to match the schema's domain_check_confidence semantics
        domain_check_confidence=round(float(dc.get("confidence") or 0.0) * 100, 1),
    )


def _run_ingest(document_id: int, force: bool = False) -> None:
    """Worker body: load -> parse -> insurance-domain gate -> chunk/embed. Persists
    status transitions; never raises out of the thread. `force` skips the gate."""
    try:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT filename, user_id, client_id FROM documents WHERE id=?", (document_id,)
            ).fetchone()
            if not row:
                return  # deleted before the worker started
            filename = row["filename"]
            uid, cid = row["user_id"], row["client_id"]
            stored = kyd_storage_service.open_file(conn, document_id)
        finally:
            conn.close()
        if not stored:
            _set_status(document_id, "failed", "Stored file not found.")
            return
        raw, _mime = stored

        # 1. Parse (document_parser marks status='failed' itself on a parse error).
        _set_status(document_id, "processing", "Parsing…")
        parsed = document_parser.parse_and_store(document_id, filename, raw)
        if parsed is None:
            return  # already 'failed'

        # 2. Insurance-domain gate (skipped on user override).
        if not force:
            _set_status(document_id, "processing", "Checking domain…")
            dc = kyd_domain_service.is_insurance_domain(parsed)
            if (not dc.get("is_insurance_related")) or float(dc.get("confidence") or 0.0) < DOMAIN_MIN_CONFIDENCE:
                _reject(document_id, dc)
                return   # STOP — do not chunk/embed a non-insurance document

        # 3. Chunk + embed (unstructured text or structured data profiles) into the
        #    vector store, and load structured rows into queryable per-doc tables.
        _set_status(document_id, "processing", "Indexing…")
        chunks = kyd_chunker.chunks_for(parsed)
        chunk_count = kyd_vector_store.add_chunks(document_id, uid, cid, chunks) if chunks else 0
        table_count = kyd_structured_loader.load_structured(document_id, uid, cid, filename, raw)

        detail = "Ingested (domain check overridden)." if force else "Ingested."
        _set_status(document_id, "ready", detail, content_kind=parsed.kind,
                    chunk_count=chunk_count, table_count=table_count)
    except Exception as exc:  # noqa: BLE001 - a worker crash must not hang the doc
        try:
            _set_status(document_id, "failed", "Ingestion error: " + (str(exc) or exc.__class__.__name__))
        except Exception:
            pass
