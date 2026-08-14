"""SEC-001 regression: cross-tenant isolation of the AI usage log over HTTP.

Replicates the Testing Agent matrix row T8 — a destructive delete issued by one
tenant must affect ONLY that tenant's rows, never another tenant's. Before the
fix, DELETE /api/ai-usage/logs ran an unconditional `DELETE FROM ai_usage_log`
(no owner scope, no role check), so any authenticated account could wipe every
tenant's usage/audit log.

The app DB is isolated by conftest; here we additionally isolate the usage DB
(usage_db_path) to a temp file so these tests never touch server/aims_usage.db.
No Claude gateway or SQL Server is required — the usage log is local SQLite and
rows are seeded via the real insert path.
"""
import pytest

from app import create_app
from app.services import ai_usage_logger as lg


class _SyncThread:
    """Drop-in for threading.Thread that runs the target immediately on start()."""
    def __init__(self, target=None, args=(), daemon=None): self._t, self._a = target, args
    def start(self): self._t(*self._a)


@pytest.fixture
def usage_db(tmp_path, monkeypatch):
    """Point the usage logger at a fresh temp SQLite file and create the table."""
    db = tmp_path / "usage_iso.db"
    monkeypatch.setattr(lg, "usage_db_path", lambda: str(db))
    lg.ensure_usage_table()
    return lg


def _seed(uid, cid, n, feature="Seeded"):
    """Insert n usage rows owned by (uid, cid), synchronously (no thread)."""
    for i in range(n):
        lg._insert({
            "call_timestamp": "2026-08-14T00:00:%02d+00:00" % i, "feature_name": feature,
            "model": "m", "input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
            "duration_ms": 1, "status": "success", "error_message": None,
            "user_id": uid, "client_id": cid,
        })


def _count(uid, cid):
    conn = lg._connect()
    try:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM ai_usage_log WHERE user_id=? AND client_id=?",
            (uid, cid),
        ).fetchone()["c"]
    finally:
        conn.close()


def _signup_with_client(app, email, client_name):
    """New session: signup + create a client. Returns (test_client, uid, cid)."""
    c = app.test_client()
    c.post("/api/auth/signup", json={"email": email, "password": "password123", "name": "U"})
    c.post("/api/clients", json={"name": client_name, "industry": "", "config": {}})
    me = c.get("/api/auth/me").get_json()
    return c, me["user"]["id"], me["activeClientId"]


# --------------------------------------------------------------------------- #
# T8 — cross-tenant destructive delete
# --------------------------------------------------------------------------- #

def test_tenant_cannot_clear_another_tenants_usage_log(usage_db):
    """T8: Tenant B's DELETE /api/ai-usage/logs must delete only B's rows;
    Tenant A's row count must be unchanged."""
    app = create_app()

    ca, uid_a, cid_a = _signup_with_client(app, "sec001_a@example.com", "A-Client")
    cb, uid_b, cid_b = _signup_with_client(app, "sec001_b@example.com", "B-Client")

    _seed(uid_a, cid_a, 3)          # Tenant A: 3 rows
    _seed(uid_b, cid_b, 2)          # Tenant B: 2 rows
    assert _count(uid_a, cid_a) == 3
    assert _count(uid_b, cid_b) == 2

    # B performs the destructive delete.
    r = cb.delete("/api/ai-usage/logs")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["deleted"] == 2                 # exactly B's rows — NOT the whole table

    # The regression guard: A's rows are completely intact; only B's are gone.
    assert _count(uid_a, cid_a) == 3
    assert _count(uid_b, cid_b) == 0


def test_reverse_direction_a_cannot_clear_b(usage_db):
    """Symmetric to T8 with roles reversed (A deletes → only A's rows go)."""
    app = create_app()
    ca, uid_a, cid_a = _signup_with_client(app, "sec001_ra@example.com", "RA-Client")
    cb, uid_b, cid_b = _signup_with_client(app, "sec001_rb@example.com", "RB-Client")
    _seed(uid_a, cid_a, 4)
    _seed(uid_b, cid_b, 5)

    r = ca.delete("/api/ai-usage/logs")
    assert r.status_code == 200 and r.get_json()["deleted"] == 4
    assert _count(uid_a, cid_a) == 0
    assert _count(uid_b, cid_b) == 5            # B untouched


# --------------------------------------------------------------------------- #
# Guards — the destructive route must be gated before it can run
# --------------------------------------------------------------------------- #

def test_clear_logs_requires_authentication(usage_db):
    app = create_app()
    c = app.test_client()
    _seed(1, 1, 2)
    assert c.delete("/api/ai-usage/logs").status_code == 401   # never reaches the delete
    assert _count(1, 1) == 2                                    # nothing deleted


