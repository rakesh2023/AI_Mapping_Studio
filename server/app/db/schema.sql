-- AI Mapping Studio — multi-tenant app store (SQLite).
-- Idempotent: safe to run on every startup (CREATE TABLE IF NOT EXISTS).
-- Holds identity (users), tenants (clients), and per-client working data
-- (tenant_documents). NOT a customer/target database.

-- One login identity.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,          -- stored lowercased
    password_hash TEXT NOT NULL,                 -- werkzeug scrypt/pbkdf2; never returned
    name          TEXT,
    role          TEXT DEFAULT 'Migration Lead',
    is_admin      INTEGER NOT NULL DEFAULT 0,    -- 1 = admin (env-seeded); manages users
    created_at    TEXT NOT NULL,
    last_login_at TEXT
);

-- A user owns many clients (UI exposes one for now; schema supports many).
CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    industry    TEXT,
    config_json TEXT,                            -- onboarding extras (migrationType, domain, apps, notes)
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS ix_clients_user ON clients(user_id);

-- Every per-client working store, one JSON blob per doc_key. The blob is the
-- exact shape the frontend previously kept in localStorage.
CREATE TABLE IF NOT EXISTS tenant_documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    doc_key    TEXT NOT NULL,                    -- 'ai_mappings','ai_joins','db_connections',...
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, client_id, doc_key)
);
CREATE INDEX IF NOT EXISTS ix_docs_scope ON tenant_documents(user_id, client_id);
