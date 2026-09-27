"""Generate the Technology Stack document (PDF) for AI Data Conversion Studio.

Senior-architect deliverable for the deployment manager, formatted in PwC brand
style: PwC logo + the signature multi-colour stripe, PwC-orange accents, and a
PwC footer. All content is derived from the actual codebase.

Run:
    pip install reportlab svglib
    python deck/build_tech_stack.py
Output:
    deck/AI_Data_Conversion_Studio_Tech_Stack.pdf
"""
import os
from datetime import date

from reportlab.graphics import renderPDF
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)
from reportlab.platypus.doctemplate import NextPageTemplate as _NPT
from svglib.svglib import svg2rlg

# --- PwC brand palette --- #
PWC_ORANGE = colors.HexColor("#d04a02")     # primary
PWC_ORANGE_DK = colors.HexColor("#a83a00")
PWC_TANGERINE = colors.HexColor("#eb8c00")
PWC_YELLOW = colors.HexColor("#ffb600")
PWC_ROSE = colors.HexColor("#db536a")
PWC_RED = colors.HexColor("#e0301e")
PWC_BLACK = colors.HexColor("#2d2d2d")
INK = colors.HexColor("#3d3d3d")
GREY = colors.HexColor("#7d7d7d")
LIGHT = colors.HexColor("#f4f4f5")
ROW_ALT = colors.HexColor("#faf7f5")
LINE = colors.HexColor("#dcdce0")
WHITE = colors.white
STRIPE = [PWC_ORANGE, PWC_TANGERINE, PWC_YELLOW, PWC_ROSE, PWC_RED]

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "AI_Data_Conversion_Studio_Tech_Stack.pdf")
LOGO_PATH = os.path.join(ROOT, "assets", "images", "pwc-logo-dark.svg")  # orange, reads on white

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

# ----------------------------------------------------------------------------- #
# Logo
# ----------------------------------------------------------------------------- #
def _load_logo(target_w):
    d = svg2rlg(LOGO_PATH)
    s = target_w / d.width
    d.scale(s, s)
    d.width *= s
    d.height *= s
    return d


_LOGO_COVER = _load_logo(34 * mm)
_LOGO_HEAD = _load_logo(18 * mm)

# ----------------------------------------------------------------------------- #
# Styles
# ----------------------------------------------------------------------------- #
ss = getSampleStyleSheet()

H1TXT = ParagraphStyle("H1TXT", fontName="Helvetica-Bold", fontSize=14.5,
                       textColor=PWC_BLACK, leading=17)
H2 = ParagraphStyle("H2", fontName="Helvetica-Bold", fontSize=11, textColor=PWC_ORANGE_DK,
                    spaceBefore=9, spaceAfter=3, leading=13)
BODY = ParagraphStyle("Body", fontName="Helvetica", fontSize=9.5, textColor=INK,
                      leading=13.5, spaceAfter=6, alignment=TA_LEFT)
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=12, bulletIndent=2, spaceAfter=3)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=8.6, leading=11.5, spaceAfter=0, textColor=INK)
CELL_B = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold", textColor=PWC_BLACK)
CELL_HEAD = ParagraphStyle("CellHead", parent=CELL, fontName="Helvetica-Bold",
                           textColor=WHITE, fontSize=8.8)
MONO = ParagraphStyle("Mono", parent=CELL, fontName="Courier", textColor=PWC_ORANGE_DK)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8, textColor=GREY, leading=10.5)

COVER_KICKER = ParagraphStyle("CoverKicker", fontName="Helvetica-Bold", fontSize=10.5,
                              textColor=PWC_ORANGE, alignment=TA_LEFT, spaceAfter=8)
COVER_TITLE = ParagraphStyle("CoverTitle", fontName="Helvetica-Bold", fontSize=30,
                             textColor=PWC_BLACK, alignment=TA_LEFT, leading=34, spaceAfter=10)
COVER_SUB = ParagraphStyle("CoverSub", fontName="Helvetica", fontSize=13, textColor=GREY,
                           alignment=TA_LEFT, leading=18)


def P(text, style=BODY):
    return Paragraph(text, style)


