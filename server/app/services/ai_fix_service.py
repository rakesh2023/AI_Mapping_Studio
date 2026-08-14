"""AI self-correction for a failing T-SQL batch.

Given the failing batch and the exact SQL Server error, ask Claude for a
corrected batch (only). Reuses the shared Anthropic client + retry ladder from
ai_client — no second client setup. NO connection details / credentials are
ever included in the prompt.
"""
import re
from typing import Any, Dict

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.services.ai_client import anthropic_client
from app.services.ai_client_service import call_ai


def _strip_fences(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n", "", t)
        t = re.sub(r"\n```$", "", t)
    return t.strip()


# T-SQL statement keywords a corrected batch should begin with.
_SQL_START = re.compile(
    r"^\s*(--|/\*|WITH|SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|"
    r"IF|BEGIN|DECLARE|SET|USE|EXEC|EXECUTE|GRANT|REVOKE|PRINT|GO)\b",
    re.IGNORECASE)
# Phrases that indicate the model DECLINED rather than returned SQL.
_REFUSAL = re.compile(
    r"\b(i (don'?t|do not|cannot|can'?t)\b|not enough (information|context)|"
    r"unable to|i'?m sorry|as an ai|please provide|need more)\b", re.IGNORECASE)


def _looks_like_sql(text: str) -> bool:
    """True if `text` plausibly IS a SQL batch (not prose / a refusal)."""
    t = (text or "").strip()
    if not t:
        return False
    if _REFUSAL.search(t):
        return False
    return bool(_SQL_START.match(t))


def _extract_sql(text: str) -> str:
    """Pull the corrected SQL out of the model's reply, tolerating a stray leading
    sentence (e.g. 'Here is the corrected batch:') or a ```sql code fence. Returns
    "" only when the reply contains no SQL at all (i.e. a genuine refusal)."""
    t = _strip_fences(text)
    if not t:
        return ""
    # Prefer the contents of a fenced ```...``` block if one appears anywhere.
    m = re.search(r"```[a-zA-Z]*\n(.*?)```", text or "", re.DOTALL)
    if m and m.group(1).strip():
        t = m.group(1).strip()
    if _SQL_START.match(t):
        return t
    # Otherwise salvage from the first line that begins a T-SQL statement, so a
    # leading explanatory sentence never causes us to discard a valid fix.
    lines = t.split("\n")
    for i, ln in enumerate(lines):
        if _SQL_START.match(ln):
            return "\n".join(lines[i:]).strip()
    return ""


def fix_batch(batch: str, error: Dict[str, Any]) -> Dict[str, Any]:
    """Return {ok, batch} with a corrected version of `batch`, or {ok:False,error}.

    `error` = {number, message, line, ...} from sql_execution_service. Only the
    batch text + error are sent to the model — never any credentials.
    """
    if anthropic is None:
        return {"ok": False, "error": "The 'anthropic' SDK is not installed on the server."}
    if not (batch or "").strip():
        return {"ok": False, "error": "No batch to fix."}

    err_num = error.get("number")
    err_msg = error.get("message") or ""
    err_line = error.get("line")

    system = (
        "You are a senior Microsoft SQL Server (T-SQL) engineer. A single SQL batch "
        "failed to execute. Return a CORRECTED version of ONLY that batch that fixes the "
        "specific error.\n\n"
        "RULES:\n"
        "- The goal is a batch that PARSES and RUNS. Correct ANY T-SQL syntax error you can "
        "find in this batch so it executes cleanly — missing or misplaced commas, unbalanced "
        "parentheses or quotes, a comma left INSIDE a '-- comment' (which comments it out), "
        "missing/extra keywords, stray characters — even if the reported error points at only "
        "one spot and even if there is more than one problem.\n"
        "- Do NOT rewrite unrelated logic, rename objects, or change table/column names, data "
        "types, or constraints beyond what makes the batch valid.\n"
        "- Preserve the existing naming conventions, bracketing ([dbo].[Table]), and "
        "structure.\n"
        "- Return runnable T-SQL for this one batch only. No prose, no markdown fences, "
        "no 'GO'.\n"
    )
    user = (
        "SQL SERVER ERROR" + (" " + str(err_num) if err_num else "") + ":\n" + err_msg + "\n"
        + ("(near line " + str(err_line) + ")\n" if err_line else "")
        + "\nFAILING BATCH:\n" + batch
    )

    model = ai_model()
    try:
        client = anthropic_client()
        base_kwargs = dict(model=model, max_tokens=4000, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("ETL Deploy - AI SQL Fix", run, [{"output_config": {"effort": "medium"}}, {}])
        if getattr(resp, "stop_reason", None) == "refusal":
            return {"ok": False, "error": "The fix request was declined by safety classifiers."}
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        # Salvage the SQL even if the model wrapped it in prose or a code fence, so a
        # chatty reply no longer causes us to throw away a valid correction.
        fixed = _extract_sql(text)
        if not fixed:
            return {"ok": False, "error": "The AI could not produce a valid SQL correction for this error."}
        # Don't retry an unchanged batch (it would just fail the same way).
        if fixed.strip() == (batch or "").strip():
            return {"ok": False, "error": "The AI returned the batch unchanged — no fix available."}
        return {"ok": True, "batch": fixed, "model": model}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": (str(exc) or exc.__class__.__name__)}
