"""Unit tests for the call_ai wrapper — usage extraction + failure logging.

log_ai_call is monkeypatched to a recorder so no DB is touched; call_with_fallback
is exercised for real (it just runs the provided `run`).
"""
import types

import pytest

from app.services import ai_client_service as cs


def _recorder(monkeypatch):
    calls = []
    monkeypatch.setattr(cs, "log_ai_call", lambda *a, **k: calls.append(a))
    return calls


def _msg(inp, out, model="claude-test"):
    return types.SimpleNamespace(usage=types.SimpleNamespace(input_tokens=inp, output_tokens=out),
                                 model=model, stop_reason="end_turn")


def test_success_logs_usage_and_model(monkeypatch):
    calls = _recorder(monkeypatch)
    resp = cs.call_ai("ETL Code Generator", lambda extra: _msg(120, 30), [{}])
    assert resp.usage.input_tokens == 120
    a = calls[0]                                  # (feature, model, in, out, dur, status)
    assert a[0] == "ETL Code Generator"
    assert a[1] == "claude-test"
    assert a[2] == 120 and a[3] == 30
    assert isinstance(a[4], int) and a[4] >= 0    # duration_ms
    assert a[5] == "success"


def test_failure_logs_failed_and_reraises(monkeypatch):
    calls = _recorder(monkeypatch)
    def run(extra): raise RuntimeError("gateway boom")
    with pytest.raises(RuntimeError):
        cs.call_ai("AI Mapping Generator", run, [{}])
    a = calls[0]
    assert a[0] == "AI Mapping Generator"
    assert a[2] == 0 and a[3] == 0                # no tokens on failure
    assert a[5] == "failed"


def test_fallback_then_success_is_logged_once(monkeypatch):
    calls = _recorder(monkeypatch)
    state = {"n": 0}
    def run(extra):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("first attempt rejected")
        return _msg(5, 7)
    resp = cs.call_ai("Source Metadata Extraction", run, [{"a": 1}, {}])
    assert resp.usage.output_tokens == 7
    assert len(calls) == 1                         # logged once, for the successful call
    assert calls[0][5] == "success" and calls[0][2] == 5


def test_missing_usage_defaults_to_zero(monkeypatch):
    calls = _recorder(monkeypatch)
    resp = cs.call_ai("Target System - Add Column (AI)",
                      lambda extra: types.SimpleNamespace(model="m"), [{}])
    a = calls[0]
    assert a[2] == 0 and a[3] == 0 and a[5] == "success"
