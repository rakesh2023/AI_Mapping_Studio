/* =========================================================================
   data-reconciliation-nonfin.js — Data Reconciliation › Non-Financial Recon.
   Reuses THIS client's migration schema (CMT / PMT / BMT) picker (same endpoints
   as IN vs OUT), then deterministically builds a SQL script:
     CREATE TABLE [<name>_CMT] ( selected columns + key )
     CREATE TABLE [<name>_Legacy] ( same )
     CREATE OR ALTER PROCEDURE dbo.usp_Reconcile_<name>  — diffs them on the key.
   Endpoints:
     GET  /api/ai/reconcile-context?source=            -> {ok, indexed, counts}
     GET  /api/ai/reconcile-tables?source=             -> {ok, tables:[{id,table,description}]}
     GET  /api/ai/reconcile-compare-columns?source=&table= -> {ok, columns:[{name,fk}]}
     POST /api/ai/reconcile-nonfin-sql                 -> {ok, sql, tables[], proc}
   ========================================================================= */

let drTables = [];              // [{id, table, description}] for the migration schema
let drSelected = new Set();     // selected table ids
let drSelectedCols = {};        // tableId -> [colName]: explicit column scope (absent = all columns)
let drColCache = {};            // tableId -> [{name, fk}] (fetched lazily)
let drColsOpen = new Set();     // tableIds whose column picker is expanded
let drColSearch = {};           // tableId -> column-name filter term (per open picker)
let drSource = "cmt";           // cmt | pmt | bmt — the migration tool for this client's Product
let drCounts = null;
let drVersions = [];            // saved versions (newest first)
let drLastMeta = null;          // {reconName, keyCols, tables, report, proc} of the last generated script

const DR_MIG_META = {
  cmt: {label: "CMT (Claim Migration Tool) schema",   short: "CMT"},
  pmt: {label: "PMT (Policy Migration Tool) schema",  short: "PMT"},
  bmt: {label: "BMT (Billing Migration Tool) schema", short: "BMT"}
};

// The client's Product picks the migration tool: Policy -> PMT, Billing -> BMT, else CMT.
function drMigSource(){
  const p = (typeof getActiveClientProduct === "function") ? (getActiveClientProduct() || "").toLowerCase() : "";
  if(p === "policy") return "pmt";
  if(p === "billing") return "bmt";
  return "cmt";
}

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-reconciliation-nonfin.html");
  drSource = drMigSource();
  wireDr();
  await loadDrContext();
  // Load the table list (unchecked — the user picks the table(s) to reconcile; recon is one combined pair).
  const card = document.getElementById("drCard");
  if(card && card.style.display !== "none") await loadDrTables();
  loadDrVersions();
});

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
      (c.columns || 0) + '</b> columns. Pick the table(s) &amp; columns to reconcile.');
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
        '<button type="button" class="btn btn-link btn-sm dr-col-toggle p-0 ms-2" style="font-size:.72rem;text-decoration:none;" title="Choose which columns to include">columns <i class="bi ' + (drColsOpen.has(t.id) ? "bi-chevron-up" : "bi-chevron-down") + '"></i></button>' +
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
  box.querySelectorAll(".dr-trow").forEach(row => {
    const tid = row.getAttribute("data-tid");
    if(drColsOpen.has(tid)) renderDrColsPanel(tid, row.querySelector(".dr-cols"));
  });
}

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
  if(!cols.length){ panel.innerHTML = '<div class="text-xs text-muted-2">No columns found for this table.</div>'; return; }
  // Default selection (first open): ALL columns (the user narrows by unchecking).
  if(!Array.isArray(drSelectedCols[tid])) drSelectedCols[tid] = cols.map(c => c.name);
  const sel = new Set(drSelectedCols[tid]);
  panel.innerHTML =
    '<div class="d-flex align-items-center gap-2 mb-1 flex-wrap">' +
      '<span class="text-xs text-muted-2">Include these columns:</span>' +
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

