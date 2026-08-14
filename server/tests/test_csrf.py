"""SEC-005 regression: double-submit CSRF protection on state-changing endpoints.

Matrix row T11: with CSRF enabled, a mutating /api/* request without a valid
X-CSRF-Token (matching the csrf_token cookie) is rejected 403; legitimate
same-origin requests carrying the token succeed; the /api/auth/* bootstrap is
exempt; and a GET issues the readable csrf_token cookie.

CSRF is disabled for the rest of the suite (conftest) so those token-less route
tests keep working; here we turn it back on to exercise real enforcement.
"""
import pytest

from app import create_app


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("AIMS_CSRF_ENABLED", "1")   # enable the guard for this file only
    return create_app()


def _csrf_from(resp):
    """Pull the csrf_token value out of a response's Set-Cookie header, or None."""
    for h in resp.headers.getlist("Set-Cookie"):
        if h.startswith("csrf_token="):
            return h.split(";", 1)[0].split("=", 1)[1]
    return None


def _signup(c, email):
    """Signup (CSRF-exempt) -> logs in and receives the csrf_token cookie. Returns the token."""
    r = c.post("/api/auth/signup", json={"email": email, "password": "password123", "name": "U"})
    assert r.status_code == 201
    return _csrf_from(r)


def test_get_issues_csrf_cookie(app):
    c = app.test_client()
    r = c.get("/login")                       # public page GET
    assert "csrf_token=" in "".join(r.headers.getlist("Set-Cookie"))


def test_mutating_request_without_token_is_rejected(app):
    c = app.test_client()
    _signup(c, "csrf_a@example.com")          # client now holds the csrf cookie
    r = c.put("/api/state/ai_mappings", json={"value": []})   # no X-CSRF-Token header
    assert r.status_code == 403
    assert "csrf" in r.get_json()["error"].lower()


def test_mutating_request_with_mismatched_token_is_rejected(app):
    c = app.test_client()
    token = _signup(c, "csrf_b@example.com")
    r = c.post("/api/clients", json={"name": "C", "config": {}},
               headers={"X-CSRF-Token": "not-" + (token or "x")})
    assert r.status_code == 403


def test_mutating_request_with_valid_token_passes(app):
    c = app.test_client()
    token = _signup(c, "csrf_c@example.com")
    # cookie (held by the client) == header -> allowed through to the route
    r = c.post("/api/clients", json={"name": "C", "config": {}},
               headers={"X-CSRF-Token": token})
    assert r.status_code == 201
    r2 = c.put("/api/state/ai_mappings", json={"value": [{"id": "AI-1"}]},
               headers={"X-CSRF-Token": token})
    assert r2.status_code == 200


def test_auth_endpoints_are_exempt(app):
    c = app.test_client()
    _signup(c, "csrf_d@example.com")
    assert c.post("/api/auth/logout").status_code == 200         # POST, no token, still ok
    r = c.post("/api/auth/login", json={"email": "csrf_d@example.com", "password": "password123"})
    assert r.status_code == 200                                  # login exempt (runs pre-token)


def test_unauth_mutating_still_401_not_403(app):
    # The auth gate runs first: no session -> 401 (not a CSRF 403).
    c = app.test_client()
    c.get("/login")                                              # get a csrf cookie but no session
    r = c.put("/api/state/ai_mappings", json={"value": []},
              headers={"X-CSRF-Token": "anything"})
    assert r.status_code == 401
