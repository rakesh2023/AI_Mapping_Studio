"""Unit tests for kyd_sql_service.run_query — SQL generation (mocked LLM),
validation, isolated execution, tenant scoping, and malicious-query attempts."""
import json
import types

import pytest

import app.services.kyd_sql_service as SQ


@pytest.fixture()
def kyd(tmp_path, monkeypatch):
    """Fresh app DB with a tenant chain + one loaded structured table (kyd_d*_claims)."""
    monkeypatch.setenv("AIMS_DISABLE_DOTENV", "1")
    monkeypatch.setenv("AIMS_APP_DB", str(tmp_path / "sql_app.db"))
    from app.db.app_db import ensure_app_tables, connect
    ensure_app_tables()
    conn = connect()
    try:
        conn.execute("INSERT INTO users(email,password_hash,created_at) VALUES('q@x.com','h','t')")
        uid = conn.execute("SELECT id FROM users").fetchone()["id"]
        conn.execute("INSERT INTO clients(user_id,name,created_at) VALUES(?,?,?)", (uid, "C", "t"))
        cid = conn.execute("SELECT id FROM clients").fetchone()["id"]
        cur = conn.execute("INSERT INTO documents(user_id,client_id,filename,file_ext,status,created_at) "
                           "VALUES(?,?,?,?, 'ready','t')", (uid, cid, "claims.csv", "csv"))
        did = cur.lastrowid
        phys = f"kyd_d{did}_claims"
        conn.execute(f'CREATE TABLE "{phys}" (claim_id INTEGER, amount REAL, state TEXT)')
        conn.executemany(f'INSERT INTO "{phys}" VALUES (?,?,?)',
                         [(1, 100.0, "NY"), (2, 200.0, "CA"), (3, 50.0, "NY"), (4, 300.0, "CA"), (5, 25.0, "TX")])
        cols = json.dumps([{"name": "claim_id", "type": "INTEGER"},
                           {"name": "amount", "type": "REAL"}, {"name": "state", "type": "TEXT"}])
        cur = conn.execute("INSERT INTO structured_tables(document_id,user_id,client_id,logical_name,"
                           "physical_table,columns_json,row_count,created_at) VALUES(?,?,?,?,?,?,?,'t')",
                           (did, uid, cid, "claims", phys, cols, 5))
        st_id = cur.lastrowid
        conn.commit()
        yield {"uid": uid, "cid": cid, "st_id": st_id, "connect": connect}
    finally:
        conn.close()


def _mock_sql(monkeypatch, sql_text):
    monkeypatch.setattr(SQ, "anthropic_client", lambda: object())
    msg = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=sql_text)], stop_reason="end_turn")
    monkeypatch.setattr(SQ, "call_ai", lambda feature, run, attempts: msg)


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #
def test_aggregate_query_runs(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT SUM(amount) AS total FROM claims")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "total claim amount?", kyd["st_id"])
    assert r["ok"] is True
    assert r["columns"] == ["total"] and r["rows"] == [[675.0]]
    assert "LIMIT" in r["query"]          # LIMIT enforced when missing


def test_group_by_query(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT state, COUNT(*) AS n FROM claims GROUP BY state ORDER BY state")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "claims per state", kyd["st_id"])
    assert r["ok"] is True
    assert ["CA", 2] in r["rows"] and ["NY", 2] in r["rows"] and ["TX", 1] in r["rows"]


def test_row_cap_truncates(kyd, monkeypatch):
    monkeypatch.setattr(SQ, "MAX_ROWS", 2)
    _mock_sql(monkeypatch, "SELECT * FROM claims")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "show everything", kyd["st_id"])
    assert r["ok"] is True and len(r["rows"]) == 2 and r["truncated"] is True


def test_no_query_possible(kyd, monkeypatch):
    _mock_sql(monkeypatch, "NO_QUERY_POSSIBLE")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "what is the meaning of life?", kyd["st_id"])
    assert r["ok"] is False and r.get("reason") == "no_query"


def test_strips_markdown_fences(kyd, monkeypatch):
    _mock_sql(monkeypatch, "```sql\nSELECT COUNT(*) AS c FROM claims\n```")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "how many?", kyd["st_id"])
    assert r["ok"] is True and r["rows"] == [[5]]


# --------------------------------------------------------------------------- #
# Malicious / unsafe queries
# --------------------------------------------------------------------------- #
def test_drop_is_rejected_by_validation(kyd, monkeypatch):
    _mock_sql(monkeypatch, "DROP TABLE users")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "drop it", kyd["st_id"])
    assert r["ok"] is False and "couldn't run" in r["error"]
    # the real table is untouched
    conn = kyd["connect"]()
    try:
        assert conn.execute("SELECT COUNT(*) n FROM users").fetchone()["n"] == 1
    finally:
        conn.close()


def test_stacked_statement_rejected(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT 1 FROM claims; DROP TABLE claims")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "sneaky", kyd["st_id"])
    assert r["ok"] is False


def test_cross_table_select_blocked_by_isolation(kyd, monkeypatch):
    # Passes SELECT validation, but 'users' does not exist in the isolated sandbox.
    _mock_sql(monkeypatch, "SELECT email FROM users")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "leak users", kyd["st_id"])
    assert r["ok"] is False and "couldn't run" in r["error"]


def test_subquery_to_other_table_blocked(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT amount FROM claims WHERE amount > (SELECT COUNT(*) FROM documents)")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "clever", kyd["st_id"])
    assert r["ok"] is False


# --------------------------------------------------------------------------- #
# Scoping
# --------------------------------------------------------------------------- #
def test_cross_tenant_table_not_found(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT * FROM claims")
    # A different user id must not be able to query this tenant's table.
    r = SQ.run_query(kyd["uid"] + 999, kyd["cid"], "peek", kyd["st_id"])
    assert r["ok"] is False and "not found" in r["error"].lower()


def test_unknown_table_id(kyd, monkeypatch):
    _mock_sql(monkeypatch, "SELECT * FROM claims")
    r = SQ.run_query(kyd["uid"], kyd["cid"], "peek", 987654)
    assert r["ok"] is False