def bullets(items, style=BULLET):
    return [Paragraph(f"<bullet>&bull;</bullet> {t}", style) for t in items]


def section(num, title):
    """PwC-style section header: orange accent bar + dark title."""
    t = Table([["", Paragraph(f"{num}. {title}", H1TXT)]],
              colWidths=[3 * mm, CONTENT_W - 3 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PWC_ORANGE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0), ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    t.spaceBefore = 14
    t.spaceAfter = 6
    return t


def pwc_stripe(width, h=2.4 * mm):
    n = len(STRIPE)
    cw = width / n
    t = Table([[""] * n], colWidths=[cw] * n, rowHeights=[h])
    st = [("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
          ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]
    for i, c in enumerate(STRIPE):
        st.append(("BACKGROUND", (i, 0), (i, 0), c))
    t.setStyle(TableStyle(st))
    return t


def make_table(header, rows, col_widths, zebra=True):
    data = [[Paragraph(h, CELL_HEAD) for h in header]]
    for r in rows:
        data.append([c if isinstance(c, Paragraph) else Paragraph(str(c), CELL) for c in r])
    t = Table(data, colWidths=col_widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), PWC_ORANGE),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 1), (-1, -1), 0.4, LINE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, PWC_ORANGE),
        ("BOX", (0, 0), (-1, -1), 0.6, PWC_ORANGE),
    ]
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), ROW_ALT))
    t.setStyle(TableStyle(style))
    return t


# ----------------------------------------------------------------------------- #
# Page furniture
# ----------------------------------------------------------------------------- #
def _footer(canvas, doc, page_label=True):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 13 * mm, PAGE_W - MARGIN, 13 * mm)
    canvas.setFillColor(GREY)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(MARGIN, 9.4 * mm,
                      "© %d PwC. All rights reserved. PwC refers to the PwC network and/or "
                      "one or more of its member firms." % date.today().year)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(MARGIN, 6.2 * mm, "Confidential — Internal Use")
    canvas.drawCentredString(PAGE_W / 2, 6.2 * mm, f"Generated {date.today().isoformat()}")
    if page_label:
        canvas.drawRightString(PAGE_W - MARGIN, 6.2 * mm, f"Page {doc.page - 1}")
    canvas.restoreState()


def _cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(WHITE)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    # PwC logo, top-left
    renderPDF.draw(_LOGO_COVER, canvas, MARGIN, PAGE_H - 26 * mm)
    # thin brand rule under the logo
    canvas.setFillColor(PWC_ORANGE)
    canvas.rect(MARGIN, PAGE_H - 29 * mm, CONTENT_W, 0.8, fill=1, stroke=0)
    _footer(canvas, doc, page_label=False)
    canvas.restoreState()


def _content_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(WHITE)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    # header: small PwC logo right + document title left + orange rule
    renderPDF.draw(_LOGO_HEAD, canvas, PAGE_W - MARGIN - _LOGO_HEAD.width, PAGE_H - 15 * mm)
    canvas.setFillColor(PWC_BLACK)
    canvas.setFont("Helvetica-Bold", 8.5)
    canvas.drawString(MARGIN, PAGE_H - 12.5 * mm, "AI Data Conversion Studio")
    canvas.setFillColor(GREY)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(MARGIN, PAGE_H - 15.5 * mm, "Technology Stack — Architecture Reference")
    canvas.setFillColor(PWC_ORANGE)
    canvas.rect(MARGIN, PAGE_H - 17.5 * mm, CONTENT_W, 0.8, fill=1, stroke=0)
    _footer(canvas, doc, page_label=True)
    canvas.restoreState()


