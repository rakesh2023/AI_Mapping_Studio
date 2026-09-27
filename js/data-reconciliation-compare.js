/* =========================================================================
   data-reconciliation-compare.js — Data Reconciliation › IN vs OUT Comparison.
   Turns THIS client's uploaded migration schema (CMT / PMT / BMT — same one used
   on the Product Schema page) into a T-SQL stored procedure that compares the
   migration tool's INPUT database against its POST-CONVERSION OUTPUT database.
   Both databases share the same schema and live on the same instance; the proc
   takes the IN/OUT database names as parameters and diffs them with dynamic SQL.
   Endpoints (reused from the SQL Assistant, with source=cmt|pmt|bmt):
     GET  /api/ai/reconcile-context?source=  -> {ok, indexed, counts}
     GET  /api/ai/reconcile-tables?source=   -> {ok, tables:[{id,table,description}]}
     POST /api/ai/reconcile-compare-sql      -> {ok, sql, grounded[], conventions}
   ========================================================================= */

let drTables = [];              // [{id, table, description}] for the migration schema
let drSelected = new Set();     // selected table ids to compare (optional scope)
let drSelectedCols = {};        // tableId -> [colName]: explicit column scope (absent = all comparable columns)
let drColCache = {};            // tableId -> [{name, fk}] (fetched lazily)
let drColsOpen = new Set();     // tableIds whose column picker is expanded
let drColSearch = {};           // tableId -> column-name filter term (per open picker)
let drLastSql = "";
let drLastGrounded = [];        // tables the last generation was grounded on (saved into version meta)
let drVersions = [];            // [{id, version, meta, bytes, createdAt}] newest first
let drCounts = null;            // counts from the migration schema, for the console
let drHistory = [];             // conversation memory: [{prompt, sql}] (per client + source)
let drSource = "cmt";           // cmt | pmt | bmt — the migration tool for this client's Product

// Migration-tool metadata (labels + where to upload the schema).
const DR_MIG_META = {
  cmt: {label: "CMT (Claim Migration Tool) schema",   short: "CMT"},
  pmt: {label: "PMT (Policy Migration Tool) schema",  short: "PMT"},
  bmt: {label: "BMT (Billing Migration Tool) schema", short: "BMT"}
};

// The editable default prompt (optional refinements only — the output shape is fixed:
// Table Name / Column name / Primary Key / InValue / OutValue). The user can tweak it and Reset to default.
const DR_DEFAULT_PROMPT =
  "Compare the selected tables between the IN and OUT databases and list every column whose value " +
  "changed after conversion. Skip audit columns (CreateTime, UpdateTime, CreateUser, UpdateUser).";

// Per-client + per-source persistence of the user's edited prompt (device-local; survives reloads).
function drPromptKey(){ return "aims_drcmp_prompt_" + drSource; }
function loadDrPrompt(){
  const ta = document.getElementById("drPrompt");
  if(!ta) return;
  let saved = null;
  try{ saved = localStorage.getItem(drPromptKey()); }catch(e){}
  ta.value = (saved != null && saved !== "") ? saved : DR_DEFAULT_PROMPT;
}
function saveDrPrompt(){
  const ta = document.getElementById("drPrompt");
  if(!ta) return;
  try{ localStorage.setItem(drPromptKey(), ta.value); }catch(e){}
}
function resetDrPrompt(){
  const ta = document.getElementById("drPrompt");
  if(!ta) return;
  ta.value = DR_DEFAULT_PROMPT;
  try{ localStorage.removeItem(drPromptKey()); }catch(e){}
  showNotification("Prompt reset to default.", "primary", 1500);
}

// The client's Product picks the migration tool: Policy -> PMT, Billing -> BMT, else CMT.
function drMigSource(){
  const p = (typeof getActiveClientProduct === "function") ? (getActiveClientProduct() || "").toLowerCase() : "";
  if(p === "policy") return "pmt";
  if(p === "billing") return "bmt";
  return "cmt";
}

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-reconciliation-compare.html");
  drSource = drMigSource();
  wireDr();
  loadDrPrompt();                 // prefill the editable prompt (saved custom, else default)
  loadDrHistory();                // restore prior turns for this client + source
  await loadDrContext();
  // Default: load the table list and select ALL tables (the user can then deselect any).
  const card = document.getElementById("drCard");
  if(card && card.style.display !== "none") await selectAllDrTables();
  loadDrVersions();               // populate the Saved Versions table (does not touch the editor)
});

