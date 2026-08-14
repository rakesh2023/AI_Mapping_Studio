"""Unit tests for tenant_store_service — round-trip, allowlist, cross-tenant isolation."""
from app.services import auth_service as A
from app.services import client_service as C
from app.services import tenant_store_service as S


def _user_client(email, client_name):
    uid = A.signup(email, "password123", "U")[0]["user"]["id"]
    cid = C.create_client(uid, client_name, "", {})[0]["client"]["id"]
    return uid, cid


def test_set_get_roundtrip_and_bundle():
    uid, cid = _user_client("ts1@example.com", "TS1")
    payload, status = S.set_doc(uid, cid, "ai_mappings", [{"id": "AI-0001"}])
    assert status == 200 and payload["ok"]
    got, st = S.get_doc(uid, cid, "ai_mappings")
    assert st == 200 and got["value"] == [{"id": "AI-0001"}]

    S.set_doc(uid, cid, "business_context", "some rules")
    bundle = S.get_bundle(uid, cid)
    assert bundle["ai_mappings"] == [{"id": "AI-0001"}]
    assert bundle["business_context"] == "some rules"


def test_unknown_doc_key_rejected():
    uid, cid = _user_client("ts2@example.com", "TS2")
    p, s = S.set_doc(uid, cid, "evil_key", {"x": 1})
    assert s == 400 and p["ok"] is False
    p, s = S.get_doc(uid, cid, "evil_key")
    assert s == 400 and p["ok"] is False


def test_get_unset_returns_none():
    uid, cid = _user_client("ts3@example.com", "TS3")
    got, st = S.get_doc(uid, cid, "ai_joins")
    assert st == 200 and got["value"] is None


def test_delete_all_scoped():
    uid, cid = _user_client("ts4@example.com", "TS4")
    S.set_doc(uid, cid, "ai_mappings", [1, 2, 3])
    S.set_doc(uid, cid, "exports", [{"id": "x"}])
    p, st = S.delete_all(uid, cid)
    assert st == 200 and p["removed"] == 2
    assert S.get_bundle(uid, cid) == {}


def test_cross_tenant_isolation():
    uid_a, cid_a = _user_client("tsa@example.com", "A")
    uid_b, cid_b = _user_client("tsb@example.com", "B")
    S.set_doc(uid_a, cid_a, "ai_mappings", [{"secret": True}])

    # User B (different user AND client) sees nothing of A's — even the same doc_key.
    got, _ = S.get_doc(uid_b, cid_b, "ai_mappings")
    assert got["value"] is None
    assert S.get_bundle(uid_b, cid_b) == {}

    # Deleting B's data does not touch A's.
    S.delete_all(uid_b, cid_b)
    assert S.get_doc(uid_a, cid_a, "ai_mappings")[0]["value"] == [{"secret": True}]