function wireDr(){
  const gen = document.getElementById("drGenerateBtn");
  if(gen) gen.addEventListener("click", generateNonfinSql);
  const copy = document.getElementById("drCopyBtn");
  if(copy) copy.addEventListener("click", copyDrSql);
  const dl = document.getElementById("drDownloadBtn");
  if(dl) dl.addEventListener("click", downloadDrSql);
  const expand = document.getElementById("drExpandBtn");
  if(expand) expand.addEventListener("click", (e) => { e.preventDefault(); openDrExpand(); });
  const expandArea = document.getElementById("drExpandArea");
  if(expandArea) expandArea.addEventListener("input", () => {
    const out = document.getElementById("drSql"); if(out) out.value = expandArea.value; updateDrSaveBtn();
  });
  const expandCopy = document.getElementById("drExpandCopyBtn");
  if(expandCopy) expandCopy.addEventListener("click", copyDrSql);
  const sql = document.getElementById("drSql");
  if(sql) sql.addEventListener("input", updateDrSaveBtn);
  // Save version (main + fullscreen).
  const save = document.getElementById("drSaveVersionBtn");
  if(save) save.addEventListener("click", (e) => { e.preventDefault(); saveDrVersion(); });
  const expandSave = document.getElementById("drExpandSaveBtn");
  if(expandSave) expandSave.addEventListener("click", (e) => { e.preventDefault(); saveDrVersion(); });
  // Saved Versions row actions.
  const vbody = document.getElementById("drVersionsBody");
  if(vbody) vbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ver-act]");
    if(!btn) return;
    const id = btn.getAttribute("data-ver-id"), act = btn.getAttribute("data-ver-act");
    if(act === "load") loadDrVersionIntoEditor(id);
    else if(act === "download") downloadDrVersion(id);
    else if(act === "delete") deleteDrVersion(id);
  });
  const search = document.getElementById("drTableSearch");
  if(search) search.addEventListener("input", () => renderDrTables((search.value || "").toLowerCase().trim()));
  const selAll = document.getElementById("drSelectAllBtn");
  if(selAll) selAll.addEventListener("click", selectAllDrTables);
  const clr = document.getElementById("drClearAllBtn");
  if(clr) clr.addEventListener("click", clearDrTableSelection);
  const hdr = document.getElementById("drTablesHdr");
  if(hdr) hdr.addEventListener("click", () => {
    const wrap = document.getElementById("drTablesWrap");
    const chev = document.getElementById("drTablesChev");
    const open = wrap.style.display === "none";
    wrap.style.display = open ? "" : "none";
    if(chev) chev.className = "bi ms-auto " + (open ? "bi-chevron-up" : "bi-chevron-down");
  });
}

