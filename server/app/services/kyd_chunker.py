"""Text chunking for Know Your Data embedding.

Pure (no Flask/DB). Splits normalized text into overlapping windows, carrying a
page number when the text contains ``[page N]`` markers (as document_parser emits
for PDFs). For structured files, each table's data-profile becomes one chunk
(section = table name) so the profile is embedded for schema-level questions.
"""
import re
from typing import Any, Dict, List

_PAGE_RE = re.compile(r"^\[page (\d+)\]\s*$", re.MULTILINE)
_DEFAULT_SIZE = 1000     # chars per chunk
_DEFAULT_OVERLAP = 150   # chars of overlap between adjacent chunks


def _window(s: str, size: int, overlap: int) -> List[str]:
    s = (s or "").strip()
    if not s:
        return []
    if len(s) <= size:
        return [s]
    out, start = [], 0
    while start < len(s):
        end = min(len(s), start + size)
        cut = s.rfind(" ", start + int(size * 0.6), end)   # prefer a word boundary
        if cut == -1 or end == len(s):
            cut = end
        piece = s[start:cut].strip()
        if piece:
            out.append(piece)
        if cut >= len(s):
            break
        start = max(cut - overlap, start + 1)
    return out


def chunk_text(text: str, size: int = _DEFAULT_SIZE, overlap: int = _DEFAULT_OVERLAP) -> List[Dict[str, Any]]:
    """Split text into overlapping chunks, tracking page numbers from [page N] markers."""
    text = (text or "").strip()
    if not text:
        return []
    markers = list(_PAGE_RE.finditer(text))
    if markers:
        segments = []
        for i, m in enumerate(markers):
            page = int(m.group(1))
            start = m.end()
            end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
            segments.append((page, text[start:end]))
    else:
        segments = [(None, text)]

    chunks, idx = [], 0
    for page, seg in segments:
        for piece in _window(seg, size, overlap):
            chunks.append({"text": piece, "chunk_index": idx, "page": page,
                           "section": None, "token_estimate": max(1, len(piece) // 4)})
            idx += 1
    return chunks


def chunks_for(parsed) -> List[Dict[str, Any]]:
    """Build chunk dicts from a document_parser.ParseResult.

    Structured -> one 'schema profile' chunk per table (section = table name).
    Unstructured -> overlapping text windows.
    """
    kind = getattr(parsed, "kind", "unstructured")
    tables = getattr(parsed, "tables", None) or []
    if kind == "structured" and tables:
        out = []
        for i, t in enumerate(tables):
            prof = t.get("profile") or ""
            if not prof:
                continue
            out.append({"text": prof, "chunk_index": i, "page": None,
                        "section": t.get("name"), "token_estimate": max(1, len(prof) // 4)})
        if out:
            return out
    return chunk_text(getattr(parsed, "text", "") or "")
