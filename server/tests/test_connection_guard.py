"""SEC-004 regression: normalize connection-error surface + rate-limit attempts.

Matrix row T10 (SSRF/port-probe): a failed DB/deploy connection attempt must not
reveal whether a host:port is open vs closed (identical generic error, no
number/host/port/driver text), and repeated attempts are throttled per user.
Legitimate connections must still succeed. No real ODBC/network is used — pyodbc
is stubbed.
"""
import pytest

from app import create_app
from app.services import db_service, sql_execution_service
from app.services import connection_guard as cg


class _RaisingPyodbc:
    """Stub whose .connect always raises the given exception (simulates a failed attempt)."""
    def __init__(self, exc): self._exc = exc
    def connect(self, *a, **k): raise self._exc
    def drivers(self): return []


@pytest.fixture(autouse=True)
def _fresh_rate(monkeypatch):
    """Reset the process-global attempt counter so tests don't leak into each other."""
    monkeypatch.setattr(cg, "_ATTEMPTS", {})


# --------------------------------------------------------------------------- #
# Error-surface normalization — open vs closed are indistinguishable
# --------------------------------------------------------------------------- #

def test_connect_failure_is_generic_regardless_of_cause(monkeypatch):
    # "connection refused" (closed port) and "login failed" (open port, auth) must
    # produce the SAME generic error — no signal to tell open from closed.
    monkeypatch.setattr(db_service, "pyodbc",
                        _RaisingPyodbc(Exception("[08001] TCP Provider: No connection could be made "
                                                 "because the target machine actively refused it (10061)")))
    p_closed, s_closed = db_service.test_connection({"server": "10.0.0.5", "database": "X"})

    monkeypatch.setattr(db_service, "pyodbc",
                        _RaisingPyodbc(Exception("[28000] Login failed for user 'sa'. (18456)")))
    p_open, s_open = db_service.test_connection({"server": "10.0.0.9", "database": "Y"})

    assert s_closed == s_open == 400
    assert p_closed["ok"] is False and p_open["ok"] is False
    assert p_closed["error"] == p_open["error"] == cg.GENERIC_CONNECTION_ERROR
    # none of the distinguishing detail leaks
    for leaked in ("10061", "18456", "refused", "Login failed", "10.0.0.5", "10.0.0.9"):
        assert leaked not in p_closed["error"] and leaked not in p_open["error"]


def test_metadata_connect_failure_is_generic(monkeypatch):
    monkeypatch.setattr(db_service, "pyodbc", _RaisingPyodbc(Exception("timeout expired (10060)")))
    payload, status = db_service.get_metadata({"server": "10.0.0.1", "database": "X"})
    assert status == 400 and payload["error"] == cg.GENERIC_CONNECTION_ERROR


def test_deploy_connect_failure_is_generic(monkeypatch):
    monkeypatch.setattr(sql_execution_service, "pyodbc",
                        _RaisingPyodbc(Exception("[08001] refused (10061)")))
    res = sql_execution_service.execute_batches({"server": "10.0.0.1", "database": "X"},
                                                ["SELECT 1"], dry_run=True)
    assert res["ok"] is False
    assert res["error"]["message"] == cg.GENERIC_CONNECTION_ERROR
    assert res["error"]["number"] is None                 # SQL error number withheld
    assert "10061" not in res["error"]["message"]


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #

def test_rate_limit_blocks_after_max(monkeypatch):
    monkeypatch.setattr(cg, "_MAX_ATTEMPTS", 3)
    ident = "user-42"
    assert [cg.check_rate(ident)[0] for _ in range(3)] == [True, True, True]
    allowed, retry = cg.check_rate(ident)
    assert allowed is False and retry >= 1


def test_rate_limit_is_per_identity(monkeypatch):
    monkeypatch.setattr(cg, "_MAX_ATTEMPTS", 1)
    assert cg.check_rate("A")[0] is True
    assert cg.check_rate("A")[0] is False       # A exhausted
    assert cg.check_rate("B")[0] is True        # B unaffected


# --------------------------------------------------------------------------- #
# HTTP surface — auth required, throttled, and legit success still works
# --------------------------------------------------------------------------- #

def test_db_test_requires_auth():
    c = create_app().test_client()
    assert c.post("/api/db/test", json={"server": "s", "database": "d"}).status_code == 401


def test_db_endpoint_throttled_over_http(monkeypatch):
    monkeypatch.setattr(cg, "_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(db_service, "pyodbc", _RaisingPyodbc(Exception("refused (10061)")))
    c = create_app().test_client()
    c.post("/api/auth/signup", json={"email": "sec004_http@example.com", "password": "password123", "name": "S"})

    r1 = c.post("/api/db/test", json={"server": "10.0.0.1", "database": "X"})
    r2 = c.post("/api/db/test", json={"server": "10.0.0.2", "database": "X"})
    assert r1.status_code == 400 and r1.get_json()["error"] == cg.GENERIC_CONNECTION_ERROR
    assert r2.status_code == 400
    # third attempt within the window is throttled
    r3 = c.post("/api/db/test", json={"server": "10.0.0.3", "database": "X"})
    assert r3.status_code == 429
    assert r3.headers.get("Retry-After")


def test_successful_connection_still_works(monkeypatch):
    # Legitimate connection must succeed unchanged (the mitigation only affects failures).
    class _Cur:
        def execute(self, *a): pass
        def fetchone(self): return ["Microsoft SQL Server 2019\nbuild"]
    class _Conn:
        def cursor(self): return _Cur()
        def close(self): pass
    monkeypatch.setattr(db_service, "open_connection", lambda cfg: _Conn())
    payload, status = db_service.test_connection({"server": "db.internal", "database": "X"})
    assert status == 200 and payload["ok"] is True
    assert payload["version"] == "Microsoft SQL Server 2019"
