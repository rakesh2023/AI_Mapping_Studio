"""Unit tests for ai_fix_service with a mocked Anthropic client."""
import types

from app.services import ai_fix_service as fx


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
            def stream(**kw):
                _client.last_kwargs = kw   # capture to assert no creds leak
                return _Stream(_Msg(reply, refusal))
    return C()


def test_fix_returns_corrected_batch(monkeypatch):
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client("IF NOT EXISTS (...) CREATE TABLE [dbo].[t] (id int)"))
    out = fx.fix_batch("CREATE TABLE [dbo].[t] (id int)", {"number": 2714, "message": "already an object named 't'", "line": 1})
    assert out["ok"] is True and "CREATE TABLE" in out["batch"]


def test_fix_strips_fences(monkeypatch):
    # fix differs from the input (adds the missing type) and is wrapped in a fence
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client("```sql\nALTER TABLE t ADD c int NOT NULL\n```"))
    out = fx.fix_batch("ALTER TABLE t ADD c", {"number": 102, "message": "syntax"})
    assert out["ok"] is True and out["batch"].startswith("ALTER TABLE")
    assert "```" not in out["batch"]


def test_fix_prompt_contains_no_credentials(monkeypatch):
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client("SELECT 1"))
    fx.fix_batch("SELECT 1", {"number": 1, "message": "boom", "line": 1})
    blob = repr(_client.last_kwargs)
    assert "password" not in blob and "secret" not in blob and "PWD=" not in blob


def test_fix_refusal(monkeypatch):
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client("", refusal=True))
    out = fx.fix_batch("SELECT 1", {"message": "x"})
    assert out["ok"] is False


def test_fix_empty_batch():
    out = fx.fix_batch("", {"message": "x"})
    assert out["ok"] is False


def test_fix_rejects_prose_refusal(monkeypatch):
    # model declines with prose instead of SQL -> must NOT be treated as a fix
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client("I don't have enough information to correct this batch reliably."))
    out = fx.fix_batch("SELECT * FROM __nope", {"number": 208, "message": "Invalid object name"})
    assert out["ok"] is False


def test_fix_rejects_unchanged_batch(monkeypatch):
    batch = "SELECT * FROM __nope"
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client(batch))   # returns it verbatim
    out = fx.fix_batch(batch, {"number": 208, "message": "Invalid object name"})
    assert out["ok"] is False and "unchanged" in out["error"].lower()


def test_fix_salvages_sql_after_prose(monkeypatch):
    # Model prefixes a sentence before the SQL -> we must still salvage the fix.
    reply = ("The problem is a missing comma. Here is the corrected batch:\n\n"
             "CREATE TABLE [dbo].[t] (\n  [a] int NULL,\n  [b] int NULL\n);")
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client(reply))
    out = fx.fix_batch("CREATE TABLE [dbo].[t] ( [a] int NULL [b] int NULL );",
                       {"number": 102, "message": "Incorrect syntax near '['"})
    assert out["ok"] is True
    assert out["batch"].startswith("CREATE TABLE")
    assert "The problem is" not in out["batch"]


def test_fix_salvages_sql_from_fenced_block_after_prose(monkeypatch):
    reply = "Sure — here's the fix:\n\n```sql\nALTER TABLE t ADD c int NOT NULL\n```\nLet me know!"
    monkeypatch.setattr(fx, "anthropic_client", lambda: _client(reply))
    out = fx.fix_batch("ALTER TABLE t ADD c", {"number": 102, "message": "syntax"})
    assert out["ok"] is True and out["batch"].startswith("ALTER TABLE")
    assert "```" not in out["batch"] and "Sure" not in out["batch"]
