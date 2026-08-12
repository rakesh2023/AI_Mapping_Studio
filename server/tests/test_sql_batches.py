"""Unit tests for the GO-batch splitter (pure)."""
from app.parsers.sql_batches import split_sql_batches


def test_empty():
    assert split_sql_batches("") == []
    assert split_sql_batches(None) == []


def test_splits_on_lone_go_case_insensitive():
    script = "USE [db]\nGO\nCREATE TABLE t (id int)\ngo\nSELECT 1"
    assert split_sql_batches(script) == ["USE [db]", "CREATE TABLE t (id int)", "SELECT 1"]


def test_go_with_whitespace_is_a_separator():
    assert split_sql_batches("A\n   GO   \nB") == ["A", "B"]


def test_consecutive_and_trailing_go_drop_blank_batches():
    assert split_sql_batches("A\nGO\nGO\nB\nGO\n") == ["A", "B"]


def test_go_inside_a_line_is_not_a_separator():
    # 'GO' as part of a statement/identifier must NOT split
    script = "SELECT 'GO' AS x, GONE FROM t"
    assert split_sql_batches(script) == ["SELECT 'GO' AS x, GONE FROM t"]


def test_single_batch_no_go():
    assert split_sql_batches("CREATE TABLE t (id int);") == ["CREATE TABLE t (id int);"]
