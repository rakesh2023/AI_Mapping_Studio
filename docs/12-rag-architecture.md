# 12 — RAG Architecture

**This application does not currently implement RAG.**

Verified across the whole repository:
- **No embeddings** are generated anywhere (no embedding model, no `embed`/`embedding` calls).
- **No vector database / index / collection** (no FAISS, Chroma, Pinecone, pgvector, Weaviate, Milvus, etc.; the only datastores are the two SQLite files in [09](09-database.md) plus live SQL Server).
- **No retriever, similarity search, reranker, or citation mechanism.**

### What is superficially similar but is NOT RAG

- **File "extraction"** (`extraction_service.py`) reads an uploaded file, **chunks** it (by tables/sheets/size), and sends each chunk to Claude to extract tables/columns. This is a *chunk‑and‑merge extraction* pipeline, not retrieval‑augmented generation — there is no vector store and no similarity retrieval; every chunk is sent in full, in order, and the results are unioned. See [10](10-ai-genai-architecture.md) and the parsers in [11].
- **Mapping generation** grounds Claude by **inlining the full source/target schema** into the prompt (see P1u in [11](11-prompt-inventory.md)). Context comes from the request payload, not from a retrieval step.

### Recommended Improvement (optional)

If schemas grow beyond what fits in a single prompt, a future enhancement could embed source columns and retrieve the top‑K candidates per target field before asking Claude to choose — turning the current "inline everything" approach into true RAG. This is **not** implemented today.
