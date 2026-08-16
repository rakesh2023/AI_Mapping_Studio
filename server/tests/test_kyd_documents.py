"""Integration tests for /api/kyd/documents — upload / list / status / delete.

Session-scoped, tenant-isolated (like /api/state). The ingestion enqueue is
stubbed to a no-op so uploads don't spawn a background thread; the worker and the
orphan reconciler are exercised directly.
"""
import io

import pytest

from app import create_app
from app.db.app_db import connect
import app.services.kyd_ingestion_service as king


@pytest.fixture(autouse=True)
def _kyd_env(tmp_path, monkeypatch):
    """Fresh app DB per test + a no-op ingestion enqueue (records the doc ids)."""
    monkeypatch.setenv("AIMS_DISABLE_DOTENV", "1")
    monkeypatch.setenv("AIMS_APP_DB", str(tmp_path / "kyd_app.db"))
    monkeypatch.setenv("AIMS_SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("AIMS_CSRF_ENABLED", "0")
    monkeypatch.setenv("AIMS_SIGNUP_ENABLED", "1")
    from app.db.app_db import ensure_app_tables
    ensure_app_tables()
    calls = []
    monkeypatch.setattr(king, "start_ingest", lambda doc_id, force=False: calls.append((doc_id, force)))
    return {"enqueued": calls}


def _client():
    return create_app().test_client()


def _signup_and_client(c, email, name="KYD Co"):
    c.post("/api/auth/signup", json={"email": email, "password": "password123", "name": "U"})
    r = c.post("/api/clients", json={"name": name, "industry": "Insurance", "config": {}})
    return r.get_json()["client"]["id"]


def _upload(c, filename, data=b"policy number and premium data"):
    return c.post("/api/kyd/documents",
                  data={"file": (io.BytesIO(data), filename)},
                  content_type="multipart/form-data")


# --------------------------------------------------------------------------- #
# Auth / active-client gating
# --------------------------------------------------------------------------- #
def test_requires_auth():
    c = _client()
    assert c.get("/api/kyd/documents").status_code == 401
    assert _upload(c, "x.pdf").status_code == 401


def test_requires_active_client():
    c = _client()
    c.post("/api/auth/signup", json={"email": "nc@example.com", "password": "password123", "name": "N"})
    assert c.get("/api/kyd/documents").status_code == 409       # logged in, no client
    assert _upload(c, "x.pdf").status_code == 409


# --------------------------------------------------------------------------- #
# Upload: happy path + validation
# --------------------------------------------------------------------------- #
def test_upload_creates_uploaded_row_stores_file_and_enqueues(_kyd_env):
    c = _client()
    _signup_and_client(c, "up@example.com")
    r = _upload(c, "claims_2024.csv", b"claim,premium\n1,100\n")
    assert r.status_code == 201
    doc = r.get_json()["document"]
    assert doc["status"] == "uploaded" and doc["fileExt"] == "csv" and doc["sizeBytes"] > 0

    # enqueued exactly once (not forced)
    assert _kyd_env["enqueued"] == [(doc["id"], False)]

    # file bytes stored in the DB (BLOB), not on disk
    conn = connect()
    try:
        row = conn.execute("SELECT byte_size FROM document_files WHERE document_id=?", (doc["id"],)).fetchone()
    finally:
        conn.close()
    assert row is not None and row["byte_size"] == len(b"claim,premium\n1,100\n")

    # shows up in the list
    lst = c.get("/api/kyd/documents").get_json()
    assert lst["ok"] and len(lst["documents"]) == 1 and lst["documents"][0]["id"] == doc["id"]


@pytest.mark.parametrize("name", ["notes.txt", "archive.zip", "image.png", "noext"])
def test_upload_rejects_unsupported_type(name):
    c = _client()
    _signup_and_client(c, "bad@example.com")
    r = _upload(c, name)
    assert r.status_code == 400 and "Unsupported" in r.get_json()["error"]


def test_upload_rejects_empty_file():
    c = _client()
    _signup_and_client(c, "empty@example.com")
    r = _upload(c, "policy.pdf", b"")
    assert r.status_code == 400 and "empty" in r.get_json()["error"].lower()


def test_upload_rejects_oversize(monkeypatch):
    import app.services.kyd_document_service as svc
    monkeypatch.setattr(svc, "kyd_max_upload_bytes", lambda: 8)   # 8-byte cap
    c = _client()
    _signup_and_client(c, "big@example.com")
    r = _upload(c, "policy.pdf", b"0123456789")   # 10 bytes > 8
    assert r.status_code == 413 and "too large" in r.get_json()["error"].lower()


def test_upload_missing_file_field():
    c = _client()
    _signup_and_client(c, "nofile@example.com")
    r = c.post("/api/kyd/documents", data={}, content_type="multipart/form-data")
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #
def test_status_for_own_document():
    c = _client()
    _signup_and_client(c, "st@example.com")
    did = _upload(c, "policy.pdf").get_json()["document"]["id"]
    r = c.get(f"/api/kyd/documents/{did}/status")
    assert r.status_code == 200
    j = r.get_json()
    assert j["ok"] and j["id"] == did and j["status"] == "uploaded"


def test_status_unknown_document_is_404():
    c = _client()
    _signup_and_client(c, "st404@example.com")
    assert c.get("/api/kyd/documents/999999/status").status_code == 404


# --------------------------------------------------------------------------- #
# Delete: removes row, file bytes, and cascades chunks
# --------------------------------------------------------------------------- #
def test_delete_removes_document_file_and_chunks():
    c = _client()
    _signup_and_client(c, "del@example.com")
    did = _upload(c, "policy.pdf", b"insurance policy text").get_json()["document"]["id"]

    # simulate an ingested chunk (vector entry) for this doc
    conn = connect()
    try:
        row = conn.execute("SELECT user_id, client_id FROM documents WHERE id=?", (did,)).fetchone()
        conn.execute(
            "INSERT INTO document_chunks (document_id,user_id,client_id,chunk_index,text,created_at) "
            "VALUES (?,?,?,?,?,datetime('now'))",
            (did, row["user_id"], row["client_id"], 0, "chunk"),
        )
        conn.commit()
    finally:
        conn.close()

    assert c.delete(f"/api/kyd/documents/{did}").status_code == 200

    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) n FROM documents WHERE id=?", (did,)).fetchone()["n"] == 0
        assert conn.execute("SELECT COUNT(*) n FROM document_files WHERE document_id=?", (did,)).fetchone()["n"] == 0
        assert conn.execute("SELECT COUNT(*) n FROM document_chunks WHERE document_id=?", (did,)).fetchone()["n"] == 0
    finally:
        conn.close()
    assert len(c.get("/api/kyd/documents").get_json()["documents"]) == 0


