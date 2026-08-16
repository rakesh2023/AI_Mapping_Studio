"""QueryRouter — pick a retrieval strategy for a Know Your Data question.

Given a question and the user's READY insurance sources (each with a type and a
short description), ask the LLM which strategy to use:

    vector_search | sql_query | pandas_query | hybrid

and which sources to target. Uses the shared ai_client plumbing. The result is
always validated; on any parse/validation failure (or when AI is unavailable) it
falls back to vector_search across ALL provided sources.

route_query(question, sources) -> {"route", "target_sources", "reasoning"}
where `sources` is a list of dicts like
    {"name"|"id"|"filename": str, "type": str, "description": str}
"""
from typing import Any, Dict, List

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client, parse_mapping_json
from app.services.ai_client_service import call_ai
from app.schemas.ai_schemas import ROUTE_QUERY_SCHEMA

ROUTES = ("vector_search", "sql_query", "pandas_query", "hybrid")
_DEFAULT_ROUTE = "vector_search"


def _source_key(s: Dict[str, Any]) -> str:
    return str((s.get("name") or s.get("id") or s.get("filename") or "")).strip()


def _sources_block(sources: List[Dict[str, Any]]) -> str:
    lines = []
    for s in sources:
        key = _source_key(s)
        if not key:
            continue
        typ = s.get("type") or s.get("contentKind") or "unknown"
        desc = (s.get("description") or "").strip()
        lines.append(f"- {key} ({typ})" + (f": {desc}" if desc else ""))
    return "\n".join(lines) or "(no sources available)"


def _fallback(sources: List[Dict[str, Any]], reasoning: str) -> Dict[str, Any]:
    """vector_search across ALL provided sources."""
    return {"route": _DEFAULT_ROUTE,
            "target_sources": [k for k in (_source_key(s) for s in sources) if k],
            "reasoning": reasoning}


def route_query(question: str, sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    question = (question or "").strip()
    sources = sources or []
    keys = [k for k in (_source_key(s) for s in sources) if k]

    if not keys:
        return {"route": _DEFAULT_ROUTE, "target_sources": [],
                "reasoning": "No ready sources are available to query."}
    if not question:
        return _fallback(sources, "No question was provided; defaulting to vector search across all sources.")
    if anthropic is None:
        return _fallback(sources, "Router unavailable (AI is not configured); defaulting to vector search across all sources.")

    system = (
        "You are a routing agent. Given the user's question and the list of available "
        "data sources below, decide which retrieval strategy to use.\n\n"
        'Respond in JSON: {"route": "vector_search"|"sql_query"|"pandas_query"|"hybrid", '
        '"target_sources": [...], "reasoning": "..."}\n\n'
        "Guidance:\n"
        "- sql_query/pandas_query for counts, sums, averages, filtering, grouping, trends, "
        "specific row lookups (e.g. claims amounts, premium totals).\n"
        "- vector_search for conceptual/descriptive/explanatory questions about policy "
        "documents, terms, coverage details, etc.\n"
        "- hybrid if both are needed."
    )
    user = ("Available sources:\n" + _sources_block(sources)
            + '\nUser question: "' + question + '"')

    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=500, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Know Your Data - Query Router", run, [
            {"output_config": {"format": {"type": "json_schema", "schema": ROUTE_QUERY_SCHEMA}}},
            {},
        ])
        if getattr(resp, "stop_reason", None) == "refusal":
            return _fallback(sources, "Router request was declined; defaulting to vector search across all sources.")
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        return _validate(parse_mapping_json(text), keys, sources)
    except Exception:  # noqa: BLE001 - a router error must never break the chat
        return _fallback(sources, "Could not parse a routing decision; defaulting to vector search across all sources.")


def _validate(obj: Any, keys: List[str], sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        return _fallback(sources, "Could not parse a routing decision; defaulting to vector search across all sources.")
    route = obj.get("route")
    if route not in ROUTES:
        return _fallback(sources, "Router returned an unrecognized route; defaulting to vector search across all sources.")
    ts = obj.get("target_sources")
    known = set(keys)
    chosen = [str(t) for t in ts if str(t) in known] if isinstance(ts, list) else []
    if not chosen:                       # empty or all-hallucinated -> target everything
        chosen = list(keys)
    reasoning = str(obj.get("reasoning") or "")
    return {"route": route, "target_sources": chosen, "reasoning": reasoning}
