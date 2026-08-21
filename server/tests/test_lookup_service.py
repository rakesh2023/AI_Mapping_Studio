"""Unit tests for lookup_service — set store, values, value mappings, scoping,
idempotency + manual-override preservation, cascade, run audit."""
from app.services import auth_service as A
from app.services import client_service as C
from app.services import lookup_service as L
from app.db.app_db import connect


def _uc(email, cname):
    uid = A.signup(email, "password123", "U")[0]["user"]["id"]
    cid = C.create_client(uid, cname, "", {})[0]["client"]["id"]
    return uid, cid


def test_save_and_read_set():
    uid, cid = _uc("lk1@example.com", "LK1")
    vals = [{"code": "1", "description": "Open"}, {"code": "2", "description": "Closed"},
            {"code": "3", "description": "Draft"}]
    p, s = L.save_lookup_set(uid, cid, "Claim_status", vals,
                             source_table="Claim_folder", source_column="Claim_status",
                             target_table="Claim", target_column="State")
    assert s == 200 and p["ok"] and p["valueCount"] == 3
    sid = p["set"]["id"]
    assert p["set"]["targetColumn"] == "State" and p["set"]["sourceColumn"] == "Claim_status"

    got, _ = L.get_values(uid, cid, sid)
    assert [v["code"] for v in got["values"]] == ["1", "2", "3"]
    sets, _ = L.list_sets(uid, cid)
    assert len(sets["sets"]) == 1 and sets["sets"][0]["valueCount"] == 3


def test_resave_bumps_version_and_replaces_values_preserving_binding():
    uid, cid = _uc("lk2@example.com", "LK2")
    L.save_lookup_set(uid, cid, "YES_NO", [{"code": "Y", "description": "Yes"}, {"code": "N", "description": "No"}],
                      target_column="ActiveFlag")
    p, _ = L.save_lookup_set(uid, cid, "YES_NO",
                             [{"code": "Y", "description": "Yes"}, {"code": "N", "description": "No"},
                              {"code": "U", "description": "Unknown"}])
    assert p["set"]["version"] == 2 and p["valueCount"] == 3
    assert p["set"]["targetColumn"] == "ActiveFlag"   # binding preserved when re-saved without it
    got, _ = L.get_values(uid, cid, p["set"]["id"])
    assert len(got["values"]) == 3


def test_dedupe_source_codes_warns():
    uid, cid = _uc("lk3@example.com", "LK3")
    p, _ = L.save_lookup_set(uid, cid, "DUP",
                             [{"code": "1", "description": "Open"}, {"code": "1", "description": "dup"},
                              {"code": "2", "description": "Closed"}])
    assert p["valueCount"] == 2 and p["duplicatesDropped"] == 1


def test_cross_tenant_isolation():
    ua, ca = _uc("lka@example.com", "A")
    ub, cb = _uc("lkb@example.com", "B")
    sid = L.save_lookup_set(ua, ca, "S", [{"code": "1", "description": "x"}])[0]["set"]["id"]
    assert L.list_sets(ub, cb)[0]["sets"] == []
    assert L.get_set(ub, cb, sid)[1] == 404
    assert L.get_values(ub, cb, sid)[1] == 404
    assert L.upsert_value_mapping(ub, cb, sid, {"sourceCode": "1", "targetCode": "y"})[1] == 404


def test_delete_cascades_values_and_mappings():
    uid, cid = _uc("lkd@example.com", "LKD")
    sid = L.save_lookup_set(uid, cid, "S", [{"code": "1", "description": "Open"}])[0]["set"]["id"]
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "open",
                                           "mappingType": "exact", "confidence": 1.0})
    assert len(L.list_value_mappings(uid, cid, sid)[0]["mappings"]) == 1

    p, s = L.delete_set(uid, cid, sid)
    assert s == 200 and p["ok"]
    assert L.get_set(uid, cid, sid)[1] == 404
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) c FROM lookup_values WHERE lookup_set_id=?", (sid,)).fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) c FROM lookup_value_mappings WHERE lookup_set_id=?", (sid,)).fetchone()["c"] == 0
    finally:
        conn.close()


