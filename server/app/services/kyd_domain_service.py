"""Insurance-domain validation for Know Your Data.

The app is scoped strictly to the INSURANCE domain. After parsing and before
chunking/embedding, ``is_insurance_domain(parsed)`` decides whether an uploaded
file belongs to that domain:

  1. Cheap heuristic pre-check — scan the extracted text (and, for tabular files,
     column names) against INSURANCE_KEYWORDS. ZERO matches -> short-circuit as
     not-insurance (confidence 0.9) WITHOUT calling the LLM.
  2. Otherwise ask Claude (via the shared ai_client plumbing) to judge the
     overall subject matter and return strict JSON.
  3. Malformed/again-unparseable LLM output defaults to not-insurance,
     confidence 0.0, reasoning "validation failed".

Returns {is_insurance_related, confidence(0..1), detected_topics, reasoning} plus
a non-contract "usedLlm" flag for observability/tests. Pure of Flask; safe to
call from the ingestion worker thread.
"""
from typing import Any, Dict

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client, parse_mapping_json
from app.services.ai_client_service import call_ai
from app.schemas.ai_schemas import DOMAIN_CHECK_SCHEMA

# Lowercased signal terms. Substring matching (favours recall: a false match only
# costs one LLM call, whereas a missed match would wrongly reject a real doc).
INSURANCE_KEYWORDS = [
    "policy", "policyholder", "premium", "claim", "insured", "insurer", "insurance",
    "underwriting", "underwriter", "deductible", "sum assured", "sum insured",
    "endorsement", "beneficiary", "coverage", "covered", "reinsurance", "reinsurer",
    "loss ratio", "rider", "actuarial", "actuary", "adjuster", "adjudication",
    "peril", "liability", "annuity", "indemnity", "subrogation", "cede", "ceded",
    "loss adjustment", "claimant", "coinsurance", "copay", "exclusion", "policy number",
    "coverage limit", "sum", "no claim bonus", "grace period", "maturity", "surrender value",
    "third party", "motor insurance", "life insurance", "health insurance", "property insurance",
]

_MAX_SAMPLE = 2000   # chars of content shown to the classifier


def _content_sample(parsed) -> str:
    """First ~2000 chars of the normalized text. For tabular files parsed.text is
    already the data profile (column names + dtypes + sample rows)."""
    return (getattr(parsed, "text", "") or "")[:_MAX_SAMPLE]


def _scan_text(parsed) -> str:
    """Text the heuristic scans: normalized text plus every table's column names."""
    parts = [getattr(parsed, "text", "") or ""]
    for t in (getattr(parsed, "tables", None) or []):
        parts.extend(str(c.get("name", "")) for c in (t.get("columns") or []))
    return " ".join(parts).lower()


def _default_fail(reasoning: str, used_llm: bool) -> Dict[str, Any]:
    return {"is_insurance_related": False, "confidence": 0.0,
            "detected_topics": [], "reasoning": reasoning, "usedLlm": used_llm}


def is_insurance_domain(parsed) -> Dict[str, Any]:
    """Classify a ParseResult as insurance-domain or not."""
    scan = _scan_text(parsed)
    matches = sorted({kw for kw in INSURANCE_KEYWORDS if kw in scan})

    # (a) No signal at all -> reject cheaply, no LLM.
    if not matches:
        return {"is_insurance_related": False, "confidence": 0.9, "detected_topics": [],
                "reasoning": "No insurance-related terminology was found in the content.",
                "usedLlm": False}

    # (b) Signal present -> let the model judge overall subject matter.
    if anthropic is None:
        # Can't verify; the app is strictly insurance, so fail closed.
        return _default_fail("Domain check unavailable (AI is not configured on the server).", False)

    sample = _content_sample(parsed)
    system = (
        "You are a domain classifier. You will be shown a sample of extracted content "
        "from an uploaded file. Determine whether this content belongs to the INSURANCE "
        "domain (policies, claims, underwriting, premiums, coverage, reinsurance, "
        "actuarial data, insured parties, endorsements, riders, claims adjudication, "
        "insurance regulatory/compliance filings, etc.)\n\n"
        "Respond in strict JSON:\n"
        '{"is_insurance_related": true|false, "confidence": 0.0-1.0, '
        '"detected_topics": ["..."], "reasoning": "..."}\n\n'
        "Rules:\n"
        "- Base your decision only on content shown, not the filename.\n"
        "- If ambiguous/too sparse, set confidence below 0.5 and is_insurance_related to false.\n"
        "- Don't be fooled by a single incidental insurance term in an unrelated document — "
        "judge overall subject matter."
    )
    user = "CONTENT SAMPLE:\n---\n" + sample + "\n---"

    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=600, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Know Your Data - Domain Check", run, [
            {"output_config": {"format": {"type": "json_schema", "schema": DOMAIN_CHECK_SCHEMA}}},
            {},
        ])
        if getattr(resp, "stop_reason", None) == "refusal":
            return _default_fail("validation failed", True)
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        parsed_json = parse_mapping_json(text)
        return _validate(parsed_json)
    except Exception:  # noqa: BLE001 - never let a classifier error crash ingestion
        return _default_fail("validation failed", True)


def _validate(obj: Any) -> Dict[str, Any]:
    """Coerce the model's JSON into the contract; malformed -> default fail."""
    if not isinstance(obj, dict) or "is_insurance_related" not in obj or "confidence" not in obj:
        return _default_fail("validation failed", True)
    try:
        is_ins = bool(obj.get("is_insurance_related"))
        conf = float(obj.get("confidence"))
    except (TypeError, ValueError):
        return _default_fail("validation failed", True)
    conf = max(0.0, min(1.0, conf))
    topics = obj.get("detected_topics")
    topics = [str(t) for t in topics] if isinstance(topics, list) else []
    reasoning = str(obj.get("reasoning") or "")
    return {"is_insurance_related": is_ins, "confidence": conf,
            "detected_topics": topics, "reasoning": reasoning, "usedLlm": True}
