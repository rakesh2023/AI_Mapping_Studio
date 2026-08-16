"""Know Your Data chat: sessions + the send-message orchestration.

send_message implements the full turn:
  (a) load last N turns of history
  (b) if history exists, condense the follow-up into a standalone question
  (c) route it with kyd_query_router over the user's READY sources
  (d) retrieve context via vector search and/or the structured query tool
  (e) empty/low-confidence context -> fallback message
  (f) otherwise answer with kyd_rag_service (grounded + citations)
Both the user and assistant messages are persisted; everything is scoped to the
session's (user_id, client_id).
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.core.capabilities import anthropic
from app.core.config import ai_model
from app.db.app_db import connect, write_lock
from app.db import kyd_models as M
from app.services.ai_client import anthropic_client
from app.services.ai_client_service import call_ai
from app.services import kyd_query_router, kyd_vector_store, kyd_sql_service, kyd_rag_service

Payload = Dict[str, Any]
Result = Tuple[Payload, int]

LAST_N_TURNS = 10                 # history messages fed to condense
VECTOR_MIN_SCORE = 0.05           # below this a vector hit is treated as no-context
VECTOR_TOP_K = 5
SQL_ROWS_IN_CONTEXT = 20          # rows rendered into the answer context


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #
def create_session(user_id: int, client_id: int, title: Optional[str] = None,
                   document_scope: Optional[List[int]] = None) -> Result:
    with write_lock():
        conn = connect()
        try:
            cur = conn.execute(
                "INSERT INTO chat_sessions (user_id, client_id, title, document_scope, created_at) "
                "VALUES (?,?,?,?,?)",
                (user_id, client_id, (title or None),
                 json.dumps(document_scope) if document_scope else None, _now()),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM chat_sessions WHERE id=?", (cur.lastrowid,)).fetchone()
        finally:
            conn.close()
    return {"ok": True, "session": M.ChatSession.from_row(row).public_dict()}, 201


def list_sessions(user_id: int, client_id: int) -> Result:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM chat_sessions WHERE user_id=? AND client_id=? ORDER BY id DESC",
            (user_id, client_id),
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "sessions": [M.ChatSession.from_row(r).public_dict() for r in rows]}, 200


def _owned_session(conn, user_id, client_id, session_id):
    return conn.execute(
        "SELECT * FROM chat_sessions WHERE id=? AND user_id=? AND client_id=?",
        (session_id, user_id, client_id),
    ).fetchone()


def get_messages(user_id: int, client_id: int, session_id: int) -> Result:
    conn = connect()
    try:
        if not _owned_session(conn, user_id, client_id, session_id):
            return {"ok": False, "error": "Chat session not found."}, 404
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE session_id=? ORDER BY id ASC", (session_id,)
        ).fetchall()
    finally:
        conn.close()
    return {"ok": True, "messages": [M.ChatMessage.from_row(r).public_dict() for r in rows]}, 200


# --------------------------------------------------------------------------- #
# Send message (the full turn)
# --------------------------------------------------------------------------- #
def send_message(user_id: int, client_id: int, session_id: int, question: str) -> Result:
    question = (question or "").strip()
    if not question:
        return {"ok": False, "error": "Empty message."}, 400

    conn = connect()
    try:
        session_row = _owned_session(conn, user_id, client_id, session_id)
        if not session_row:
            return {"ok": False, "error": "Chat session not found."}, 404
        # (a) last N turns
        history = conn.execute(
            "SELECT role, content FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
            (session_id, LAST_N_TURNS),
        ).fetchall()
        history = list(reversed(history))
        scope = session_row["document_scope"]
    finally:
        conn.close()

    # (b) condense follow-up into a standalone question when there's prior context
    standalone = _condense(history, question) if history else question

    # (c) route over the user's ready sources
    sources, name2doc, doc2stx = _ready_sources(user_id, client_id)
    route_info = kyd_query_router.route_query(standalone, sources)
    route = route_info.get("route", "vector_search")
    targets = route_info.get("target_sources") or [s["name"] for s in sources]
    target_docs = [name2doc[n] for n in targets if n in name2doc]

    # (d) retrieve context per the route
    contexts, citations = _retrieve(user_id, client_id, route, standalone, target_docs, doc2stx)

    # (e)/(f) fallback if nothing usable, else grounded answer
    if not contexts:
        answer_text, usage = kyd_rag_service.FALLBACK_MESSAGE, None
        citations = []
    else:
        res = kyd_rag_service.answer(standalone, contexts)
        answer_text, usage = res["answer"], res.get("usage")
        if not res.get("grounded"):
            citations = []

    assistant = _persist_turn(user_id, client_id, session_id, question, answer_text,
                              route, citations, usage, set_title=not history)
    return {"ok": True, "sessionId": session_id, "route": route,
            "standaloneQuestion": standalone, "answer": answer_text,
            "citations": citations, "usage": usage,
            "message": assistant}, 200


def _condense(history: List[Any], question: str) -> str:
    """Rewrite a follow-up into a standalone question using the chat history."""
    if anthropic is None:
        return question
    hist_text = "\n".join(f"{r['role']}: {r['content']}" for r in history)
    system = ("You rewrite a user's follow-up question into a standalone question. "
              "Output ONLY the standalone question, nothing else.")
    user = ("Given the conversation history and a follow-up question, rewrite the "
            "follow-up question into a standalone question that includes all necessary "
            "context.\nChat history: " + hist_text + '\nFollow-up question: "' + question
            + '"\nStandalone question:')
    try:
        client = anthropic_client()
        base_kwargs = dict(model=ai_model(), max_tokens=300, system=system,
                           messages=[{"role": "user", "content": user}])

        def run(extra):
            with client.messages.stream(**base_kwargs, **extra) as stream:
                return stream.get_final_message()

        resp = call_ai("Know Your Data - Condense Question", run,
                       [{"output_config": {"effort": "low"}}, {}])
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
        return text or question
    except Exception:  # noqa: BLE001 - condense is best-effort
        return question


def _ready_sources(user_id: int, client_id: int):
    """Return (router_sources, name->doc_id, doc_id->[structured_table_id]) for READY docs."""
    conn = connect()
    try:
        docs = conn.execute(
            "SELECT id, filename, content_kind, detected_topics FROM documents "
            "WHERE user_id=? AND client_id=? AND status='ready' ORDER BY id DESC",
            (user_id, client_id),
        ).fetchall()
        stx = conn.execute(
            "SELECT id, document_id, logical_name FROM structured_tables "
            "WHERE user_id=? AND client_id=?", (user_id, client_id),
        ).fetchall()
    finally:
        conn.close()

    doc2stx: Dict[int, List[int]] = {}
    for s in stx:
        doc2stx.setdefault(s["document_id"], []).append(s["id"])

    sources, name2doc = [], {}
    for d in docs:
        name = d["filename"]
        name2doc[name] = d["id"]
        topics = []
        try:
            topics = json.loads(d["detected_topics"]) if d["detected_topics"] else []
        except (ValueError, TypeError):
            topics = []
        desc = ", ".join(topics) if topics else ""
        sources.append({"name": name, "id": d["id"],
                        "type": d["content_kind"] or "unstructured", "description": desc})
    return sources, name2doc, doc2stx


def _retrieve(user_id, client_id, route, question, target_docs, doc2stx):
    """Gather context snippets + citations for the chosen route."""
    contexts: List[Dict[str, Any]] = []
    citations: List[Dict[str, Any]] = []

    def _add(text, citation):
        label = f"S{len(contexts) + 1}"
        contexts.append({"label": label, "text": text})
        citations.append({**citation, "label": label})

    if route in ("vector_search", "hybrid"):
        hits = kyd_vector_store.search(user_id, client_id, question,
                                       doc_ids=target_docs or None, k=VECTOR_TOP_K)
        for h in hits:
            if h.get("score", 0) < VECTOR_MIN_SCORE:
                continue
            _add(h["text"], {"type": "vector", "documentId": h["documentId"],
                             "chunkId": h["chunkId"], "page": h.get("page"),
                             "section": h.get("section"),
                             "snippet": (h["text"] or "")[:200]})

    if route in ("sql_query", "pandas_query", "hybrid"):
        st_ids = [st for d in (target_docs or list(doc2stx.keys())) for st in doc2stx.get(d, [])]
        for st_id in st_ids:
            res = kyd_sql_service.run_query(user_id, client_id, question, st_id)
            if not res.get("ok"):
                continue
            text = _render_rows(res)
            _add(text, {"type": "structured", "table": res.get("table"),
                        "query": res.get("query"), "snippet": text[:200]})

    return contexts, citations


def _render_rows(res: Dict[str, Any]) -> str:
    cols = res.get("columns") or []
    rows = (res.get("rows") or [])[:SQL_ROWS_IN_CONTEXT]
    lines = [f"Query result from table '{res.get('table')}' (SQL: {res.get('query')}):",
             " | ".join(str(c) for c in cols)]
    for r in rows:
        lines.append(" | ".join("" if v is None else str(v) for v in r))
    if res.get("truncated"):
        lines.append("… (results truncated)")
    return "\n".join(lines)


def _persist_turn(user_id, client_id, session_id, user_text, assistant_text,
                  route, citations, usage, set_title: bool) -> Dict[str, Any]:
    ts = _now()
    with write_lock():
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO chat_messages (session_id, user_id, client_id, role, content, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (session_id, user_id, client_id, "user", user_text, ts),
            )
            cur = conn.execute(
                "INSERT INTO chat_messages (session_id, user_id, client_id, role, content, route, "
                "citations_json, usage_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (session_id, user_id, client_id, "assistant", assistant_text, route,
                 json.dumps(citations) if citations else None,
                 json.dumps(usage) if usage else None, ts),
            )
            assistant_id = cur.lastrowid
            if set_title:
                conn.execute("UPDATE chat_sessions SET title=?, updated_at=? WHERE id=? AND title IS NULL",
                             (user_text[:80], ts, session_id))
            conn.execute("UPDATE chat_sessions SET updated_at=? WHERE id=?", (ts, session_id))
            conn.commit()
            row = conn.execute("SELECT * FROM chat_messages WHERE id=?", (assistant_id,)).fetchone()
        finally:
            conn.close()
    return M.ChatMessage.from_row(row).public_dict()
