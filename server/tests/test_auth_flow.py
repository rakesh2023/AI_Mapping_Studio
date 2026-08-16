"""Integration tests for the auth guard + session flow via the Flask test client.

Auth is ENABLED here (unlike test_api_routes.py) so we exercise the real gate.
"""
import pytest

from app import create_app


@pytest.fixture
def client():
    return create_app().test_client()   # guard active


def test_guard_redirects_unauth_page_to_login(client):
    r = client.get("/pages/dashboard.html")
    assert r.status_code == 302 and r.headers["Location"].endswith("/login")


def test_guard_blocks_unauth_api_with_401(client):
    r = client.get("/api/ai/status")
    assert r.status_code == 401 and r.get_json()["ok"] is False


def test_public_paths_open(client):
    assert client.get("/login").status_code == 200
    assert client.get("/api/auth/me").status_code == 401   # allowlisted endpoint, but reports not-authed


def test_signup_onboard_then_reach_pages(client):
    r = client.post("/api/auth/signup", json={"email": "flow@example.com", "password": "password123", "name": "Flo"})
    assert r.status_code == 201 and r.get_json()["needsOnboarding"] is True

    # Logged in but no client yet -> app pages bounce to onboarding.
    r = client.get("/pages/dashboard.html")
    assert r.status_code == 302 and r.headers["Location"].endswith("/onboarding")

    # Create the client -> it becomes active -> pages now load.
    r = client.post("/api/clients", json={"name": "FlowCo", "industry": "Ins", "config": {}})
    assert r.status_code == 201 and r.get_json()["ok"]
    assert client.get("/pages/dashboard.html").status_code == 200

    # /api/auth/me reflects the session.
    me = client.get("/api/auth/me").get_json()
    assert me["ok"] and me["user"]["email"] == "flow@example.com"
    assert me["activeClientId"] == r.get_json()["client"]["id"]


def test_login_reports_specific_reason(client):
    client.post("/api/auth/signup", json={"email": "who@example.com", "password": "password123", "name": "W"})
    client.post("/api/auth/logout")

    # Unknown email -> tells the user no such account.
    r = client.post("/api/auth/login", json={"email": "ghost@example.com", "password": "password123"})
    assert r.status_code == 401
    body = r.get_json()
    assert body["reason"] == "no_account" and "No account" in body["error"]

    # Right email, wrong password -> tells the user the password is wrong.
    r = client.post("/api/auth/login", json={"email": "who@example.com", "password": "WRONGpass1"})
    assert r.status_code == 401
    body = r.get_json()
    assert body["reason"] == "bad_password" and "password" in body["error"].lower()

    # Correct credentials still log in.
    r = client.post("/api/auth/login", json={"email": "who@example.com", "password": "password123"})
    assert r.status_code == 200 and r.get_json()["ok"] is True


def test_login_blank_fields_report_what_is_missing(client):
    r = client.post("/api/auth/login", json={"email": "", "password": ""})
    assert r.status_code == 400 and r.get_json()["reason"] == "empty"
    r = client.post("/api/auth/login", json={"email": "x@example.com", "password": ""})
    assert r.status_code == 400 and r.get_json()["reason"] == "empty_password"


def test_logout_clears_session(client):
    client.post("/api/auth/signup", json={"email": "out@example.com", "password": "password123", "name": "O"})
    assert client.get("/api/auth/me").status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_admin_cannot_create_client(client):
    # Create an account, promote it to admin in the DB, then it must not create clients.
    client.post("/api/auth/signup", json={"email": "adm@example.com", "password": "password123", "name": "Adm"})
    from app.db.app_db import connect
    conn = connect()
    try:
        conn.execute("UPDATE users SET is_admin=1 WHERE email=?", ("adm@example.com",))
        conn.commit()
    finally:
        conn.close()
    r = client.post("/api/clients", json={"name": "ShouldFail", "config": {}})
    assert r.status_code == 403 and r.get_json()["ok"] is False


def test_cannot_select_another_users_client(client):
    # User A creates a client.
    ca = create_app().test_client()
    ca.post("/api/auth/signup", json={"email": "sa@example.com", "password": "password123", "name": "A"})
    cid_a = ca.post("/api/clients", json={"name": "SecretCo", "industry": "", "config": {}}).get_json()["client"]["id"]

    # User B (this client) cannot activate A's client id.
    client.post("/api/auth/signup", json={"email": "sb@example.com", "password": "password123", "name": "B"})
    r = client.post("/api/auth/select-client", json={"clientId": cid_a})
    assert r.status_code == 403 and r.get_json()["ok"] is False
