"""Deterministic SQL DDL parser.

LLMs tend to SUMMARISE large/repetitive DDL scripts (dropping tables), so for
SQL scripts we parse every CREATE TABLE ourselves — no truncation, every table.
Pure: string in, list of table dicts out. No Flask, no Anthropic.
"""
import re
from typing import List, Dict, Any

_SQL_TYPE_KEYWORDS = (
    "int", "bigint", "smallint", "tinyint", "bit", "decimal", "numeric", "money",
    "smallmoney", "float", "real", "date", "datetime", "datetime2", "smalldatetime",
    "time", "timestamp", "char", "varchar", "nchar", "nvarchar", "text", "ntext",
    "binary", "varbinary", "image", "uniqueidentifier", "xml", "number", "varchar2",
    "nvarchar2", "clob", "blob", "boolean", "bool", "json", "double", "serial",
)
# non-column lines inside a CREATE TABLE (...) body
_SQL_CONSTRAINT_STARTS = (
    "primary", "foreign", "unique", "constraint", "check", "key", "index",
    "period", ")", "with", "on",
)


def parse_sql_ddl(text: str) -> List[Dict[str, Any]]:
    """Parse CREATE TABLE statements into the source shape.

    Returns a list of {name, columns:[...]} (possibly empty if nothing parsed).
    """
    tables: List[Dict[str, Any]] = []
    # Match: CREATE TABLE [schema.]name ( ... )  — capture the parenthesised body.
    pattern = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\((.*?)\)\s*;",
        re.IGNORECASE | re.DOTALL,
    )
    for m in pattern.finditer(text):
        raw_name = m.group(1).strip().strip('`"[]')
        # keep only the final identifier (drop schema/db qualifiers)
        name = raw_name.split(".")[-1].strip('`"[]')
        body = m.group(2)

        # Split the body on top-level commas (ignore commas inside type parens
        # like DECIMAL(18,2)).
        cols: List[str] = []
        depth = 0
        buf: List[str] = []
        for ch in body:
            if ch == "(":
                depth += 1
                buf.append(ch)
            elif ch == ")":
                depth -= 1
                buf.append(ch)
            elif ch == "," and depth == 0:
                cols.append("".join(buf))
                buf = []
            else:
                buf.append(ch)
        if buf:
            cols.append("".join(buf))

        columns: List[Dict[str, Any]] = []
        for raw_col in cols:
            line = raw_col.strip().strip(",").strip()
            if not line:
                continue
            low = line.lower()
            if low.startswith(_SQL_CONSTRAINT_STARTS):
                continue
            parts = line.split(None, 2)   # col_name, type, rest
            if len(parts) < 2:
                continue
            col_name = parts[0].strip('`"[]')
            type_token = parts[1]
            base_type = type_token.split("(")[0].lower()
            if base_type not in _SQL_TYPE_KEYWORDS:
                # not a recognisable column definition (e.g. a stray constraint)
                continue
            length = None
            lm = re.search(r"\(\s*(\d+)", type_token)
            if lm:
                length = int(lm.group(1))
            columns.append({
                "name": col_name, "dataType": base_type, "length": length,
                "businessTerm": "", "description": "", "sample": "",
            })
        if name and columns:
            tables.append({"name": name, "columns": columns})
    return tables
