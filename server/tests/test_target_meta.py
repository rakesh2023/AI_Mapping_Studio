"""AI target-metadata inference — keys copied/matched, descriptions returned."""
import types

from app.services import target_meta_service as T


class _Msg:
    def __init__(self, text):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "end_turn"
        self.usage = None
        self.model = "test-model"


class _Stream:
    def __init__(self, m): self._m = m
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self._m


def _mock_client(reply):
    class C:
        class messages:
            @staticmethod
            def stream(**kw): return _Stream(_Msg(reply))
    return C()


def test_infer_target_metadata(monkeypatch):
    reply = ('{"columns":[{"name":"LossType","pk":false,"fk":false,"fkReference":"",'
             '"isListTable":true,"description":"The kind of loss."},'
             '{"name":"InsuredID","pk":false,"fk":true,"fkReference":"Contact",'
             '"isListTable":false,"description":"FK to the insured contact."}]}')
    monkeypatch.setattr(T, "anthropic_client", lambda: _mock_client(reply))
    body = {"tables": [{"name": "cc_claim", "table": "cc_claim",
                        "columns": [{"name": "LossType", "dataType": "varchar"},
                                    {"name": "InsuredID", "dataType": "bigint"}],
                        "reference": [{"name": "LossType", "pk": False, "fk": False,
                                       "fkReference": "", "isListTable": True}],
                        "known": {}}]}
    p, s = T.infer_target_metadata(body)
    assert s == 200 and p["ok"]
    cols = {c["name"]: c for c in p["tables"][0]["columns"]}
    assert cols["LossType"]["isListTable"] is True
    assert cols["InsuredID"]["fk"] is True and cols["InsuredID"]["fkReference"] == "Contact"
    assert cols["InsuredID"]["description"]


def test_infer_no_tables():
    p, s = T.infer_target_metadata({"tables": []})
    assert s == 400 and not p["ok"]


def test_match_tables(monkeypatch):
    reply = ('{"matches":[{"target":"cs_activity","match":"activity","confidence":0.97},'
             '{"target":"cs_xyz","match":"","confidence":0.1}]}')
    monkeypatch.setattr(T, "anthropic_client", lambda: _mock_client(reply))
    p, s = T.match_tables({"targets": ["cs_activity", "cs_xyz"], "candidates": ["activity", "address"]})
    assert s == 200 and p["ok"]
    by = {m["target"]: m for m in p["matches"]}
    assert by["cs_activity"]["match"] == "activity" and by["cs_activity"]["confidence"] >= 0.9
    assert by["cs_xyz"]["match"] == "" and by["cs_xyz"]["confidence"] < 0.5


def test_match_tables_requires_both():
    p, s = T.match_tables({"targets": [], "candidates": ["a"]})
    assert s == 400 and not p["ok"]