def test_delete_unknown_document_is_404():
    c = _client()
    _signup_and_client(c, "del404@example.com")
    assert c.delete("/api/kyd/documents/424242").status_code == 404


# --------------------------------------------------------------------------- #
# Cross-tenant isolation
# --------------------------------------------------------------------------- #
def test_cross_tenant_cannot_see_or_touch_others_documents():
    ca = _client(); cb = _client()
    _signup_and_client(ca, "a@example.com", "A Co")
    _signup_and_client(cb, "b@example.com", "B Co")     # created before A uploads (no orphan reconcile impact)

    did = _upload(ca, "policy.pdf").get_json()["document"]["id"]

    # B sees nothing and cannot read/delete A's document
    assert cb.get("/api/kyd/documents").get_json()["documents"] == []
    assert cb.get(f"/api/kyd/documents/{did}/status").status_code == 404
    assert cb.delete(f"/api/kyd/documents/{did}").status_code == 404

    # A still has it
    assert len(ca.get("/api/kyd/documents").get_json()["documents"]) == 1


# --------------------------------------------------------------------------- #
# Ingestion worker + orphan reconciler (direct calls)
# --------------------------------------------------------------------------- #
def test_worker_marks_processing_then_ready(monkeypatch):
    c = _client()
    _signup_and_client(c, "wrk@example.com")
    did = _upload(c, "claims.csv", b"policy,premium\nP1,100\n").get_json()["document"]["id"]
    assert c.get(f"/api/kyd/documents/{did}/status").get_json()["status"] == "uploaded"

    # Mock the domain gate (no network) — accept as insurance.
    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain",
                        lambda parsed: {"is_insurance_related": True, "confidence": 0.9,
                                        "detected_topics": ["claims"], "reasoning": "ok", "usedLlm": True})
    king._run_ingest(did)   # run the real worker synchronously

    j = c.get(f"/api/kyd/documents/{did}/status").get_json()
    assert j["status"] == "ready" and j["contentKind"] == "structured"


