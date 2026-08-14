"""Shared test setup: isolate the multi-tenant SQLite store to a temp file so
tests never create or mutate the real server/aims_app.db, and provide a signing
key so session-based auth tests work.
"""
import os
import tempfile

import pytest


@pytest.fixture(autouse=True, scope="session")
def _isolated_app_db():
    fd, path = tempfile.mkstemp(prefix="aims_app_test_", suffix=".db")
    os.close(fd)
    prev_db = os.environ.get("AIMS_APP_DB")
    prev_key = os.environ.get("AIMS_SECRET_KEY")
    prev_csrf = os.environ.get("AIMS_CSRF_ENABLED")
    os.environ["AIMS_APP_DB"] = path
    os.environ.setdefault("AIMS_SECRET_KEY", "test-secret-key")
    # Drive the API without a browser-issued CSRF token by default; test_csrf.py
    # re-enables it (via monkeypatch.setenv) to exercise real enforcement.
    os.environ["AIMS_CSRF_ENABLED"] = "0"
    from app.db.app_db import ensure_app_tables
    ensure_app_tables()   # create users/clients/tenant_documents in the temp DB
    try:
        yield
    finally:
        if prev_db is None:
            os.environ.pop("AIMS_APP_DB", None)
        else:
            os.environ["AIMS_APP_DB"] = prev_db
        if prev_key is None:
            os.environ.pop("AIMS_SECRET_KEY", None)
        else:
            os.environ["AIMS_SECRET_KEY"] = prev_key
        if prev_csrf is None:
            os.environ.pop("AIMS_CSRF_ENABLED", None)
        else:
            os.environ["AIMS_CSRF_ENABLED"] = prev_csrf
        try:
            os.remove(path)
        except OSError:
            pass
