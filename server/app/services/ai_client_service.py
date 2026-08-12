"""Single choke point for every Claude API call — times it, records usage, logs.

`call_ai(feature_name, run, attempts)` wraps the existing `call_with_fallback`
degradation ladder so ALL model calls in the app funnel through one function
that:
  - runs the call (via the same `run`/`attempts` pattern each service already uses),
  - measures wall-clock duration,
  - extracts response.usage.input_tokens / output_tokens and response.model,
  - writes ONE usage row via ai_usage_logger.log_ai_call, and
  - on any exception, logs status="failed" (0 tokens) and RE-RAISES unchanged.

The logging insert is fire-and-forget on a background thread, so this adds no
latency and can never alter a service's behavior — services keep getting the
exact same response object (or the exact same exception) as before.
"""
import time
from typing import Any, Callable, Dict, List

from app.core.config import ai_model
from app.services.ai_client import call_with_fallback
from app.services.ai_usage_logger import log_ai_call


def call_ai(feature_name: str, run: Callable[[Dict[str, Any]], Any],
            attempts: List[Dict[str, Any]]) -> Any:
    """Execute a model call through the fallback ladder, logging usage.

    Identical return/raise semantics to call_with_fallback — only observability
    is added. `feature_name` labels the log row (e.g. "ETL Code Generator").
    """
    start = time.perf_counter()
    try:
        resp = call_with_fallback(run, attempts)
    except Exception as exc:  # noqa: BLE001 - log the failure, then re-raise unchanged
        dur = int((time.perf_counter() - start) * 1000)
        log_ai_call(feature_name, ai_model(), 0, 0, dur, "failed",
                    (str(exc) or exc.__class__.__name__))
        raise

    dur = int((time.perf_counter() - start) * 1000)
    usage = getattr(resp, "usage", None)
    input_tokens = getattr(usage, "input_tokens", 0) or 0
    output_tokens = getattr(usage, "output_tokens", 0) or 0
    model = getattr(resp, "model", None) or ai_model()
    log_ai_call(feature_name, model, input_tokens, output_tokens, dur, "success")
    return resp
