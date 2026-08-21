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
    must_change_password INTEGER NOT NULL DEFAULT 0,  -- 1 = force a password change on next login
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

-- ==========================================================================
-- Know Your Data (KYD) — insurance document Q&A (upload → ingest → chat/RAG).
-- Row-oriented (NOT the tenant_documents blob store). Every table is scoped by
-- user_id + client_id and hangs off users/clients with the same ON DELETE
-- CASCADE convention, so deleting a user or client removes all their KYD data.
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
-- ==========================================================================

-- An uploaded insurance document and its ingestion lifecycle.
CREATE TABLE IF NOT EXISTS documents (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    client_id               INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    filename                TEXT NOT NULL,
    file_ext                TEXT,                                   -- pdf|xml|json|sql|xlsx|csv
    mime_type               TEXT,
    size_bytes              INTEGER,
    storage_path            TEXT,                                   -- path under kyd_storage/ (NULL if BLOB mode)
    content_kind            TEXT,                                   -- unstructured|structured|mixed
    status                  TEXT NOT NULL DEFAULT 'uploaded',       -- uploaded|processing|ready|failed|rejected
    status_detail           TEXT,                                   -- last message / error
    detected_topics         TEXT,                                   -- JSON array, e.g. ["claims","premiums"]
    domain_check_confidence REAL,                                   -- 0-100 insurance-relevance
    domain_check_reasoning  TEXT,                                   -- classifier justification (audit)
    domain_override         INTEGER NOT NULL DEFAULT 0,             -- 1 = user force-ingested a rejected doc
    chunk_count             INTEGER NOT NULL DEFAULT 0,
    table_count             INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL,
    updated_at              TEXT,
    CHECK (status IN ('uploaded','processing','ready','failed','rejected'))
);
CREATE INDEX IF NOT EXISTS ix_documents_scope  ON documents(user_id, client_id);
CREATE INDEX IF NOT EXISTS ix_documents_status ON documents(status);

-- Original uploaded bytes, kept in the DB (BLOB) rather than on disk: static_routes
-- serves the whole repo root, so an on-disk path under the repo would be cross-tenant
-- readable. One row per document; separate table so document list scans stay light.
CREATE TABLE IF NOT EXISTS document_files (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    mime_type   TEXT,
    byte_size   INTEGER NOT NULL DEFAULT 0,
    data        BLOB NOT NULL,
    created_at  TEXT NOT NULL
);

-- Unstructured text chunks + embeddings (SQLite-native vector store; embedding
-- is a float32 BLOB, retrieved with scoped cosine similarity in Python).
CREATE TABLE IF NOT EXISTS document_chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL,                            -- denormalized for scoped retrieval
    client_id      INTEGER NOT NULL,
    chunk_index    INTEGER NOT NULL,
    text           TEXT NOT NULL,
    token_estimate INTEGER,
    page           INTEGER,                                     -- for PDF citations (nullable)
    section        TEXT,                                        -- heading/sheet/label for citations
    embedding      BLOB,                                        -- float32 LE; NULL until embedded
    embed_model    TEXT,                                        -- provenance (model + dim)
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_document_chunks_scope ON document_chunks(user_id, client_id, document_id);
CREATE INDEX IF NOT EXISTS ix_document_chunks_doc   ON document_chunks(document_id, chunk_index);

-- Registry of structured data loaded from CSV/Excel/SQL uploads. The physical
-- per-document data tables (kyd_d<document_id>_<slug>) are created at ingest time.
CREATE TABLE IF NOT EXISTS structured_tables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL,
    client_id      INTEGER NOT NULL,
    logical_name   TEXT,                                        -- sheet/table name as seen by the user
    physical_table TEXT NOT NULL,                               -- actual table name in the store
    columns_json   TEXT,                                        -- [{name,type,sample}] for text-to-SQL grounding
    row_count      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    UNIQUE(document_id, physical_table)
);
CREATE INDEX IF NOT EXISTS ix_structured_tables_scope ON structured_tables(user_id, client_id, document_id);

-- A chat conversation over one client's documents.
CREATE TABLE IF NOT EXISTS chat_sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title          TEXT,
    document_scope TEXT,                                        -- JSON array of document ids (NULL/[]=all ready docs)
    created_at     TEXT NOT NULL,
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_chat_sessions_scope ON chat_sessions(user_id, client_id);

