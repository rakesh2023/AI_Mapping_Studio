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


# ---- change-password + forced-first-login flag ----

def test_admin_created_user_must_change_password():
    from app.services import admin_service as AD
    payload, status = AD.create_user("newhire@example.com", "temp-pass-123", "New Hire")
    assert status == 201 and payload["ok"] is True
    assert payload["user"]["mustChangePassword"] is True   # forced on first login


def test_change_password_flow():
    uid = A.signup("cp@example.com", "password123", "CP")[0]["user"]["id"]

    # wrong current -> rejected
    p, s = A.change_password(uid, "WRONG", "newpassword1")
    assert s == 400 and p["reason"] == "bad_current"

    # too short -> rejected
    p, s = A.change_password(uid, "password123", "short")
    assert s == 400 and p["reason"] == "weak"

    # same as current -> rejected
    p, s = A.change_password(uid, "password123", "password123")
    assert s == 400 and p["reason"] == "same"

    # valid -> succeeds, old password stops working, new one authenticates
    p, s = A.change_password(uid, "password123", "brand-new-pass-1")
    assert s == 200 and p["ok"] is True
    assert A.authenticate("cp@example.com", "password123") is None
    assert A.authenticate("cp@example.com", "brand-new-pass-1") is not None


def test_change_password_clears_must_change_flag():
    from app.services import admin_service as AD
    uid = AD.create_user("forced@example.com", "temp-pass-123", "Forced")[0]["user"]["id"]
    assert A.get_user(uid)["mustChangePassword"] is True
    p, s = A.change_password(uid, "temp-pass-123", "chosen-pass-99")
    assert s == 200 and p["ok"] is True
    assert A.get_user(uid)["mustChangePassword"] is False
