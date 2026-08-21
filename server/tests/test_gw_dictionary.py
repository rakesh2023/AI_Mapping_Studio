"""Guidewire HTML dictionary parser + zip import (entities -> source tables,
typelists -> lookup sets)."""
import io
import zipfile

from app.parsers.gw_dictionary import parse_gw_entity, parse_gw_typelist, iter_zip_html
from app.services import extraction_service as X
from app.services import auth_service as A
from app.services import client_service as C
from app.services import lookup_service as L


ENTITY_HTML = """<html><head><title>Account</title></head><body>
<div class="pagetitle">Account <span class="entityname">(cc_account) (delegates to <A HREF="Retireable.html">Retireable</A>)</span></div>
<div class="desc"><b>Description</b><div id="refbox_80" class="refbox_inner">Customer account.</div></div>
<a name="Fields"></a><div class="arraysbox">Fields</div>
<p class="column"><span class="coltitle">ID</span>&nbsp;&nbsp;<span class="titleDesc"><span class='defPopupLink'>key</span></span>
<span class = "spaceandsize">(non-null)<sup><span>?</span></sup></span><br><span class="desc">PK</span>
<p class="column"><span class="coltitle">AccountHolder</span>&nbsp;&nbsp;<span class="titleDesc">foreign key to <A HREF="Contact.html">Contact</A></span>
<span class = "spaceandsize">(database column: AccountHolderID)&nbsp;&nbsp;(non-null)</span><br><span class="desc"></span>
<p class="column"><span class="coltitle">AccountNumber</span>&nbsp;&nbsp;<span class="titleDesc"><span class='defPopupLink'>shorttext</span> (255)</span>
<span class = "spaceandsize">(exportable)&nbsp;&nbsp;(non-null)</span><br><span class="desc">The account number</span>
</body></html>"""

TYPELIST_HTML = """<html><head><title>AccidentPremises</title></head><body>
<div><span class="pagetitle">AccidentPremises</span> <span class="entityname">(cctl_accidentpremises)</span></div>
<div class="desc">A code for premises.</div>
<div class="arraysbox">Typecodes</div>
<table class="typelistbody"><tr class="typelistheader"><td>Code</td><td>Name</td><td>Description</td></tr>
<tr><td><a href=#Employer>Employer</a></td><td>Employer</td><td>Employer desc</td></tr>
<tr><td>Lessee</td><td>Lessee</td><td>Lessee desc</td></tr>
</table>
<div class="arraysbox">Localizations</div>
<table class="typelistbody"><tr><td>en_US</td><td>x</td><td>y</td></tr></table>
</body></html>"""

SECURITY_HTML = "<html><body><div class='pagetitle'>SomePermission</div><table><tr><td>a</td></tr></table></body></html>"


def test_parse_entity():
    ent = parse_gw_entity(ENTITY_HTML)
    assert ent["name"] == "Account" and ent["physical"] == "cc_account"
    assert ent["description"] == "Customer account."
    by = {c["name"]: c for c in ent["columns"]}
    assert by["ID"]["pk"] is True and by["ID"]["mandatory"] is True
    assert by["AccountHolder"]["fk"] is True and by["AccountHolder"]["fkReference"] == "Contact"
    assert by["AccountHolder"]["dbColumn"] == "AccountHolderID"
    assert by["AccountNumber"]["dataType"] == "shorttext" and by["AccountNumber"]["length"] == 255
    assert by["AccountNumber"]["description"] == "The account number"


def test_parse_typelist():
    tl = parse_gw_typelist(TYPELIST_HTML)
    assert tl["name"] == "AccidentPremises" and tl["physical"] == "cctl_accidentpremises"
    assert [(v["code"], v["description"]) for v in tl["values"]] == \
        [("Employer", "Employer desc"), ("Lessee", "Lessee desc")]