def test_clear_logs_requires_active_client(usage_db):
    app = create_app()
    c = app.test_client()
    c.post("/api/auth/signup", json={"email": "sec001_noc@example.com", "password": "password123", "name": "N"})
    assert c.delete("/api/ai-usage/logs").status_code == 409    # logged in, no active client


# --------------------------------------------------------------------------- #
# Write path — the owner is derived from the session, never the client
# --------------------------------------------------------------------------- #

def test_log_ai_call_stamps_session_owner(usage_db, monkeypatch):
    monkeypatch.setattr(lg.threading, "Thread", _SyncThread)    # inline the insert
    app = create_app()
    with app.test_request_context("/"):
        from flask import session
        session["uid"], session["cid"] = 4242, 77
        lg.log_ai_call("ETL Code Generator", "m", 5, 3, 10, "success")
    assert _count(4242, 77) == 1


def test_log_ai_call_outside_request_context_has_null_owner(usage_db, monkeypatch):
    # Logging must still succeed with a NULL owner when there is no request/session
    # context (preserves the "logging never breaks the AI feature" guarantee).
    monkeypatch.setattr(lg.threading, "Thread", _SyncThread)
    lg.log_ai_call("Background", "m", 1, 1, 1, "success")
    conn = lg._connect()
    try:
        row = conn.execute("SELECT user_id, client_id FROM ai_usage_log").fetchone()
    finally:
        conn.close()
    assert row["user_id"] is None and row["client_id"] is None


# --------------------------------------------------------------------------- #
# T7 non-regression — client/list read scoping still isolates after the schema change
# --------------------------------------------------------------------------- #

def test_client_list_read_scoping_not_regressed(usage_db):
    """SEC-002 (T7) sanity: the ai_usage_log schema change must not affect the
    existing per-user read scoping on /api/clients."""
    app = create_app()
    ca, _, _ = _signup_with_client(app, "sec001_t7a@example.com", "T7-A")
    cb, _, _ = _signup_with_client(app, "sec001_t7b@example.com", "T7-B")

    names_a = [c["name"] for c in ca.get("/api/clients").get_json()["clients"]]
    names_b = [c["name"] for c in cb.get("/api/clients").get_json()["clients"]]
    assert names_a == ["T7-A"]      # A sees only its own client
    assert names_b == ["T7-B"]      # B sees only its own client


# --------------------------------------------------------------------------- #
# SEC-002 / T7 — the usage-report READ endpoints are tenant-scoped
# --------------------------------------------------------------------------- #

def test_usage_reads_are_tenant_scoped(usage_db):
    """SEC-002 (T7): GET /api/ai-usage/logs and /summary must return only the
    caller's rows — never another tenant's activity metadata."""
    app = create_app()
    ca, uid_a, cid_a = _signup_with_client(app, "sec002_a@example.com", "A-Client")
    cb, uid_b, cid_b = _signup_with_client(app, "sec002_b@example.com", "B-Client")
    _seed(uid_a, cid_a, 3, feature="A-DISTINCTIVE")
    _seed(uid_b, cid_b, 2, feature="B-DISTINCTIVE")

    # B's /logs shows only B's rows — none of A's distinctive rows leak.
    logs_b = cb.get("/api/ai-usage/logs?limit=1000").get_json()
    assert logs_b["ok"] and logs_b["total"] == 2
    assert {r["feature_name"] for r in logs_b["rows"]} == {"B-DISTINCTIVE"}

    # B's /summary totals cover only B.
    sum_b = cb.get("/api/ai-usage/summary").get_json()
    assert sum_b["overall"]["total_calls"] == 2
    assert {r["feature_name"] for r in sum_b["by_feature"]} == {"B-DISTINCTIVE"}

    # Reverse direction: A sees only A's rows.
    logs_a = ca.get("/api/ai-usage/logs?limit=1000").get_json()
    assert logs_a["total"] == 3
    assert {r["feature_name"] for r in logs_a["rows"]} == {"A-DISTINCTIVE"}


def test_usage_reads_require_auth_and_active_client(usage_db):
    app = create_app()
    c = app.test_client()
    _seed(1, 1, 2, feature="SEEDED")
    assert c.get("/api/ai-usage/logs").status_code == 401       # unauth
    assert c.get("/api/ai-usage/summary").status_code == 401
    c.post("/api/auth/signup", json={"email": "sec002_noc@example.com", "password": "password123", "name": "N"})
    assert c.get("/api/ai-usage/logs").status_code == 409       # no active client
    assert c.get("/api/ai-usage/summary").status_code == 409
