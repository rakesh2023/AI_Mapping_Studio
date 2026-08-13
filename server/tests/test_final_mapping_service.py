"""Unit tests for final_mapping_service.suggest with a mocked Anthropic client."""
import json
import types

from app.services import final_mapping_service as fm


class _Msg:
    def __init__(self, text, refusal=False):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "refusal" if refusal else "end_turn"


class _Stream:
    def __init__(self, m): self._m = m
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self._m


def _client(reply, refusal=False):
    class C:
        class messages:
            @staticmethod
            def stream(**kw): return _Stream(_Msg(reply, refusal))
    return C()


STAGING = [{"entity": "CLM", "table": "CLM", "columns": [
    {"name": "claimid", "dataType": "int"}, {"name": "lossdt", "dataType": "date"}]}]
TARGET = [{"entity": "Claim", "table": "Claim", "columns": [
    {"name": "ClaimId", "dataType": "int"}, {"name": "LossDate", "dataType": "date"}]}]


def test_requires_both_sides():
    p, s = fm.suggest({"staging": [], "target": TARGET})
    assert s == 400 and p["ok"] is False


def test_happy_path_maps_and_defaults_type(monkeypatch):
    reply = json.dumps({"links": [
        {"stagingEntity": "CLM", "stagingColumn": "claimid", "targetEntity": "Claim",
         "targetColumn": "ClaimId", "mappingType": "Direct", "transformationRule": "", "confidence": 95},
        {"stagingEntity": "CLM", "stagingColumn": "lossdt", "targetEntity": "Claim",
         "targetColumn": "LossDate", "confidence": 80},   # no mappingType -> defaults to Direct
    ]})
    monkeypatch.setattr(fm, "anthropic_client", lambda: _client(reply))
    p, s = fm.suggest({"staging": STAGING, "target": TARGET})
    assert s == 200 and p["ok"] is True
    assert len(p["links"]) == 2
    assert {l["targetColumn"] for l in p["links"]} == {"ClaimId", "LossDate"}
    assert all(l["mappingType"] in fm.MAPPING_TYPES for l in p["links"])


def test_drops_hallucinated_columns(monkeypatch):
    reply = json.dumps({"links": [
        {"stagingEntity": "CLM", "stagingColumn": "claimid", "targetEntity": "Claim", "targetColumn": "ClaimId"},
        {"stagingEntity": "CLM", "stagingColumn": "ghost", "targetEntity": "Claim", "targetColumn": "ClaimId"},   # staging col not real
        {"stagingEntity": "CLM", "stagingColumn": "claimid", "targetEntity": "Claim", "targetColumn": "Nope"},    # target col not real
    ]})
    monkeypatch.setattr(fm, "anthropic_client", lambda: _client(reply))
    p, _ = fm.suggest({"staging": STAGING, "target": TARGET})
    assert len(p["links"]) == 1 and p["links"][0]["stagingColumn"] == "claimid"


def test_dedupes_identical_links(monkeypatch):
    reply = json.dumps({"links": [
        {"stagingEntity": "CLM", "stagingColumn": "claimid", "targetEntity": "Claim", "targetColumn": "ClaimId"},
        {"stagingEntity": "CLM", "stagingColumn": "claimid", "targetEntity": "Claim", "targetColumn": "ClaimId"},
    ]})
    monkeypatch.setattr(fm, "anthropic_client", lambda: _client(reply))
    p, _ = fm.suggest({"staging": STAGING, "target": TARGET})
    assert len(p["links"]) == 1


def test_refusal_yields_no_links(monkeypatch):
    monkeypatch.setattr(fm, "anthropic_client", lambda: _client("", refusal=True))
    p, s = fm.suggest({"staging": STAGING, "target": TARGET})
    assert s == 200 and p["ok"] is True and p["links"] == []
