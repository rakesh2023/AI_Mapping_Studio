"""Unit tests for schema_service.parse_column with a mocked Anthropic client."""
import json
import types

from app.services import schema_service as ss


class _FakeMsg:
    def __init__(self, text, refusal=False):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "refusal" if refusal else "end_turn"


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


def test_parse_column_requires_instruction():
    payload, status = ss.parse_column({"instruction": "", "existingColumns": []})
    assert status == 400 and payload["ok"] is False


def test_parse_column_happy_path(monkeypatch):
    reply = json.dumps({
        "column": "external_ref", "dataType": "varchar", "length": 100,
        "mandatory": True, "pk": False, "fk": False, "fkReference": None,
        "afterColumn": "publicid", "description": "", "confidence": 95, "note": "",
    })
    monkeypatch.setattr(ss, "anthropic_client", lambda: _fake_client(reply))
    payload, status = ss.parse_column({
        "instruction": "add a required varchar 100 column external_ref after publicid",
        "tableName": "cs_activity",
        "existingColumns": [{"name": "publicid", "dataType": "varchar"}],
    })
    assert status == 200 and payload["ok"] is True
    col = payload["column"]
    assert col["column"] == "external_ref" and col["dataType"] == "varchar"
    assert col["length"] == 100 and col["mandatory"] is True
    assert col["afterColumn"] == "publicid" and col["duplicate"] is False


def test_parse_column_length_nulled_for_non_length_type(monkeypatch):
    reply = json.dumps({
        "column": "is_active", "dataType": "boolean", "length": 5,
        "mandatory": False, "pk": False, "fk": False, "confidence": 90,
    })
    monkeypatch.setattr(ss, "anthropic_client", lambda: _fake_client(reply))
    payload, _ = ss.parse_column({"instruction": "add boolean is_active", "existingColumns": []})
    assert payload["column"]["length"] is None   # boolean carries no length


def test_parse_column_flags_duplicate(monkeypatch):
    reply = json.dumps({"column": "City", "dataType": "varchar", "length": 50,
                        "mandatory": False, "pk": False, "fk": False, "confidence": 80})
    monkeypatch.setattr(ss, "anthropic_client", lambda: _fake_client(reply))
    payload, _ = ss.parse_column({
        "instruction": "add city", "existingColumns": [{"name": "city", "dataType": "varchar"}],
    })
    assert payload["column"]["duplicate"] is True   # case-insensitive clash with 'city'


def test_parse_column_unsupported_type_falls_back_to_varchar(monkeypatch):
    reply = json.dumps({"column": "blob_data", "dataType": "jsonb", "length": None,
                        "mandatory": False, "pk": False, "fk": False, "confidence": 70})
    monkeypatch.setattr(ss, "anthropic_client", lambda: _fake_client(reply))
    payload, _ = ss.parse_column({"instruction": "add blob_data", "existingColumns": []})
    assert payload["column"]["dataType"] == "varchar"


def test_parse_column_unparseable_returns_soft_error(monkeypatch):
    monkeypatch.setattr(ss, "anthropic_client", lambda: _fake_client("I cannot do that"))
    payload, status = ss.parse_column({"instruction": "do something vague", "existingColumns": []})
    assert status == 200 and payload["ok"] is False   # soft error, not a crash