-- Individual messages within a chat session.
CREATE TABLE IF NOT EXISTS chat_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL,                            -- defense-in-depth scope
    client_id      INTEGER NOT NULL,
    role           TEXT NOT NULL,                               -- user|assistant
    content        TEXT NOT NULL,
    route          TEXT,                                        -- vector|structured|hybrid (assistant msgs)
    citations_json TEXT,                                        -- [{documentId,chunkId?,page?,section?,table?,snippet}]
    usage_json     TEXT,                                        -- token counts (mirrors usage logging)
    created_at     TEXT NOT NULL,
    CHECK (role IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS ix_chat_messages_session ON chat_messages(session_id, id);

-- ==========================================================================
-- Feedback — user-raised suggestions / bug reports (app-wide, admin-reviewed).
-- NOT tenant-scoped (no client_id); reviewed by admins on the Admin page.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- keep feedback if the user is deleted
    type       TEXT NOT NULL,                 -- suggestion | bug | other
    message    TEXT NOT NULL,
    page       TEXT,                          -- page/route where it was raised
    user_agent TEXT,                          -- browser/OS, for bug reproduction
    status     TEXT NOT NULL DEFAULT 'new',   -- new | accepted | in_development | done | declined
    created_at TEXT NOT NULL,
    updated_at TEXT,                          -- last status change
    CHECK (type IN ('suggestion','bug','other')),
    CHECK (status IN ('new','accepted','in_development','done','declined'))
);
CREATE INDEX IF NOT EXISTS ix_feedback_created ON feedback(created_at);

-- ==========================================================================
-- Lookup / typelist value mapping (separate from structural field mapping).
-- Tenant-scoped like KYD. A lookup_set is a SOURCE coded column's value set
-- (code -> description), optionally bound to the TARGET list column it feeds.
-- Value mappings (source code -> target value) are keyed by (set, source_code)
-- so a shared lookup is mapped once and reused. No target value dictionary —
-- the AI infers target values by normalizing the source descriptions.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS lookup_sets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    lookup_name        TEXT NOT NULL,               -- e.g. Claim_status or YES_NO
    source_table       TEXT,                        -- source coded column this set describes
    source_column      TEXT,
    target_table       TEXT,                        -- target list column it feeds (nullable until matched)
    target_column      TEXT,
    target_values_spec TEXT,                        -- generated legacy->Guidewire mapping summary ("1 -> open, 2 -> closed")
    legacy_values_spec TEXT,                        -- user-entered legacy/source coded values (free text)
    source_document    TEXT,                        -- filename it came from, if uploaded
    version            INTEGER NOT NULL DEFAULT 1,  -- bumped on re-upload
    value_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT,
    UNIQUE(user_id, client_id, lookup_name)
);
CREATE INDEX IF NOT EXISTS ix_lookup_sets_scope ON lookup_sets(user_id, client_id);

-- The source code -> description values within a lookup set.
CREATE TABLE IF NOT EXISTS lookup_values (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    lookup_set_id  INTEGER NOT NULL REFERENCES lookup_sets(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL,                -- denormalized for scoped queries (KYD pattern)
    client_id      INTEGER NOT NULL,
    code           TEXT NOT NULL,
    description    TEXT,
    sort_order     INTEGER,
    is_active      INTEGER NOT NULL DEFAULT 1,
    parent_code    TEXT,
    effective_from TEXT,
    effective_to   TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE(lookup_set_id, code)
);
CREATE INDEX IF NOT EXISTS ix_lookup_values_set   ON lookup_values(lookup_set_id);
CREATE INDEX IF NOT EXISTS ix_lookup_values_scope ON lookup_values(user_id, client_id);

-- Value-level mappings: source code -> target value (the "expected mapping").
CREATE TABLE IF NOT EXISTS lookup_value_mappings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    lookup_set_id      INTEGER NOT NULL REFERENCES lookup_sets(id) ON DELETE CASCADE,
    user_id            INTEGER NOT NULL,
    client_id          INTEGER NOT NULL,
    source_code        TEXT NOT NULL,
    source_description TEXT,
    target_code        TEXT,
    target_description TEXT,
    confidence         REAL,
    rationale          TEXT,
    mapping_type       TEXT NOT NULL DEFAULT 'unmapped',
    is_reviewed        INTEGER NOT NULL DEFAULT 0,
    reviewed_by        INTEGER,
    reviewed_at        TEXT,
    ai_run_id          INTEGER,
    created_at         TEXT NOT NULL,
    updated_at         TEXT,
    UNIQUE(lookup_set_id, source_code),
    CHECK (mapping_type IN ('exact','semantic','defaulted','unmapped','manual_override','ignored'))
);
CREATE INDEX IF NOT EXISTS ix_lvm_set   ON lookup_value_mappings(lookup_set_id);
CREATE INDEX IF NOT EXISTS ix_lvm_scope ON lookup_value_mappings(user_id, client_id);

-- Per-pass AI run audit (counts/tokens/timing); complements per-call ai_usage_log.
CREATE TABLE IF NOT EXISTS ai_mapping_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    client_id      INTEGER NOT NULL,
    pass_no        INTEGER NOT NULL,                -- 1 (structural) or 2 (lookup values)
    prompt_version TEXT,
    model          TEXT,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    duration_ms    INTEGER,
    counts_json    TEXT,                            -- {mapped, unmapped, lowConfidence, resolvedWithoutLlm, …}
    status         TEXT NOT NULL DEFAULT 'success',
    error          TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_mapping_runs_scope ON ai_mapping_runs(user_id, client_id);
