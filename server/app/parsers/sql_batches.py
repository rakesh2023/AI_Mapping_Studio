"""Split a T-SQL script into executable batches on 'GO' separator lines.

`GO` is a SSMS/sqlcmd batch separator, NOT valid T-SQL — pyodbc/ODBC errors on
it. Each batch must be executed as its own pyodbc .execute() call. This module
is pure (no Flask/pyodbc/Anthropic) so it is trivially unit-testable.
"""
import re
from typing import List

# A line that is exactly GO (optionally surrounded by whitespace), case-insensitive.
_GO_LINE = re.compile(r"^\s*GO\s*$", re.IGNORECASE)


def split_sql_batches(script: str) -> List[str]:
    """Return the non-empty batches of `script`, split on lone `GO` lines.

    Blank batches (e.g. consecutive GOs, or a trailing GO) are dropped. Leading/
    trailing whitespace of each batch is stripped.
    """
    if not script:
        return []
    batches: List[str] = []
    current: List[str] = []
    for line in script.split("\n"):
        if _GO_LINE.match(line):
            chunk = "\n".join(current).strip()
            if chunk:
                batches.append(chunk)
            current = []
        else:
            current.append(line)
    chunk = "\n".join(current).strip()
    if chunk:
        batches.append(chunk)
    return batches
