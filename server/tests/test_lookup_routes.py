"""API tests for /api/lookups — auth + active-client gating, CRUD, cross-tenant
isolation, PATCH override, and the feature flag. CSRF disabled by conftest."""
from app import create_app
from app.services import auth_service as A
from app.services import lookup_service as L


def _authed(email):
    """Signed-in client WITH an active client selected; returns (client, uid, cid)."""
    uid = A.signup(email, "password123", "U")[0]["user"]["id"]
    c = create_app().test_client()
    c.post("/api/auth/login", json={"email": email, "password": "password123"})
    cid = c.post("/api/clients", json={"name": "WS-" + email}).get_json()["client"]["id"]
    return c, uid, cid


def test_requires_auth():
    c = create_app().test_client()
    assert c.get("/api/lookups").status_code == 401
    assert c.post("/api/lookups", json={"lookupName": "X", "values": [{"code": "1"}]}).status_code == 401


def test_requires_active_client():
    A.signup("lrn@example.com", "password123", "U")
    c = create_app().test_client()
    c.post("/api/auth/login", json={"email": "lrn@example.com", "password": "password123"})
    assert c.get("/api/lookups").status_code == 400   # logged in but no active client


def test_create_list_get_roundtrip():
    c, _, _ = _authed("lr1@example.com")
    r = c.post("/api/lookups", json={
        "lookupName": "Claim_status", "sourceTable": "Claim_folder", "sourceColumn": "Claim_status",
        "targetTable": "Claim", "targetColumn": "State",
        "values": [{"code": "1", "description": "Open"}, {"code": "2", "description": "Closed"}]})
    assert r.status_code == 200 and r.get_json()["ok"]
    sid = r.get_json()["set"]["id"]

    lst = c.get("/api/lookups").get_json()
    assert any(s["id"] == sid and s["targetColumn"] == "State" for s in lst["sets"])

    g = c.get("/api/lookups/%d" % sid).get_json()
    assert g["ok"] and [v["code"] for v in g["values"]] == ["1", "2"]


def test_update_and_delete():
    c, _, _ = _authed("lr2@example.com")
    sid = c.post("/api/lookups", json={"lookupName": "S", "values": [{"code": "1", "description": "x"}]}).get_json()["set"]["id"]
    up = c.put("/api/lookups/%d" % sid, json={"targetColumn": "State"}).get_json()
    assert up["set"]["targetColumn"] == "State"
    assert c.delete("/api/lookups/%d" % sid).status_code == 200
    assert c.get("/api/lookups/%d" % sid).status_code == 404


def test_cross_tenant_isolation():
    ca, _, _ = _authed("lra@example.com")
    sid = ca.post("/api/lookups", json={"lookupName": "S", "values": [{"code": "1", "description": "x"}]}).get_json()["set"]["id"]
    cb, _, _ = _authed("lrb@example.com")
    assert cb.get("/api/lookups/%d" % sid).status_code == 404
    assert cb.delete("/api/lookups/%d" % sid).status_code == 404
    assert not any(s["id"] == sid for s in cb.get("/api/lookups").get_json()["sets"])


def test_patch_value_mapping_override():
    c, uid, cid = _authed("lrp@example.com")
    sid = c.post("/api/lookups", json={"lookupName": "S", "values": [{"code": "1", "description": "Open"}]}).get_json()["set"]["id"]
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "open",
                                           "mappingType": "semantic", "confidence": 0.7})
    mid = L.list_value_mappings(uid, cid, sid)[0]["mappings"][0]["id"]
    r = c.patch("/api/lookups/mappings/%d" % mid, json={"targetCode": "closed", "targetDescription": "Closed"})
    j = r.get_json()
    assert r.status_code == 200 and j["mapping"]["mappingType"] == "manual_override" and j["mapping"]["isReviewed"] is True


def test_upload_document():
    import csv, io
    c, _, _ = _authed("lru@example.com")
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in [["Target table", "Target column", "Source Table", "Source column", "Code", "Description"],
              ["Claim", "State", "Claim_folder", "Claim_status", "1", "Open"],
              ["Claim", "State", "Claim_folder", "Claim_status", "2", "Closed"]]:
        w.writerow(r)
    data = {"file": (io.BytesIO(buf.getvalue().encode("utf-8")), "lk.csv")}
    r = c.post("/api/lookups/upload", data=data, content_type="multipart/form-data")
    j = r.get_json()
    assert r.status_code == 200 and j["ok"] and j["created"] == 1 and j["totalValues"] == 2
    m = [s for s in c.get("/api/lookups").get_json()["sets"] if s["sourceColumn"] == "Claim_status"]
    assert m and m[0]["targetColumn"] == "State"


def test_feature_flag_disabled(monkeypatch):
    monkeypatch.setenv("AIMS_LOOKUP_MAPPING_ENABLED", "0")
    A.signup("lrf@example.com", "password123", "U")
    c = create_app().test_client()          # reads the flag at creation
    c.post("/api/auth/login", json={"email": "lrf@example.com", "password": "password123"})
    assert c.get("/api/lookups").status_code == 404
