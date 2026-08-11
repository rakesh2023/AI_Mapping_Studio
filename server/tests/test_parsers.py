"""Unit tests for the pure parsers (SQL DDL, text chunking, xlsx dictionary)."""
import io

import pytest

from app.parsers.sql_ddl_parser import parse_sql_ddl
from app.parsers.text_chunking import split_text_chunks, split_by_tables, table_marker
from app.parsers.file_parsers import (
    parse_xlsx_dictionary, xlsx_sheet_chunks, norm_hdr,
)
from app.core.capabilities import openpyxl


# ------------------------------- SQL DDL --------------------------------- #

def test_parse_sql_ddl_basic():
    ddl = """
    CREATE TABLE dbo.Policy (
      POLICY_ID int PRIMARY KEY,
      POLICY_NUMBER varchar(30),
      PREMIUM_AMT decimal(18,2),
      CONSTRAINT fk FOREIGN KEY (POLICY_ID) REFERENCES Other(ID)
    );
    CREATE TABLE Claim ( CLM_NO bigint, DESCR nvarchar(255) );
    """
    tables = parse_sql_ddl(ddl)
    assert [t["name"] for t in tables] == ["Policy", "Claim"]
    pol = tables[0]["columns"]
    # constraint line is skipped; only real columns kept
    assert [c["name"] for c in pol] == ["POLICY_ID", "POLICY_NUMBER", "PREMIUM_AMT"]
    # length parsed, comma inside decimal(18,2) not treated as a column split
    assert pol[1]["dataType"] == "varchar" and pol[1]["length"] == 30
    assert pol[2]["dataType"] == "decimal" and pol[2]["length"] == 18


def test_parse_sql_ddl_strips_schema_qualifier_and_quotes():
    # schema qualifier dropped, brackets stripped (identifiers have no spaces —
    # the name regex stops at whitespace, matching the original behavior)
    tables = parse_sql_ddl('CREATE TABLE [dbo].[MyTable] ( [Id] int );')
    assert tables[0]["name"] == "MyTable"
    assert tables[0]["columns"][0]["name"] == "Id"


def test_parse_sql_ddl_none_when_no_tables():
    assert parse_sql_ddl("SELECT * FROM x;") == []


# ---------------------------- text chunking ------------------------------ #

def test_split_text_chunks_small_returns_single():
    assert split_text_chunks("a\nb") == ["a\nb"]


def test_split_text_chunks_empty():
    assert split_text_chunks("   ") == []


def test_split_text_chunks_respects_size():
    text = "\n".join(f"line{i}" for i in range(1000))
    chunks = split_text_chunks(text, size=100)
    assert len(chunks) > 1
    assert all(len(c) <= 100 for c in chunks)
    # no data lost
    assert "".join(chunks).replace("\n", "") == text.replace("\n", "")


def test_split_by_tables_groups_on_markers():
    text = "\n".join([f"CREATE TABLE T{i} (\n  A int\n);" for i in range(20)])
    chunks = split_by_tables(text, tables_per_chunk=8, max_chars=100000)
    assert len(chunks) == 3   # 20 tables / 8 per chunk = 3 chunks


def test_split_by_tables_falls_back_without_markers():
    text = "just prose with no table markers at all " * 50
    chunks = split_by_tables(text, max_chars=200)
    assert len(chunks) >= 1


def test_table_marker_matches_variants():
    m = table_marker()
    assert m.match("CREATE TABLE Foo (")
    assert m.match("TABLE: Customer")
    assert m.match("ENTITY: Policy")
    assert not m.match("  some regular text")


# --------------------------- xlsx dictionary ----------------------------- #

def test_norm_hdr():
    assert norm_hdr("Table_Name") == "tablename"
    assert norm_hdr("  Data-Type ") == "datatype"


@pytest.mark.skipif(openpyxl is None, reason="openpyxl not installed")
def test_parse_xlsx_dictionary_reads_cells():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Table", "Column", "Data Type", "Length", "Description", "Business Term", "Sample"])
    ws.append(["POLICY", "POLICY_NUMBER", "varchar", "30", "Policy no", "Policy Number", "P1"])
    ws.append(["POLICY", "PREMIUM", "decimal", "18", "Prem", "Premium", "9"])
    ws.append(["CLAIM", "CLM_NO", "bigint", "", "Claim", "Claim No", "7"])
    buf = io.BytesIO(); wb.save(buf)
    tables = parse_xlsx_dictionary(buf.getvalue())
    assert [t["name"] for t in tables] == ["POLICY", "CLAIM"]
    assert len(tables[0]["columns"]) == 2
    col = tables[0]["columns"][0]
    assert col["name"] == "POLICY_NUMBER" and col["dataType"] == "varchar"
    assert col["length"] == 30 and col["businessTerm"] == "Policy Number"


@pytest.mark.skipif(openpyxl is None, reason="openpyxl not installed")
def test_parse_xlsx_dictionary_returns_none_for_raw_data():
    # A sheet with no Table/Column header pair is not a dictionary -> None (AI fallback)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["x", "y", "z"])
    ws.append(["1", "2", "3"])
    buf = io.BytesIO(); wb.save(buf)
    assert parse_xlsx_dictionary(buf.getvalue()) is None


def test_xlsx_sheet_chunks_empty_grid():
    assert xlsx_sheet_chunks("S", []) == []