def test_entity_parser_ignores_typelist_and_security():
    assert parse_gw_entity(TYPELIST_HTML) is None
    assert parse_gw_entity(SECURITY_HTML) is None
    assert parse_gw_typelist(ENTITY_HTML) is None


def _zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path, text in entries.items():
            z.writestr(path, text)
    return buf.getvalue()


def test_extract_gw_zip_prefers_db_view():
    z = _zip({
        "d/data/data/db/Account.html": ENTITY_HTML,
        "d/data/data/full/Account.html": ENTITY_HTML,          # skipped (physical view)
        "d/data/data/typelist/AccidentPremises_tl.html": TYPELIST_HTML,  # not a table
        "d/security/pages/Perm.html": SECURITY_HTML,           # skipped (no fields)
    })
    tables, stats = X.extract_gw_zip(z)
    assert stats["tables"] == 1 and tables[0]["name"] == "cc_account"
    # physical view: FK column carries its physical DB column name
    names = [c["name"] for c in tables[0]["columns"]]
    assert "AccountHolderID" in names and "AccountNumber" in names


def test_iter_zip_html_filters_non_html():
    z = _zip({"a/x.html": "<i>hi</i>", "a/y.txt": "nope", "a/z.htm": "<b>ok</b>"})
    got = sorted(p for p, _ in iter_zip_html(z))
    assert got == ["a/x.html", "a/z.htm"]


def _uc(email, cname):
    uid = A.signup(email, "password123", "U")[0]["user"]["id"]
    cid = C.create_client(uid, cname, "", {})[0]["client"]["id"]
    return uid, cid


POLICY_TL_HTML = """<html><head><title>PolicyType</title></head><body>
<div><span class="pagetitle">PolicyType</span> <span class="entityname">(pctl_policytype)</span></div>
<div class="arraysbox">Typecodes</div>
<table class="typelistbody"><tr class="typelistheader"><td>Code</td><td>Name</td><td>Description</td></tr>
<tr><td>Auto</td><td>Auto</td><td>Auto policy</td></tr>
</table></body></html>"""


def test_import_typelists_from_zip_as_lookups():
    uid, cid = _uc("gwtl@example.com", "GWTL")
    z = _zip({
        "d/data/data/typelist/AccidentPremises_tl.html": TYPELIST_HTML,
        "d/data/data/db/Account.html": ENTITY_HTML,   # entity ignored by typelist import
    })
    p, s = L.import_document(uid, cid, "dictionary.zip", z, "zip")
    assert s == 200 and p["ok"] and p["created"] == 1 and p["totalValues"] == 2
    sets = L.list_sets(uid, cid)[0]["sets"]
    m = [x for x in sets if x["lookupName"] == "cctl_accidentpremises"][0]
    vals = L.get_values(uid, cid, m["id"])[0]["values"]
    assert [v["code"] for v in vals] == ["Employer", "Lessee"]


def test_import_typelists_filtered_by_product():
    uid, cid = _uc("gwprod@example.com", "GWPROD")
    z = _zip({
        "d/data/data/typelist/AccidentPremises_tl.html": TYPELIST_HTML,   # cctl_
        "d/data/data/typelist/PolicyType_tl.html": POLICY_TL_HTML,        # pctl_
    })
    # Claim -> only the cctl_ typelist
    p, s = L.import_document(uid, cid, "dict.zip", z, "zip", product="claim")
    assert s == 200 and p["created"] == 1 and p["skippedRows"] == 1
    assert L.list_sets(uid, cid)[0]["sets"][0]["lookupName"] == "cctl_accidentpremises"

    # Policy -> only the pctl_ typelist (new tenant to keep it clean)
    uid2, cid2 = _uc("gwprod2@example.com", "GWPROD2")
    p2, s2 = L.import_document(uid2, cid2, "dict.zip", z, "zip", product="policy")
    assert s2 == 200 and p2["created"] == 1
    assert L.list_sets(uid2, cid2)[0]["sets"][0]["lookupName"] == "pctl_policytype"
