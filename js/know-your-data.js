/* =========================================================================
   know-your-data.js — Know Your Data: upload + ingest insurance documents,
   then chat with them (RAG). Talks to the real /api/kyd/* endpoints; the global
   fetch wrapper in common.js adds the CSRF header to mutating requests.
   ========================================================================= */

const KYD_ACCEPT = ["pdf", "xml", "json", "sql", "xlsx", "xls", "csv"];
const KYD_MAX_BYTES = 25 * 1024 * 1024;   // mirror the server cap
const KYD_POLL_MS = 1500;

let kydDocs = [];              // [{id, filename, ext, sizeBytes, status, statusDetail,
                               //   detectedTopics[], domainCheckReasoning, contentKind}]
const kydPolling = {};         // id -> true while its status is being polled
const kydChat = { sessionId: null, busy: false };

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("know-your-data.html");
  renderTypeChips();
  wireDropzone();
  wireChat();
  wireCollapse();
  await loadDocuments();
});

/* Collapse the whole left column (upload + documents) to give the chat full width. */
function wireCollapse() {
  const btn = document.getElementById("kydCollapseBtn");
  if (!btn) return;
  applyCollapse(!!lsGet("aims_kyd_left_collapsed", false));
  btn.addEventListener("click", () => {
    const collapsed = !lsGet("aims_kyd_left_collapsed", false);
    lsSet("aims_kyd_left_collapsed", collapsed);
    applyCollapse(collapsed);
  });
}

function applyCollapse(collapsed) {
  const body = document.getElementById("kydUploadBody");
  const docs = document.getElementById("kydDocsCard");
  const left = document.getElementById("kydLeftCol");
  const chat = document.getElementById("kydChatCol");
  const btn = document.getElementById("kydCollapseBtn");
  if (body) body.style.display = collapsed ? "none" : "";
  if (docs) docs.style.display = collapsed ? "none" : "";
  if (left) left.className = collapsed ? "col-12" : "col-lg-7";     // thin header bar when collapsed
  if (chat) chat.className = collapsed ? "col-12" : "col-lg-5";     // chat spans full width when collapsed
  if (btn) {
    const i = btn.querySelector("i");
    if (i) i.className = "bi " + (collapsed ? "bi-chevron-down" : "bi-chevron-up");
    btn.title = collapsed ? "Expand upload & documents" : "Collapse upload & documents — more room for chat";
  }
}

/* ------------------------------------------------------------------ *
 * API (real endpoints)
 * ------------------------------------------------------------------ */
async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, status: res.status, data };
}

async function loadDocuments() {
  const r = await jsonFetch("/api/kyd/documents", { headers: { Accept: "application/json" } });
  if (!r.ok) { kydDocs = []; renderList(); refreshChatEnabled(); return; }
  kydDocs = (r.data.documents || []).map(fromServer);
  renderList();
  refreshChatEnabled();
  kydDocs.forEach((d) => { if (d.status === "uploaded" || d.status === "processing") pollStatus(d.id); });
}

function fromServer(d) {
  return {
    id: d.id, filename: d.filename || "document", ext: d.fileExt || "",
    sizeBytes: d.sizeBytes || 0, status: d.status || "uploaded", statusDetail: d.statusDetail || "",
    detectedTopics: d.detectedTopics || [], domainCheckReasoning: d.domainCheckReasoning || "",
    contentKind: d.contentKind || "",
  };
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await jsonFetch("/api/kyd/documents", { method: "POST", body: fd });
  if (!r.ok) {
    showErrors(['"' + file.name + '" — ' + (r.data.error || "upload failed.")]);
    return;
  }
  const doc = fromServer(r.data.document);
  kydDocs.unshift(doc);
  renderList();
  pollStatus(doc.id);
}

function pollStatus(id) {
  if (kydPolling[id]) return;
  kydPolling[id] = true;
  const tick = async () => {
    const r = await jsonFetch("/api/kyd/documents/" + id + "/status");
    if (!r.ok) { delete kydPolling[id]; return; }
    const d = kydDocs.find((x) => x.id === id);
    if (!d) { delete kydPolling[id]; return; }
    Object.assign(d, {
      status: r.data.status, statusDetail: r.data.statusDetail || "",
      detectedTopics: r.data.detectedTopics || [], domainCheckReasoning: r.data.domainCheckReasoning || "",
      contentKind: r.data.contentKind || d.contentKind,
    });
    renderList();
    if (d.status === "uploaded" || d.status === "processing") {
      setTimeout(tick, KYD_POLL_MS);
    } else {
      delete kydPolling[id];
      refreshChatEnabled();
      if (typeof showNotification === "function") {
        if (d.status === "ready") showNotification('"' + d.filename + '" is ready to query.', "success");
        else if (d.status === "rejected") showNotification('"' + d.filename + '" was flagged as non-insurance.', "warning");
        else if (d.status === "failed") showNotification('"' + d.filename + '" failed to ingest.', "danger");
      }
    }
  };
  setTimeout(tick, 400);
}

