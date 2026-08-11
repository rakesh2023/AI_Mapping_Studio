"""Unit tests for the shared AI plumbing (retry ladder + JSON parsing)."""
import pytest

from app.services.ai_client import (
    call_with_fallback, schema_attempts, parse_mapping_json,
)


def test_call_with_fallback_returns_first_success():
    tried = []

    def run(cfg):
        tried.append(cfg)
        if len(tried) < 2:
            raise RuntimeError("first attempt fails")
        return "OK"

    result = call_with_fallback(run, [{"a": 1}, {"b": 2}, {"c": 3}])
    assert result == "OK"
    assert len(tried) == 2   # stopped at the first success, didn't try the third


def test_call_with_fallback_first_attempt_wins():
    tried = []

    def run(cfg):
        tried.append(cfg)
        return "OK"

    assert call_with_fallback(run, [{"a": 1}, {"b": 2}]) == "OK"
    assert len(tried) == 1


def test_call_with_fallback_raises_last_error_when_all_fail():
    def run(cfg):
        raise ValueError("attempt-" + str(cfg["n"]))

    with pytest.raises(ValueError) as exc:
        call_with_fallback(run, [{"n": 1}, {"n": 2}, {"n": 3}])
    assert str(exc.value) == "attempt-3"   # the LAST error, not the first


def test_schema_attempts_ladder_order():
    schema = {"type": "object"}
    attempts = schema_attempts(schema)
    assert attempts == [
        {"output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": schema}}},
        {"output_config": {"format": {"type": "json_schema", "schema": schema}}},
        {"output_config": {"effort": "medium"}},
        {},
    ]


@pytest.mark.parametrize("text,expected", [
    ('{"a": 1}', {"a": 1}),
    ('```json\n{"b": 2}\n```', {"b": 2}),
    ('prefix {"c": 3} suffix', {"c": 3}),
    ('not json at all', {"mappings": []}),
    ('', {"mappings": []}),
    ('{"nested": {"x": [1,2]}}', {"nested": {"x": [1, 2]}}),
])
def test_parse_mapping_json(text, expected):
    assert parse_mapping_json(text) == expected
