"""SEC-003 regression: cross-tenant isolation of deploy-job status over HTTP.

Replicates Testing Agent matrix row T9 — a deploy job's status is readable only by
the tenant that created it. Before the fix, GET /api/deploy/status/<job_id>
returned the job (server, database, finalSql, fixes[].before/after, error, log) for
ANY id, with no binding to the requesting tenant.

The background worker is stubbed so no real SQL Server is contacted; we only need a
job to exist under Tenant A and then have Tenant B try to read it.
"""
import pytest

from app import create_app
from app.services import deployment_service as ds

CFG = {"server": "SERVER-A", "database": "DB-A"}
SQL = "CREATE TABLE [dbo].[t] (id int)"


@pytest.fixture
def app(monkeypatch):
    # Keep the daemon worker from touching a real DB (mirrors test_deployment_service).
    monkeypatch.setattr(
        ds, "execute_batches",
        lambda cfg, batches, dry_run=False: {"ok": True, "executed": len(batches), "total": len(batches)},
    )
    return create_app()


def _signup_client(app, email, client_name):
    c = app.test_client()
    c.post("/api/auth/signup", json={"email": email, "password": "password123", "name": "U"})
    c.post("/api/clients", json={"name": client_name, "industry": "", "config": {}})
    return c


def test_cross_tenant_cannot_read_deploy_status(app):
    """T9: Tenant B requesting Tenant A's job_id must get 404 and no job fields;
    Tenant A must still read their own job."""
    ca = _signup_client(app, "sec003_a@example.com", "A-Client")
    cb = _signup_client(app, "sec003_b@example.com", "B-Client")

    # A starts a (dry-run) deploy and captures the jobId.
    r = ca.post("/api/deploy", json={"connection": CFG, "sql": SQL, "dryRun": True})
    assert r.status_code == 202
    job_id = r.get_json()["jobId"]

    # A reads their OWN job — allowed, and the owner ids are never exposed.
    ra = ca.get("/api/deploy/status/%s" % job_id)
    assert ra.status_code == 200
    job_a = ra.get_json()["job"]
    assert job_a["id"] == job_id and job_a["server"] == "SERVER-A"
    assert "owner" not in job_a

    # B requests A's jobId — must be 404 with NO job payload (no server/db/finalSql/log leak).
    rb = cb.get("/api/deploy/status/%s" % job_id)
    assert rb.status_code == 404
    body_b = rb.get_json()
    assert body_b["ok"] is False and "job" not in body_b


def test_deploy_status_requires_auth_and_active_client(app):
    c = app.test_client()
    assert c.get("/api/deploy/status/deadbeefcafe").status_code == 401     # unauth
    c.post("/api/auth/signup", json={"email": "sec003_noc@example.com", "password": "password123", "name": "N"})
    assert c.get("/api/deploy/status/deadbeefcafe").status_code == 409     # no active client


def test_start_deploy_requires_active_client(app):
    c = app.test_client()
    c.post("/api/auth/signup", json={"email": "sec003_noc2@example.com", "password": "password123", "name": "N"})
    r = c.post("/api/deploy", json={"connection": CFG, "sql": SQL, "dryRun": True})
    assert r.status_code == 409
