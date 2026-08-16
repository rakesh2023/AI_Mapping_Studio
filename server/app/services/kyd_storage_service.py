"""File storage for Know Your Data uploads.

The app has no pre-existing file store (see docs/know-your-data/CODEBASE_CONTEXT.md
§6). Because static_routes serves the entire repo root, an on-disk path under the
repo would be readable cross-tenant by any authenticated user — so uploaded bytes
are stored as a BLOB in the app DB (``document_files``), scoped by the owning
``documents`` row and removed by FK cascade on delete.

This module is a thin storage seam: services call save/open/delete here and never
touch the blob table directly, so a future disk/S3 backend can replace it without
changing callers. Writes must be inside a write_lock() the caller already holds
(save_file is called from the document-creation transaction).
"""
import sqlite3
from datetime import datetime, timezone
from typing import Optional, Tuple


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def save_file(conn: sqlite3.Connection, document_id: int, mime_type: Optional[str], data: bytes) -> None:
    """Persist (or replace) the original bytes for a document. Caller owns the txn + lock."""
    conn.execute(
        "INSERT INTO document_files (document_id, mime_type, byte_size, data, created_at) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(document_id) DO UPDATE SET mime_type=excluded.mime_type, "
        "byte_size=excluded.byte_size, data=excluded.data, created_at=excluded.created_at",
        (document_id, mime_type, len(data or b""), sqlite3.Binary(data or b""), _now()),
    )


def open_file(conn: sqlite3.Connection, document_id: int) -> Optional[Tuple[bytes, Optional[str]]]:
    """Return (bytes, mime_type) for a document, or None if no stored file."""
    row = conn.execute(
        "SELECT data, mime_type FROM document_files WHERE document_id=?", (document_id,)
    ).fetchone()
    if not row:
        return None
    return (bytes(row["data"]), row["mime_type"])


def delete_file(conn: sqlite3.Connection, document_id: int) -> None:
    """Remove the stored bytes. (Also removed automatically by FK cascade when the
    documents row is deleted; kept explicit for callers that delete the file only.)"""
    conn.execute("DELETE FROM document_files WHERE document_id=?", (document_id,))
