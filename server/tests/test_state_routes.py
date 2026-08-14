"""Integration tests for /api/state — session-scoped, cross-user isolation via HTTP."""
import pytest

from app import create_app


@pytest.fixture
def client():
    return create_app().test_client()   # guard active


def _signup_and_client(c, email, client_name):
    c.post("/api/auth/signup", json={"email": email, "password": "password123", "name": "U"})
    r = c.post("/api/clients", json={"name": client_name, "industry": "", "config": {}})
    return r.get_json()["client"]["id"]


def test_state_requires_auth(client):
    assert client.get("/api/state").status_code == 401
    assert client.put("/api/state/ai_mappings", json={"value": []}).status_code == 401


def test_state_requires_active_client(client):
    client.post("/api/auth/signup", json={"email": "nc@example.com", "password": "password123", "name": "N"})
    r = client.get("/api/state")           # logged in, but no client selected yet
    assert r.status_code == 409


def test_put_get_bundle_delete_roundtrip(client):
    _signup_and_client(client, "rt@example.com", "RT")
    assert client.put("/api/state/ai_mappings", json={"value": [{"id": "AI-0001"}]}).status_code == 200
    r = client.get("/api/state/ai_mappings")
    assert r.status_code == 200 and r.get_json()["value"] == [{"id": "AI-0001"}]
    b = client.get("/api/state").get_json()
    assert b["ok"] and b["state"]["ai_mappings"] == [{"id": "AI-0001"}]
    assert client.delete("/api/state").status_code == 200
    assert client.get("/api/state").get_json()["state"] == {}


def test_unknown_doc_key_rejected_over_http(client):
    _signup_and_client(client, "uk@example.com", "UK")
    assert client.put("/api/state/evil", json={"value": 1}).status_code == 400


def test_cross_user_cannot_read_others_state():
    # User A stores data.
    ca = create_app().test_client()
    _signup_and_client(ca, "sra@example.com", "SRA")
    ca.put("/api/state/ai_mappings", json={"value": [{"secret": 1}]})

    # User B (separate session) sees only their own (empty) state — never A's.
    cb = create_app().test_client()
    _signup_and_client(cb, "srb@example.com", "SRB")
    assert cb.get("/api/state/ai_mappings").get_json()["value"] is None
    assert cb.get("/api/state").get_json()["state"] == {}

    # A's data is intact.
    assert ca.get("/api/state/ai_mappings").get_json()["value"] == [{"secret": 1}]
