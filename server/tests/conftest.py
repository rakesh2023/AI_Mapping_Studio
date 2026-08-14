"""Shared test setup: isolate the multi-tenant SQLite store to a temp file so
tests never create or mutate the real server/aims_app.db, and provide a signing
key so session-based auth tests work.
"""
import os
import tempfile

import pytest

# Keep the test run isolated from any developer's local server/.env (which could
# otherwise inject AIMS_ADMIN_EMAIL etc.). Set at import time — before conftest's
# fixtures and before any test module imports the app.
os.environ["AIMS_DISABLE_DOTENV"] = "1"


@pytest.fixture(autouse=True, scope="session")
def _isolated_app_db():
    fd, path = tempfile.mkstemp(prefix="aims_app_test_", suffix=".db")
    os.close(fd)
    prev_db = os.environ.get("AIMS_APP_DB")
    prev_key = os.environ.get("AIMS_SECRET_KEY")
    prev_csrf = os.environ.get("AIMS_CSRF_ENABLED")
    prev_signup = os.environ.get("AIMS_SIGNUP_ENABLED")
    os.environ["AIMS_APP_DB"] = path
    os.environ.setdefault("AIMS_SECRET_KEY", "test-secret-key")
    # Drive the API without a browser-issued CSRF token by default; test_csrf.py
    # re-enables it (via monkeypatch.setenv) to exercise real enforcement.
    os.environ["AIMS_CSRF_ENABLED"] = "0"
    # Most tests bootstrap users via POST /api/auth/signup; that endpoint is disabled
    # in production, so enable it for the suite. test_admin.py toggles it off to verify
    # the closed-signup behaviour.
    os.environ["AIMS_SIGNUP_ENABLED"] = "1"
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
        if prev_signup is None:
            os.environ.pop("AIMS_SIGNUP_ENABLED", None)
        else:
            os.environ["AIMS_SIGNUP_ENABLED"] = prev_signup
        try:
            os.remove(path)
        except OSError:
            pass