# ----------------------------------------------------------------------------- #
# Build
# ----------------------------------------------------------------------------- #
def build():
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=16 * mm, bottomMargin=17 * mm,
                          title="AI Data Conversion Studio — Technology Stack",
                          author="PwC — Solution Architecture / Rakesh Sinha")
    frame = Frame(MARGIN, 15 * mm, CONTENT_W, PAGE_H - 34 * mm, id="body")
    cover_frame = Frame(MARGIN, 30 * mm, CONTENT_W, PAGE_H - 68 * mm, id="cover")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[cover_frame], onPage=_cover_page),
        PageTemplate(id="content", frames=[frame], onPage=_content_page),
    ])

    story = []

    # ---------------- COVER ---------------- #
    story.append(Spacer(1, 34 * mm))
    story.append(P("TECHNOLOGY STACK DOCUMENT", COVER_KICKER))
    story.append(P("AI Data Conversion Studio", COVER_TITLE))
    story.append(pwc_stripe(74 * mm))
    story.append(Spacer(1, 10))
    story.append(P("AI-Assisted Source-to-Target Data Migration Mapping Platform<br/>"
                   "for Insurance / Guidewire modernization programs", COVER_SUB))
    story.append(Spacer(1, 16 * mm))

    dc = [
        ["Document", "Technology Stack &amp; Architecture Reference"],
        ["Prepared for", "Deployment Manager / Release &amp; Operations"],
        ["Prepared by", "Solution Architecture / Rakesh Sinha"],
        ["Audience", "Deployment, Infrastructure &amp; Security reviewers"],
        ["Version", "1.0"],
        ["Date", date.today().strftime("%d %B %Y")],
        ["Status", "For deployment review"],
        ["Classification", "Confidential — Internal Use"],
    ]
    dc_rows = [[Paragraph(k, CELL_B), Paragraph(v, CELL)] for k, v in dc]
    dct = Table(dc_rows, colWidths=[45 * mm, CONTENT_W - 45 * mm])
    dct.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(dct)
    story.append(_NPT("content"))
    story.append(PageBreak())

    # ---------------- 1. EXECUTIVE SUMMARY ---------------- #
    story.append(section(1, "Executive Summary"))
    story.append(P(
        "AI Data Conversion Studio helps teams map data from old source systems to new "
        "<b>Guidewire</b> targets (ClaimCenter, PolicyCenter, BillingCenter) during an "
        "insurance data migration. It reads the source system's structure and uses "
        "<b>Claude</b> (an AI model) to suggest the field-to-field mappings, join logic, "
        "value mappings and validation/ETL SQL — which the migration team then reviews "
        "and refines."))
    story.append(P(
        "The design is deliberately simple: a plain <b>HTML/CSS/JavaScript</b> website "
        "served by one small <b>Python (Flask)</b> service on a single address — no "
        "separate web server and no build step. The backend keeps no long-running state: "
        "it opens short database connections when needed, calls the Claude API through the "
        "corporate gateway, and stores users and each client's working data in a local "
        "<b>SQLite</b> file. It runs as a normal service with "
        "<font face='Courier'>python main.py</font> (or behind a production WSGI server). "
        "The rest of this document lists each part of the stack, its version, and how it "
        "is installed."))

    # ---------------- 2. STACK AT A GLANCE ---------------- #
    story.append(section(2, "Stack at a Glance"))
    story.append(P("The platform is organized into the following technology layers.", BODY))
    glance = [
        ["Presentation", "HTML5, CSS3, vanilla JavaScript (ES6, no framework); Bootstrap 5.3, "
                         "Bootstrap Icons, Chart.js, SheetJS", "Browser UI, dashboards, editors"],
        ["Application / API", "Python 3.12, Flask 3 (app-factory + blueprints), Werkzeug", "REST-style /api/* over a single origin"],
        ["AI / GenAI", "Anthropic Claude SDK via corporate Bedrock-style gateway (httpx)", "Mapping generation, extraction, chat, SQL"],
        ["Retrieval (RAG)", "fastembed (BGE-small ONNX) / NumPy hashing fallback; SQLite-native vector store", "Know Your Data document Q&amp;A"],
        ["Document parsing", "openpyxl, pypdf, python-docx, pandas, sqlparse; custom SQL-DDL parser", "Excel / PDF / Word / CSV / SQL ingestion"],
        ["Data connectivity", "pyodbc + Microsoft ODBC Driver for SQL Server 17/18", "Live source &amp; target metadata, profiling, deploy"],
        ["Persistence", "SQLite (stdlib sqlite3); browser localStorage; in-memory job store", "Identity, tenant data, telemetry, working state"],
        ["Security", "Flask signed sessions, Werkzeug scrypt hashing, CSRF, multi-tenant scoping", "Auth, isolation, transport trust"],
        ["Quality", "pytest (41 test modules)", "Backend regression tests"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in glance]
    story.append(make_table(["Layer", "Core technologies", "Role"], rows,
                            [30 * mm, CONTENT_W - 30 * mm - 42 * mm, 42 * mm]))

    story.append(PageBreak())

    # ---------------- 3. FRONTEND ---------------- #
    story.append(section(3, "Frontend / Presentation Layer"))
    story.append(P(
        "The frontend is a set of standalone HTML pages under "
        "<font face='Courier'>pages/</font>, each paired with its own vanilla-JS "
        "controller under <font face='Courier'>js/</font>. A shared shell "
        "(<font face='Courier'>js/common.js</font>) injects the sidebar and header, "
        "applies the persisted theme, and holds storage/connection helpers. There is "
        "<b>no framework and no build step</b> — files are served as-is by Flask.", BODY))
    fe = [
        ["HTML5 / CSS3", "—", "Static markup; token-based theming with light/dark modes"],
        ["JavaScript (ES6)", "—", "Vanilla, framework-free; string-built HTML render functions"],
        ["Bootstrap", "5.3.3", "Layout, components, responsive grid (jsDelivr CDN)"],
        ["Bootstrap Icons", "1.11.3", "Icon set (jsDelivr CDN)"],
        ["Chart.js", "4.4.1", "Dashboard / usage-report charts"],
        ["SheetJS (xlsx)", "0.18.5", "Client-side Excel export/read"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in fe]
    story.append(make_table(["Technology", "Version", "Purpose"], rows,
                            [38 * mm, 20 * mm, CONTENT_W - 58 * mm]))
    story.append(P(
        "<b>State model:</b> working data (generated mappings, source/target "
        "connections, history, settings) lives in the browser under "
        "<font face='Courier'>aims_*</font> localStorage keys and is mirrored "
        "server-side per client. The ~5&nbsp;MB localStorage quota is the main "
        "client-side scaling limit for very large schemas.", SMALL))

    # ---------------- 4. BACKEND ---------------- #
    story.append(section(4, "Backend / Application Layer"))
    story.append(P(
        "The backend is a Flask application factory "
        "(<font face='Courier'>create_app()</font>) launched by "
        "<font face='Courier'>server/main.py</font>, serving both the static site and "
        "the <font face='Courier'>/api/*</font> endpoints on "
        "<font face='Courier'>127.0.0.1:8000</font>. It follows a strict layered "
        "architecture with a one-way import direction "
        "<font face='Courier'>api → services → parsers/schemas → core</font>.", BODY))
    be = [
        ["Python", "3.12", "Runtime language (developed/tested on 3.12.5)"],
        ["Flask", "&ge; 3.0", "Web framework: app factory, 12 blueprints, before/after-request guards"],
        ["Werkzeug", "(with Flask)", "WSGI utilities + password hashing (scrypt)"],
        ["httpx", "&ge; 0.25, &lt; 1", "HTTP client for the Claude gateway (custom CA trust)"],
        ["NumPy", "&ge; 1.24", "Vector maths for embeddings / similarity"],
        ["Blueprints", "—", "static, auth, client, state, db, ai, deploy, ai_usage, admin, kyd, feedback, lookup"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in be]
    story.append(make_table(["Component", "Version", "Purpose"], rows,
                            [34 * mm, 26 * mm, CONTENT_W - 60 * mm]))
    story.append(P("<b>Backend package layers</b>", H2))
    story.extend(bullets([
        "<b>core/</b> — environment/path config, model id resolution, CA-bundle lookup, "
        "and centralized optional-import capability guards.",
        "<b>parsers/</b> — pure text/file parsing &amp; chunking (SQL DDL, Excel dictionaries, "
        "text/table splitting); no Flask or AI dependency.",
        "<b>schemas/</b> — JSON schemas for Claude structured output.",
        "<b>services/</b> — business logic (auth, clients, DB, AI client, mapping, extraction, "
        "KYD/RAG, lookup, deployment, admin, usage); each returns (payload, http_status).",
        "<b>db/</b> — multi-tenant SQLite app store (connection, schema, models).",
        "<b>api/</b> — thin blueprints: parse request → call service → jsonify.",
    ]))

    story.append(PageBreak())

    # ---------------- 5. AI / GENAI ---------------- #
    story.append(section(5, "AI / GenAI Layer"))
    story.append(P(
        "AI features call <b>Anthropic Claude</b> through the official Python SDK, "
        "routed to a corporate <b>Bedrock-style gateway</b> "
        "(<font face='Courier'>ANTHROPIC_BASE_URL</font> + "
        "<font face='Courier'>ANTHROPIC_AUTH_TOKEN</font> / "
        "<font face='Courier'>ANTHROPIC_API_KEY</font>). The default model is "
        "<font face='Courier'>bedrock.anthropic.claude-opus-4-8</font> "
        "(Claude Opus 4.8), overridable via <font face='Courier'>AIMS_MODEL</font>; "
        "the client trusts the corporate TLS-intercepting proxy via a local CA bundle.", BODY))
    ai = [
        ["anthropic (SDK)", "&ge; 0.40", "Claude API client for all GenAI calls"],
        ["Default model", "Claude Opus 4.8", "bedrock.anthropic.claude-opus-4-8 (gateway id)"],
        ["Transport", "httpx + corporate CA bundle", "TLS trust for the internal gateway"],
        ["Structured output", "JSON-schema, 4-step ladder", "Degrades schema+effort → schema → effort → bare"],
        ["Streaming", "NDJSON progress events", "File-extraction progress bar with non-stream fallback"],
        ["Usage logging", "SQLite (aims_usage.db)", "Per-call token counts + metadata (telemetry)"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in ai]
    story.append(make_table(["Aspect", "Detail", "Notes"], rows,
                            [36 * mm, 44 * mm, CONTENT_W - 80 * mm]))
    story.append(P("<b>How the AI is kept reliable</b>", H2))
    story.extend(bullets([
        "<b>Work in small pieces</b> — big jobs are split (per target table, and per column "
        "for wide tables) so the AI's answer is never cut off; the pieces are merged back together.",
        "<b>Stay grounded</b> — the AI may only use tables and columns that actually exist, "
        "so it cannot invent them.",
        "<b>Skip the AI when possible</b> — SQL scripts and well-structured Excel are read "
        "directly (no AI — faster and exact); only messy files go to the model.",
        "<b>Fail safely</b> — calls retry and fall back automatically; a failed deployment "
        "step is fixed by the AI but always shown for a human to approve, never run on its own.",
    ]))

    # ---------------- 6. RAG ---------------- #
    story.append(section(6, "Retrieval-Augmented Generation (Know Your Data)"))
    story.append(P(
        "The <b>Know Your Data</b> feature lets users upload insurance documents and "
        "chat over them. It runs a full RAG pipeline — ingest → chunk → embed "
        "→ retrieve → grounded answer — plus text-to-SQL over structured "
        "uploads. A query router chooses a vector, structured, or hybrid strategy per "
        "question, and answers cite their sources.", BODY))
    rag = [
        ["Embeddings (primary)", "fastembed — BAAI/bge-small-en-v1.5", "384-dim ONNX semantic vectors, no API key"],
        ["Embeddings (fallback)", "NumPy hashing embedder", "256-dim lexical vectors, always available offline"],
        ["Vector store", "SQLite-native (float32 BLOB)", "Tenant-scoped cosine similarity in NumPy"],
        ["Chunking / ingestion", "Custom chunker + loaders", "PDF/text chunking; CSV/Excel/SQL structured loading"],
        ["Retrieval scope", "user_id + client_id", "Per-tenant isolation; optional document scoping"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in rag]
    story.append(make_table(["Element", "Technology", "Notes"], rows,
                            [40 * mm, 55 * mm, CONTENT_W - 95 * mm]))
    story.append(P(
        "The vector store reuses the existing SQLite database rather than introducing "
        "pgvector or a dedicated vector DB — appropriate for the small per-tenant "
        "corpora this tool handles. A <font face='Courier'>sqlite-vec</font> ANN index "
        "can slot in behind the same interface if corpora grow.", SMALL))

    story.append(PageBreak())

    # ---------------- 7. DOCUMENT PARSING ---------------- #
    story.append(section(7, "Document Parsing &amp; Data Connectivity"))
    story.append(P(
        "File ingestion and live-database access are provided by optional libraries "
        "guarded by centralized capability checks: if a package is absent the app still "
        "boots and reports the missing capability only when a matching request arrives.", BODY))
    dp = [
        ["openpyxl", "&ge; 3.1", "Excel (.xlsx/.xlsm/.xls) parsing &amp; dictionary extraction"],
        ["pypdf", "&ge; 4.0", "PDF text extraction"],
        ["python-docx", "&ge; 1.1", "Word (.docx) parsing"],
        ["pandas", "&ge; 2.0", "Tabular parsing &amp; data profiling (Know Your Data)"],
        ["sqlparse", "&ge; 0.4", "Pretty-printing generated SQL (optional, guarded)"],
        ["pyodbc", "&ge; 5.1", "Live SQL Server metadata, profiling &amp; deployment"],
        ["MS ODBC Driver", "17 or 18", "System prerequisite for pyodbc connections"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in dp]
    story.append(make_table(["Library / Driver", "Version", "Purpose"], rows,
                            [40 * mm, 22 * mm, CONTENT_W - 62 * mm]))

    # ---------------- 8. DATA STORAGE ---------------- #
    story.append(section(8, "Data Storage &amp; Persistence"))
    story.append(P(
        "There is no external database server for application state. Persistence is "
        "split across three tiers:", BODY))
    ds = [
        ["SQLite — app store", "server/aims_app.db", "Users, clients, per-client tenant documents, KYD documents / "
                                                          "chunks / embeddings / chat, lookup value mappings, and "
                                                          "Guidewire (CC/PC/BC) dictionary indexes"],
        ["SQLite — usage", "server/aims_usage.db", "AI usage telemetry: per-call token counts + metadata"],
        ["Browser localStorage", "aims_* keys", "Primary client working state; ~5&nbsp;MB quota per origin"],
        ["In-memory", "process dict + lock", "Background deployment job state (not persisted; history kept client-side)"],
        ["SQL Server", "external, per connection", "Source &amp; target customer databases — read live, never copied server-side"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in ds]
    story.append(make_table(["Store", "Location / key", "Contents"], rows,
                            [34 * mm, 34 * mm, CONTENT_W - 68 * mm]))
    story.append(P(
        "Access uses the stdlib <font face='Courier'>sqlite3</font> module (no ORM) "
        "with a process-wide write lock, foreign keys enabled per connection, and "
        "short-lived per-operation connections. Every tenant table is scoped by "
        "<font face='Courier'>user_id + client_id</font> with "
        "<font face='Courier'>ON DELETE CASCADE</font>.", SMALL))

    story.append(PageBreak())

    # ---------------- 9. SECURITY ---------------- #
    story.append(section(9, "Security &amp; Identity"))
    story.append(P(
        "The application is closed and multi-tenant. Every page and API is gated behind "
        "an authenticated session; users are created by an administrator (self-signup "
        "disabled by default).", BODY))
    sec = [
        ["Authentication", "Flask signed-cookie sessions; HttpOnly + SameSite=Lax; 12&nbsp;h default lifetime"],
        ["Password storage", "Werkzeug scrypt hashing; plaintext never stored or returned"],
        ["Brute-force defense", "In-memory per-email login throttling with temporary lockout"],
        ["CSRF", "Double-submit token on state-changing /api/* requests (defense-in-depth over SameSite)"],
        ["Multi-tenancy", "All tenant data scoped by user_id + client_id; cross-tenant reads prevented by query scoping"],
        ["Admin / lifecycle", "Env-seeded admin, forced-password-change flow, orphan-ingest reconciliation on startup"],
        ["Secrets handling", "Credentials come from env vars / per-request payloads; never written to jobs, logs or prompts"],
        ["Transport trust", "Corporate CA bundle (win-ca-bundle.pem) wired into httpx for the TLS-intercepting proxy"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL)] for a, b in sec]
    story.append(make_table(["Control", "Implementation"], rows, [42 * mm, CONTENT_W - 42 * mm]))
    story.append(P(
        "<b>Deployment note:</b> <font face='Courier'>AIMS_SECRET_KEY</font> must be set "
        "to a long random value in any real deployment — without it a random "
        "per-process key is used and all sessions are invalidated on restart.", SMALL))

    # ---------------- 10. DEPLOYMENT ---------------- #
    story.append(section(10, "Deployment"))
    story.append(P("The application is deployed as a single Python/Flask service from the codebase, "
                   "serving the static site and the API on one origin.", BODY))
    story.extend(bullets([
        "<font face='Courier'>pip install -r server/requirements.txt</font>, then "
        "<font face='Courier'>cd server &amp;&amp; python main.py</font> — serves the whole "
        "app (static site + <font face='Courier'>/api/*</font>) at "
        "<font face='Courier'>http://127.0.0.1:8000</font>.",
        "A module-level <font face='Courier'>app</font> is exposed, so the same code runs behind a "
        "production WSGI server (e.g. waitress / gunicorn) fronted by a reverse proxy.",
        "The dependency-free <font face='Courier'>.env</font> loader reads "
        "<font face='Courier'>server/.env</font> at startup; real environment variables always win.",
    ]))

    story.append(PageBreak())

    # ---------------- 11. INSTALLATION AT A GLANCE ---------------- #
    story.append(section(11, "Installation at a Glance — What, How &amp; When"))
    story.append(P(
        "Every software component, with how and when it is installed. Items marked "
        "<b>Manual</b> are installed once by hand before the first start; items marked "
        "<b>Automatic</b> are created by the app itself when it starts — it never "
        "installs software on its own.", BODY))
    matrix = [
        ["Python 3.12 (runtime)", "python.org installer, or OS package manager, on the host", "Manual · before start"],
        ["SQLite (database engine)", "Built into Python (<font face='Courier'>sqlite3</font>) — nothing to install", "Comes with Python"],
        ["Flask (+ Werkzeug)", "<font face='Courier'>pip install -r server/requirements.txt</font>", "Manual · before start"],
        ["pyodbc", "pip (in requirements.txt)", "Manual · before start"],
        ["anthropic SDK (+ httpx)", "pip (in requirements.txt)", "Manual · before start"],
        ["openpyxl", "pip (in requirements.txt)", "Manual · before start"],
        ["pypdf", "pip (in requirements.txt)", "Manual · before start"],
        ["python-docx", "pip (in requirements.txt)", "Manual · before start"],
        ["pandas (+ NumPy)", "pip (in requirements.txt)", "Manual · before start"],
        ["sqlparse", "pip (in requirements.txt)", "Manual · before start"],
        ["pytest (tests only)", "pip (in requirements.txt)", "Manual · before start"],
        ["MS ODBC Driver 17/18", "Microsoft MSI (<font face='Courier'>msodbcsql18.msi</font>) or winget", "Manual · before start"],
        ["Corporate CA bundle", "Generate <font face='Courier'>win-ca-bundle.pem</font>, place in <font face='Courier'>server/</font>", "Manual · before start"],
        ["Configuration / secrets", "Set env vars or fill <font face='Courier'>server/.env</font>", "Manual · before start"],
        ["fastembed (better AI search)", "<font face='Courier'>pip install fastembed</font> (else NumPy fallback — no install)", "Optional · on demand"],
        ["Bootstrap, Icons, Chart.js, SheetJS", "Loaded from the CDN by the browser (or self-host under <font face='Courier'>assets/</font>)", "Runtime · in browser"],
        ["SQLite database files + tables", "Created by the app if missing (<font face='Courier'>aims_app.db</font>, <font face='Courier'>aims_usage.db</font>)", "Automatic · on start"],
        ["Seed admin account", "Created by the app from <font face='Courier'>AIMS_ADMIN_EMAIL/_PASSWORD</font>", "Automatic · on start"],
        ["fastembed model (ONNX)", "Downloaded automatically — only if fastembed is installed", "Automatic · first use"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in matrix]
    story.append(make_table(["Software", "How it is installed", "When"], rows,
                            [42 * mm, CONTENT_W - 42 * mm - 34 * mm, 34 * mm]))
    story.append(P(
        "<b>In short:</b> install the Manual items once, then start the server with "
        "<font face='Courier'>python main.py</font> — the app creates its databases, "
        "tables and admin user on startup. Nothing is <i>pip-installed</i> at start.", SMALL))

    story.append(PageBreak())

    # ---------------- 12. RUNTIME PREREQUISITES ---------------- #
    story.append(section(12, "Runtime Prerequisites &amp; Configuration"))
    story.append(P("<b>Environment / platform</b>", H2))
    story.extend(bullets([
        "<b>Python 3.12+</b> on the server host.",
        "<b>Microsoft ODBC Driver for SQL Server 17 or 18</b> for live SQL connections.",
        "<b>Outbound access</b> to the corporate Claude gateway and the CDN assets "
        "(Bootstrap, Chart.js, SheetJS) — or self-host the CDN assets in a locked-down network.",
        "<b>Corporate CA bundle</b> (<font face='Courier'>server/win-ca-bundle.pem</font>) "
        "rebuilt on the host for the TLS-intercepting proxy (gitignored).",
    ]))
    story.append(P("<b>Key configuration variables</b>", H2))
    env = [
        ["ANTHROPIC_BASE_URL", "AI (required)", "Corporate / Bedrock gateway base URL"],
        ["ANTHROPIC_AUTH_TOKEN / _API_KEY", "AI (required)", "Gateway credential"],
        ["AIMS_SECRET_KEY", "Auth (required)", "Signs session cookies; set a long random value"],
        ["AIMS_ADMIN_EMAIL / _PASSWORD", "Auth", "Bootstraps the seed administrator account"],
        ["AIMS_MODEL", "AI (optional)", "Override the default Claude model id"],
        ["PORT", "Optional", "Dev server port (default 8000)"],
        ["AIMS_SESSION_HOURS / _CSRF_ENABLED / _SIGNUP_ENABLED", "Optional", "Session lifetime; CSRF (on); self-signup (off)"],
        ["AIMS_APP_DB / _USAGE_DB / _KYD_MAX_UPLOAD_MB", "Optional", "SQLite paths; max KYD upload (25&nbsp;MB default)"],
    ]
    rows = [[Paragraph(a, CELL_B), Paragraph(b, CELL), Paragraph(c, CELL)] for a, b, c in env]
    story.append(make_table(["Variable", "Category", "Purpose"], rows,
                            [60 * mm, 28 * mm, CONTENT_W - 88 * mm]))
    story.append(P(
        "Secrets are injected as environment variables (e.g. via a secret manager) or a "
        "gitignored <font face='Courier'>server/.env</font>; no credentials are committed "
        "to source control.", SMALL))

    # ---------------- 13. QUALITY & CONSTRAINTS ---------------- #
    story.append(section(13, "Quality, Constraints &amp; Scaling Notes"))
    story.extend(bullets([
        "<b>Testing:</b> pytest with 41 backend test modules (routing, auth, admin, AI "
        "plumbing, parsers, services). There is no frontend build/lint tooling; frontend "
        "verification is manual in the browser.",
        "<b>Concurrency:</b> the dev server runs single-process with SQLite single-writer "
        "semantics (a process-wide write lock). For higher concurrency, run behind a WSGI "
        "server and consider migrating SQLite to a server database.",
        "<b>Client storage:</b> the ~5&nbsp;MB browser localStorage quota bounds very large "
        "schemas on the client.",
        "<b>Graceful degradation:</b> optional features (SQL Server, Excel/PDF/Word, AI) "
        "are capability-guarded — the app boots and serves static content even when a "
        "dependency or credential is missing.",
        "<b>Statelessness:</b> the backend holds no long-lived per-request state except the "
        "in-memory deployment job store, which is intentionally not persisted.",
    ]))
    story.append(Spacer(1, 6))
    story.append(P(
        "This document reflects the technology stack as implemented in the current "
        "codebase and is intended as the architecture reference for the deployment review.",
        SMALL))

    doc.build(story)
    print("Wrote", OUT)


if __name__ == "__main__":
    build()