async function forceInclude(doc) {
  const r = await jsonFetch("/api/kyd/documents/" + doc.id + "/force-ingest", { method: "POST" });
  if (!r.ok) { if (typeof showNotification === "function") showNotification(r.data.error || "Could not force-ingest.", "danger"); return; }
  doc.status = "processing"; renderList(); pollStatus(doc.id);
}

async function retryDoc(doc) { return forceInclude(doc); }   // re-runs ingestion

async function deleteDoc(doc) {
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog('Delete "' + doc.filename + '"? This removes the file and everything ingested from it.', "Delete")
    : window.confirm("Delete this document?");
  if (!ok) return;
  const r = await jsonFetch("/api/kyd/documents/" + doc.id, { method: "DELETE" });
  if (!r.ok) { if (typeof showNotification === "function") showNotification(r.data.error || "Delete failed.", "danger"); return; }
  kydDocs = kydDocs.filter((x) => x !== doc);
  renderList(); refreshChatEnabled();
  if (typeof showNotification === "function") showNotification('"' + doc.filename + '" deleted.', "success");
}

/* ------------------------------------------------------------------ *
 * Documents rendering
 * ------------------------------------------------------------------ */
function renderList() {
  const el = document.getElementById("kydList");
  const count = document.getElementById("kydCount");
  if (!el) return;
  count.textContent = kydDocs.length ? (kydDocs.length + " document" + (kydDocs.length === 1 ? "" : "s")) : "";
  if (!kydDocs.length) {
    el.innerHTML = '<div class="kyd-empty"><i class="bi bi-folder2-open"></i>' +
      '<div class="kyd-empty-title">No documents yet</div>' +
      '<div class="kyd-empty-sub">Upload an insurance file above to get started.</div></div>';
    return;
  }
  el.innerHTML = '<div class="kyd-doc-list">' + kydDocs.map(renderDocCard).join("") + '</div>';
}

function renderDocCard(d) {
  const busy = (d.status === "uploaded" || d.status === "processing");
  const actions = [];
  if (d.status === "failed") actions.push(btn("retry", d.id, "bi-arrow-clockwise", "Retry", "btn-outline-soft"));
  if (d.status === "rejected") actions.push(btn("force", d.id, "bi-shield-check", "Force include anyway", "btn-primary"));
  if (!busy) actions.push(iconBtn("delete", d.id, "bi-trash", "Delete"));
  return (
    '<div class="kyd-doc" data-doc="' + d.id + '">' +
      '<div class="kyd-doc-ico"><i class="bi ' + fileIcon(d.ext) + '"></i></div>' +
      '<div class="kyd-doc-main">' +
        '<div class="kyd-doc-top">' +
          '<span class="kyd-doc-name" title="' + escapeHtml(d.filename) + '">' + escapeHtml(d.filename) + '</span>' +
          statusPill(d) +
        '</div>' +
        '<div class="kyd-doc-meta">' + escapeHtml((d.ext || "").toUpperCase()) + ' · ' + humanSize(d.sizeBytes) + '</div>' +
        (busy ? '<div class="kyd-progress indet"><span></span></div>' : '') +
        (d.status === "ready" ? '<div class="kyd-ready-note"><i class="bi bi-check-circle"></i> Ingested — ask about it in the chat.</div>' : '') +
        (d.status === "failed" ? '<div class="kyd-fail-note"><i class="bi bi-exclamation-triangle"></i> ' + escapeHtml(d.statusDetail || "Ingestion failed.") + '</div>' : '') +
        (d.status === "rejected" ? rejectNote(d) : '') +
      '</div>' +
      (actions.length ? '<div class="kyd-doc-actions">' + actions.join("") + '</div>' : '') +
    '</div>'
  );
}

