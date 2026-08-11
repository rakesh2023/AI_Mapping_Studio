"""Unit tests for db_service pure helpers and pyodbc-mocked flows."""
from app.services import db_service
from app.services.db_service import build_connection_string, _quote


def test_build_connection_string_defaults_driver():
    s = build_connection_string({"server": "S", "database": "DB"})
    assert "DRIVER={ODBC Driver 17 for SQL Server}" in s
    assert "SERVER=S" in s and "DATABASE=DB" in s
    # modern driver -> TrustServerCertificate added
    assert "TrustServerCertificate=yes" in s
    assert s.endswith(";")


def test_build_connection_string_trusted_auth():
    s = build_connection_string({"server": "S", "database": "DB", "trusted": True})
    assert "Trusted_Connection=yes" in s
    assert "UID=" not in s and "PWD=" not in s


def test_build_connection_string_sql_auth():
    s = build_connection_string({"server": "S", "database": "DB",
                                 "username": "sa", "password": "pw"})
    assert "UID=sa" in s and "PWD=pw" in s
    assert "Trusted_Connection" not in s


def test_build_connection_string_legacy_driver_no_trustcert():
    # the legacy "SQL Server" driver rejects TrustServerCertificate
    s = build_connection_string({"driver": "SQL Server", "server": "S", "database": "DB"})
    assert "TrustServerCertificate" not in s


def test_quote_escapes_brackets():
    assert _quote("dbo") == "[dbo]"
    assert _quote("a]b") == "[a]]b]"


def test_list_drivers_when_pyodbc_present(monkeypatch):
    class FakePyodbc:
        @staticmethod
        def drivers():
            return ["ODBC Driver 17 for SQL Server", "SQL Server"]
    monkeypatch.setattr(db_service, "pyodbc", FakePyodbc)
    out = db_service.list_drivers()
    assert out["ok"] is True
    assert "SQL Server" in out["drivers"]


def test_list_drivers_when_pyodbc_missing(monkeypatch):
    monkeypatch.setattr(db_service, "pyodbc", None)
    out = db_service.list_drivers()
    assert out["ok"] is False
    assert out["drivers"] == []


def test_test_connection_success_with_mock(monkeypatch):
    class FakeCursor:
        def execute(self, *a): pass
        def fetchone(self): return ["Microsoft SQL Server 2019\nline2"]
    class FakeConn:
        def cursor(self): return FakeCursor()
        def close(self): pass
    monkeypatch.setattr(db_service, "open_connection", lambda cfg: FakeConn())
    payload, status = db_service.test_connection({})
    assert status == 200 and payload["ok"] is True
    assert payload["version"] == "Microsoft SQL Server 2019"   # first line only


def test_test_connection_failure_returns_400(monkeypatch):
    def boom(cfg): raise RuntimeError("login failed")
    monkeypatch.setattr(db_service, "open_connection", boom)
    payload, status = db_service.test_connection({})
    assert status == 400 and payload["ok"] is False
    assert "login failed" in payload["error"]


def test_profile_table_requires_table():
    payload, status = db_service.profile_table({"schema": "dbo"})
    assert status == 400 and payload["ok"] is False
