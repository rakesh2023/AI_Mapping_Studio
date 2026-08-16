"""Unit tests for the KYD vector foundation: chunker, embedder, vector store."""
import numpy as np
import pytest

from app.services import kyd_chunker as CK
from app.services import kyd_embedder as EMB
from app.services import kyd_vector_store as VS


# --------------------------------------------------------------------------- #
# Chunker
# --------------------------------------------------------------------------- #
def test_chunk_text_splits_with_overlap_and_indices():
    text = "word " * 800   # ~4000 chars -> multiple chunks
    chunks = CK.chunk_text(text, size=1000, overlap=150)
    assert len(chunks) >= 3
    assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))
    assert all(len(c["text"]) <= 1000 for c in chunks)


def test_chunk_text_tracks_pages():
    text = "[page 1]\nPolicy intro text.\n[page 2]\nClaims section text."
    chunks = CK.chunk_text(text, size=1000, overlap=50)
    pages = {c["page"] for c in chunks}
    assert pages == {1, 2}


def test_chunks_for_structured_uses_table_profiles():
    parsed = type("P", (), {})()
    parsed.kind = "structured"
    parsed.text = "ignored"
    parsed.tables = [{"name": "claims", "profile": "Table: claims\nRows: 3"},
                     {"name": "policies", "profile": "Table: policies\nRows: 2"}]
    chunks = CK.chunks_for(parsed)
    assert [c["section"] for c in chunks] == ["claims", "policies"]


def test_empty_text_no_chunks():
    assert CK.chunk_text("") == []


# --------------------------------------------------------------------------- #
# Embedder
# --------------------------------------------------------------------------- #
def test_embedder_is_deterministic_and_normalized():
    v1 = EMB.embed_query("premium and claim amounts")
    v2 = EMB.embed_query("premium and claim amounts")
    assert v1.shape[0] == EMB.embedding_dim()
    assert np.allclose(v1, v2)                       # deterministic
    assert abs(float(np.linalg.norm(v1)) - 1.0) < 1e-5   # unit length


def test_embedder_similar_texts_closer_than_unrelated():
    a = EMB.embed_query("insurance premium payment for the policy")
    b = EMB.embed_query("premium payment on the insurance policy")   # shares tokens
    c = EMB.embed_query("chocolate cake baking recipe")              # unrelated
    assert float(a @ b) > float(a @ c)


# --------------------------------------------------------------------------- #
# Vector store (needs a DB with a document row for the FK)
# --------------------------------------------------------------------------- #
@pytest.fixture()
def vecdb(tmp_path, monkeypatch):
    monkeypatch.setenv("AIMS_DISABLE_DOTENV", "1")
    monkeypatch.setenv("AIMS_APP_DB", str(tmp_path / "vec_app.db"))
    from app.db.app_db import ensure_app_tables, connect
    ensure_app_tables()
    conn = connect()
    try:
        conn.execute("INSERT INTO users(email,password_hash,created_at) VALUES('v@x.com','h','t')")
        uid = conn.execute("SELECT id FROM users").fetchone()["id"]
        conn.execute("INSERT INTO clients(user_id,name,created_at) VALUES(?,?,?)", (uid, "C", "t"))
        cid = conn.execute("SELECT id FROM clients").fetchone()["id"]
        def mkdoc(name):
            cur = conn.execute("INSERT INTO documents(user_id,client_id,filename,status,created_at) "
                               "VALUES(?,?,?, 'ready','t')", (uid, cid, name))
            conn.commit()
            return cur.lastrowid
        yield {"uid": uid, "cid": cid, "mkdoc": mkdoc, "connect": connect}
    finally:
        conn.close()


def test_add_and_search_returns_most_similar(vecdb):
    d1 = vecdb["mkdoc"]("policy.pdf")
    n = VS.add_chunks(d1, vecdb["uid"], vecdb["cid"], [
        {"text": "The policy provides collision coverage for the insured vehicle.", "chunk_index": 0},
        {"text": "Premium is due monthly; a grace period applies.", "chunk_index": 1},
        {"text": "The office kitchen has a coffee machine and a fridge.", "chunk_index": 2},
    ])
    assert n == 3
    hits = VS.search(vecdb["uid"], vecdb["cid"], "what collision coverage does the policy provide?", k=2)
    assert hits and "collision coverage" in hits[0]["text"]
    assert hits[0]["documentId"] == d1 and "score" in hits[0]


def test_search_is_tenant_scoped(vecdb):
    d1 = vecdb["mkdoc"]("policy.pdf")
    VS.add_chunks(d1, vecdb["uid"], vecdb["cid"], [{"text": "insured premium coverage", "chunk_index": 0}])
    # A different user sees nothing.
    assert VS.search(vecdb["uid"] + 999, vecdb["cid"], "premium", k=5) == []


def test_search_doc_id_filter(vecdb):
    d1 = vecdb["mkdoc"]("a.pdf"); d2 = vecdb["mkdoc"]("b.pdf")
    VS.add_chunks(d1, vecdb["uid"], vecdb["cid"], [{"text": "alpha premium claim", "chunk_index": 0}])
    VS.add_chunks(d2, vecdb["uid"], vecdb["cid"], [{"text": "beta premium claim", "chunk_index": 0}])
    hits = VS.search(vecdb["uid"], vecdb["cid"], "premium claim", doc_ids=[d1], k=5)
    assert hits and all(h["documentId"] == d1 for h in hits)
