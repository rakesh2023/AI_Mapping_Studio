"""Optional-dependency guards, centralized.

The backend must boot even when optional packages are absent; each feature
reports which package is missing only when a matching request arrives. Import
these names from here instead of re-writing try/except blocks throughout the
app. A name is None when its package is not installed.

    pyodbc     -> live SQL Server metadata/profiling
    anthropic  -> AI mapping generation / extraction
    openpyxl   -> Excel (.xlsx/.xlsm/.xls) parsing
    PdfReader  -> PDF parsing (from pypdf)
    docx       -> Word (.docx) parsing (python-docx)
"""
from typing import Any, Dict, Optional

try:
    import pyodbc  # type: ignore
except ImportError:  # surfaced nicely to the UI instead of crashing on import
    pyodbc = None  # type: ignore

try:
    import anthropic  # type: ignore
except ImportError:  # AI generation degrades gracefully if the SDK isn't installed
    anthropic = None  # type: ignore

try:
    import openpyxl  # type: ignore
except ImportError:
    openpyxl = None  # type: ignore

try:
    from pypdf import PdfReader  # type: ignore
except ImportError:
    PdfReader = None  # type: ignore

try:
    import docx  # type: ignore  # python-docx
except ImportError:
    docx = None  # type: ignore


def capability_report() -> Dict[str, bool]:
    """Report which optional packages are available on this machine.

    Handy for a /health-style check; not wired to a route by default so the
    externally-visible API is unchanged.
    """
    return {
        "pyodbc": pyodbc is not None,
        "anthropic": anthropic is not None,
        "openpyxl": openpyxl is not None,
        "pypdf": PdfReader is not None,
        "docx": docx is not None,
    }
