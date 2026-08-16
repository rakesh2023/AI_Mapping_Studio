"""Unit tests for mapping_service with a mocked Anthropic client."""
import json
import types

import pytest

from app.services import mapping_service as ms


class _FakeMsg:
    def __init__(self, text, refusal=False):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "refusal" if refusal else "end_turn"
        self.usage = types.SimpleNamespace(input_tokens=5, output_tokens=7)


class _FakeStream:
    def __init__(self, msg): self._msg = msg
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self._msg


def _fake_client(reply, refusal=False):
    class C:
        class messages:
            @staticmethod
            def stream(**kw):
                return _FakeStream(_FakeMsg(reply, refusal))
    return C()


def test_generate_mappings_requires_source():
    payload, status = ms.generate_mappings({"targetEntities": [{"name": "A", "fields": []}]})
    assert status == 400 and payload["ok"] is False


def test_generate_mappings_requires_targets():
    payload, status = ms.generate_mappings({"source": {"tables": [{"name": "T", "columns": []}]}})
    assert status == 400 and payload["ok"] is False


def test_generate_mappings_happy_path(monkeypatch):
    reply = json.dumps({
        "mappings": [{"targetEntity": "Account", "targetColumn": "ACCT_NO",
                      "sourceTable": "CUST", "sourceColumn": "CUST_NO", "mappingType": "Direct",
                      "transformationRule": "x", "businessRule": "y", "nullHandling": "z",
                      "confidence": 90, "explanation": "e"}],
        "joins": [{"targetEntity": "Account", "joinCondition": "FROM CUST"}],
    })
    monkeypatch.setattr(ms, "anthropic_client", lambda: _fake_client(reply))
    body = {
        "source": {"connection": "DB", "tables": [{"name": "CUST", "columns": [{"name": "CUST_NO", "dataType": "int"}]}]},
        "targetEntities": [{"name": "Account", "table": "ACCT",
                            "fields": [{"name": "ACCT_NO", "dataType": "int"}]}],
    }
    payload, status = ms.generate_mappings(body)
    assert status == 200 and payload["ok"] is True
    assert payload["returnedCount"] == 1
    assert payload["mappings"][0]["sourceColumn"] == "CUST_NO"
    assert payload["joins"][0]["joinCondition"] == "FROM CUST"
    assert payload["usage"] == {"input_tokens": 5, "output_tokens": 7}


def test_generate_mappings_fills_not_mapped_for_missing(monkeypatch):
    # model returns no mapping for the requested field -> a Not Mapped row is synthesized
    monkeypatch.setattr(ms, "anthropic_client",
                        lambda: _fake_client(json.dumps({"mappings": [], "joins": []})))
    body = {
        "source": {"tables": [{"name": "T", "columns": [{"name": "C", "dataType": "int"}]}]},
        "targetEntities": [{"name": "E", "fields": [{"name": "F", "dataType": "int"}]}],
    }
    payload, status = ms.generate_mappings(body)
    assert status == 200
    assert payload["mappings"][0]["mappingType"] == "Not Mapped"
    assert payload["returnedCount"] == 0


def test_default_system_prompt_interpolates_strategy():
    p = ms.default_mapping_system_prompt("Aggressive")
    assert "Apply the 'Aggressive' strategy" in p
    assert "JOIN CONDITIONS" in p and "ONLY a JSON object" in p


def _capturing_client(reply, sink):
    class C:
        class messages:
            @staticmethod
            def stream(**kw):
                sink["system"] = kw.get("system")
                return _FakeStream(_FakeMsg(reply))
    return C()


def test_generate_mappings_uses_custom_system_prompt(monkeypatch):
    sink = {}
    monkeypatch.setattr(ms, "anthropic_client",
                        lambda: _capturing_client(json.dumps({"mappings": [], "joins": []}), sink))
    body = {
        "source": {"tables": [{"name": "T", "columns": [{"name": "C", "dataType": "int"}]}]},
        "targetEntities": [{"name": "E", "fields": [{"name": "F", "dataType": "int"}]}],
        "systemPrompt": "CUSTOM PROMPT — map things.",
    }
    payload, status = ms.generate_mappings(body)
    assert status == 200
    assert sink["system"] == "CUSTOM PROMPT — map things."


def test_generate_mappings_defaults_system_when_no_override(monkeypatch):
    sink = {}
    monkeypatch.setattr(ms, "anthropic_client",
                        lambda: _capturing_client(json.dumps({"mappings": [], "joins": []}), sink))
    body = {
        "source": {"tables": [{"name": "T", "columns": [{"name": "C", "dataType": "int"}]}]},
        "targetEntities": [{"name": "E", "fields": [{"name": "F", "dataType": "int"}]}],
        "strategy": "Conservative",
    }
    ms.generate_mappings(body)
    assert "Apply the 'Conservative' strategy" in sink["system"]


def test_regenerate_requires_target_column():
    payload, status = ms.regenerate_mapping({"mapping": {}})
    assert status == 400 and payload["ok"] is False


def test_regenerate_happy_path(monkeypatch):
    reply = json.dumps({"sourceTable": "CUST", "sourceColumn": "CUST_NO", "mappingType": "Direct",
                        "transformationRule": "x", "businessRule": "y", "nullHandling": "z",
                        "confidence": 88, "explanation": "e", "joinCondition": "FROM CUST"})
    monkeypatch.setattr(ms, "anthropic_client", lambda: _fake_client(reply))
    payload, status = ms.regenerate_mapping({
        "mapping": {"targetEntity": "Account", "targetColumn": "ACCT_NO"},
        "sourceColumns": [{"table": "CUST", "column": "CUST_NO", "dataType": "int"}],
        "instruction": "map to customer number",
    })
    assert status == 200 and payload["ok"] is True
    assert payload["mapping"]["sourceColumn"] == "CUST_NO"


def test_regenerate_refusal_returns_400(monkeypatch):
    monkeypatch.setattr(ms, "anthropic_client", lambda: _fake_client("{}", refusal=True))
    payload, status = ms.regenerate_mapping({
        "mapping": {"targetColumn": "X"}, "sourceColumns": [],
    })
    assert status == 400 and "declined" in payload["error"].lower()
