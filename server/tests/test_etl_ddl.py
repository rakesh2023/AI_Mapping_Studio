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


def test_generate_ddl_strips_fences(monkeypatch):
    reply = "```sql\nCREATE TABLE [dbo].[cs_activity] ( [activityid] int NOT NULL );\n```"
    monkeypatch.setattr(es, "anthropic_client", lambda: _client(reply))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": COLS})
    assert s == 200 and p["sql"].startswith("CREATE TABLE")


def test_generate_ddl_refusal(monkeypatch):
    monkeypatch.setattr(es, "anthropic_client", lambda: _client("", refusal=True))
    p, s = es.generate_ddl({"targetTable": "cs_activity", "columns": COLS})
    assert s == 400 and "declined" in p["error"].lower()
