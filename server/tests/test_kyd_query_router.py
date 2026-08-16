"""Unit tests for kyd_query_router.route_query — example questions vs mocked
source lists, with a mocked LLM (no network)."""
import json
import types

import pytest

import app.services.kyd_query_router as R

SOURCES = [
    {"name": "claims.csv", "type": "structured",
     "description": "Claim records with amounts, dates, and status"},
    {"name": "auto_policy.pdf", "type": "unstructured",
     "description": "Auto policy wording, coverage terms and exclusions"},
]


def _mock_llm(monkeypatch, reply, stop="end_turn"):
    monkeypatch.setattr(R, "anthropic_client", lambda: object())
    msg = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=reply)], stop_reason=stop)
    monkeypatch.setattr(R, "call_ai", lambda feature, run, attempts: msg)


def _reply(route, targets, reasoning="because"):
    return json.dumps({"route": route, "target_sources": targets, "reasoning": reasoning})


def test_numeric_question_routes_to_sql(monkeypatch):
    _mock_llm(monkeypatch, _reply("sql_query", ["claims.csv"]))
    r = R.route_query("What is the total claim amount in 2024?", SOURCES)
    assert r["route"] == "sql_query" and r["target_sources"] == ["claims.csv"]
    assert r["reasoning"]


def test_conceptual_question_routes_to_vector(monkeypatch):
    _mock_llm(monkeypatch, _reply("vector_search", ["auto_policy.pdf"]))
    r = R.route_query("What does the policy say about collision coverage?", SOURCES)
    assert r["route"] == "vector_search" and r["target_sources"] == ["auto_policy.pdf"]


def test_pandas_route_supported(monkeypatch):
    _mock_llm(monkeypatch, _reply("pandas_query", ["claims.csv"]))
    r = R.route_query("Average premium grouped by state", SOURCES)
    assert r["route"] == "pandas_query"


def test_hybrid_route(monkeypatch):
    _mock_llm(monkeypatch, _reply("hybrid", ["claims.csv", "auto_policy.pdf"]))
    r = R.route_query("How many collision claims and what does the policy cover?", SOURCES)
    assert r["route"] == "hybrid" and set(r["target_sources"]) == {"claims.csv", "auto_policy.pdf"}


def test_malformed_json_falls_back_to_vector_all(monkeypatch):
    _mock_llm(monkeypatch, "sorry, I cannot decide")     # not JSON
    r = R.route_query("anything", SOURCES)
    assert r["route"] == "vector_search"
    assert set(r["target_sources"]) == {"claims.csv", "auto_policy.pdf"}   # all sources


def test_unrecognized_route_falls_back(monkeypatch):
    _mock_llm(monkeypatch, _reply("banana", ["claims.csv"]))
    r = R.route_query("weird", SOURCES)
    assert r["route"] == "vector_search" and len(r["target_sources"]) == 2


def test_hallucinated_targets_default_to_all(monkeypatch):
    _mock_llm(monkeypatch, _reply("vector_search", ["ghost.pdf"]))    # not in the list
    r = R.route_query("explain coverage", SOURCES)
    assert set(r["target_sources"]) == {"claims.csv", "auto_policy.pdf"}


def test_partial_valid_targets_are_kept(monkeypatch):
    _mock_llm(monkeypatch, _reply("sql_query", ["claims.csv", "ghost.pdf"]))
    r = R.route_query("count claims", SOURCES)
    assert r["target_sources"] == ["claims.csv"]     # invalid dropped, valid kept


def test_no_sources_short_circuits(monkeypatch):
    monkeypatch.setattr(R, "anthropic_client",
                        lambda: (_ for _ in ()).throw(AssertionError("LLM must not be called")))
    r = R.route_query("total claims?", [])
    assert r["route"] == "vector_search" and r["target_sources"] == []


def test_empty_question_falls_back(monkeypatch):
    monkeypatch.setattr(R, "anthropic_client",
                        lambda: (_ for _ in ()).throw(AssertionError("LLM must not be called")))
    r = R.route_query("   ", SOURCES)
    assert r["route"] == "vector_search" and set(r["target_sources"]) == {"claims.csv", "auto_policy.pdf"}


def test_ai_unavailable_falls_back(monkeypatch):
    monkeypatch.setattr(R, "anthropic", None)
    r = R.route_query("total claims?", SOURCES)
    assert r["route"] == "vector_search" and set(r["target_sources"]) == {"claims.csv", "auto_policy.pdf"}
