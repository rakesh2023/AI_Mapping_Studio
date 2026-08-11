"""Pure text chunking helpers for the file-extraction pipeline.

No Flask, no Anthropic, no I/O — just string in, chunks out. Large dictionary/
DDL/spec text is split so each AI call is asked for only a few tables (the
model then returns them all instead of summarising a long list).
"""
import re
from typing import List, Optional, Pattern

from app.core.config import EXTRACT_TEXT_BUDGET, EXTRACT_AI_CHUNK


def split_text_chunks(text: str, size: int = EXTRACT_TEXT_BUDGET) -> List[str]:
    """Split a long text into <=size chunks, breaking on newlines where possible."""
    text = text or ""
    if len(text) <= size:
        return [text] if text.strip() else []
    chunks: List[str] = []
    i, n = 0, len(text)
    while i < n:
        end = min(i + size, n)
        if end < n:
            nl = text.rfind("\n", i, end)   # prefer a clean line break
            if nl > i + int(size * 0.5):
                end = nl
        chunk = text[i:end]
        if chunk.strip():
            chunks.append(chunk)
        i = end
    return chunks


# A new table usually starts with one of these markers in a dictionary / DDL / doc.
_TABLE_MARKER: Optional[Pattern] = None


def table_marker() -> Pattern:
    """Lazily compiled regex matching a line that begins a new table block."""
    global _TABLE_MARKER
    if _TABLE_MARKER is None:
        _TABLE_MARKER = re.compile(
            r"^\s*(?:CREATE\s+TABLE\b|TABLE\s*[:\-]|TABLE\s+NAME\s*[:\-]|ENTITY\s*[:\-]|"
            r"\d+[.)]\s*TABLE\b)", re.IGNORECASE)
    return _TABLE_MARKER


def split_by_tables(text: str, tables_per_chunk: int = 8,
                    max_chars: int = EXTRACT_AI_CHUNK) -> List[str]:
    """Split dictionary/DDL text on TABLE boundaries and batch a small number of
    tables per chunk, so each AI call is asked for only a few tables (it then
    returns them all instead of summarising a long list). Falls back to
    size-splitting when no markers are found.
    """
    text = text or ""
    lines = text.split("\n")
    marker = table_marker()
    # find line indexes where a new table begins
    starts = [i for i, ln in enumerate(lines) if marker.match(ln)]
    if len(starts) < 2:
        return split_text_chunks(text, max_chars)   # not a table-per-block layout

    # build per-table blocks
    blocks: List[str] = []
    for bi, s in enumerate(starts):
        e = starts[bi + 1] if bi + 1 < len(starts) else len(lines)
        # keep any preamble before the first table with the first block
        if bi == 0 and s > 0:
            s = 0
        blocks.append("\n".join(lines[s:e]).strip())
    blocks = [b for b in blocks if b]

    # group blocks into chunks by count AND size
    chunks: List[str] = []
    cur: List[str] = []
    cur_len = 0
    for b in blocks:
        if cur and (len(cur) >= tables_per_chunk or cur_len + len(b) > max_chars):
            chunks.append("\n\n".join(cur))
            cur, cur_len = [], 0
        cur.append(b)
        cur_len += len(b) + 2
    if cur:
        chunks.append("\n\n".join(cur))
    return chunks