async function generateNonfinSql(){
  const reconName = (document.getElementById("nfReconName").value || "").trim();
  const keyCols = (document.getElementById("nfKeyCols").value || "").trim();
  const status = document.getElementById("drStatus");
  const setStatus = (html) => { if(status) status.innerHTML = html || ""; };
  if(!drSelected.size){ showNotification("Select at least one table to reconcile.", "warning", 3500); return; }
  if(!reconName){ showNotification("Enter a Non-Financial Recon table name.", "warning", 3500); document.getElementById("nfReconName").focus(); return; }
  if(!keyCols){ showNotification("Enter the common key column present in both tables.", "warning", 4000); document.getElementById("nfKeyCols").focus(); return; }

  const btn = document.getElementById("drGenerateBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  setStatus('<span class="text-muted-2">Building script…</span>');
  try{
    const res = await fetch("/api/ai/reconcile-nonfin-sql", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({source: drSource, tableIds: Array.from(drSelected), columns: drSelectedCols,
                            reconName: reconName, keyCols: keyCols})});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){
      setStatus('<span class="text-danger">Failed</span>');
      showNotification((j && j.error) || "Could not generate the reconciliation SQL.", "danger", 6000);
      return;
    }
    document.getElementById("drSql").value = j.sql || "";
    drLastMeta = {reconName: reconName, keyCols: keyCols, tables: j.tables || [], report: j.report || "", proc: j.proc || ""};
    document.getElementById("drUsed").innerHTML = '<span class="text-xs text-muted-2">Created: </span>' +
      (j.tables || []).map(t => '<span class="dr-chip">' + escapeHtml(t) + '</span>').join("") +
      (j.report ? '<span class="dr-chip">' + escapeHtml(j.report) + '</span>' : "") +
      ' <span class="text-xs text-muted-2">Proc: </span><span class="dr-chip">' + escapeHtml(j.proc || "") + '</span>';
    document.getElementById("drResult").style.display = "";
    updateDrSaveBtn();
    const vcard = document.getElementById("drVersionsCard"); if(vcard) vcard.style.display = "";
    setStatus('<span class="text-success">✓ Generated</span>');
    showNotification("Reconciliation SQL generated — review it before running.", "success", 2500);
  }catch(e){
    setStatus('<span class="text-danger">Failed</span>');
    showNotification("Backend not reachable.", "danger");
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
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
  const name = ((document.getElementById("nfReconName").value || "nonfin_recon").trim().replace(/[^A-Za-z0-9_]+/g, "_") || "nonfin_recon");
  const blob = new Blob([sql], {type: "text/sql"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name + "_recon.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function openDrExpand(){
  const out = document.getElementById("drSql");
  const area = document.getElementById("drExpandArea");
  if(area && out) area.value = out.value || "";
  const modalEl = document.getElementById("drExpandModal");
  if(modalEl && typeof bootstrap !== "undefined"){
    const m = new bootstrap.Modal(modalEl);
    m.show();
  }
}

/* ---- Saved Versions (SQLite-backed, per client; feature=reconcile_nonfin) ----
   Endpoints: GET/POST /api/ai/reconcile-nonfin/versions, GET/DELETE .../versions/<id> */
function updateDrSaveBtn(){
  const has = !!((document.getElementById("drSql") || {}).value || "").trim();
  ["drSaveVersionBtn", "drExpandSaveBtn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !has; });
}

async function saveDrVersion(){
  const sql = ((document.getElementById("drSql") || {}).value || "").trim();
  if(!sql){ showNotification("Nothing to save — generate the script first.", "warning"); return; }
  const m = drLastMeta || {};
  const body = {
    content: sql,
    kind: "Non-Financial Recon",
    groupKey: "",
    title: "Non-Financial Recon" + (m.reconName ? (" — " + m.reconName) : ""),
    meta: {source: drSource, reconName: m.reconName || "", keyCols: m.keyCols || "",
           tables: m.tables || [], report: m.report || "", proc: m.proc || ""}
  };
  const btns = ["drSaveVersionBtn", "drExpandSaveBtn"].map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => b.disabled = true);
  try{
    const res = await fetch("/api/ai/reconcile-nonfin/versions", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
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
    const res = await fetch("/api/ai/reconcile-nonfin/versions", {headers:{Accept:"application/json"}});
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
    body.innerHTML = '<tr><td colspan="5" class="text-xs text-muted-2 py-3">No saved versions yet. Generate the script, then click <b>Save version</b>.</td></tr>';
    return;
  }
  body.innerHTML = drVersions.map(v => {
    const nm = (v.meta && v.meta.reconName) ? v.meta.reconName : (v.title || "—");
    return '<tr>' +
      '<td class="mono">v' + v.version + '</td>' +
      '<td class="text-xs text-muted-2">' + escapeHtml(_drFmtWhen(v.createdAt)) + '</td>' +
      '<td class="text-xs">' + escapeHtml(nm.length > 60 ? nm.slice(0, 60) + "…" : nm) + '</td>' +
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
  const res = await fetch("/api/ai/reconcile-nonfin/versions/" + encodeURIComponent(id), {headers:{Accept:"application/json"}});
  const j = await res.json().catch(() => ({}));
  if(!res.ok || !j.ok || !j.version) throw new Error((j && j.error) || "Could not load that version.");
  return j.version;
}

async function loadDrVersionIntoEditor(id){
  try{
    const v = await _fetchDrVersion(id);
    const out = document.getElementById("drSql");
    if(out) out.value = v.content || "";
    const m = v.meta || {};
    drLastMeta = {reconName: m.reconName || "", keyCols: m.keyCols || "", tables: m.tables || [], report: m.report || "", proc: m.proc || ""};
    if(m.reconName){ const rn = document.getElementById("nfReconName"); if(rn && !rn.value.trim()) rn.value = m.reconName; }
    if(m.keyCols){ const kc = document.getElementById("nfKeyCols"); if(kc && !kc.value.trim()) kc.value = m.keyCols; }
    document.getElementById("drResult").style.display = "";
    document.getElementById("drUsed").innerHTML = '<span class="text-xs text-muted-2">Loaded version v' + v.version + '.</span>';
    updateDrSaveBtn();
    if(out) out.scrollIntoView({behavior:"smooth", block:"center"});
    showNotification("Loaded version " + v.version + " — edit and Save to create a new version.", "primary", 2400);
  }catch(e){ showNotification(e.message || "Cannot reach the server.", "danger"); }
}

async function downloadDrVersion(id){
  try{
    const v = await _fetchDrVersion(id);
    const nm = ((v.meta && v.meta.reconName) || "nonfin_recon").replace(/[^A-Za-z0-9_]+/g, "_") || "nonfin_recon";
    const blob = new Blob([v.content || ""], {type: "text/sql"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nm + "_recon_v" + v.version + ".sql";
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
    const res = await fetch("/api/ai/reconcile-nonfin/versions/" + encodeURIComponent(id), {method:"DELETE"});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Delete failed.", "danger"); return; }
    showNotification("Deleted " + label + ".", "primary", 1800);
    await loadDrVersions();
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}