def test_delete_all_sets_clears_tenant_and_cascades():
    uid, cid = _uc("lkall@example.com", "LKALL")
    s1 = L.save_lookup_set(uid, cid, "A", [{"code": "1", "description": "Open"}])[0]["set"]["id"]
    L.save_lookup_set(uid, cid, "B", [{"code": "X", "description": "x"}])
    L.upsert_value_mapping(uid, cid, s1, {"sourceCode": "1", "targetCode": "open"})
    assert len(L.list_sets(uid, cid)[0]["sets"]) == 2

    p, st = L.delete_all_sets(uid, cid)
    assert st == 200 and p["ok"] and p["removed"] == 2
    assert L.list_sets(uid, cid)[0]["sets"] == []
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) c FROM lookup_values WHERE lookup_set_id=?", (s1,)).fetchone()["c"] == 0
        assert conn.execute("SELECT COUNT(*) c FROM lookup_value_mappings WHERE lookup_set_id=?", (s1,)).fetchone()["c"] == 0
    finally:
        conn.close()


def test_delete_all_sets_is_tenant_scoped():
    ua, ca = _uc("lkall_a@example.com", "AA")
    ub, cb = _uc("lkall_b@example.com", "BB")
    L.save_lookup_set(ua, ca, "S", [{"code": "1", "description": "x"}])
    L.save_lookup_set(ub, cb, "S", [{"code": "1", "description": "x"}])
    p, _ = L.delete_all_sets(ua, ca)
    assert p["removed"] == 1
    assert len(L.list_sets(ub, cb)[0]["sets"]) == 1   # other tenant untouched


def test_value_mapping_idempotent_and_preserves_override():
    uid, cid = _uc("lkm@example.com", "LKM")
    sid = L.save_lookup_set(uid, cid, "S", [{"code": "1", "description": "Open"}])[0]["set"]["id"]
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "open",
                                           "mappingType": "semantic", "confidence": 0.8})
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "open",
                                           "mappingType": "semantic", "confidence": 0.9})
    ms = L.list_value_mappings(uid, cid, sid)[0]["mappings"]
    assert len(ms) == 1 and ms[0]["confidence"] == 0.9         # updated in place, no duplicate

    # mark manual override; a non-force upsert must NOT overwrite it
    L.set_value_mapping_override(uid, cid, ms[0]["id"], "closed", "Closed", reviewed_by=uid)
    p, _ = L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "draft",
                                                  "mappingType": "semantic", "confidence": 0.5})
    assert p.get("skipped") is True
    ms = L.list_value_mappings(uid, cid, sid)[0]["mappings"]
    assert ms[0]["targetCode"] == "closed" and ms[0]["mappingType"] == "manual_override" and ms[0]["isReviewed"] is True

    # force overwrites even a reviewed row
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "1", "targetCode": "draft",
                                           "mappingType": "semantic", "confidence": 0.5}, force=True)
    ms = L.list_value_mappings(uid, cid, sid)[0]["mappings"]
    assert ms[0]["targetCode"] == "draft"


def test_invalid_mapping_type_coerced_to_unmapped():
    uid, cid = _uc("lkt@example.com", "LKT")
    sid = L.save_lookup_set(uid, cid, "S", [{"code": "9", "description": "Xfer-Legacy"}])[0]["set"]["id"]
    L.upsert_value_mapping(uid, cid, sid, {"sourceCode": "9", "mappingType": "bogus"})
    ms = L.list_value_mappings(uid, cid, sid)[0]["mappings"]
    assert ms[0]["mappingType"] == "unmapped"


import types


class _Msg:
    def __init__(self, text):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "end_turn"
        self.usage = None
        self.model = "test-model"


class _Stream:
    def __init__(self, m): self._m = m
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self._m


