"""Unit tests for etl_service.generate_ddl (AI CREATE TABLE) with a mocked client."""
import types

from app.services import etl_service as es


class _Msg:
    def __init__(self, text, refusal=False):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = "refusal" if refusal else "end_turn"


class _Stream:
    def __init__(self, m): self._m = m
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get_final_message(self): return self._m


def _client(reply, refusal=False):
    class C:
        class messages:
            @staticmethod
            def stream(**kw): return _Stream(_Msg(reply, refusal))
    return C()


def _capturing_client(reply, sink):
    """Like _client but records the kwargs (system/messages) passed to stream()."""
    class C:
        class messages:
            @staticmethod
            def stream(**kw):
                sink.append(kw)
                return _Stream(_Msg(reply))
    return C()


COLS = [
    {"name": "activityid", "dataType": "int", "length": None, "mandatory": True, "pk": True},
    {"name": "subject", "dataType": "varchar", "length": 100, "mandatory": False, "pk": False},
    {"name": "claimid", "dataType": "int", "length": None, "mandatory": True, "fk": True, "fkReference": "cs_claim.id"},
]


def test_generate_ddl_requires_table_and_columns():
    p, s = es.generate_ddl({"columns": COLS})
    assert s == 400
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": []})
    assert s == 400


def test_generate_ddl_happy_path(monkeypatch):
    reply = ("CREATE TABLE [dbo].[cs_activity] (\n"
             "  [activityid] int NOT NULL,\n"
             "  [subject] varchar(100) NULL,\n"
             "  [claimid] int NOT NULL,\n"
             "  CONSTRAINT [PK_cs_activity] PRIMARY KEY ([activityid]),\n"
             "  CONSTRAINT [FK_cs_activity_claim] FOREIGN KEY ([claimid]) REFERENCES [cs_claim]([id])\n"
             ");")
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(reply))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "database": "CommonStage",
                            "columns": COLS, "baselineDdl": "…", "instructions": "add PK"})
    assert s == 200 and p["ok"] is True
    assert "CREATE TABLE" in p["sql"]
    assert p["warnings"] == []   # every bracketed identifier is a real column/table/constraint


def test_generate_ddl_flags_hallucinated_column(monkeypatch):
    reply = ("CREATE TABLE [dbo].[cs_activity] (\n"
             "  [activityid] int NOT NULL,\n"
             "  [boguscol] varchar(50) NULL\n"   # not in COLS
             ");")
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(reply))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": COLS, "instructions": "x"})
    assert s == 200 and p["ok"] is True
    assert "boguscol" in [w.lower() for w in p["warnings"]]


def test_generate_ddl_passes_default_to_prompt(monkeypatch):
    # A column's `default` must reach the model so it can emit a DEFAULT constraint.
    cols = [
        {"name": "id", "dataType": "int", "mandatory": True, "pk": True},
        {"name": "created", "dataType": "datetime", "mandatory": True, "default": "GETDATE()"},
        {"name": "status", "dataType": "varchar", "length": 20, "default": "Active"},
        {"name": "publicid", "dataType": "varchar", "length": 20, "default": "auto-generated"},
    ]
    sink = []
    reply = "CREATE TABLE [dbo].[cs_activity] ( [id] int NOT NULL );"
    monkeypatch.setattr(es, "anthropic_client", lambda: _capturing_client(reply, sink))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": cols})
    assert s == 200 and p["ok"] is True
    user_msg = sink[0]["messages"][0]["content"]
    # Real defaults are surfaced; the descriptive placeholder is surfaced too (the
    # prompt instructs the model to skip literal defaults for placeholders).
    assert "DEFAULT: GETDATE()" in user_msg
    assert "DEFAULT: Active" in user_msg
    assert "DEFAULT: auto-generated" in user_msg
    # And the system prompt tells the model how to handle defaults.
    assert "DEFAULT" in sink[0]["system"]


def test_generate_ddl_strips_fences(monkeypatch):
    reply = "```sql\nCREATE TABLE [dbo].[cs_activity] ( [activityid] int NOT NULL );\n```"
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(reply))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": COLS})
    assert s == 200 and p["sql"].startswith("CREATE TABLE")


def test_generate_ddl_refusal(monkeypatch):
    monkeypatch.setattr(es, "anthropic_client", lambda: _client("", refusal=True))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": COLS})
    assert s == 400 and "declined" in p["error"].lower()


# ---- generate_etl: the model habitually prepends USE [db]; we strip it by default ----

_PROC = ("USE [CommonStage]\nGO\nSET ANSI_NULLS ON\nGO\n"
         "ALTER   PROCEDURE [dbo].[INSERT_CommonStage_ACTIVITY]\nAS\nBEGIN\n  SELECT 1;\nEND")
_ETL_BODY = {"targetTable": "CMT_ACTIVITY", "database": "CommonStage",
             "joinCondition": "FROM cs_activity a",
             "mappings": [{"targetColumn": "PMT_ID", "sourceTable": "cs_activity",
                           "sourceColumn": "activityid", "mappingType": "Direct"}]}


def test_generate_etl_strips_leading_use(monkeypatch):
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(_PROC))
    p, s = es.generate_etl(dict(_ETL_BODY))
    assert s == 200 and p["ok"] is True
    assert "USE [" not in p["sql"]
    assert p["sql"].startswith("SET ANSI_NULLS ON")


