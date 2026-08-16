"""Chat: sessions + the send-message orchestration (condense, route, retrieve,
fallback, answer, persist). Sub-services are mocked (no network)."""
import pytest

from app.db.app_db import connect
from app.services import kyd_chat_service as CS


@pytest.fixture()
def fix(tmp_path, monkeypatch):
    monkeypatch.setenv("AIMS_DISABLE_DOTENV", "1")
    monkeypatch.setenv("AIMS_APP_DB", str(tmp_path / "chat_app.db"))
    from app.db.app_db import ensure_app_tables
    ensure_app_tables()
    conn = connect()
    try:
        conn.execute("INSERT INTO users(email,password_hash,created_at) VALUES('c@x.com','h','t')")
        uid = conn.execute("SELECT id FROM users").fetchone()["id"]
        conn.execute("INSERT INTO clients(user_id,name,created_at) VALUES(?,?,?)", (uid, "C", "t"))
        cid = conn.execute("SELECT id FROM clients").fetchone()["id"]
        conn.commit()
    finally:
        conn.close()

    def ready_doc(filename, kind, structured=False):
        c = connect()
        try:
            cur = c.execute("INSERT INTO documents(user_id,client_id,filename,file_ext,status,content_kind,created_at) "
                            "VALUES(?,?,?,?, 'ready', ?, 't')",
                            (uid, cid, filename, filename.rsplit(".", 1)[-1], kind))
            did = cur.lastrowid
            if structured:
                c.execute("INSERT INTO structured_tables(document_id,user_id,client_id,logical_name,"
                          "physical_table,columns_json,row_count,created_at) VALUES(?,?,?,?,?,?,?,'t')",
                          (did, uid, cid, "claims", f"kyd_d{did}_claims", "[]", 2))
            c.commit()
        finally:
            c.close()
        return did, filename
    return {"uid": uid, "cid": cid, "ready_doc": ready_doc}


# ---- Sessions ---- #
def test_create_and_list_and_history(fix):
    uid, cid = fix["uid"], fix["cid"]
    sess = CS.create_session(uid, cid)[0]["session"]
    assert sess["id"] and sess["title"] is None
    assert any(s["id"] == sess["id"] for s in CS.list_sessions(uid, cid)[0]["sessions"])
    payload, status = CS.get_messages(uid, cid, sess["id"])
    assert status == 200 and payload["messages"] == []


def test_history_and_get_messages_ownership_404(fix):
    uid, cid = fix["uid"], fix["cid"]
    sess = CS.create_session(uid, cid)[0]["session"]["id"]
    assert CS.get_messages(uid, cid, 999999)[1] == 404
    assert CS.get_messages(uid + 777, cid, sess)[1] == 404   # other user


def test_send_message_ownership_404(fix):
    assert CS.send_message(fix["uid"], fix["cid"], 999999, "hi")[1] == 404


# ---- Send: vector route ---- #
def test_send_vector_route(fix, monkeypatch):
    uid, cid = fix["uid"], fix["cid"]
    did, fname = fix["ready_doc"]("policy.pdf", "unstructured")
    sess = CS.create_session(uid, cid)[0]["session"]["id"]

    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: {"route": "vector_search", "target_sources": [fname], "reasoning": "r"})
    monkeypatch.setattr(CS.kyd_vector_store, "search",
                        lambda u, c, q, doc_ids=None, k=5: [{"chunkId": 7, "documentId": did,
                        "text": "Collision coverage is included.", "page": 1, "section": None, "score": 0.9}])
    monkeypatch.setattr(CS.kyd_rag_service, "answer",
                        lambda q, ctx: {"answer": "Yes, collision is covered [S1].",
                                        "usage": {"input_tokens": 1, "output_tokens": 1}, "grounded": True})

    payload, status = CS.send_message(uid, cid, sess, "is collision covered?")
    assert status == 200 and payload["route"] == "vector_search"
    assert "collision" in payload["answer"].lower()
    assert payload["citations"][0]["label"] == "S1" and payload["citations"][0]["documentId"] == did
    msgs = CS.get_messages(uid, cid, sess)[0]["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["route"] == "vector_search"


# ---- Send: fallback when no context ---- #
def test_send_fallback_when_no_context(fix, monkeypatch):
    uid, cid = fix["uid"], fix["cid"]
    fix["ready_doc"]("policy.pdf", "unstructured")
    sess = CS.create_session(uid, cid)[0]["session"]["id"]
    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: {"route": "vector_search", "target_sources": [], "reasoning": "r"})
    monkeypatch.setattr(CS.kyd_vector_store, "search", lambda u, c, q, doc_ids=None, k=5: [])

    payload, status = CS.send_message(uid, cid, sess, "what about mars colonization?")
    assert status == 200 and payload["answer"] == CS.kyd_rag_service.FALLBACK_MESSAGE
    assert payload["citations"] == []
    assert [m["role"] for m in CS.get_messages(uid, cid, sess)[0]["messages"]] == ["user", "assistant"]


