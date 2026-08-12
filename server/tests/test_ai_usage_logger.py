"""Unit tests for ai_usage_logger against a temp SQLite file.

The real log_ai_call inserts on a background daemon thread; here we monkeypatch
threading.Thread so the insert runs synchronously and the row is queryable
immediately.
"""
import pytest

from app.services import ai_usage_logger as lg


class _SyncThread:
    """Drop-in for threading.Thread that runs the target immediately on start()."""
    def __init__(self, target=None, args=(), daemon=None): self._t, self._a = target, args
    def start(self): self._t(*self._a)


@pytest.fixture
def logger(tmp_path, monkeypatch):
    db = tmp_path / "usage.db"
    monkeypatch.setattr(lg, "usage_db_path", lambda: str(db))
    monkeypatch.setattr(lg.threading, "Thread", _SyncThread)   # inline inserts
    lg.ensure_usage_table()
    return lg


def test_log_success_row_and_total_tokens(logger):
    logger.log_ai_call("ETL Code Generator", "claude-x", 100, 40, 1234, "success")
    out = logger.query_logs()
    assert out["ok"] and out["total"] == 1
    row = out["rows"][0]
    assert row["feature_name"] == "ETL Code Generator"
    assert row["input_tokens"] == 100 and row["output_tokens"] == 40
    assert row["total_tokens"] == 140          # computed at insert
    assert row["duration_ms"] == 1234
    assert row["status"] == "success" and row["error_message"] is None


def test_log_failed_row_keeps_error(logger):
    logger.log_ai_call("AI Mapping Generator", None, 0, 0, 12, "failed", "boom happened")
    out = logger.query_logs(feature="AI Mapping Generator")
    assert out["total"] == 1
    row = out["rows"][0]
    assert row["status"] == "failed"
    assert row["total_tokens"] == 0
    assert "boom" in (row["error_message"] or "")


def test_summary_overall_and_by_feature(logger):
    logger.log_ai_call("ETL Code Generator", "m", 100, 50, 10, "success")
    logger.log_ai_call("ETL Code Generator", "m", 200, 60, 10, "success")
    logger.log_ai_call("AI Mapping Generator", "m", 10, 5, 10, "failed", "x")
    s = logger.summary()
    o = s["overall"]
    assert o["total_calls"] == 3
    assert o["total_input_tokens"] == 310
    assert o["total_output_tokens"] == 115
    assert o["total_tokens"] == 425
    assert o["failed_calls"] == 1
    feats = {r["feature_name"]: r for r in s["by_feature"]}
    assert feats["ETL Code Generator"]["total_calls"] == 2
    assert feats["ETL Code Generator"]["total_tokens"] == 410


def test_feature_filter_isolates_rows(logger):
    logger.log_ai_call("A", "m", 1, 1, 1, "success")
    logger.log_ai_call("B", "m", 2, 2, 1, "success")
    assert logger.query_logs(feature="A")["total"] == 1
    assert logger.query_logs()["total"] == 2


def test_pagination(logger):
    for i in range(5):
        logger.log_ai_call("A", "m", i, i, 1, "success")
    page = logger.query_logs(limit=2, offset=0)
    assert page["total"] == 5 and len(page["rows"]) == 2
    # newest first (id DESC): first page starts at the last inserted
    assert page["rows"][0]["id"] > page["rows"][1]["id"]


def test_clear_logs_removes_all(logger):
    logger.log_ai_call("A", "m", 1, 1, 1, "success")
    logger.log_ai_call("B", "m", 2, 2, 1, "success")
    assert logger.query_logs()["total"] == 2
    res = logger.clear_logs()
    assert res["ok"] is True and res["deleted"] == 2
    assert logger.query_logs()["total"] == 0
    assert logger.summary()["overall"]["total_calls"] == 0


def test_clear_logs_on_empty_is_safe(logger):
    res = logger.clear_logs()
    assert res["ok"] is True and res["deleted"] == 0


def test_query_before_table_exists_is_safe(tmp_path, monkeypatch):
    # No ensure_usage_table() called -> query returns ok:False, never raises.
    monkeypatch.setattr(lg, "usage_db_path", lambda: str(tmp_path / "missing.db"))
    out = lg.query_logs()
    assert out["ok"] is False and out["rows"] == []