function rejectNote(d) {
  const topics = (d.detectedTopics && d.detectedTopics.length) ? d.detectedTopics.join(", ") : "another subject";
  return (
    '<div class="kyd-reject">' +
      '<b><i class="bi bi-exclamation-octagon"></i> Not recognized as insurance data.</b> ' +
      'This file doesn’t appear to contain insurance-related data — it looks like it’s about <b>' + escapeHtml(topics) + '</b>…' +
      (d.domainCheckReasoning ? '<div class="kyd-reject-reason">' + escapeHtml(d.domainCheckReasoning) + '</div>' : '') +
    '</div>'
  );
}

function statusPill(d) {
  const map = { uploaded: ["is-uploading", "Uploading"], processing: ["is-processing", "Processing"],
    ready: ["is-ready", "Ready"], failed: ["is-failed", "Failed"], rejected: ["is-rejected", "Rejected"] };
  const [cls, label] = map[d.status] || ["is-uploading", d.status];
  return '<span class="kyd-status ' + cls + '"><span class="dot"></span>' + label + '</span>';
}

function btn(action, id, icon, label, variant) {
  return '<button type="button" class="btn btn-sm ' + variant + '" data-action="' + action + '" data-id="' + id + '"><i class="bi ' + icon + ' me-1"></i>' + label + '</button>';
}
function iconBtn(action, id, icon, title) {
  return '<button type="button" class="icon-btn" data-action="' + action + '" data-id="' + id + '" title="' + title + '"><i class="bi ' + icon + '"></i></button>';
}

/* ------------------------------------------------------------------ *
 * Upload wiring + validation
 * ------------------------------------------------------------------ */
function wireDropzone() {
  const dz = document.getElementById("kydDropzone");
  const input = document.getElementById("kydFileInput");
  const list = document.getElementById("kydList");
  if (!dz || !input) return;
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
  dz.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  if (list) list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]"); if (!b) return;
    const doc = kydDocs.find((x) => String(x.id) === b.dataset.id); if (!doc) return;
    if (b.dataset.action === "delete") deleteDoc(doc);
    else if (b.dataset.action === "retry") retryDoc(doc);
    else if (b.dataset.action === "force") forceInclude(doc);
  });
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const errors = [];
  files.forEach((f) => {
    const ext = fileExt(f.name);
    if (KYD_ACCEPT.indexOf(ext) === -1) errors.push('"' + f.name + '" — unsupported type (.' + (ext || "?") + '). Allowed: ' + KYD_ACCEPT.map((x) => "." + x).join(", "));
    else if (f.size > KYD_MAX_BYTES) errors.push('"' + f.name + '" — too large (' + humanSize(f.size) + '). Max ' + humanSize(KYD_MAX_BYTES) + ".");
    else uploadFile(f);
  });
  showErrors(errors);
}

