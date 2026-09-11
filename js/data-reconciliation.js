/* =========================================================================
   data-reconciliation.js — Data Reconciliation › SQL Assistant.
   Plain-English prompt -> a read-only SQL SELECT, grounded on THIS client's
   ClaimCenter dictionary index (built from the entityModel.xml in the uploaded
   dictionary .zip) + the server-side conventions doc. Endpoints:
     GET  /api/ai/reconcile-context   -> {ok, indexed, counts}
     GET  /api/ai/reconcile-tables?q= -> {ok, tables:[{id,table,description}]}
     POST /api/ai/reconcile-sql       -> {ok, sql, tablesUsed[]}
   ========================================================================= */

let drTables = [];              // [{id, table, description}] for the current source
let drSelected = new Set();     // selected entity ids (optional scope)
let drLastSql = "";
let drCounts = null;            // counts from the current source, for the console
let drHistory = [];             // conversation memory: [{prompt, sql}] (per client + source)
let drSource = "claimcenter";   // claimcenter | policycenter | cmt | pmt
let drSources = [];             // [{source,label,indexed,counts}] available for this client

const DR_SOURCE_META = {
  claimcenter: {label: "ClaimCenter dictionary", radio: "ClaimCenter dictionary", uploadHref: "lookup-data-system.html",
    uploadText: "upload your <b>ClaimCenter</b> dictionary <b>.zip</b> on <a href=\"lookup-data-system.html\">Product Data Dictionary</a> (choose ClaimCenter; it contains <span class=\"mono\">entityModel.xml</span>)"},
  policycenter: {label: "PolicyCenter dictionary", radio: "PolicyCenter dictionary", uploadHref: "lookup-data-system.html",
    uploadText: "upload your <b>PolicyCenter</b> dictionary <b>.zip</b> on <a href=\"lookup-data-system.html\">Product Data Dictionary</a> (choose PolicyCenter; it contains <span class=\"mono\">entityModel.xml</span>)"},
  cmt: {label: "CMT (Claim Migration Tool) schema", radio: "CMT — Claim Migration Tool", uploadHref: "schema-file-explore.html",
    uploadText: "upload your <b>CMT</b> schema on <a href=\"schema-file-explore.html\">Product Schema</a> (choose CMT)"},
  pmt: {label: "PMT (Policy Migration Tool) schema", radio: "PMT — Policy Migration Tool", uploadHref: "schema-file-explore.html",
    uploadText: "upload your <b>PMT</b> schema on <a href=\"schema-file-explore.html\">Product Schema</a> (choose PMT)"}
};

// The client's Product decides which two sources the SQL Assistant offers.
function drProductSources(){
  const p = (typeof getActiveClientProduct === "function") ? (getActiveClientProduct() || "").toLowerCase() : "";
  return p === "policy" ? ["policycenter", "pmt"] : ["claimcenter", "cmt"];
}

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-reconciliation.html");
  wireDr();
  await loadDrSources();          // discover ClaimCenter + this client's one product schema; render radios
  loadDrHistory();                // restore prior turns for this client+source
  await loadDrContext();
});

