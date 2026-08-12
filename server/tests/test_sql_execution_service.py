"""Unit tests for sql_execution_service with a fake pyodbc."""
from app.services import sql_execution_service as ex

CFG = {"server": "S", "database": "DB", "trusted": True}


class _FakeCursor:
    def __init__(self, fail_on=None, err_msg="[SQL Server]There is already an object named 'x' (2714)"):
        self.executed = []
        self._fail_on = fail_on
        self._err_msg = err_msg
    def execute(self, sql):
        self.executed.append(sql)
        if self._fail_on is not None and sql == self._fail_on:
            raise Exception("HY000", self._err_msg)
    def nextset(self): return False
    def fetchall(self): return [(1,)]


class _FakeConn:
    def __init__(self, cursor): self._c = cursor; self.committed = False; self.rolled_back = False
    def cursor(self): return self._c
    def commit(self): self.committed = True
    def rollback(self): self.rolled_back = True
    def close(self): pass


def _install(monkeypatch, cursor):
    conn = _FakeConn(cursor)
    fake_pyodbc = type("P", (), {"connect": staticmethod(lambda *a, **k: conn)})
    monkeypatch.setattr(ex, "pyodbc", fake_pyodbc)
    monkeypatch.setattr(ex, "build_connection_string", lambda cfg: "CONNSTR")
    return conn


def test_empty_batches():
    r = ex.execute_batches(CFG, [])
    assert r["ok"] is False and r["error"]["batchIndex"] == -1


def test_all_batches_commit(monkeypatch):
    cur = _FakeCursor()
    conn = _install(monkeypatch, cur)
    r = ex.execute_batches(CFG, ["A", "B", "C"])
    assert r["ok"] is True and r["executed"] == 3
    assert conn.committed is True and conn.rolled_back is False
    assert cur.executed == ["A", "B", "C"]


def test_failure_rolls_back_whole_script(monkeypatch):
    cur = _FakeCursor(fail_on="B")
    conn = _install(monkeypatch, cur)
    r = ex.execute_batches(CFG, ["A", "B", "C"])
    assert r["ok"] is False
    assert r["error"]["batchIndex"] == 1 and r["error"]["batchText"] == "B"
    assert r["error"]["number"] == 2714          # parsed from the error message
    assert conn.committed is False and conn.rolled_back is True
    assert cur.executed == ["A", "B"]            # stopped at the failing batch


def test_dry_run_does_not_execute_script(monkeypatch):
    cur = _FakeCursor()
    conn = _install(monkeypatch, cur)
    r = ex.execute_batches(CFG, ["CREATE TABLE t (id int)"], dry_run=True)
    assert r["ok"] is True and r.get("dryRun") is True
    assert cur.executed == ["SELECT 1"]          # only the connectivity probe
    assert conn.committed is False


def test_pyodbc_missing(monkeypatch):
    monkeypatch.setattr(ex, "pyodbc", None)
    r = ex.execute_batches(CFG, ["A"])
    assert r["ok"] is False and "pyodbc" in r["error"]["message"]
