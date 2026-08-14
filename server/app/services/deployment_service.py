"""Background deployment orchestration.

Starts a deploy in a daemon thread and tracks status in an in-memory dict
(guarded by a Lock) — no server-side persistence; durable history is kept by
the frontend in localStorage. State machine:

    queued -> running -> [fixing_error -> needs_review] | succeeded | failed

On a batch failure the whole script is rolled back and the failing batch is sent
to ai_fix_service. The corrected batch is substituted into a copy of the script
and surfaced as `finalSql` — but it is NEVER deployed automatically. The job ends
in `needs_review` so the user can review the highlighted change in the editor and
deploy again. The target DB is left unchanged (the failed transaction rolled back).
`failed` is used only when no fix could be produced or the failing batch can't be
located.

Credentials (cfg) are held only for the duration of the thread and are NEVER
written into the job record, logs, or AI prompts.
"""
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

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
        "maxAttempts": 1,     # one execution attempt; AI fixes are surfaced for review, not auto-deployed
        "fixes": [],          # [{attempt, batchIndex, error, before, after, model}]
        "finalSql": None,     # corrected full script (GO-joined) once AI fixes are applied
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

        work = list(batches)   # local copy; we patch the failing batch with the AI fix
        _update(job_id, attempts=1)
        _append_log(job_id, "Executing " + str(len(work)) + " batch(es) in a transaction…")

        res = execute_batches(cfg, work, dry_run=False)
        if res.get("ok"):
            _append_log(job_id, "All batches committed successfully.")
            _finish(job_id, "succeeded")
            return

        err = res.get("error") or {}
        _append_log(job_id, "Batch " + str(err.get("batchIndex")) + " failed: "
                    + (("SQL " + str(err.get("number")) + " ") if err.get("number") else "")
                    + (err.get("message") or "unknown error") + " (transaction rolled back — nothing deployed).")

        # Locate the failing batch so the AI can correct it.
        idx = err.get("batchIndex")
        if idx is None or idx < 0 or idx >= len(work):
            _update(job_id, error=err)
            _append_log(job_id, "Could not locate the failing batch to fix. Nothing deployed.")
            _finish(job_id, "failed")
            return

        # Ask the AI to correct the batch — but DO NOT deploy the fix. Surface it for review.
        _update(job_id, state="fixing_error")
        _append_log(job_id, "Asking AI to correct batch " + str(idx) + " (the fix is NOT deployed — you review it, then deploy again)…")
        fix = fix_batch(work[idx], err)
        if not fix.get("ok"):
            _update(job_id, error=err)
            _append_log(job_id, "AI could not produce a fix: " + (fix.get("error") or "unknown") + ". Nothing deployed.")
            _finish(job_id, "failed")
            return

        before, after = work[idx], fix["batch"]
        with _LOCK:
            job = _JOBS.get(job_id)
            if job:
                job["fixes"].append({
                    "attempt": 1, "batchIndex": idx,
                    "error": {"number": err.get("number"), "message": err.get("message"), "line": err.get("line")},
                    "before": before, "after": after, "model": fix.get("model"),
                })
        work[idx] = after
        # Corrected full script for the editor; the user reviews and re-deploys manually.
        _update(job_id, finalSql="\nGO\n".join(work))
        _append_log(job_id, "AI corrected batch " + str(idx) + ". Review the highlighted change in the editor, then deploy again. Nothing was deployed.")
        _finish(job_id, "needs_review")
    except Exception as exc:  # noqa: BLE001 - never leave a job stuck in 'running'
        _update(job_id, error={"batchIndex": -1, "number": None,
                               "message": "Deployment crashed: " + (str(exc) or exc.__class__.__name__), "line": None})
        _append_log(job_id, "Unexpected error: " + (str(exc) or exc.__class__.__name__))
        _finish(job_id, "failed")
