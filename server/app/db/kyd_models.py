"""Typed models for the Know Your Data (KYD) feature.

This project has NO ORM (see docs/know-your-data/CODEBASE_CONTEXT.md): data
access is plain stdlib ``sqlite3`` with parameterized queries, and the schema
is applied idempotently from ``schema.sql`` by ``app_db.ensure_app_tables()``.

These dataclasses are the lightweight, framework-free equivalent of ORM
models — they document each row's shape, centralize the allowed enum values,
and provide ``from_row`` / ``to_insert`` helpers so services don't hand-map
columns. They intentionally add no dependency and do not touch the DB; the
KYD service layer uses them together with ``app_db.connect()`` /
``app_db.write_lock()``.

Relationships (all ON DELETE CASCADE), enforced by FKs in schema.sql:

    users ──1:N──> documents ──1:N──> document_chunks
                    │            └───> structured_tables
    users ──1:N──> chat_sessions ──1:N──> chat_messages
    clients ──1:N──> documents / chat_sessions  (tenant scope)

Every table also carries user_id + client_id so every query can be scoped to
the signed-in session's tenant, never a client-supplied id.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ---- Table names (single source of truth for query builders) ----
TABLE_DOCUMENTS = "documents"
TABLE_DOCUMENT_CHUNKS = "document_chunks"
TABLE_STRUCTURED_TABLES = "structured_tables"
TABLE_CHAT_SESSIONS = "chat_sessions"
TABLE_CHAT_MESSAGES = "chat_messages"

# ---- Enum-like value sets (mirror the CHECK constraints in schema.sql) ----
STATUS_UPLOADED = "uploaded"
STATUS_PROCESSING = "processing"
STATUS_READY = "ready"
STATUS_FAILED = "failed"
STATUS_REJECTED = "rejected"
DOCUMENT_STATUSES = (
    STATUS_UPLOADED, STATUS_PROCESSING, STATUS_READY, STATUS_FAILED, STATUS_REJECTED,
)

CONTENT_UNSTRUCTURED = "unstructured"
CONTENT_STRUCTURED = "structured"
CONTENT_MIXED = "mixed"
CONTENT_KINDS = (CONTENT_UNSTRUCTURED, CONTENT_STRUCTURED, CONTENT_MIXED)

ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
CHAT_ROLES = (ROLE_USER, ROLE_ASSISTANT)

ROUTE_VECTOR = "vector"
ROUTE_STRUCTURED = "structured"
ROUTE_HYBRID = "hybrid"
QUERY_ROUTES = (ROUTE_VECTOR, ROUTE_STRUCTURED, ROUTE_HYBRID)


def _loads(value: Optional[str], default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return default


@dataclass
class Document:
    """A row of ``documents`` — an uploaded insurance file + its ingestion state."""
    id: Optional[int] = None
    user_id: int = 0
    client_id: int = 0
    filename: str = ""
    file_ext: Optional[str] = None
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = None
    storage_path: Optional[str] = None
    content_kind: Optional[str] = None          # CONTENT_KINDS
    status: str = STATUS_UPLOADED               # DOCUMENT_STATUSES
    status_detail: Optional[str] = None
    detected_topics: List[str] = field(default_factory=list)   # JSON array in DB
    domain_check_confidence: Optional[float] = None            # 0-100
    domain_check_reasoning: Optional[str] = None
    domain_override: bool = False
    chunk_count: int = 0
    table_count: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    TABLE = TABLE_DOCUMENTS

    @classmethod
    def from_row(cls, r: sqlite3.Row) -> "Document":
        return cls(
            id=r["id"], user_id=r["user_id"], client_id=r["client_id"],
            filename=r["filename"], file_ext=r["file_ext"], mime_type=r["mime_type"],
            size_bytes=r["size_bytes"], storage_path=r["storage_path"],
            content_kind=r["content_kind"], status=r["status"], status_detail=r["status_detail"],
            detected_topics=_loads(r["detected_topics"], []),
            domain_check_confidence=r["domain_check_confidence"],
            domain_check_reasoning=r["domain_check_reasoning"],
            domain_override=bool(r["domain_override"]),
            chunk_count=r["chunk_count"], table_count=r["table_count"],
            created_at=r["created_at"], updated_at=r["updated_at"],
        )

    def public_dict(self) -> Dict[str, Any]:
        """API-safe view (no storage_path)."""
        return {
            "id": self.id, "filename": self.filename, "fileExt": self.file_ext,
            "sizeBytes": self.size_bytes, "contentKind": self.content_kind,
            "status": self.status, "statusDetail": self.status_detail,
            "detectedTopics": self.detected_topics,
            "domainCheckConfidence": self.domain_check_confidence,
            "domainCheckReasoning": self.domain_check_reasoning,
            "domainOverride": self.domain_override,
            "chunkCount": self.chunk_count, "tableCount": self.table_count,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        }


@dataclass
class DocumentChunk:
    """A row of ``document_chunks`` — one embedded text chunk (vector store)."""
    id: Optional[int] = None
    document_id: int = 0
    user_id: int = 0
    client_id: int = 0
    chunk_index: int = 0
    text: str = ""
    token_estimate: Optional[int] = None
    page: Optional[int] = None
    section: Optional[str] = None
    embedding: Optional[bytes] = None           # float32 little-endian
    embed_model: Optional[str] = None
    created_at: Optional[str] = None

    TABLE = TABLE_DOCUMENT_CHUNKS

    @classmethod
    def from_row(cls, r: sqlite3.Row) -> "DocumentChunk":
        return cls(
            id=r["id"], document_id=r["document_id"], user_id=r["user_id"],
            client_id=r["client_id"], chunk_index=r["chunk_index"], text=r["text"],
            token_estimate=r["token_estimate"], page=r["page"], section=r["section"],
            embedding=r["embedding"], embed_model=r["embed_model"], created_at=r["created_at"],
        )


@dataclass
class StructuredTable:
    """A row of ``structured_tables`` — registry of a loaded CSV/Excel/SQL table."""
    id: Optional[int] = None
    document_id: int = 0
    user_id: int = 0
    client_id: int = 0
    logical_name: Optional[str] = None
    physical_table: str = ""
    columns: List[Dict[str, Any]] = field(default_factory=list)   # columns_json in DB
    row_count: int = 0
    created_at: Optional[str] = None

    TABLE = TABLE_STRUCTURED_TABLES

    @classmethod
    def from_row(cls, r: sqlite3.Row) -> "StructuredTable":
        return cls(
            id=r["id"], document_id=r["document_id"], user_id=r["user_id"],
            client_id=r["client_id"], logical_name=r["logical_name"],
            physical_table=r["physical_table"], columns=_loads(r["columns_json"], []),
            row_count=r["row_count"], created_at=r["created_at"],
        )


@dataclass
class ChatSession:
    """A row of ``chat_sessions`` — a conversation over a client's documents."""
    id: Optional[int] = None
    user_id: int = 0
    client_id: int = 0
    title: Optional[str] = None
    document_scope: List[int] = field(default_factory=list)   # JSON array; []=all ready docs
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    TABLE = TABLE_CHAT_SESSIONS

    @classmethod
    def from_row(cls, r: sqlite3.Row) -> "ChatSession":
        return cls(
            id=r["id"], user_id=r["user_id"], client_id=r["client_id"], title=r["title"],
            document_scope=_loads(r["document_scope"], []),
            created_at=r["created_at"], updated_at=r["updated_at"],
        )

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "documentScope": self.document_scope,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        }