function showErrors(errors) {
  const box = document.getElementById("kydErrors");
  if (!box) return;
  if (!errors.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "";
  box.innerHTML =
    '<button type="button" class="btn-close-x" aria-label="Dismiss" onclick="this.parentNode.style.display=\'none\'">&times;</button>' +
    '<div class="kyd-err-head"><i class="bi bi-exclamation-triangle"></i> ' + errors.length + ' file' + (errors.length === 1 ? "" : "s") + ' could not be added</div>' +
    '<ul>' + errors.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") + '</ul>';
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */
function wireChat() {
  const form = document.getElementById("kydChatForm");
  const newBtn = document.getElementById("kydNewChat");
  const full = document.getElementById("kydFullDoc");
  if (full) {
    full.checked = !!lsGet("aims_kyd_full_doc", false);   // device pref (local)
    full.addEventListener("change", () => lsSet("aims_kyd_full_doc", full.checked));
  }
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
  if (newBtn) newBtn.addEventListener("click", () => {
    kydChat.sessionId = null;
    document.getElementById("kydChatMsgs").innerHTML = "";
    chatWelcome();
  });
  chatWelcome();
  refreshChatEnabled();
}

function chatWelcome() {
  const box = document.getElementById("kydChatMsgs");
  if (box && !box.children.length) {
    box.innerHTML = '<div class="kyd-chat-empty"><i class="bi bi-chat-square-text"></i>' +
      '<div>Ask questions about your uploaded insurance data — e.g. “total claim amount by state” or “what does the policy cover?”</div></div>';
  }
}

function refreshChatEnabled() {
  const ready = kydDocs.some((d) => d.status === "ready");
  const input = document.getElementById("kydChatInput");
  const send = document.getElementById("kydChatSend");
  const hint = document.getElementById("kydChatHint");
  if (input) input.disabled = !ready || kydChat.busy;
  if (send) send.disabled = !ready || kydChat.busy;
  if (hint) hint.textContent = ready ? "" : "Upload and ingest an insurance document to start chatting.";
}

async function ensureSession() {
  if (kydChat.sessionId) return kydChat.sessionId;
  const r = await jsonFetch("/api/kyd/chat/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  if (!r.ok) return null;
  kydChat.sessionId = r.data.session.id;
  return kydChat.sessionId;
}

async function sendChat() {
  const input = document.getElementById("kydChatInput");
  const text = (input.value || "").trim();
  if (!text || kydChat.busy) return;
  kydChat.busy = true; refreshChatEnabled();
  clearWelcome();
  appendBubble("user", escapeHtml(text));
  input.value = "";
  const typing = appendTyping();

  try {
    const sid = await ensureSession();
    if (!sid) throw new Error("no session");
    const full = document.getElementById("kydFullDoc");
    const mode = (full && full.checked) ? "full" : "rag";
    const r = await jsonFetch("/api/kyd/chat/sessions/" + sid + "/messages", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, mode: mode }),
    });
    typing.remove();
    if (!r.ok) { appendBubble("assistant", escapeHtml(r.data.error || "Sorry — something went wrong.")); return; }
    appendAssistant(r.data);
  } catch (e) {
    typing.remove();
    appendBubble("assistant", "Sorry — I couldn’t reach the server. Please try again.");
  } finally {
    kydChat.busy = false; refreshChatEnabled();
    document.getElementById("kydChatInput").focus();
  }
}

function appendAssistant(data) {
  const answer = escapeHtml(data.answer || "");
  const badge = data.route ? routeBadge(data.route) : "";
  const cites = renderCitations(data.citations || []);
  appendBubble("assistant", answer + badge + cites);
}

function appendBubble(role, html) {
  const box = document.getElementById("kydChatMsgs");
  const div = document.createElement("div");
  div.className = "kyd-msg kyd-msg-" + role;
  div.innerHTML = '<div class="kyd-bubble">' + html + "</div>";
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function appendTyping() {
  const box = document.getElementById("kydChatMsgs");
  const div = document.createElement("div");
  div.className = "kyd-msg kyd-msg-assistant";
  div.innerHTML = '<div class="kyd-bubble kyd-typing"><span></span><span></span><span></span></div>';
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  return div;
}

function clearWelcome() {
  const w = document.querySelector("#kydChatMsgs .kyd-chat-empty");
  if (w) w.parentNode.removeChild(w);
}

function routeBadge(route) {
  const map = { vector_search: "semantic", sql_query: "SQL", pandas_query: "SQL",
    hybrid: "hybrid", full_document: "full document" };
  return '<span class="kyd-route">' + (map[route] || route) + "</span>";
}

function renderCitations(cites) {
  if (!cites || !cites.length) return "";
  const chips = cites.map((c) => {
    let label;
    if (c.type === "structured") label = "▦ " + escapeHtml(c.table || "table");
    else {
      const doc = docName(c.documentId);
      const loc = c.page ? " p." + c.page : (c.section ? " · " + escapeHtml(String(c.section)) : "");
      label = "▤ " + escapeHtml(doc) + loc;
    }
    const tip = escapeHtml(c.query || c.snippet || "");
    return '<span class="kyd-chip" title="' + tip + '">' + label + "</span>";
  }).join("");
  return '<div class="kyd-cites">' + chips + "</div>";
}

function docName(id) {
  const d = kydDocs.find((x) => x.id === id);
  return d ? d.filename : ("document #" + id);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function renderTypeChips() {
  const el = document.getElementById("kydTypes");
  if (el) el.innerHTML = KYD_ACCEPT.map((x) => '<span class="kyd-type-chip">.' + x + "</span>").join("");
}
function fileExt(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
function fileIcon(ext) {
  return ({ pdf: "bi-filetype-pdf", csv: "bi-filetype-csv", json: "bi-filetype-json", xml: "bi-filetype-xml",
    sql: "bi-filetype-sql", xlsx: "bi-file-earmark-spreadsheet", xls: "bi-file-earmark-spreadsheet" })[ext] || "bi-file-earmark-text";
}
function humanSize(bytes) {
  bytes = bytes || 0;
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
