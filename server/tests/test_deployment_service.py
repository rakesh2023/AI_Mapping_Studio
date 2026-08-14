"""Unit tests for the deployment orchestration (threaded, mocked exec + fix)."""
import time

from app.services import deployment_service as ds

CFG = {"server": "S", "database": "DB", "username": "sa", "password": "secret", "trusted": False}
SQL = "CREATE TABLE [dbo].[t] (id int)\nGO\nALTER PROCEDURE p AS SELECT 1"


def _wait(job_id, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        job = ds.get_status(job_id)
        if job.get("state") in ("succeeded", "failed", "needs_review"):
            return job
        time.sleep(0.02)
    return ds.get_status(job_id)


def test_success_first_try(monkeypatch):
    monkeypatch.setattr(ds, "execute_batches", lambda cfg, batches, dry_run=False: {"ok": True, "executed": len(batches), "total": len(batches)})
    started = ds.start_deploy(CFG, SQL, dry_run=False)
    job = _wait(started["jobId"])
    assert job["state"] == "succeeded"
    assert job["attempts"] == 1 and job["totalBatches"] == 2


def test_fix_stops_for_review_not_deployed(monkeypatch):
    # A batch fails -> AI produces a fix -> job STOPS in needs_review (fix NOT deployed).
    calls = {"n": 0}
    def fake_exec(cfg, batches, dry_run=False):
        calls["n"] += 1
        return {"ok": False, "executed": 0, "total": len(batches),
                "error": {"batchIndex": 0, "batchText": batches[0], "number": 102, "message": "syntax error", "line": 1}}
    monkeypatch.setattr(ds, "execute_batches", fake_exec)
    monkeypatch.setattr(ds, "fix_batch", lambda batch, err: {"ok": True, "batch": "IF NOT EXISTS ... " + batch, "model": "m"})
    started = ds.start_deploy(CFG, SQL, dry_run=False)
    job = _wait(started["jobId"])
    assert job["state"] == "needs_review"
    assert job["attempts"] == 1                      # executed once, never re-run
    assert calls["n"] == 1                           # the fix was NOT deployed
    assert len(job["fixes"]) == 1
    assert job["fixes"][0]["before"] != job["fixes"][0]["after"]
    assert job["finalSql"] and "IF NOT EXISTS" in job["finalSql"]
    assert job["error"] is None                      # needs_review is not a hard failure


def test_fail_when_no_fix_available(monkeypatch):
    monkeypatch.setattr(ds, "execute_batches", lambda cfg, batches, dry_run=False: {"ok": False, "executed": 0, "total": len(batches),
        "error": {"batchIndex": 0, "batchText": batches[0], "number": 102, "message": "syntax error", "line": 1}})
    monkeypatch.setattr(ds, "fix_batch", lambda batch, err: {"ok": False, "error": "no fix"})
    started = ds.start_deploy(CFG, SQL, dry_run=False)
    job = _wait(started["jobId"])
    assert job["state"] == "failed"
    assert job["attempts"] == 1
    assert job["error"]["number"] == 102


def test_job_record_never_contains_credentials(monkeypatch):
    monkeypatch.setattr(ds, "execute_batches", lambda cfg, batches, dry_run=False: {"ok": True, "executed": len(batches), "total": len(batches)})
    started = ds.start_deploy(CFG, SQL, dry_run=False)
    job = _wait(started["jobId"])
    blob = repr(job)
    assert "secret" not in blob and "password" not in blob and "username" not in blob
    assert job["server"] == "S" and job["database"] == "DB"   # safe context kept


def test_dry_run_does_not_call_fix(monkeypatch):
    monkeypatch.setattr(ds, "execute_batches", lambda cfg, batches, dry_run=False: {"ok": True, "dryRun": True, "executed": 0, "total": len(batches)})
    def boom(*a, **k): raise AssertionError("fix_batch must not run on dry run")
    monkeypatch.setattr(ds, "fix_batch", boom)
    started = ds.start_deploy(CFG, SQL, dry_run=True)
    job = _wait(started["jobId"])
    assert job["state"] == "succeeded" and job["dryRun"] is True
