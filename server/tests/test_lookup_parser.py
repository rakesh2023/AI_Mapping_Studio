"""Unit tests for the lookup-document parser (Code/Description shape)."""
import csv
import io

from app.parsers.lookup_parsers import parse_lookup_document


def _csv(rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


def test_parse_code_description_shape():
    raw = _csv([
        ["Target table", "Target column", "Source Table", "Source column", "Code", "Description"],
        ["Claim", "State", "Claim_folder", "Claim_status", "1", "Open"],
        ["Claim", "State", "Claim_folder", "Claim_status", "2", "Closed"],
        ["Claim", "State", "Claim_folder", "Claim_status", "3", "Draft"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and len(out["sets"]) == 1
    s = out["sets"][0]
    assert s["sourceColumn"] == "Claim_status" and s["targetColumn"] == "State" and s["targetTable"] == "Claim"
    assert [v["code"] for v in s["values"]] == ["1", "2", "3"]
    assert out["rowCount"] == 3 and out["skipped"] == 0


def test_parse_groups_multiple_sets_with_header_synonyms():
    raw = _csv([
        ["Tgt Table", "Tgt Col", "Src Table", "Src Col", "CD", "Desc"],
        ["Claim", "State", "Claim_folder", "Claim_status", "1", "Open"],
        ["Policy", "PolType", "Pol", "pol_type_cd", "A", "Auto"],
        ["Policy", "PolType", "Pol", "pol_type_cd", "H", "Home"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and len(out["sets"]) == 2
    assert sorted(s["sourceColumn"] for s in out["sets"]) == ["Claim_status", "pol_type_cd"]


def test_parse_skips_rows_without_code():
    raw = _csv([
        ["Target table", "Target column", "Source Table", "Source column", "Code", "Description"],
        ["Claim", "State", "Claim_folder", "Claim_status", "", "(no code)"],
        ["Claim", "State", "Claim_folder", "Claim_status", "1", "Open"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and out["skipped"] == 1 and out["rowCount"] == 1


def test_parse_missing_headers_errors():
    out = parse_lookup_document(_csv([["Foo", "Bar"], ["a", "b"]]), "csv")
    assert out["ok"] is False


def test_parse_fuzzy_target_table_header():
    # 'Target Table Name' / 'Tgt Col' aren't exact synonyms -> fuzzy fallback resolves them.
    raw = _csv([
        ["Target Table Name", "Tgt Col", "Source Table", "Source column", "Code", "Description"],
        ["Claim", "State", "Claim_folder", "Claim_status", "1", "Open"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and len(out["sets"]) == 1
    s = out["sets"][0]
    assert s["targetTable"] == "Claim" and s["targetColumn"] == "State"


def test_parse_expected_value_mode():
    raw = _csv([
        ["LookupName", "Source Table", "Source column", "Target table", "Target column", "Expected value"],
        ["Claim status", "Claim_folder", "Claim_status", "Claim", "State", "1 then open, 2 then closed, 3 then draft"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and len(out["sets"]) == 1
    s = out["sets"][0]
    assert s["lookupName"] == "Claim status" and s["sourceColumn"] == "Claim_status" and s["targetColumn"] == "State"
    assert "1 then open" in s["expectedValues"] and s["values"] == []


def test_parse_expected_value_merged_rows():
    raw = _csv([
        ["LookupName", "Source Table", "Source column", "Target table", "Target column", "Expected value"],
        ["Claim status", "Claim_folder", "Claim_status", "Claim", "State", "1 then open"],
        ["", "", "", "", "", "2 then closed"],
        ["", "", "", "", "", "3 then draft"],
    ])
    out = parse_lookup_document(raw, "csv")
    assert out["ok"] and len(out["sets"]) == 1
    s = out["sets"][0]
    assert "1 then open" in s["expectedValues"] and "3 then draft" in s["expectedValues"]