# ---- Send: sql route ---- #
def test_send_sql_route(fix, monkeypatch):
    uid, cid = fix["uid"], fix["cid"]
    did, fname = fix["ready_doc"]("claims.csv", "structured", structured=True)
    sess = CS.create_session(uid, cid)[0]["session"]["id"]

    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: {"route": "sql_query", "target_sources": [fname], "reasoning": "r"})
    monkeypatch.setattr(CS.kyd_sql_service, "run_query",
                        lambda u, c, q, st_id: {"ok": True, "table": "claims",
                        "query": "SELECT SUM(amount) AS total FROM claims LIMIT 201",
                        "columns": ["total"], "rows": [[675.0]], "truncated": False})
    monkeypatch.setattr(CS.kyd_rag_service, "answer",
                        lambda q, ctx: {"answer": "The total is 675 [S1].",
                                        "usage": None, "grounded": True})

    payload, status = CS.send_message(uid, cid, sess, "total claim amount?")
    assert status == 200 and payload["route"] == "sql_query"
    assert "675" in payload["answer"]
    assert payload["citations"][0]["type"] == "structured"


# ---- Condense uses history on the 2nd turn ---- #
def test_condense_used_with_history(fix, monkeypatch):
    uid, cid = fix["uid"], fix["cid"]
    fix["ready_doc"]("policy.pdf", "unstructured")
    sess = CS.create_session(uid, cid)[0]["session"]["id"]
    captured = {}
    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: (captured.__setitem__("q", q) or
                                      {"route": "vector_search", "target_sources": [], "reasoning": ""}))
    monkeypatch.setattr(CS.kyd_vector_store, "search", lambda u, c, q, doc_ids=None, k=5: [])

    CS.send_message(uid, cid, sess, "does my policy cover flooding?")   # 1st turn -> history
    monkeypatch.setattr(CS, "_condense", lambda hist, q: "STANDALONE: does the policy cover flooding?")
    payload, _ = CS.send_message(uid, cid, sess, "what about that?")    # 2nd turn -> condense
    assert payload["standaloneQuestion"] == "STANDALONE: does the policy cover flooding?"
    assert captured["q"] == "STANDALONE: does the policy cover flooding?"


# ---- Full-document mode reads the whole file, skips the router ---- #
def test_send_full_document_mode(fix, monkeypatch):
    uid, cid = fix["uid"], fix["cid"]
    did, fname = fix["ready_doc"]("policy.pdf", "unstructured")
    # give the document some chunks (what full mode concatenates)
    conn = connect()
    try:
        for i, t in enumerate(["Page one: coverage terms.", "Page two: exclusions.", "Page three: premiums."]):
            conn.execute("INSERT INTO document_chunks(document_id,user_id,client_id,chunk_index,text,created_at) "
                         "VALUES(?,?,?,?,?, 't')", (did, uid, cid, i, t))
        conn.commit()
    finally:
        conn.close()
    sess = CS.create_session(uid, cid)[0]["session"]["id"]

    captured = {}
    # In full mode the router must NOT be consulted.
    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: (_ for _ in ()).throw(AssertionError("router must not run in full mode")))
    monkeypatch.setattr(CS.kyd_rag_service, "answer",
                        lambda q, ctx: (captured.__setitem__("ctx", ctx) or
                                        {"answer": "Full-file answer.", "usage": None, "grounded": True}))

    payload, status = CS.send_message(uid, cid, sess, "summarize the document", mode="full")
    assert status == 200 and payload["route"] == "full_document" and payload["mode"] == "full"
    # whole document (all 3 chunks) was passed as one labeled source
    assert captured["ctx"] and "Document: policy.pdf" in captured["ctx"][0]["text"]
    assert "exclusions" in captured["ctx"][0]["text"] and "premiums" in captured["ctx"][0]["text"]
    assert payload["citations"][0]["type"] == "document" and payload["citations"][0]["documentId"] == did


# ---- HTTP smoke (routes + scoping) ---- #
def test_http_session_and_send(fix, monkeypatch):
    from app import create_app
    c = create_app().test_client()
    c.post("/api/auth/signup", json={"email": "http@example.com", "password": "password123", "name": "H"})
    c.post("/api/clients", json={"name": "HCo", "industry": "Insurance", "config": {}})

    r = c.post("/api/kyd/chat/sessions", json={})
    assert r.status_code == 201
    sid = r.get_json()["session"]["id"]
    assert c.get("/api/kyd/chat/sessions").status_code == 200
    assert c.get(f"/api/kyd/chat/sessions/{sid}/messages").get_json()["messages"] == []

    monkeypatch.setattr(CS.kyd_query_router, "route_query",
                        lambda q, s: {"route": "vector_search", "target_sources": [], "reasoning": "r"})
    monkeypatch.setattr(CS.kyd_vector_store, "search", lambda u, c2, q, doc_ids=None, k=5: [])
    r = c.post(f"/api/kyd/chat/sessions/{sid}/messages", json={"message": "hello"})
    assert r.status_code == 200 and r.get_json()["answer"] == CS.kyd_rag_service.FALLBACK_MESSAGE
    assert len(c.get(f"/api/kyd/chat/sessions/{sid}/messages").get_json()["messages"]) == 2


def test_http_requires_active_client(fix):
    from app import create_app
    c = create_app().test_client()
    c.post("/api/auth/signup", json={"email": "nc2@example.com", "password": "password123", "name": "N"})
    assert c.post("/api/kyd/chat/sessions", json={}).status_code == 409   # no active client
