"""SQLite-native vector store over document_chunks.

"Reuse the existing DB for vector storage" (there is no Postgres/pgvector): each
chunk's embedding is a float32 BLOB in document_chunks; retrieval loads the
tenant-scoped rows and ranks by cosine similarity in numpy. Fine for the small
per-tenant corpora this tool handles; a `sqlite-vec` ANN index could slot in
behind the same interface later.

All reads/writes are scoped by (user_id, client_id) — the vectors of one tenant
are never visible to another.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Union

import numpy as np

from app.db.app_db import connect, write_lock
from app.services import kyd_embedder


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def add_chunks(document_id: int, user_id: int, client_id: int,
               chunks: List[Dict[str, Any]]) -> int:
    """Embed and store chunks for a document. `chunks` items:
    {text, chunk_index, page?, section?, token_estimate?}. Returns count stored."""
    texts = [c.get("text") or "" for c in chunks]
    if not texts:
        return 0
    vecs = kyd_embedder.embed_texts(texts)
    model = kyd_embedder.embedder_name()
    ts = _now()
    with write_lock():
        conn = connect()
        try:
            conn.executemany(
                "INSERT INTO document_chunks (document_id, user_id, client_id, chunk_index, "
                "text, token_estimate, page, section, embedding, embed_model, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(document_id, user_id, client_id, c.get("chunk_index", i), c.get("text") or "",
                  c.get("token_estimate"), c.get("page"), c.get("section"),
                  np.asarray(vecs[i], dtype=np.float32).tobytes(), model, ts)
                 for i, c in enumerate(chunks)],
            )
            conn.commit()
        finally:
            conn.close()
    return len(chunks)


def search(user_id: int, client_id: int, query: Union[str, Sequence[float]],
           doc_ids: Optional[Sequence[int]] = None, k: int = 5) -> List[Dict[str, Any]]:
    """Top-k most similar chunks for `query` (a question string or a vector),
    scoped to the tenant and optionally to specific document ids."""
    qv = kyd_embedder.embed_query(query) if isinstance(query, str) else np.asarray(query, dtype=np.float32)
    qn = float(np.linalg.norm(qv))
    if qn:
        qv = qv / qn

    sql = ("SELECT id, document_id, text, page, section, embedding FROM document_chunks "
           "WHERE user_id=? AND client_id=?")
    params: List[Any] = [user_id, client_id]
    if doc_ids:
        sql += " AND document_id IN (%s)" % ",".join("?" * len(doc_ids))
        params += list(doc_ids)

    conn = connect()
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    if not rows:
        return []

    dim = qv.shape[0]
    embs, keep = [], []
    for r in rows:
        v = np.frombuffer(r["embedding"], dtype=np.float32)
        if v.shape[0] == dim:               # skip rows embedded with a different model/dim
            embs.append(v)
            keep.append(r)
    if not embs:
        return []
    scores = np.vstack(embs) @ qv           # cosine (all vectors are unit-normalized)
    order = np.argsort(-scores)[:max(1, k)]
    return [{"chunkId": keep[i]["id"], "documentId": keep[i]["document_id"],
             "text": keep[i]["text"], "page": keep[i]["page"], "section": keep[i]["section"],
             "score": float(scores[i])} for i in order]
