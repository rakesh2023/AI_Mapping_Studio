"""Ingestion pipeline: structured loader + end-to-end _run_ingest (chunk/embed +
structured load). LLM domain check is mocked; embedder is the offline hashing one."""
import pytest

from app.db.app_db import connect, write_lock
from app.services import kyd_structured_loader as LOADER
from app.services import kyd_ingestion_service as king
from app.services import kyd_storage_service as storage


@pytest.fixture()
def fix(tmp_path, monkeypatch):
    monkeypatch.setenv("AIMS_DISABLE_DOTENV", "1")
    monkeypatch.setenv("AIMS_APP_DB", str(tmp_path / "pipe_app.db"))
    from app.db.app_db import ensure_app_tables
    ensure_app_tables()
    conn = connect()
    try:
        conn.execute("INSERT INTO users(email,password_hash,created_at) VALUES('p@x.com','h','t')")
        uid = conn.execute("SELECT id FROM users").fetchone()["id"]
        conn.execute("INSERT INTO clients(user_id,name,created_at) VALUES(?,?,?)", (uid, "C", "t"))
        cid = conn.execute("SELECT id FROM clients").fetchone()["id"]
        conn.commit()
    finally:
        conn.close()

    def create_doc(filename, raw, content_kind=None):
        with write_lock():
            c = connect()
            try:
                cur = c.execute("INSERT INTO documents(user_id,client_id,filename,file_ext,status,content_kind,created_at) "
                                "VALUES(?,?,?,?, 'uploaded', ?, 't')",
                                (uid, cid, filename, filename.rsplit(".", 1)[-1], content_kind))
                did = cur.lastrowid
                storage.save_file(c, did, None, raw)
                c.commit()
            finally:
                c.close()
        return did
    return {"uid": uid, "cid": cid, "create_doc": create_doc}


def _accept(monkeypatch):
    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain",
                        lambda parsed: {"is_insurance_related": True, "confidence": 0.95,
                                        "detected_topics": ["claims"], "reasoning": "ok", "usedLlm": True})


def test_structured_loader_creates_table_and_registry(fix):
    did = fix["create_doc"]("claims.csv", b"claim_id,amount,state\n1,100,NY\n2,200,CA\n")
    n = LOADER.load_structured(did, fix["uid"], fix["cid"], "claims.csv",
                               b"claim_id,amount,state\n1,100,NY\n2,200,CA\n")
    assert n == 1
    conn = connect()
    try:
        st = conn.execute("SELECT physical_table, row_count FROM structured_tables WHERE document_id=?",
                          (did,)).fetchone()
        assert st["row_count"] == 2
        cnt = conn.execute(f'SELECT COUNT(*) n FROM "{st["physical_table"]}"').fetchone()["n"]
        assert cnt == 2
    finally:
        conn.close()


def test_ingest_structured_end_to_end(fix, monkeypatch):
    _accept(monkeypatch)
    did = fix["create_doc"]("claims.csv", b"policy,premium\nP1,100\nP2,200\n")
    king._run_ingest(did)
    conn = connect()
    try:
        d = conn.execute("SELECT status, content_kind, chunk_count, table_count FROM documents WHERE id=?",
                         (did,)).fetchone()
        assert d["status"] == "ready" and d["content_kind"] == "structured"
        assert d["chunk_count"] >= 1 and d["table_count"] == 1
        assert conn.execute("SELECT COUNT(*) n FROM document_chunks WHERE document_id=?", (did,)).fetchone()["n"] >= 1
        assert conn.execute("SELECT COUNT(*) n FROM structured_tables WHERE document_id=?", (did,)).fetchone()["n"] == 1
    finally:
        conn.close()


def test_ingest_unstructured_end_to_end(fix, monkeypatch):
    _accept(monkeypatch)
    did = fix["create_doc"]("policy.xml", b"<policy><coverage>collision and comprehensive</coverage></policy>")
    king._run_ingest(did)
    conn = connect()
    try:
        d = conn.execute("SELECT status, content_kind, chunk_count, table_count FROM documents WHERE id=?",
                         (did,)).fetchone()
        assert d["status"] == "ready" and d["content_kind"] == "unstructured"
        assert d["chunk_count"] >= 1 and d["table_count"] == 0
    finally:
        conn.close()


def test_ingest_rejected_stores_no_chunks(fix, monkeypatch):
    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain",
                        lambda parsed: {"is_insurance_related": False, "confidence": 0.1,
                                        "detected_topics": ["recipes"], "reasoning": "no", "usedLlm": True})
    did = fix["create_doc"]("claims.csv", b"a,b\n1,2\n")
    king._run_ingest(did)
    conn = connect()
    try:
        assert conn.execute("SELECT status FROM documents WHERE id=?", (did,)).fetchone()["status"] == "rejected"
        assert conn.execute("SELECT COUNT(*) n FROM document_chunks WHERE document_id=?", (did,)).fetchone()["n"] == 0
        assert conn.execute("SELECT COUNT(*) n FROM structured_tables WHERE document_id=?", (did,)).fetchone()["n"] == 0
    finally:
        conn.close()