@dataclass
class ChatMessage:
    """A row of ``chat_messages`` — one user or assistant turn."""
    id: Optional[int] = None
    session_id: int = 0
    user_id: int = 0
    client_id: int = 0
    role: str = ROLE_USER                       # CHAT_ROLES
    content: str = ""
    route: Optional[str] = None                 # QUERY_ROUTES (assistant only)
    citations: List[Dict[str, Any]] = field(default_factory=list)   # citations_json in DB
    usage: Optional[Dict[str, Any]] = None      # usage_json in DB
    created_at: Optional[str] = None

    TABLE = TABLE_CHAT_MESSAGES

    @classmethod
    def from_row(cls, r: sqlite3.Row) -> "ChatMessage":
        return cls(
            id=r["id"], session_id=r["session_id"], user_id=r["user_id"],
            client_id=r["client_id"], role=r["role"], content=r["content"], route=r["route"],
            citations=_loads(r["citations_json"], []), usage=_loads(r["usage_json"], None),
            created_at=r["created_at"],
        )

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "role": self.role, "content": self.content, "route": self.route,
            "citations": self.citations, "usage": self.usage, "createdAt": self.created_at,
        }


# Human/tooling-readable relationship map (FKs live in schema.sql).
RELATIONSHIPS = {
    "documents":        [("user_id", "users.id", "CASCADE"), ("client_id", "clients.id", "CASCADE")],
    "document_chunks":  [("document_id", "documents.id", "CASCADE")],
    "structured_tables": [("document_id", "documents.id", "CASCADE")],
    "chat_sessions":    [("user_id", "users.id", "CASCADE"), ("client_id", "clients.id", "CASCADE")],
    "chat_messages":    [("session_id", "chat_sessions.id", "CASCADE")],
}
