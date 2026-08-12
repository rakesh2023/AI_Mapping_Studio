"""Background deployment orchestration.

Starts a deploy in a daemon thread and tracks status in an in-memory dict
(guarded by a Lock) — no server-side persistence; durable history is kept by
the frontend in localStorage. State machine:

    queued -> running -> [fixing_error -> retrying]* -> succeeded | failed

On a batch failure the whole script is rolled back, the failing batch is sent to
ai_fix_service, the returned fix is substituted, and the ENTIRE script is
re-run in a fresh transaction — up to DEPLOY_MAX_ATTEMPTS. If it still fails,
the target DB is left unchanged (each attempt rolls back) and the full error +
fix history is surfaced.

Credentials (cfg) are held only for the duration of the thread and are NEVER
written into the job record, logs, or AI prompts.
"""
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

from app.core.config import DEPLOY_MAX_ATTEMPTS
from app.parsers.sql_batches import split_sql_batches
from app.services.sql_execution_service import execute_batches
from app.services.ai_fix_service import fix_batch

_JOBS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update(job_id: str, **changes) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job:
            job.update(changes)


def _append_log(job_id: str, message: str) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job:
            job.setdefault("log", []).append({"at": _now(), "message": message})


def start_deploy(cfg: Dict[str, Any], sql: str, dry_run: bool = False) -> Dict[str, Any]:
    """Create a job, spawn the worker thread, return {jobId, totalBatches}."""
    job_id = uuid.uuid4().hex[:12]
    batches = split_sql_batches(sql)
    job = {
        "id": job_id,
        "state": "queued",
        "dryRun": bool(dry_run),
        # safe, non-secret context only — no username/password/driver
        "server": cfg.get("server") or cfg.get("host") or "",
        "database": cfg.get("database") or cfg.get("db") or "",
        "totalBatches": len(batches),
        "attempts": 0,
        "maxAttempts": DEPLOY_MAX_ATTEMPTS,
        "fixes": [],          # [{attempt, batchIndex, error, before, after, model}]
        "error": None,        # final error {batchIndex, number, message, line}
        "log": [],
        "startedAt": _now(),
        "finishedAt": None,
    }
    with _LOCK:
        _JOBS[job_id] = job

    t = threading.Thread(target=_run_job, args=(job_id, cfg, batches, bool(dry_run)), daemon=True)
    t.start()
    return {"jobId": job_id, "totalBatches": len(batches)}


def get_status(job_id: str) -> Dict[str, Any]:
    """Return a COPY of the job record (never the live dict, never cfg)."""
    with _LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else {}


def _finish(job_id: str, state: str) -> None:
    _update(job_id, state=state, finishedAt=_now())


def _run_job(job_id: str, cfg: Dict[str, Any], batches: List[str], dry_run: bool) -> None:
    try:
        _update(job_id, state="running")
        if dry_run:
            _append_log(job_id, "Dry run: split into " + str(len(batches)) + " batch(es); verifying connectivity (no execution).")
            res = execute_batches(cfg, batches, dry_run=True)
            if res.get("ok"):
                _append_log(job_id, "Dry run OK — connection reachable; " + str(len(batches)) + " batch(es) ready to deploy.")
                _finish(job_id, "succeeded")
            else:
                _update(job_id, error=res.get("error"))
                _append_log(job_id, "Dry run failed: " + (res.get("error", {}).get("message") or "unknown error"))
                _finish(job_id, "failed")
            return

        work = list(batches)   # local, mutable copy we may patch with AI fixes
        max_attempts = DEPLOY_MAX_ATTEMPTS
        for attempt in range(1, max_attempts + 1):
            _update(job_id, attempts=attempt)
            if attempt > 1:
                _update(job_id, state="retrying")
                _append_log(job_id, "Attempt " + str(attempt) + " of " + str(max_attempts) + "…")
            _append_log(job_id, "Executing " + str(len(work)) + " batch(es) in a transaction…")

            res = execute_batches(cfg, work, dry_run=False)
            if res.get("ok"):
                _append_log(job_id, "All batches committed successfully.")
                _finish(job_id, "succeeded")
                return

            err = res.get("error") or {}
            _append_log(job_id, "Batch " + str(err.get("batchIndex")) + " failed: "
                        + (("SQL " + str(err.get("number")) + " ") if err.get("number") else "")
                        + (err.get("message") or "unknown error") + " (transaction rolled back).")

            if attempt >= max_attempts:
                _update(job_id, error=err)
                _append_log(job_id, "Reached max attempts (" + str(max_attempts) + "). Target database left unchanged.")
                _finish(job_id, "failed")
                return

            # Try to self-correct the failing batch, then retry the whole script.
            idx = err.get("batchIndex")
            if idx is None or idx < 0 or idx >= len(work):
                _update(job_id, error=err)
                _append_log(job_id, "Could not locate the failing batch to fix. Stopping.")
                _finish(job_id, "failed")
                return

            _update(job_id, state="fixing_error")
            _append_log(job_id, "Asking AI to correct batch " + str(idx) + "…")
            fix = fix_batch(work[idx], err)
            if not fix.get("ok"):
                _update(job_id, error=err)
                _append_log(job_id, "AI could not produce a fix: " + (fix.get("error") or "unknown") + ". Stopping.")
                _finish(job_id, "failed")
                return

            before, after = work[idx], fix["batch"]
            with _LOCK:
                job = _JOBS.get(job_id)
                if job:
                    job["fixes"].append({
                        "attempt": attempt, "batchIndex": idx,
                        "error": {"number": err.get("number"), "message": err.get("message"), "line": err.get("line")},
                        "before": before, "after": after, "model": fix.get("model"),
                    })
            work[idx] = after
            _append_log(job_id, "Applied AI fix to batch " + str(idx) + "; retrying.")

        # Loop exhausted (shouldn't reach here — handled inside).
        _finish(job_id, "failed")
    except Exception as exc:  # noqa: BLE001 - never leave a job stuck in 'running'
        _update(job_id, error={"batchIndex": -1, "number": None,
                               "message": "Deployment crashed: " + (str(exc) or exc.__class__.__name__), "line": None})
        _append_log(job_id, "Unexpected error: " + (str(exc) or exc.__class__.__name__))
        _finish(job_id, "failed")
