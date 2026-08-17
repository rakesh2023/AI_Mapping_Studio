"""Unit tests for client_service — creation, validation, and cross-user isolation."""
from app.services import auth_service as A
from app.services import client_service as C
from app.services import tenant_store_service as S


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


def test_delete_client_removes_client_and_tenant_data():
    uid = _new_user("del_owner@example.com")
    cid = C.create_client(uid, "ToDelete", "Ins", {})[0]["client"]["id"]
    S.set_doc(uid, cid, "ai_mappings", [{"id": "AI-0001"}])

    p, st = C.delete_client(uid, cid)
    assert st == 200 and p["ok"] and p["deletedId"] == cid

    # Client is gone, and its per-client data cascaded away.
    assert C.get_client(uid, cid) is None
    assert C.list_clients(uid) == []
    assert S.get_bundle(uid, cid) == {}


def test_delete_client_cross_user_rejected():
    uid_a = _new_user("del_a@example.com")
    uid_b = _new_user("del_b@example.com")
    cid_a = C.create_client(uid_a, "A-Only", "Ins", {})[0]["client"]["id"]
    S.set_doc(uid_a, cid_a, "ai_mappings", [{"secret": True}])

    # User B cannot delete User A's client, even with the real id.
    p, st = C.delete_client(uid_b, cid_a)
    assert st == 404 and p["ok"] is False

    # A's client and data are untouched.
    assert C.get_client(uid_a, cid_a)["name"] == "A-Only"
    assert S.get_doc(uid_a, cid_a, "ai_mappings")[0]["value"] == [{"secret": True}]