def test_reconcile_orphans_fails_interrupted_rows():
    c = _client()
    _signup_and_client(c, "orph@example.com")
    did = _upload(c, "policy.pdf").get_json()["document"]["id"]
    conn = connect()
    try:
        conn.execute("UPDATE documents SET status='processing' WHERE id=?", (did,)); conn.commit()
    finally:
        conn.close()

    fixed = king.reconcile_orphans()
    assert fixed >= 1
    assert c.get(f"/api/kyd/documents/{did}/status").get_json()["status"] == "failed"


# --------------------------------------------------------------------------- #
# Domain gate wiring (real parse of an uploaded CSV; domain check mocked)
# --------------------------------------------------------------------------- #
def test_ingest_rejects_non_insurance_and_exposes_topics(monkeypatch):
    c = _client()
    _signup_and_client(c, "rej@example.com")
    did = _upload(c, "claims.csv", b"a,b\n1,2\n").get_json()["document"]["id"]

    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain",
                        lambda parsed: {"is_insurance_related": False, "confidence": 0.1,
                                        "detected_topics": ["recipes", "cooking"],
                                        "reasoning": "Not insurance data.", "usedLlm": True})
    king._run_ingest(did)   # real worker: load -> parse -> domain gate

    j = c.get(f"/api/kyd/documents/{did}/status").get_json()
    assert j["status"] == "rejected"
    assert j["detectedTopics"] == ["recipes", "cooking"]
    assert j["domainCheckReasoning"] == "Not insurance data."
    assert j["domainCheckConfidence"] == 10.0    # 0.1 -> 0-100
    # list endpoint also surfaces the fields
    doc = c.get("/api/kyd/documents").get_json()["documents"][0]
    assert doc["detectedTopics"] == ["recipes", "cooking"] and doc["status"] == "rejected"


def test_ingest_accepts_insurance(monkeypatch):
    c = _client()
    _signup_and_client(c, "acc@example.com")
    did = _upload(c, "claims.csv", b"policy,premium\nP1,100\n").get_json()["document"]["id"]
    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain",
                        lambda parsed: {"is_insurance_related": True, "confidence": 0.95,
                                        "detected_topics": ["claims"], "reasoning": "ok", "usedLlm": True})
    king._run_ingest(did)
    assert c.get(f"/api/kyd/documents/{did}/status").get_json()["status"] == "ready"


def test_force_ingest_route_sets_override(monkeypatch):
    c = _client()
    _signup_and_client(c, "force@example.com")
    did = _upload(c, "claims.csv", b"a,b\n1,2\n").get_json()["document"]["id"]
    r = c.post(f"/api/kyd/documents/{did}/force-ingest")
    assert r.status_code == 200 and r.get_json()["domainOverride"] is True
    conn = connect()
    try:
        assert conn.execute("SELECT domain_override FROM documents WHERE id=?", (did,)).fetchone()["domain_override"] == 1
    finally:
        conn.close()


def test_force_ingest_unknown_is_404():
    c = _client()
    _signup_and_client(c, "force404@example.com")
    assert c.post("/api/kyd/documents/999999/force-ingest").status_code == 404


def test_worker_force_skips_domain_check(monkeypatch):
    c = _client()
    _signup_and_client(c, "fw@example.com")
    did = _upload(c, "claims.csv", b"a,b\n1,2\n").get_json()["document"]["id"]

    def _boom(parsed):
        raise AssertionError("domain check must not run on force-ingest")
    monkeypatch.setattr(king.kyd_domain_service, "is_insurance_domain", _boom)

    king._run_ingest(did, force=True)   # must not call the domain check
    assert c.get(f"/api/kyd/documents/{did}/status").get_json()["status"] == "ready"
