"""Admin user management + closed-signup tests.

CSRF is disabled by conftest, so mutating admin calls need no token here.
The multi-tenant DB is a shared session temp file (conftest), so each test uses
unique emails to avoid cross-test collisions.
"""
from app import create_app
from app.db.app_db import connect
from app.services import ai_usage_logger


def _admin(monkeypatch, email, pw="adminpass123"):
    """Bootstrap an admin via env, return a logged-in test client for it."""
    monkeypatch.setenv("AIMS_ADMIN_EMAIL", email)
    monkeypatch.setenv("AIMS_ADMIN_PASSWORD", pw)
    app = create_app()                      # ensure_admin() seeds/promotes the admin
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.get_data(as_text=True)
    return c


def _user_client():
    return create_app().test_client()


# --------------------------- closed signup --------------------------- #

def test_signup_disabled_returns_403():
    app = create_app()
    app.config["SIGNUP_ENABLED"] = False    # production default (conftest turns it on)
    c = app.test_client()
    r = c.post("/api/auth/signup", json={"email": "nope@example.com", "password": "password123"})
    assert r.status_code == 403
    assert r.get_json()["ok"] is False


# --------------------------- admin bootstrap --------------------------- #

def test_admin_bootstrap_creates_admin(monkeypatch):
    c = _admin(monkeypatch, "boot@example.com")
    me = c.get("/api/auth/me").get_json()
    assert me["ok"] is True and me["user"]["isAdmin"] is True


def test_admin_bootstrap_promotes_existing(monkeypatch):
    # Pre-create a normal account via signup, then bootstrap the same email as admin.
    _user_client().post("/api/auth/signup",
                        json={"email": "promote@example.com", "password": "password123", "name": "P"})
    c = _admin(monkeypatch, "promote@example.com", "password123")
    assert c.get("/api/auth/me").get_json()["user"]["isAdmin"] is True


# --------------------------- authorization --------------------------- #

def test_non_admin_cannot_access_admin_api():
    c = _user_client()
    c.post("/api/auth/signup", json={"email": "plain@example.com", "password": "password123", "name": "U"})
    assert c.get("/api/admin/users").status_code == 403
    assert c.post("/api/admin/users", json={"email": "x@example.com", "password": "password123"}).status_code == 403


def test_unauthenticated_admin_api_is_401():
    assert create_app().test_client().get("/api/admin/users").status_code == 401


# --------------------------- create / login --------------------------- #

def test_admin_creates_user_who_can_login(monkeypatch):
    admin = _admin(monkeypatch, "creator@example.com")
    r = admin.post("/api/admin/users",
                   json={"email": "made@example.com", "password": "password123", "name": "Made"})
    assert r.status_code == 201 and r.get_json()["ok"] is True
    # the created account is a STANDARD user...
    assert r.get_json()["user"]["isAdmin"] is False
    # ...and can log in.
    login = _user_client().post("/api/auth/login", json={"email": "made@example.com", "password": "password123"})
    assert login.status_code == 200

    # duplicate email -> 409
    dup = admin.post("/api/admin/users", json={"email": "made@example.com", "password": "password123"})
    assert dup.status_code == 409


# --------------------------- delete cascades everything --------------------------- #

def test_delete_user_purges_all_their_data(monkeypatch):
    admin = _admin(monkeypatch, "purger@example.com")
    made = admin.post("/api/admin/users",
                      json={"email": "victim@example.com", "password": "password123", "name": "V"}).get_json()
    uid = made["user"]["id"]

    # The victim logs in, creates a client, writes a tenant doc; seed a usage-log row.
    v = _user_client()
    v.post("/api/auth/login", json={"email": "victim@example.com", "password": "password123"})
    cid = v.post("/api/clients", json={"name": "Victim WS"}).get_json()["client"]["id"]
    v.put("/api/state/ai_mappings", json={"value": [{"id": "M1"}]})
    ai_usage_logger._insert({
        "call_timestamp": "2026-08-14T10:00:00+00:00", "feature_name": "F", "model": "m",
        "input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "duration_ms": 1,
        "status": "success", "error_message": None, "user_id": uid, "client_id": cid})

    # sanity: data exists
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) c FROM clients WHERE user_id=?", (uid,)).fetchone()["c"] == 1
        assert conn.execute("SELECT COUNT(*) c FROM tenant_documents WHERE user_id=?", (uid,)).fetchone()["c"] >= 1
    finally:
        conn.close()
    assert ai_usage_logger.summary(uid, cid)["overall"]["total_calls"] == 1

    # admin deletes the victim
    r = admin.delete("/api/admin/users/%d" % uid)
    assert r.status_code == 200 and r.get_json()["ok"] is True

    # everything is gone
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) c FROM users WHERE id=?", (uid,)).fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) c FROM clients WHERE user_id=?", (uid,)).fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) c FROM tenant_documents WHERE user_id=?", (uid,)).fetchone()["c"] == 0
    finally:
        conn.close()
    assert ai_usage_logger.summary(uid, cid)["overall"]["total_calls"] == 0
    # the victim can no longer log in
    assert _user_client().post("/api/auth/login",
                               json={"email": "victim@example.com", "password": "password123"}).status_code == 401


# --------------------------- delete guards --------------------------- #

def test_admin_cannot_delete_self(monkeypatch):
    admin = _admin(monkeypatch, "self@example.com")
    uid = admin.get("/api/auth/me").get_json()["user"]["id"]
    r = admin.delete("/api/admin/users/%d" % uid)
    assert r.status_code == 400


def test_admin_cannot_delete_another_admin(monkeypatch):
    admin = _admin(monkeypatch, "chief@example.com")
    other = admin.post("/api/admin/users",
                       json={"email": "second@example.com", "password": "password123"}).get_json()["user"]["id"]
    # promote the second account to admin directly, then try to delete it
    conn = connect()
    try:
        conn.execute("UPDATE users SET is_admin=1 WHERE id=?", (other,))
        conn.commit()
    finally:
        conn.close()
    r = admin.delete("/api/admin/users/%d" % other)
    assert r.status_code == 400
