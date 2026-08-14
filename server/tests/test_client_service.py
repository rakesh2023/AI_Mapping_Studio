"""Unit tests for client_service — creation, validation, and cross-user isolation."""
from app.services import auth_service as A
from app.services import client_service as C


def _new_user(email):
    payload, _ = A.signup(email, "password123", "U")
    return payload["user"]["id"]


def test_create_list_update_client():
    uid = _new_user("owner1@example.com")
    payload, status = C.create_client(uid, "Acme", "Insurance", {"domain": "Claims"})
    assert status == 201 and payload["ok"]
    cid = payload["client"]["id"]
    assert payload["client"]["config"]["domain"] == "Claims"

    clients = C.list_clients(uid)
    assert len(clients) == 1 and clients[0]["id"] == cid

    up, st = C.update_client(uid, cid, "Acme Corp", "Insurance", {"domain": "Policy"})
    assert st == 200 and up["client"]["name"] == "Acme Corp"
    assert up["client"]["config"]["domain"] == "Policy"


def test_create_requires_name():
    uid = _new_user("owner2@example.com")
    payload, status = C.create_client(uid, "   ", "", {})
    assert status == 400 and payload["ok"] is False


def test_cross_user_isolation():
    uid_a = _new_user("iso_a@example.com")
    uid_b = _new_user("iso_b@example.com")
    payload, _ = C.create_client(uid_a, "A-Client", "Ins", {})
    cid_a = payload["client"]["id"]

    # User B cannot see, fetch, own, or update User A's client — even with the real id.
    assert C.list_clients(uid_b) == []
    assert C.get_client(uid_b, cid_a) is None
    assert C.owns_client(uid_b, cid_a) is False
    up, st = C.update_client(uid_b, cid_a, "Hijacked", "", {})
    assert st == 404 and up["ok"] is False

    # Owner still sees it unchanged.
    assert C.get_client(uid_a, cid_a)["name"] == "A-Client"


def test_duplicate_client_name_per_user_conflicts():
    uid = _new_user("owner3@example.com")
    C.create_client(uid, "Dup", "", {})
    payload, status = C.create_client(uid, "Dup", "", {})
    assert status == 409 and payload["ok"] is False
