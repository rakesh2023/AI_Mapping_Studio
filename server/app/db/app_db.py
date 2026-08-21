"""App store (SQLite) connection + schema init for the multi-tenant layer.

Holds users, clients and tenant_documents (see schema.sql). Mirrors the existing
ai_usage_logger pattern: stdlib sqlite3 (no extra dependency), a process-wide
write lock (SQLite is single-writer), and short-lived per-operation connections
that are opened/committed/closed in a try/finally.

Foreign keys are enabled per connection (SQLite defaults them OFF) so the
ON DELETE CASCADE rules in the schema actually fire.
"""
import os
import sqlite3
import threading
import traceback

from app.core.config import app_db_path

# Serializes writes across threads (SQLite allows a single writer). Reads are fine
# concurrently, but we keep all access short-lived and lock writes for safety.
_WRITE_LOCK = threading.Lock()

_SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


def connect() -> sqlite3.Connection:
    """Open a Row-factory connection with foreign keys enforced."""
    conn = sqlite3.connect(app_db_path(), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_user_columns(conn: sqlite3.Connection) -> None:
    """Add columns to a pre-existing (legacy) users table.

    CREATE TABLE IF NOT EXISTS won't add new columns to a table that already
    exists, so migrate in place: add `is_admin` when missing. Idempotent; caller
    holds _WRITE_LOCK.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "is_admin" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "must_change_password" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")


def _ensure_lookup_columns(conn: sqlite3.Connection) -> None:
    """Add newer columns to a pre-existing lookup_sets table (CREATE TABLE IF NOT
    EXISTS won't). Idempotent; caller holds _WRITE_LOCK."""
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(lookup_sets)").fetchall()}
    except Exception:  # noqa: BLE001 — table may not exist yet on a brand-new DB
        return
    if cols and "legacy_values_spec" not in cols:
        conn.execute("ALTER TABLE lookup_sets ADD COLUMN legacy_values_spec TEXT")


def ensure_app_tables() -> None:
    """Create the app tables if they don't exist (idempotent).

    Called once at startup. Also migrates a legacy users table to add newer
    columns (is_admin). Guarded so a failure here (e.g. read-only dir) is logged
    but never prevents the app from starting.
    """
    try:
        with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
            script = fh.read()
        with _WRITE_LOCK:
            conn = connect()
            try:
                conn.executescript(script)
                _ensure_user_columns(conn)
                _ensure_lookup_columns(conn)
                conn.commit()
            finally:
                conn.close()
    except Exception:  # noqa: BLE001
        print("[app_db] ensure_app_tables failed:\n" + traceback.format_exc())


def write_lock() -> threading.Lock:
    """Expose the shared write lock so services serialize their writes too."""
    return _WRITE_LOCK
