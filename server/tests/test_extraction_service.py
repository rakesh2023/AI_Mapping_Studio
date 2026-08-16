"""Unit tests for extraction_service fast-paths and the AI loop (mocked)."""
import io
import json
import types

import pytest

from app.services import extraction_service as ex
from app.core.capabilities import openpyxl


def _xlsx_dict_bytes():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Table", "Column", "Type"])
    ws.append(["POLICY", "PNUM", "varchar"])
    ws.append(["CLAIM", "CNO", "bigint"])
    buf = io.BytesIO(); wb.save(buf)
    return buf.getvalue()


def test_extract_source_empty_file():
    payload, status = ex.extract_source("x.txt", b"")
    assert status == 400 and payload["ok"] is False


def test_extract_source_sql_fast_path():
    sql = b"CREATE TABLE Policy (PID int, PNUM varchar(30)); CREATE TABLE Claim (CID bigint);"
    payload, status = ex.extract_source("s.sql", sql)
    assert status == 200 and payload["model"] == "sql-ddl-parser"
    assert payload["tableCount"] == 2


@pytest.mark.skipif(openpyxl is None, reason="openpyxl not installed")
def test_extract_source_xlsx_dictionary_fast_path():
    payload, status = ex.extract_source("d.xlsx", _xlsx_dict_bytes())
    assert status == 200 and payload["model"] == "xlsx-dictionary-parser"
    assert payload["tableCount"] == 2


def test_extract_source_ai_loop(monkeypatch):
    reply = json.dumps({"tables": [{"name": "CUSTOMER", "columns": [
        {"name": "CUST_ID", "dataType": "int", "length": None,
         "businessTerm": "", "description": "", "sample": ""}]}]})

    class _Msg:
        def __init__(self): self.content = [types.SimpleNamespace(type="text", text=reply)]; self.stop_reason = "end_turn"
    class _S:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self): return _Msg()

    class _C:
        class messages:
            @staticmethod
            def stream(**kw): return _S()
    monkeypatch.setattr(ex, "anthropic_client", lambda: _C())

    payload, status = ex.extract_source("spec.txt", b"TABLE: CUSTOMER\nCUST_ID row data here")
    assert status == 200 and payload["tableCount"] == 1
    assert payload["tables"][0]["name"] == "CUSTOMER"


def test_extract_source_stream_sql_events():
    sql = b"CREATE TABLE T (A int, B varchar(9));"
    events = [json.loads(l) for l in ex.extract_source_stream("s.sql", sql)]
    assert [e["type"] for e in events] == ["start", "progress", "done"]
    assert events[-1]["tableCount"] == 1


def test_extract_source_stream_empty():
    events = [json.loads(l) for l in ex.extract_source_stream("x.txt", b"")]
    assert events[0]["type"] == "error"


def _mock_ai(monkeypatch, reply):
    class _Msg:
        def __init__(self): self.content = [types.SimpleNamespace(type="text", text=reply)]; self.stop_reason = "end_turn"
    class _S:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self): return _Msg()
    class _C:
        class messages:
            @staticmethod
            def stream(**kw): return _S()
    monkeypatch.setattr(ex, "anthropic_client", lambda: _C())


def test_extract_source_rich_detects_pk_fk(monkeypatch):
    reply = json.dumps({"tables": [{"name": "CLAIM", "columns": [
        {"name": "CLAIM_ID", "dataType": "varchar", "length": 20, "mandatory": True, "pk": True,
         "fk": False, "fkReference": None, "businessTerm": "", "description": "claim id", "sample": ""},
        {"name": "POLICY_ID", "dataType": "varchar", "length": 20, "mandatory": True, "pk": False,
         "fk": True, "fkReference": "POLICY.POLICY_ID", "businessTerm": "", "description": "", "sample": ""},
    ]}]})
    _mock_ai(monkeypatch, reply)
    payload, status = ex.extract_source("dict.txt", b"CLAIM data dictionary with keys", rich=True)
    assert status == 200 and payload["tableCount"] == 1
    cols = {c["name"]: c for c in payload["tables"][0]["columns"]}
    assert cols["CLAIM_ID"]["pk"] is True and cols["CLAIM_ID"]["mandatory"] is True
    assert cols["POLICY_ID"]["fk"] is True and cols["POLICY_ID"]["fkReference"] == "POLICY.POLICY_ID"


@pytest.mark.skipif(openpyxl is None, reason="openpyxl not installed")
def test_rich_skips_xlsx_fast_path(monkeypatch):
    # rich=True must bypass the direct xlsx-dictionary parser and use the AI instead.
    reply = json.dumps({"tables": [{"name": "POLICY", "columns": [
        {"name": "PNUM", "dataType": "varchar", "mandatory": True, "pk": True, "fk": False}]}]})
    _mock_ai(monkeypatch, reply)
    payload, status = ex.extract_source("d.xlsx", _xlsx_dict_bytes(), rich=True)
    assert status == 200 and payload["model"] != "xlsx-dictionary-parser"
    assert payload["tables"][0]["columns"][0]["pk"] is True
