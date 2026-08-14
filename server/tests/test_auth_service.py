"""Unit tests for auth_service (real temp SQLite via conftest)."""
from app.services import auth_service as A


def test_validate_signup_rejects_bad_input():
    assert A.validate_signup("not-an-email", "password123", "X")
    assert A.validate_signup("a@b.com", "short", "X")
    assert A.validate_signup("a@b.com", "password123", "X") is None


def test_signup_then_authenticate_roundtrip():
    payload, status = A.signup("alice@example.com", "password123", "Alice")
    assert status == 201 and payload["ok"] is True
    assert "password_hash" not in payload["user"]        # never leaked
    assert payload["user"]["email"] == "alice@example.com"

    user = A.authenticate("Alice@Example.com", "password123")  # email is case-insensitive
    assert user and user["id"] == payload["user"]["id"]
    assert user["lastLoginAt"]                              # updated on login


def test_authenticate_wrong_password_returns_none():
    A.signup("bob@example.com", "password123", "Bob")
    assert A.authenticate("bob@example.com", "wrong-password") is None
    assert A.authenticate("nobody@example.com", "password123") is None


def test_signup_duplicate_email_conflicts():
    A.signup("dupe@example.com", "password123", "One")
    payload, status = A.signup("dupe@example.com", "password123", "Two")
    assert status == 409 and payload["ok"] is False


def test_login_throttle_locks_after_failures_and_clears_on_success():
    email = "throttle@example.com"
    assert A.login_locked_seconds(email) == 0
    for _ in range(5):
        A.record_login_result(email, False)
    assert A.login_locked_seconds(email) > 0          # locked after 5 failures
    A.record_login_result(email, True)                # a success resets the counter
    assert A.login_locked_seconds(email) == 0


def test_password_is_hashed_not_plaintext():
    A.signup("hash@example.com", "password123", "H")
    from app.db.app_db import connect
    conn = connect()
    try:
        row = conn.execute("SELECT password_hash FROM users WHERE email=?", ("hash@example.com",)).fetchone()
    finally:
        conn.close()
    assert row["password_hash"] and "password123" not in row["password_hash"]