/* ---- conversation memory (sessionStorage: kept until the tab/session ends) ---- */
function drHistoryKey(){
  try{ return "aims_drcmp_history_" + ((typeof AUTH !== "undefined" && AUTH && AUTH.activeClientId) || "") + "_" + drSource; }
  catch(e){ return "aims_drcmp_history_" + drSource; }
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
    ? ("Context: " + drHistory.length + " previous request" + (drHistory.length === 1 ? "" : "s") + " remembered")
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
  if(gen) gen.addEventListener("click", generateDrCompareSql);
  const cancel = document.getElementById("drCancelBtn");
  if(cancel) cancel.addEventListener("click", () => { if(drAbort) drAbort.abort(); });
  const copy = document.getElementById("drCopyBtn");
  if(copy) copy.addEventListener("click", copyDrSql);
  const dl = document.getElementById("drDownloadBtn");
  if(dl) dl.addEventListener("click", downloadDrSql);
  const sql = document.getElementById("drSql");
  if(sql) sql.addEventListener("input", () => { drLastSql = sql.value; updateDrSaveBtn(); });
  // Save version (main + fullscreen) and fullscreen editor.
  const save = document.getElementById("drSaveVersionBtn");
  if(save) save.addEventListener("click", (e) => { e.preventDefault(); saveDrVersion(); });
  const expand = document.getElementById("drExpandBtn");
  if(expand) expand.addEventListener("click", (e) => { e.preventDefault(); openDrExpand(); });
  const expandArea = document.getElementById("drExpandArea");
  if(expandArea) expandArea.addEventListener("input", () => {
    const out = document.getElementById("drSql");
    if(out){ out.value = expandArea.value; drLastSql = expandArea.value; updateDrSaveBtn(); }
  });
  const expandCopy = document.getElementById("drExpandCopyBtn");
  if(expandCopy) expandCopy.addEventListener("click", copyDrSql);
  const expandSave = document.getElementById("drExpandSaveBtn");
  if(expandSave) expandSave.addEventListener("click", (e) => {
    e.preventDefault();
    const area = document.getElementById("drExpandArea");   // push fullscreen edits back first
    const out = document.getElementById("drSql");
    if(area && out){ out.value = area.value; drLastSql = area.value; }
    saveDrVersion();
  });
  // Saved Versions row actions (load / download / delete).
  const vbody = document.getElementById("drVersionsBody");
  if(vbody) vbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ver-act]");
    if(!btn) return;
    const id = btn.getAttribute("data-ver-id");
    const act = btn.getAttribute("data-ver-act");
    if(act === "load") loadDrVersionIntoEditor(id);
    else if(act === "download") downloadDrVersion(id);
    else if(act === "delete") deleteDrVersion(id);
  });
  const search = document.getElementById("drTableSearch");
  if(search) search.addEventListener("input", () => renderDrTables((search.value || "").toLowerCase().trim()));
  const chdr = document.getElementById("drConsoleHdr");
  if(chdr) chdr.addEventListener("click", () => toggleDrConsole());
  const nb = document.getElementById("drNewChatBtn");
  if(nb) nb.addEventListener("click", clearDrHistory);
  const prompt = document.getElementById("drPrompt");
  if(prompt) prompt.addEventListener("input", saveDrPrompt);
  const resetPrompt = document.getElementById("drResetPromptBtn");
  if(resetPrompt) resetPrompt.addEventListener("click", resetDrPrompt);
  const selAll = document.getElementById("drSelectAllBtn");
  if(selAll) selAll.addEventListener("click", selectAllDrTables);
  const clr = document.getElementById("drClearAllBtn");
  if(clr) clr.addEventListener("click", clearDrTableSelection);
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
  const meta = DR_MIG_META[drSource] || DR_MIG_META.cmt;
  try{
    const res = await fetch("/api/ai/reconcile-context?source=" + encodeURIComponent(drSource), {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ drBanner("warning", "bi-exclamation-triangle", escapeHtml((j && j.error) || "Could not check the schema source.")); return; }
    if(!j.indexed){
      drBanner("warning", "bi-info-circle",
        'No ' + escapeHtml(meta.label) + ' is loaded for this client yet — upload your <b>' + escapeHtml(meta.short) +
        '</b> schema on <a href="schema-file-explore.html">Product Schema</a> first.');
      const card = document.getElementById("drCard");
      if(card) card.style.display = "none";
      return;
    }
    drCounts = j.counts || {};
    const c = drCounts;
    drBanner("primary", "bi-hdd-network",
      'Grounded on this client’s ' + escapeHtml(meta.label) + ' — <b>' + (c.entities || c.tables || 0) + '</b> tables, <b>' +
      (c.columns || 0) + '</b> columns. Both the IN and OUT databases are assumed to share this schema.');
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
  box.innerHTML = rows.slice(0, 400).map((t, i) => {
    const scoped = Array.isArray(drSelectedCols[t.id]);
    const scopeNote = scoped ? ' <span class="text-primary text-xs" style="font-family:inherit;">· ' + drSelectedCols[t.id].length + ' col(s)</span>' : '';
    return '<div class="dr-trow" data-tid="' + escapeHtml(t.id) + '" data-i="' + i + '">' +
      '<div class="d-flex align-items-center">' +
        '<label class="dr-tbl mb-0"><input type="checkbox" class="dr-tbl-cb" value="' + escapeHtml(t.id) + '"' +
          (drSelected.has(t.id) ? " checked" : "") + '> ' + escapeHtml(t.table) +
          (t.description ? ' <span class="text-muted-2" style="font-family:inherit;">— ' + escapeHtml(t.description.slice(0, 50)) + '</span>' : '') +
        '</label>' + scopeNote +
        '<button type="button" class="btn btn-link btn-sm dr-col-toggle p-0 ms-2" style="font-size:.72rem;text-decoration:none;" title="Choose which columns to compare">columns <i class="bi ' + (drColsOpen.has(t.id) ? "bi-chevron-up" : "bi-chevron-down") + '"></i></button>' +
      '</div>' +
      '<div class="dr-cols" style="margin:.15rem 0 .35rem 1.4rem;' + (drColsOpen.has(t.id) ? '' : 'display:none;') + '"></div>' +
    '</div>';
  }).join("");
  box.querySelectorAll(".dr-tbl-cb").forEach(cb => cb.addEventListener("change", e => {
    if(e.target.checked) drSelected.add(e.target.value); else drSelected.delete(e.target.value);
    updateDrSelCount();
  }));
  box.querySelectorAll(".dr-col-toggle").forEach(btn => btn.addEventListener("click", () => {
    const row = btn.closest(".dr-trow");
    toggleDrCols(row.getAttribute("data-tid"), row.querySelector(".dr-cols"), btn.querySelector("i"));
  }));
  // Re-open any panels that were expanded (after a search re-render).
  box.querySelectorAll(".dr-trow").forEach(row => {
    const tid = row.getAttribute("data-tid");
    if(drColsOpen.has(tid)) renderDrColsPanel(tid, row.querySelector(".dr-cols"));
  });
}

// Expand/collapse a table's column picker; lazily fetch its columns on first open.
async function toggleDrCols(tid, panel, chevron){
  if(!panel) return;
  const open = !drColsOpen.has(tid);
  if(open) drColsOpen.add(tid); else drColsOpen.delete(tid);
  panel.style.display = open ? "" : "none";
  if(chevron) chevron.className = "bi " + (open ? "bi-chevron-up" : "bi-chevron-down");
  if(open) await renderDrColsPanel(tid, panel);
}

async function renderDrColsPanel(tid, panel){
  if(!panel) return;
  if(!drColCache[tid]){
    panel.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-1"></span>Loading columns…</div>';
    let j = null, st = 0;
    try{
      const res = await fetch("/api/ai/reconcile-compare-columns?source=" + encodeURIComponent(drSource) + "&table=" + encodeURIComponent(tid), {headers:{Accept:"application/json"}});
      st = res.status;
      j = await res.json().catch(() => ({}));
    }catch(e){ j = null; }
    // Cache ONLY a genuine successful response (an empty list then means truly key-only).
    // A failed / non-ok fetch is NOT cached, so reopening the picker retries instead of
    // sticking on "No comparable columns" after a transient hiccup.
    if(j && j.ok){ drColCache[tid] = j.columns || []; }
    else {
      const msg = (st === 401 || st === 403)
        ? "Session expired — refresh the page and sign in again, then reopen."
        : "Could not load columns — collapse and reopen to retry.";
      panel.innerHTML = '<div class="text-xs text-danger"><i class="bi bi-exclamation-triangle me-1"></i>' + escapeHtml(msg) + '</div>';
      return;
    }
  }
  const cols = drColCache[tid];
  if(!cols.length){ panel.innerHTML = '<div class="text-xs text-muted-2">No comparable columns (this table has only key / FK columns).</div>'; return; }
  // Default selection (first open, no explicit scope yet): all non-FK columns (matches the default diff).
  if(!Array.isArray(drSelectedCols[tid])) drSelectedCols[tid] = cols.filter(c => !c.fk).map(c => c.name);
  const sel = new Set(drSelectedCols[tid]);
  panel.innerHTML =
    '<div class="d-flex align-items-center gap-2 mb-1 flex-wrap">' +
      '<span class="text-xs text-muted-2">Compare only these columns:</span>' +
      '<button type="button" class="btn btn-sm btn-outline-soft dr-col-all" style="padding:0 .4rem;font-size:.7rem;">All</button>' +
      '<button type="button" class="btn btn-sm btn-outline-soft dr-col-none" style="padding:0 .4rem;font-size:.7rem;">None</button>' +
      '<input type="text" class="form-control form-control-sm dr-col-search" placeholder="Search columns…" style="max-width:180px;height:26px;font-size:.75rem;">' +
    '</div>' +
    '<div class="dr-col-list">' + cols.map(c =>
      '<label class="dr-tbl mb-0 dr-col-row" data-col="' + escapeHtml((c.name || "").toLowerCase()) + '" style="padding:.05rem 0;"><input type="checkbox" class="dr-col-cb" value="' + escapeHtml(c.name) + '"' +
      (sel.has(c.name) ? " checked" : "") + '> ' + escapeHtml(c.name) +
      (c.fk ? ' <span class="text-muted-2 text-xs" style="font-family:inherit;">(FK)</span>' : '') + '</label>').join("") +
    '</div>';
  const commit = () => {
    drSelectedCols[tid] = Array.from(panel.querySelectorAll(".dr-col-cb")).filter(cb => cb.checked).map(cb => cb.value);
  };
  panel.querySelectorAll(".dr-col-cb").forEach(cb => cb.addEventListener("change", commit));
  // Live column-name filter (hides rows in place; checkbox/selection state is preserved).
  const searchInp = panel.querySelector(".dr-col-search");
  const applyColFilter = () => {
    const q = (searchInp.value || "").toLowerCase().trim();
    drColSearch[tid] = q;
    panel.querySelectorAll(".dr-col-row").forEach(row => {
      row.style.display = (!q || (row.getAttribute("data-col") || "").indexOf(q) !== -1) ? "" : "none";
    });
  };
  if(searchInp){ searchInp.value = drColSearch[tid] || ""; searchInp.addEventListener("input", applyColFilter); applyColFilter(); }
  // All / None act on the currently VISIBLE (filtered) columns.
  const visibleCbs = () => Array.from(panel.querySelectorAll(".dr-col-row"))
    .filter(r => r.style.display !== "none").map(r => r.querySelector(".dr-col-cb"));
  const allBtn = panel.querySelector(".dr-col-all");
  if(allBtn) allBtn.addEventListener("click", () => { visibleCbs().forEach(cb => { cb.checked = true; }); commit(); });
  const noneBtn = panel.querySelector(".dr-col-none");
  if(noneBtn) noneBtn.addEventListener("click", () => { visibleCbs().forEach(cb => { cb.checked = false; }); commit(); });
}

function updateDrSelCount(){
  const c = document.getElementById("drSelCount");
  if(c) c.textContent = drSelected.size ? ("(" + drSelected.size + " selected)") : "";
}

// Select every table currently loaded (loads the list first if needed).
async function selectAllDrTables(){
  if(!drTables.length) await loadDrTables();
  drTables.forEach(t => drSelected.add(t.id));
  const q = (document.getElementById("drTableSearch").value || "").toLowerCase().trim();
  renderDrTables(q);
  updateDrSelCount();
}
function clearDrTableSelection(){
  drSelected = new Set();
  const q = (document.getElementById("drTableSearch").value || "").toLowerCase().trim();
  renderDrTables(q);
  updateDrSelCount();
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

let drAbort = null;   // AbortController for the in-flight generation (null when idle)

async function generateDrCompareSql(){
  const prompt = (document.getElementById("drPrompt").value || "").trim();
  if(!drSelected.size){
    showNotification("Select one or more tables to compare (use Select all to compare everything).", "warning", 4500);
    return;
  }
  // Blank the previous output as soon as Generate is clicked.
  const sqlBox = document.getElementById("drSql");
  if(sqlBox) sqlBox.value = "";
  drLastSql = "";
  const expandBox = document.getElementById("drExpandArea"); if(expandBox) expandBox.value = "";
  const used = document.getElementById("drUsed"); if(used) used.innerHTML = "";
  const result = document.getElementById("drResult"); if(result) result.style.display = "none";
  updateDrSaveBtn();

  const btn = document.getElementById("drGenerateBtn");
  const cancelBtn = document.getElementById("drCancelBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  drAbort = new AbortController();
  if(cancelBtn) cancelBtn.style.display = "";

  const con = document.getElementById("drConsoleWrap");
  if(con) con.style.display = "";
  const el = document.getElementById("drConsole"); if(el) el.innerHTML = "";
  toggleDrConsole(false);          // expand while running
  setDrConsoleStatus("");
  const meta = DR_MIG_META[drSource] || DR_MIG_META.cmt;
  drLog("Reading your request…", "done");
  const c = drCounts || {};
  const nTables = c.entities || c.tables || 0;
  drLog("Grounding on your " + meta.label +
        (nTables ? " (" + nTables + " tables, " + (c.columns || 0) + " columns)" : "") +
        " — comparing " + drSelected.size + " selected table(s).", "done");
  drLog("Output: changed values as Table Name · Column name · Primary Key · InValue · OutValue.", "done");
  if(drHistory.length) drLog("Using previous context (" + drHistory.length + " earlier request" + (drHistory.length === 1 ? "" : "s") + ")…", "done");
  drLog("Applying IN-vs-OUT stored-procedure conventions (SQL Server; QUOTENAME on keyword/spaced names)…", "done");
  const running = drLog("Generating & re-validating comparison SQL with AI…", "run");

  try{
    const res = await fetch("/api/ai/reconcile-compare-sql", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({prompt: prompt, source: drSource, tableIds: Array.from(drSelected),
                            columns: drSelectedCols, history: drHistory.slice(-6)}),
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
    drDone(running, "Stored procedure generated by AI.");
    if(j.conventions) drLog("Skill / conventions used: " + j.conventions, "done");
    const grounded = j.grounded || [];
    if(grounded.length) drLog("Grounded on " + grounded.length + " table" + (grounded.length === 1 ? "" : "s") +
        (grounded.length <= 8 ? (": " + grounded.join(", ")) : "") + ".", "done");
    if(j.interpretation) drLog("Purpose: " + j.interpretation, "done");
    drLog(j.revalidated ? "Re-validated T-SQL — auto-corrected syntax / quoting."
                        : "Re-validated T-SQL — no syntax issues found.", "done");
    if(j.issues && j.issues.length) drLog("Residual structural warnings: " + j.issues.join("; "), "error");
    drLog("Done.", "done");
    setDrConsoleStatus('<span class="text-success">✓ Done</span>');
    toggleDrConsole(true);

    drLastSql = j.sql || "";
    drLastGrounded = grounded.slice();
    document.getElementById("drSql").value = drLastSql;
    drHistory.push({prompt: prompt || ("Compare: " + grounded.join(", ")), sql: drLastSql});
    saveDrHistory();
    document.getElementById("drUsed").innerHTML = drGroundedSummary(grounded);
    document.getElementById("drResult").style.display = "";
    updateDrSaveBtn();
    const vcard = document.getElementById("drVersionsCard"); if(vcard) vcard.style.display = "";
    showNotification("Comparison SQL generated — review it before running.", "success", 2500);
  }catch(e){
    if(e && e.name === "AbortError"){
      if(running){ running.className = "log-line"; running.innerHTML = '<i class="bi bi-slash-circle"></i> Generation cancelled.'; }
      drLog("Cancelled by user.", "done");
      setDrConsoleStatus('<span class="text-muted-2">Cancelled</span>');
      toggleDrConsole(false);
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

// Compact "grounded on" summary: list chips only for a few tables; otherwise just a count
// (avoids dumping the whole table list when the user selects many / all tables).
function drGroundedSummary(tables){
  const t = tables || [];
  if(!t.length) return "";
  if(t.length > 8) return '<span class="text-xs text-muted-2">Grounded on ' + t.length + ' tables.</span>';
  return '<span class="text-xs text-muted-2">Grounded on:</span> ' +
    t.map(x => '<span class="dr-chip">' + escapeHtml(x) + '</span>').join("");
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
  a.href = url; a.download = "in_vs_out_comparison.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---- Fullscreen editor (edits sync back to the main editor live) ---- */
function openDrExpand(){
  const out = document.getElementById("drSql");
  const area = document.getElementById("drExpandArea");
  if(area && out) area.value = out.value || "";
  const modalEl = document.getElementById("drExpandModal");
  if(modalEl && typeof bootstrap !== "undefined"){
    const m = new bootstrap.Modal(modalEl);
    m.show();
    setTimeout(() => { if(area) area.focus(); }, 250);
  }
}

/* Enable "Save version" whenever there is SQL in the editor. */
function updateDrSaveBtn(){
  const has = !!((document.getElementById("drSql") || {}).value || "").trim();
  ["drSaveVersionBtn", "drExpandSaveBtn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !has; });
}

/* ---- Saved Versions (SQLite-backed, per client; feature=reconcile_compare) ----
   Endpoints: GET/POST /api/ai/reconcile-compare/versions, GET/DELETE .../versions/<id> */
async function saveDrVersion(){
  const sql = ((document.getElementById("drSql") || {}).value || "").trim();
  if(!sql){ showNotification("Nothing to save — generate or paste SQL first.", "warning"); return; }
  const tables = drLastGrounded.slice();
  const body = {
    content: sql,
    kind: "IN vs OUT",
    groupKey: "",   // single version sequence for this feature
    title: "IN vs OUT comparison" + (tables.length ? (" — " + tables.length + " table" + (tables.length === 1 ? "" : "s")) : ""),
    meta: {source: drSource, tables: tables}
  };
  const btns = ["drSaveVersionBtn", "drExpandSaveBtn"].map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => b.disabled = true);
  try{
    const res = await fetch("/api/ai/reconcile-compare/versions", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Could not save the version.", "danger", 5000); return; }
    showNotification("Saved version " + j.version + ".", "success", 2000);
    await loadDrVersions();
    const vcard = document.getElementById("drVersionsCard"); if(vcard) vcard.style.display = "";
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
  finally{ updateDrSaveBtn(); }
}

async function loadDrVersions(){
  try{
    const res = await fetch("/api/ai/reconcile-compare/versions", {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    drVersions = (j && j.ok) ? (j.versions || []) : [];
  }catch(e){ drVersions = []; }
  renderDrVersionsTable();
}

function _drFmtWhen(iso){
  try{ return (typeof formatDateTime === "function") ? formatDateTime(iso) : new Date(iso).toLocaleString(); }
  catch(e){ return iso || ""; }
}
function _drFmtBytes(n){
  n = n || 0;
  return n < 1024 ? (n + " B") : (n < 1048576 ? ((n / 1024).toFixed(1) + " KB") : ((n / 1048576).toFixed(1) + " MB"));
}

function renderDrVersionsTable(){
  const body = document.getElementById("drVersionsBody");
  const info = document.getElementById("drVersionsInfo");
  const card = document.getElementById("drVersionsCard");
  if(!body) return;
  if(info) info.textContent = drVersions.length ? (drVersions.length + " version" + (drVersions.length === 1 ? "" : "s")) : "";
  if(!drVersions.length){
    body.innerHTML = '<tr><td colspan="5" class="text-xs text-muted-2 py-3">No saved versions yet. Generate SQL, then click <b>Save version</b>.</td></tr>';
    if(card && card.style.display !== "") card.style.display = "";   // keep visible once revealed
    return;
  }
  // Newest first (server orders version DESC within the single group_key).
  body.innerHTML = drVersions.map(v => {
    const tables = (v.meta && v.meta.tables) ? v.meta.tables : [];
    const tlabel = tables.length ? tables.join(", ") : "—";
    return '<tr>' +
      '<td class="mono">v' + v.version + '</td>' +
      '<td class="text-xs text-muted-2">' + escapeHtml(_drFmtWhen(v.createdAt)) + '</td>' +
      '<td class="text-xs">' + escapeHtml(tlabel.length > 60 ? tlabel.slice(0, 60) + "…" : tlabel) + '</td>' +
      '<td class="text-xs text-muted-2">' + _drFmtBytes(v.bytes) + '</td>' +
      '<td>' +
        '<button class="btn btn-sm btn-outline-primary me-1" data-ver-act="load" data-ver-id="' + v.id + '" title="Load this version into the editor"><i class="bi bi-box-arrow-in-up-right"></i></button>' +
        '<button class="btn btn-sm btn-outline-soft me-1" data-ver-act="download" data-ver-id="' + v.id + '" title="Download this version (.sql)"><i class="bi bi-download"></i></button>' +
        '<button class="btn btn-sm btn-outline-danger" data-ver-act="delete" data-ver-id="' + v.id + '" title="Delete this version"><i class="bi bi-trash"></i></button>' +
      '</td></tr>';
  }).join("");
  if(card) card.style.display = "";
}

async function _fetchDrVersion(id){
  const res = await fetch("/api/ai/reconcile-compare/versions/" + encodeURIComponent(id), {headers:{Accept:"application/json"}});
  const j = await res.json().catch(() => ({}));
  if(!res.ok || !j.ok || !j.version) throw new Error((j && j.error) || "Could not load that version.");
  return j.version;
}

async function loadDrVersionIntoEditor(id){
  try{
    const v = await _fetchDrVersion(id);
    const out = document.getElementById("drSql");
    if(out) out.value = v.content || "";
    drLastSql = v.content || "";
    drLastGrounded = (v.meta && v.meta.tables) ? v.meta.tables.slice() : [];
    document.getElementById("drResult").style.display = "";
    document.getElementById("drUsed").innerHTML = drGroundedSummary(drLastGrounded);
    updateDrSaveBtn();
    if(out) out.scrollIntoView({behavior:"smooth", block:"center"});
    showNotification("Loaded version " + v.version + " — edit and Save to create a new version.", "primary", 2400);
  }catch(e){ showNotification(e.message || "Cannot reach the server.", "danger"); }
}

async function downloadDrVersion(id){
  try{
    const v = await _fetchDrVersion(id);
    const blob = new Blob([v.content || ""], {type: "text/sql"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "in_vs_out_comparison_v" + v.version + ".sql";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }catch(e){ showNotification(e.message || "Cannot reach the server.", "danger"); }
}

async function deleteDrVersion(id){
  const v = drVersions.find(x => String(x.id) === String(id));
  const label = v ? ("version " + v.version) : "this version";
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Delete <b>" + escapeHtml(label) + "</b>? This removes its saved SQL permanently.", "Delete version")
    : window.confirm("Delete " + label + "? This cannot be undone.");
  if(!ok) return;
  try{
    const res = await fetch("/api/ai/reconcile-compare/versions/" + encodeURIComponent(id), {method:"DELETE"});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Delete failed.", "danger"); return; }
    showNotification("Deleted " + label + ".", "primary", 1800);
    await loadDrVersions();
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}