def _mock_client(reply):
    class C:
        class messages:
            @staticmethod
            def stream(**kw): return _Stream(_Msg(reply))
    return C()


def test_import_document_ai_fallback(monkeypatch):
    uid, cid = _uc("lkai@example.com", "LKAI")
    reply = ('{"sets":[{"lookupName":"Claim_status","sourceTable":"Claim_folder",'
             '"sourceColumn":"Claim_status","targetTable":"Claim","targetColumn":"State",'
             '"values":[{"code":"1","description":"Open"},{"code":"2","description":"Closed"}]}]}')
    monkeypatch.setattr(L, "anthropic_client", lambda: _mock_client(reply))
    # A .txt with prose the deterministic parser can't table-parse -> AI fallback runs.
    p, s = L.import_document(uid, cid, "claim_lookups.txt",
                             b"Claim status codes: 1 Open, 2 Closed. Maps to Claim.State.", "txt")
    assert s == 200 and p["ok"] and p["created"] == 1 and p.get("extractedByAI") is True
    sets = L.list_sets(uid, cid)[0]["sets"]
    assert any(x["sourceColumn"] == "Claim_status" and x["targetColumn"] == "State" for x in sets)


def test_import_expected_value_document():
    uid, cid = _uc("lkexp@example.com", "LKEXP")
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in [["LookupName", "Source Table", "Source column", "Target table", "Target column", "Expected value"],
              ["Claim status", "Claim_folder", "Claim_status", "Claim", "State", "1 then open, 2 then closed"]]:
        w.writerow(r)
    p, s = L.import_document(uid, cid, "lk.csv", buf.getvalue().encode("utf-8"), "csv")
    assert s == 200 and p["ok"] and p["created"] == 1
    # lookup name is always TargetTable_TargetColumn (not the file's LookupName).
    m = [x for x in L.list_sets(uid, cid)[0]["sets"] if x["lookupName"] == "Claim_State"][0]
    assert "1 then open" in m["targetValuesSpec"] and m["sourceColumn"] == "Claim_status" and m["targetColumn"] == "State"


def test_split_dotted_binding_recovers_table():
    s = {"targetTable": "", "targetColumn": "Claim.State", "sourceTable": "", "sourceColumn": "cf.status"}
    L._split_dotted_binding(s)
    assert s["targetTable"] == "Claim" and s["targetColumn"] == "State"
    assert s["sourceTable"] == "cf" and s["sourceColumn"] == "status"
    # a plain column with an existing table is left untouched
    s2 = {"targetTable": "Claim", "targetColumn": "State"}
    L._split_dotted_binding(s2)
    assert s2["targetTable"] == "Claim" and s2["targetColumn"] == "State"


def test_target_lookup_name_rule():
    assert L.target_lookup_name("Claim", "State") == "Claim_State"
    assert L.target_lookup_name("", "State") == "State"
    assert L.target_lookup_name(None, None, fallback="Claim_status") == "Claim_status"


def test_snapshot_all_returns_sets_with_values():
    uid, cid = _uc("lksnap@example.com", "LKSNAP")
    L.save_lookup_set(uid, cid, "A", [{"code": "1", "description": "Open"}, {"code": "2", "description": "Closed"}])
    L.save_lookup_set(uid, cid, "B", [{"code": "X", "description": "x"}])
    p, s = L.snapshot_all(uid, cid)
    assert s == 200 and p["ok"] and p.get("at")
    by = {x["lookupName"]: x for x in p["sets"]}
    assert [v["code"] for v in by["A"]["values"]] == ["1", "2"]
    assert [v["code"] for v in by["B"]["values"]] == ["X"]


def test_log_run_inserts():
    uid, cid = _uc("lkr@example.com", "LKR")
    rid = L.log_run(uid, cid, 2, prompt_version="pass2.v1", model="m",
                    input_tokens=10, output_tokens=5, counts={"mapped": 3, "unmapped": 1})
    assert isinstance(rid, int) and rid > 0