// Discover which sources this client has and render radios. The client's Product picks the pair:
// Policy -> [PolicyCenter dictionary, PMT]; Claim (or unset) -> [ClaimCenter dictionary, CMT].
async function loadDrSources(){
  try{
    const res = await fetch("/api/ai/reconcile-sources", {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    drSources = (j && j.ok) ? (j.sources || []) : [];
  }catch(e){ drSources = []; }

  const wanted = drProductSources();                      // the two sources for this product
  const byId = {};
  drSources.forEach(s => { byId[s.source] = s; });
  const show = wanted.map(src => byId[src] ||
    {source: src, label: (DR_SOURCE_META[src] || {}).label || src, indexed: false});

  // Default to the first loaded source in the pair, else the first (the dictionary).
  const firstIndexed = show.find(s => s.indexed);
  drSource = (firstIndexed || show[0]).source;

  renderDrSourceRadios(show);
}

function renderDrSourceRadios(show){
  const box = document.getElementById("drSourceRadios");
  if(!box) return;
  box.innerHTML = show.map(s => {
    const meta = DR_SOURCE_META[s.source] || {radio: s.label};
    return '<label class="dr-src"><input type="radio" name="drSource" value="' + escapeHtml(s.source) + '"' +
      (s.source === drSource ? " checked" : "") + '> ' + escapeHtml(meta.radio || s.label) + '</label>';
  }).join("");
  box.querySelectorAll('input[name="drSource"]').forEach(r =>
    r.addEventListener("change", e => { if(e.target.checked) onDrSourceChange(e.target.value); }));
}

// Switch source: reset the picker/result, reload the banner + this source's conversation.
async function onDrSourceChange(src){
  drSource = src || "claimcenter";
  drTables = []; drSelected = new Set(); drCounts = null;
  const list = document.getElementById("drTableList"); if(list) list.innerHTML = "";
  const res = document.getElementById("drResult"); if(res) res.style.display = "none";
  const con = document.getElementById("drConsoleWrap"); if(con) con.style.display = "none";
  const sc = document.getElementById("drSelCount"); if(sc) sc.textContent = "";
  loadDrHistory();
  await loadDrContext();
}

/* ---- conversation memory (sessionStorage: kept until the tab/session ends) ---- */
function drHistoryKey(){
  try{ return "aims_dr_history_" + ((typeof AUTH !== "undefined" && AUTH && AUTH.activeClientId) || "") + "_" + drSource; }
  catch(e){ return "aims_dr_history_" + drSource; }
}
function loadDrHistory(){
  try{ const raw = sessionStorage.getItem(drHistoryKey()); drHistory = raw ? JSON.parse(raw) : []; }
  catch(e){ drHistory = []; }
  if(!Array.isArray(drHistory)) drHistory = [];
  updateDrContextInfo();
}
function saveDrHistory(){
  try{ sessionStorage.setItem(drHistoryKey(), JSON.stringify(drHistory.slice(-8))); }catch(e){}
  updateDrContextInfo();
}
function updateDrContextInfo(){
  const el = document.getElementById("drContextInfo");
  if(el) el.textContent = drHistory.length
    ? ("Context: " + drHistory.length + " previous question" + (drHistory.length === 1 ? "" : "s") + " remembered")
    : "";
  const nb = document.getElementById("drNewChatBtn");
  if(nb) nb.style.display = drHistory.length ? "" : "none";
}
function clearDrHistory(){
  drHistory = [];
  try{ sessionStorage.removeItem(drHistoryKey()); }catch(e){}
  updateDrContextInfo();
  showNotification("Started a new conversation — previous context cleared.", "primary", 1800);
}

function wireDr(){
  const gen = document.getElementById("drGenerateBtn");
  if(gen) gen.addEventListener("click", generateDrSql);
  const cancel = document.getElementById("drCancelBtn");
  if(cancel) cancel.addEventListener("click", () => { if(drAbort) drAbort.abort(); });
  const copy = document.getElementById("drCopyBtn");
  if(copy) copy.addEventListener("click", copyDrSql);
  const dl = document.getElementById("drDownloadBtn");
  if(dl) dl.addEventListener("click", downloadDrSql);
  const sql = document.getElementById("drSql");
  if(sql) sql.addEventListener("input", () => { drLastSql = sql.value; });
  const search = document.getElementById("drTableSearch");
  if(search) search.addEventListener("input", () => renderDrTables((search.value || "").toLowerCase().trim()));
  const chdr = document.getElementById("drConsoleHdr");
  if(chdr) chdr.addEventListener("click", () => toggleDrConsole());
  const nb = document.getElementById("drNewChatBtn");
  if(nb) nb.addEventListener("click", clearDrHistory);
  // collapsible table scope
  const hdr = document.getElementById("drTablesHdr");
  if(hdr) hdr.addEventListener("click", () => {
    const wrap = document.getElementById("drTablesWrap");
    const chev = document.getElementById("drTablesChev");
    const open = wrap.style.display === "none";
    wrap.style.display = open ? "" : "none";
    if(chev) chev.className = "bi ms-auto " + (open ? "bi-chevron-up" : "bi-chevron-down");
    if(open && !drTables.length) loadDrTables();
  });
}

function drBanner(kind, icon, html){
  const el = document.getElementById("drBanner");
  if(!el) return;
  el.innerHTML = '<div class="card-el d-flex align-items-center gap-2" style="padding:.6rem .9rem;">' +
    '<i class="bi ' + icon + ' text-' + (kind === "warning" ? "warning" : "primary") + '"></i>' +
    '<span>' + html + '</span></div>';
}

async function loadDrContext(){
  const meta = DR_SOURCE_META[drSource] || DR_SOURCE_META.claimcenter;
  try{
    const res = await fetch("/api/ai/reconcile-context?source=" + encodeURIComponent(drSource), {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ drBanner("warning", "bi-exclamation-triangle", escapeHtml((j && j.error) || "Could not check the schema source.")); return; }
    if(!j.indexed){
      drBanner("warning", "bi-info-circle",
        'No ' + escapeHtml(meta.label) + ' is loaded for this client yet — ' + meta.uploadText + '.');
      const card = document.getElementById("drCard");
      if(card) card.style.display = "none";
      return;
    }
    drCounts = j.counts || {};
    const c = drCounts;
    const tl = (typeof c.typelists === "number") ? (', <b>' + c.typelists + '</b> typelists') : '';
    drBanner("primary", "bi-hdd-network",
      'Grounded on this client’s ' + escapeHtml(meta.label) + ' — <b>' + (c.entities || c.tables || 0) + '</b> tables, <b>' +
      (c.columns || 0) + '</b> columns' + tl + '. Re-upload anytime to refresh (e.g. after new tables are added).');
    const card = document.getElementById("drCard");
    if(card) card.style.display = "";
  }catch(e){ drBanner("warning", "bi-plug", "Backend not reachable — is the server running?"); }
}

async function loadDrTables(){
  const box = document.getElementById("drTableList");
  if(box) box.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span>Loading tables…</div>';
  try{
    const res = await fetch("/api/ai/reconcile-tables?source=" + encodeURIComponent(drSource), {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    drTables = (j && j.ok) ? (j.tables || []) : [];
  }catch(e){ drTables = []; }
  renderDrTables("");
}

function renderDrTables(q){
  const box = document.getElementById("drTableList");
  if(!box) return;
  const rows = q ? drTables.filter(t => (t.id + " " + t.table + " " + t.description).toLowerCase().includes(q)) : drTables;
  if(!rows.length){ box.innerHTML = '<div class="text-xs text-muted-2">' + (drTables.length ? "No tables match." : "No tables in the index.") + '</div>'; return; }
  box.innerHTML = rows.slice(0, 400).map(t =>
    '<label class="dr-tbl"><input type="checkbox" class="dr-tbl-cb" value="' + escapeHtml(t.id) + '"' +
      (drSelected.has(t.id) ? " checked" : "") + '> ' + escapeHtml(t.table) +
      (t.description ? ' <span class="text-muted-2" style="font-family:inherit;">— ' + escapeHtml(t.description.slice(0, 60)) + '</span>' : '') +
    '</label>').join("");
  box.querySelectorAll(".dr-tbl-cb").forEach(cb => cb.addEventListener("change", e => {
    if(e.target.checked) drSelected.add(e.target.value); else drSelected.delete(e.target.value);
    const c = document.getElementById("drSelCount");
    if(c) c.textContent = drSelected.size ? ("(" + drSelected.size + " selected)") : "";
  }));
}

// Append a line to the AI Processing Console. kind: 'run' | 'done' | 'info' | 'error'.
function drLog(text, kind){
  const el = document.getElementById("drConsole");
  if(!el) return null;
  const line = document.createElement("div");
  line.className = "log-line" + (kind === "done" ? " done" : kind === "error" ? " error" : "");
  const icon = kind === "done" ? "bi-check-circle-fill" : kind === "error" ? "bi-x-circle-fill"
             : kind === "run" ? "bi-arrow-repeat" : "bi-info-circle";
  line.innerHTML = '<i class="bi ' + icon + '"></i> ' + escapeHtml(text);
  el.appendChild(line); el.scrollTop = el.scrollHeight;
  return line;
}
function drDone(line, text){
  if(!line) return;
  line.className = "log-line done";
  line.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(text);
}
// Collapse/expand the console step list. force=true collapses, false expands, undefined toggles.
function toggleDrConsole(force){
  const log = document.getElementById("drConsole");
  const chev = document.getElementById("drConsoleChev");
  if(!log) return;
  const collapse = (typeof force === "boolean") ? force : (log.style.display !== "none");
  log.style.display = collapse ? "none" : "";
  if(chev) chev.className = "bi ms-auto " + (collapse ? "bi-chevron-down" : "bi-chevron-up");
}
function setDrConsoleStatus(html){
  const s = document.getElementById("drConsoleStatus");
  if(s) s.innerHTML = html || "";
}

let drAbort = null;   // AbortController for the in-flight SQL generation (null when idle)

async function generateDrSql(){
  const prompt = (document.getElementById("drPrompt").value || "").trim();
  if(!prompt){ showNotification("Describe what you want to query.", "warning"); return; }
  const btn = document.getElementById("drGenerateBtn");
  const cancelBtn = document.getElementById("drCancelBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  drAbort = new AbortController();
  if(cancelBtn) cancelBtn.style.display = "";

  // Show what the AI is doing (grounding + which conventions/"skill" file + progress).
  const con = document.getElementById("drConsoleWrap");
  if(con) con.style.display = "";
  const el = document.getElementById("drConsole"); if(el) el.innerHTML = "";
  toggleDrConsole(false);          // expand while running
  setDrConsoleStatus("");
  const meta = DR_SOURCE_META[drSource] || DR_SOURCE_META.claimcenter;
  drLog("Reading your request…", "done");
  const c = drCounts || {};
  const nTables = c.entities || c.tables || 0;
  drLog("Grounding on your " + meta.label +
        (nTables ? " (" + nTables + " tables, " + (c.columns || 0) + " columns)" : "") +
        (drSelected.size ? " — scoped to " + drSelected.size + " selected table(s)" : " — auto-selecting relevant tables") + ".", "done");
  if(drHistory.length) drLog("Using previous context (" + drHistory.length + " earlier question" + (drHistory.length === 1 ? "" : "s") + ")…", "done");
  drLog("Applying SQL conventions…", "done");
  const running = drLog("Generating SQL with AI…", "run");

  try{
    const res = await fetch("/api/ai/reconcile-sql", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({prompt: prompt, source: drSource, tableIds: Array.from(drSelected), history: drHistory.slice(-6)}),
      signal: drAbort.signal});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){
      if(running){ running.className = "log-line error"; running.innerHTML = '<i class="bi bi-x-circle-fill"></i> Generation failed.'; }
      drLog((j && j.error) || "Could not generate SQL.", "error");
      setDrConsoleStatus('<span class="text-danger">Failed</span>');
      toggleDrConsole(false);   // keep expanded so the error is visible
      showNotification((j && j.error) || "Could not generate SQL.", "danger", 6000);
      return;
    }
    drDone(running, "SQL generated by AI.");
    if(j.conventions) drLog("Skill / conventions used: " + j.conventions, "done");
    const grounded = j.grounded || [];
    if(grounded.length) drLog("Grounded on tables: " + grounded.join(", "), "done");
    if(j.interpretation) drLog("Purpose: " + j.interpretation, "done");
    drLog("Done.", "done");
    // Collapse the steps to a single green "Done" summary (click the header to expand).
    setDrConsoleStatus('<span class="text-success">✓ Done</span>');
    toggleDrConsole(true);

    drLastSql = j.sql || "";
    document.getElementById("drSql").value = drLastSql;   // SQL-only, with a leading comment header
    // Remember this turn so follow-up questions build on it (until a new session / New conversation).
    drHistory.push({prompt: prompt, sql: drLastSql});
    saveDrHistory();
    document.getElementById("drUsed").innerHTML = grounded.length
      ? '<span class="text-xs text-muted-2">Grounded on:</span> ' + grounded.map(t => '<span class="dr-chip">' + escapeHtml(t) + '</span>').join("")
      : '';
    document.getElementById("drResult").style.display = "";
    showNotification("SQL generated — review it before running.", "success", 2500);
  }catch(e){
    if(e && e.name === "AbortError"){
      if(running){ running.className = "log-line"; running.innerHTML = '<i class="bi bi-slash-circle"></i> Generation cancelled.'; }
      drLog("Cancelled by user.", "done");
      setDrConsoleStatus('<span class="text-muted-2">Cancelled</span>');
      toggleDrConsole(false);   // keep expanded so the cancellation is visible
      showNotification("SQL generation cancelled.", "warning", 2000);
    } else {
      if(running){ running.className = "log-line error"; running.innerHTML = '<i class="bi bi-x-circle-fill"></i> Backend not reachable.'; }
      showNotification("Backend not reachable.", "danger");
    }
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
    if(cancelBtn) cancelBtn.style.display = "none";
    drAbort = null;
  }
}

function copyDrSql(){
  const sql = document.getElementById("drSql").value;
  if(!sql) return;
  navigator.clipboard.writeText(sql)
    .then(() => showNotification("SQL copied to clipboard.", "success", 1500))
    .catch(() => showNotification("Could not copy to clipboard.", "danger"));
}

function downloadDrSql(){
  const sql = document.getElementById("drSql").value;
  if(!sql) return;
  const blob = new Blob([sql], {type: "text/sql"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "reconciliation_query.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
