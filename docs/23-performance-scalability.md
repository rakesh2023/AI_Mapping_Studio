# 23 — Performance & Scalability

Separated into **Current Implementation** and **Recommendations**.

## Caching

**Current:** frontend assets are cache‑busted (`?v=YYYYMMDD<letter>`) so browsers cache aggressively between releases. The tenant state is cached in‑memory client‑side (`CLIENT_STATE`) and read synchronously; writes are **debounced (300 ms)** and flushed on unload. LLM responses are **not** cached server‑side. The Anthropic client trusts a CA bundle and reuses one httpx client per call site.
**Recommendation:** consider caching idempotent AI results (e.g. extraction of an unchanged file) and `GET /api/ai/mapping-prompt`.

## Concurrency

**Current:** single Flask **dev server** process. SQLite is single‑writer and every app write is serialized by a process‑wide `write_lock()`; the usage DB has its own lock. Deploys run on background **daemon threads** with an in‑memory job store; the reloader is disabled so threads survive.
**Observed Limitation:** write throughput is bounded by the global lock + SQLite; the dev server is not built for many concurrent users. The deploy job store is per‑process and lost on restart.
**Recommendation:** run under a production WSGI server; if concurrency grows, move to Postgres and a shared job/store backend.

## Database performance

**Current:** indexes `ix_clients_user`, `ix_docs_scope(user_id,client_id)`, `ix_usage_scope(user_id,client_id)` back the hot scoped reads. Documents are whole‑JSON blobs (one row per `doc_key`), so a read/write is a single indexed row op. Per‑doc cap 6 MB.
**Observed Limitation:** very large mapping sets are stored as one JSON blob per client — a big `ai_mappings` doc is read/written whole on each change (mitigated by debounced writes). SQLite on local disk ties data to one host.
**Recommendation:** if mapping volumes get large, consider row‑per‑mapping storage (and server‑side pagination) instead of a single blob.

## API performance

**Current:** thin blueprints; most non‑AI endpoints are single indexed SQLite ops. `/api/db/*` open short‑lived pyodbc connections per request.
**Recommendation:** connection pooling for SQL Server if profiling/metadata calls become frequent.

## LLM latency & token usage

**Current:** the dominant latency source. Mitigations already in place:
- **Loop + merge** avoids output truncation but multiplies calls: mapping generation is **one call per target entity** (and per 40‑field chunk); extraction is **one call per file chunk**; ETL/DDL auto‑continue on truncation (≤5).
- `max_tokens` sized per feature (16000 mapping/extraction/entity; 8000 ETL; 6000 DDL; 4000 fix; 2500 column; 2000 regenerate).
- httpx `timeout=600s`.
- Token usage is recorded per call (`aims_usage.db`) and shown in the AI Usage Report.
**Observed Limitation:** generating mappings for many tables is inherently many sequential calls (the frontend loops per table), so wall‑clock scales with table count; there is no server‑side parallelism.
**Recommendation:** batch or parallelize per‑entity calls where the gateway allows; surface progress (already done via the console/stream); cache repeat extractions.

## File processing

**Current:** uploads parsed in memory; deterministic fast‑paths (SQL DDL, structured Excel) avoid AI entirely and are instant; otherwise chunked (`EXTRACT_TEXT_BUDGET`/`EXTRACT_AI_CHUNK`, wide‑sheet column slicing, table‑boundary splitting) with a `EXTRACT_MAX_CHUNKS=200` safety cap and per‑chunk retry‑once‑then‑skip. Streaming endpoint reports progress.
**Recommendation:** enforce an explicit max upload size at the route ([16](16-security.md)).

## Memory usage

**Current:** files parsed fully in memory; SQLite datasets are small; the client holds all tenant docs in `CLIENT_STATE`.
**Observed Limitation:** very large files/schemas increase server memory transiently and client memory persistently (whole state in the browser).

## Potential bottlenecks (summary)

1. **LLM call fan‑out** for multi‑table mapping generation (sequential). — biggest wall‑clock cost.
2. **Global write lock + SQLite** under concurrent writers.
3. **Whole‑blob per‑client documents** for very large mapping sets.
4. **Single dev‑server process** (no horizontal scaling as configured).

## Scaling considerations

The design is appropriate for a **small team per host**. To scale up: production WSGI + multiple workers, Postgres (portable schema), a shared deploy‑job/store, optional AI‑result caching, and row‑level mapping storage with server‑side pagination.
