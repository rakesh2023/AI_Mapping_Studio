"""reset_client_data clears every per-client store but keeps the client."""
from app.services import auth_service as A
from app.services import client_service as C
from app.services import lookup_service as L
from app.services import tenant_store_service as S


def _uc(email, cname):
    uid = A.signup(email, "password123", "U")[0]["user"]["id"]
    cid = C.create_client(uid, cname, "", {})[0]["client"]["id"]
    return uid, cid


def test_reset_clears_lookups_and_docs_keeps_client():
    uid, cid = _uc("reset1@example.com", "R1")
    L.save_lookup_set(uid, cid, "A", [{"code": "1", "description": "Open"}])
    S.set_doc(uid, cid, "cmt_schema", {"entities": [{"name": "x"}]})
    assert len(L.list_sets(uid, cid)[0]["sets"]) == 1
    assert S.get_doc(uid, cid, "cmt_schema")[0].get("value") is not None

    p, s = C.reset_client_data(uid, cid)
    assert s == 200 and p["ok"]

    assert L.list_sets(uid, cid)[0]["sets"] == []          # lookups cleared
    assert S.get_doc(uid, cid, "cmt_schema")[0].get("value") is None   # tenant doc cleared
    assert C.owns_client(uid, cid) is True                 # client kept


def test_reset_scoped_to_client():
    ua, ca = _uc("reseta@example.com", "RA")
    ub, cb = _uc("resetb@example.com", "RB")
    L.save_lookup_set(ub, cb, "S", [{"code": "1", "description": "x"}])
    C.reset_client_data(ua, ca)
    assert len(L.list_sets(ub, cb)[0]["sets"]) == 1        # other client untouched
