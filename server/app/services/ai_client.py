"""Anthropic client construction and shared AI-call plumbing.

Owns the one place that builds a client trusting the corporate CA bundle, the
JSON-extraction helper used by every AI path, and — importantly —
call_with_fallback(), which unifies the "try a list of output_config attempts,
fall back on exception" pattern that was duplicated across mapping generation,
regeneration, and file extraction.
"""
import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model, ca_bundle


def anthropic_client():
    """Build a client whose httpx transport trusts the corporate CA bundle, so the
    TLS handshake to the internal gateway (ANTHROPIC_BASE_URL) succeeds instead of
    failing with 'Connection error'. base_url + auth token are read from env.
    """
    kwargs: Dict[str, Any] = {}
    ca = ca_bundle()
    if ca:
        try:
            import httpx
            kwargs["http_client"] = httpx.Client(verify=ca, timeout=600.0)
        except Exception:  # noqa: BLE001 - fall back to the default client
            pass
    return anthropic.Anthropic(**kwargs)


def call_with_fallback(run: Callable[[Dict[str, Any]], Any],
                       attempts: List[Dict[str, Any]]) -> Any:
    """Try each attempt config in order; return the first success.

    `run` is a callable that performs one model call given an extra-kwargs dict
    (e.g. an output_config). Attempts are tried in order — typically most-capable
    (structured output + effort) first, degrading to a bare call — so gateways
    that reject an option fall through to a simpler one. If every attempt raises,
    the LAST exception is re-raised (matching the original per-site behavior).
    """
    resp, last_err = None, None
    for cfg in attempts:
        try:
            resp = run(cfg)
            break
        except Exception as e:  # noqa: BLE001 - any gateway/SDK error -> try next cfg
            last_err = e
    if resp is None:
        raise last_err
    return resp


def schema_attempts(schema: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The standard 4-step degradation ladder for a structured-output schema.

    Order preserved from the original call sites: json_schema+effort, json_schema,
    effort-only, bare. Used by mapping generation and file extraction.
    """
    return [
        {"output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": schema}}},
        {"output_config": {"format": {"type": "json_schema", "schema": schema}}},
        {"output_config": {"effort": "medium"}},
        {},
    ]


def parse_mapping_json(text: str) -> Dict[str, Any]:
    """Best-effort JSON extraction — tolerates ```json fences or leading prose."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:  # noqa: BLE001
            pass
    return {"mappings": []}


def ai_status() -> Dict[str, Any]:
    """Report whether the AI backend is usable (SDK present + credentials resolvable).

    Returns the payload dict for GET /api/ai/status (route stays thin).
    """
    if anthropic is None:
        return {"ok": False, "reason": "The 'anthropic' SDK is not installed (pip install anthropic)."}
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return {"ok": False, "reason": "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set in the server environment."}
    base = os.environ.get("ANTHROPIC_BASE_URL")
    return {"ok": True, "model": ai_model(), "endpoint": (base or "api.anthropic.com")}
