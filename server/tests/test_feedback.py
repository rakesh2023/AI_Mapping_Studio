"""Feedback: submit (any user) + admin list/status. CSRF disabled by conftest;
shared temp DB, so tests use unique emails."""
from app import create_app
from app.services import auth_service as A
from app.services import feedback_service as F


def _login_user(email, pw="password123"):
    A.signup(email, pw, "FB User")
    c = create_app().test_client()
    assert c.post("/api/auth/login", json={"email": email, "password": pw}).status_code == 200
    return c


def _admin(monkeypatch, email="fbadmin@example.com", pw="adminpass123"):
    monkeypatch.setenv("AIMS_ADMIN_EMAIL", email)
    monkeypatch.setenv("AIMS_ADMIN_PASSWORD", pw)
    c = create_app().test_client()
    assert c.post("/api/auth/login", json={"email": email, "password": pw}).status_code == 200
    return c


# ---- service ----

def test_create_feedback_validation():
    uid = A.signup("fbsvc@example.com", "password123", "S")[0]["user"]["id"]
    p, s = F.create_feedback(uid, "bug", "")                     # empty message rejected
    assert s == 400 and p["ok"] is False
    p, s = F.create_feedback(uid, "weird", "Something odd")      # invalid type -> coerced to 'other'
    assert s == 201 and p["ok"] is True
    top = F.list_feedback()[0]                                   # newest first
    assert top["type"] == "other" and top["message"] == "Something odd"


def test_set_status_validates_and_progresses():
    uid = A.signup("fbstat@example.com", "password123", "S")[0]["user"]["id"]
    fid = F.create_feedback(uid, "suggestion", "Add a dark-mode toggle")[0]["id"]
    p, s = F.set_status(fid, "bogus")
    assert s == 400 and p["ok"] is False
    for st in ("accepted", "in_development", "done", "declined"):
        p, s = F.set_status(fid, st)
        assert s == 200 and p["status"] == st


# ---- routes ----

def test_submit_requires_auth():
    c = create_app().test_client()
    assert c.post("/api/feedback", json={"type": "bug", "message": "x"}).status_code == 401


def test_submit_and_admin_review(monkeypatch):
    user = _login_user("fbsubmit@example.com")
    r = user.post("/api/feedback", json={"type": "bug", "message": "Grid is misaligned",
                                         "page": "#mapping-workspace.html"})
    assert r.status_code == 201 and r.get_json()["ok"] is True

    # a normal user cannot list feedback
    assert user.get("/api/admin/feedback").status_code == 403

    admin = _admin(monkeypatch)
    lst = admin.get("/api/admin/feedback").get_json()
    assert lst["ok"] is True
    mine = [f for f in lst["feedback"] if f["message"] == "Grid is misaligned"]
    assert mine and mine[0]["submitterEmail"] == "fbsubmit@example.com" and mine[0]["status"] == "new"

    # admin progresses the status
    r = admin.post("/api/admin/feedback/%d/status" % mine[0]["id"], json={"status": "in_development"})
    assert r.status_code == 200 and r.get_json()["status"] == "in_development"
