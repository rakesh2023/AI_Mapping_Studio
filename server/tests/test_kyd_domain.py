"""Unit tests for kyd_domain_service.is_insurance_domain.

Covers: a clearly-insurance file passes, a clearly-unrelated file is rejected by
the cheap heuristic WITHOUT calling the LLM, a borderline (single incidental
term) file takes the LLM path, and malformed LLM JSON is handled without crashing.
The LLM is mocked (no network, no usage-DB writes).
"""
import json
import types

import pytest

import app.services.kyd_domain_service as D


def _parsed(text, tables=None):
    """Minimal stand-in for document_parser.ParseResult (text + tables)."""
    return types.SimpleNamespace(text=text, tables=tables or [], kind="unstructured")


def _mock_llm(monkeypatch, reply, stop="end_turn"):
    """Force is_insurance_domain down the LLM path with a canned reply."""
    monkeypatch.setattr(D, "anthropic_client", lambda: object())
    msg = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=reply)], stop_reason=stop)
    monkeypatch.setattr(D, "call_ai", lambda feature, run, attempts: msg)


def test_clear_insurance_file_passes(monkeypatch):
    _mock_llm(monkeypatch, json.dumps({
        "is_insurance_related": True, "confidence": 0.92,
        "detected_topics": ["claims", "premiums"], "reasoning": "Insurance claims data."}))
    r = D.is_insurance_domain(_parsed(
        "Policy number POL-123. Premium 500 USD. Claim filed for coverage under the policy."))
    assert r["is_insurance_related"] is True and r["confidence"] == 0.92
    assert r["detected_topics"] == ["claims", "premiums"] and r["usedLlm"] is True


def test_unrelated_file_rejected_without_llm(monkeypatch):
    # If the LLM were called this would explode — proving the heuristic short-circuit.
    monkeypatch.setattr(D, "anthropic_client",
                        lambda: (_ for _ in ()).throw(AssertionError("LLM must not be called")))
    r = D.is_insurance_domain(_parsed(
        "Chocolate cake recipe. Mix flour, eggs and cocoa. Bake for thirty minutes."))
    assert r["is_insurance_related"] is False and r["confidence"] == 0.9 and r["usedLlm"] is False
    assert r["detected_topics"] == []


def test_borderline_single_term_triggers_llm(monkeypatch):
    # "premium" (economy seat) is an incidental hit -> heuristic matches -> LLM decides.
    _mock_llm(monkeypatch, json.dumps({
        "is_insurance_related": False, "confidence": 0.3,
        "detected_topics": ["air travel"], "reasoning": "Incidental use of 'premium'."}))
    r = D.is_insurance_domain(_parsed(
        "Our premium economy seats offer extra legroom on long-haul flights."))
    assert r["usedLlm"] is True and r["is_insurance_related"] is False and r["confidence"] == 0.3


def test_malformed_llm_json_is_handled(monkeypatch):
    _mock_llm(monkeypatch, "Sorry, I can't help with that.")   # not JSON
    r = D.is_insurance_domain(_parsed("This acceptable-use policy governs the office gym."))
    assert r["is_insurance_related"] is False and r["confidence"] == 0.0
    assert r["reasoning"] == "validation failed" and r["usedLlm"] is True


def test_tabular_column_names_are_scanned(monkeypatch):
    # No insurance words in free text, but a column is named 'premium' -> heuristic hits.
    _mock_llm(monkeypatch, json.dumps({
        "is_insurance_related": True, "confidence": 0.8,
        "detected_topics": ["premiums"], "reasoning": "Premium column present."}))
    parsed = _parsed("Table: data\nRows: 2", tables=[{"name": "data", "columns": [
        {"name": "id"}, {"name": "premium"}]}])
    r = D.is_insurance_domain(parsed)
    assert r["usedLlm"] is True and r["is_insurance_related"] is True