def test_generate_etl_keeps_use_when_instructed(monkeypatch):
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(_PROC))
    body = dict(_ETL_BODY, instructions="keep the USE [CommonStage] statement at the top")
    p, s = es.generate_etl(body)
    assert s == 200 and p["sql"].startswith("USE [CommonStage]")


# ---- completeness guard: never silently ship a half (truncated) procedure ----

_ETL_BODY3 = {"targetTable": "CMT_ACTIVITY", "database": "CommonStage",
              "joinCondition": "FROM cs_activity a",
              "mappings": [{"targetColumn": "PMT_ID", "sourceTable": "cs_activity", "sourceColumn": "activityid", "mappingType": "Direct"},
                           {"targetColumn": "ClaimNo", "sourceTable": "cs_activity", "sourceColumn": "claimno", "mappingType": "Direct"},
                           {"targetColumn": "Amount", "sourceTable": "cs_activity", "sourceColumn": "amount", "mappingType": "Direct"}]}


def test_generate_etl_uses_mapping_default_even_when_not_mapped(monkeypatch):
    # A 'Not Mapped' column that carries a defaultValue must send that default into the
    # prompt, and the system prompt must tell the model to use it (not NULL).
    body = {"targetTable": "CMT_CLAIM", "database": "CommonStage",
            "joinCondition": "FROM cs_claim c",
            "mappings": [
                {"targetColumn": "PMT_ID", "sourceTable": "cs_claim", "sourceColumn": "id", "mappingType": "Direct"},
                {"targetColumn": "src_upd_dt", "sourceTable": "", "sourceColumn": "",
                 "mappingType": "Not Mapped", "defaultValue": "(getdate())", "nullHandling": "Set NULL"},
            ]}
    sink = []
    reply = ("SET ANSI_NULLS ON\nGO\nCREATE PROCEDURE [dbo].[INSERT_CommonStage_CLAIM]\nAS\nBEGIN\n"
             "  INSERT INTO CMT_CLAIM (PMT_ID, src_upd_dt)\n  SELECT\n"
             "    c.id AS PMT_ID,\n    (getdate()) AS src_upd_dt\n  FROM cs_claim c;\nEND")
    monkeypatch.setattr(es, "anthropic_client", lambda: _capturing_client(reply, sink))
    p, s = es.generate_etl(body)
    assert s == 200 and p["ok"] is True
    user_msg = sink[0]["messages"][0]["content"]
    assert "default=(getdate())" in user_msg          # the default reaches the model
    assert "default=" in sink[0]["system"]            # and the rule to use it is present


def test_generate_etl_complete_has_no_warning(monkeypatch):
    full = ("SET ANSI_NULLS ON\nGO\nCREATE PROCEDURE [dbo].[INSERT_CommonStage_ACTIVITY]\nAS\nBEGIN\n"
            "  INSERT INTO CMT_ACTIVITY (PMT_ID, ClaimNo, Amount)\n  SELECT\n"
            "    a.activityid AS PMT_ID,\n    a.claimno AS ClaimNo,\n    a.amount AS Amount\n  FROM cs_activity a;\nEND")
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(full))
    p, s = es.generate_etl(dict(_ETL_BODY3))
    assert s == 200 and p["ok"] is True
    assert p["warnings"] == [] and not p.get("incomplete")


def test_generate_etl_flags_missing_columns(monkeypatch):
    # Simulate a truncated proc: only the first column made it into the SELECT list.
    half = ("SET ANSI_NULLS ON\nGO\nCREATE PROCEDURE [dbo].[INSERT_CommonStage_ACTIVITY]\nAS\nBEGIN\n"
            "  INSERT INTO CMT_ACTIVITY (PMT_ID)\n  SELECT\n    a.activityid AS PMT_ID\n  FROM cs_activity a;\nEND")
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(half))
    p, s = es.generate_etl(dict(_ETL_BODY3))
    assert s == 200 and p["ok"] is True
    assert p.get("incomplete") is True
    assert set(p["missingColumns"]) == {"ClaimNo", "Amount"}
    assert p["warnings"] and "INCOMPLETE" in p["warnings"][0]


def test_generate_etl_other_dialect_skips_completeness_guard(monkeypatch):
    # Oracle output uses different aliasing; the T-SQL 'AS <col>' guard must NOT
    # false-flag it as incomplete when the user explicitly asked for Oracle.
    oracle = ("CREATE OR REPLACE PROCEDURE INSERT_CommonStage_ACTIVITY AS BEGIN\n"
              "  INSERT INTO CMT_ACTIVITY (PMT_ID, ClaimNo, Amount)\n"
              "  SELECT a.activityid, a.claimno, a.amount FROM cs_activity a;\nEND;")
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(oracle))
    p, s = es.generate_etl(dict(_ETL_BODY3, instructions="generate this in Oracle PL/SQL format"))
    assert s == 200 and p["ok"] is True and not p.get("incomplete")


def test_strip_leading_use_only_first_statement():
    # a USE that is NOT the leading statement is left untouched
    sql = "SET ANSI_NULLS ON\nGO\nUSE [Other]\nGO\nSELECT 1"
    assert es._strip_leading_use(sql) == sql
    # leading USE (with/without trailing GO) is removed
    assert es._strip_leading_use("USE [DB]\nGO\nSELECT 1") == "SELECT 1"
    assert es._strip_leading_use("USE [DB]\nSELECT 1") == "SELECT 1"
