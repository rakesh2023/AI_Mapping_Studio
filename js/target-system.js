/* =========================================================================
   target-system.js
   Dynamic target systems: multiple saved target connections (SQL Server OR
   file), one marked ACTIVE. The active connection is materialized into the
   single getTargetSchema() blob (via target-schema.js) so the AI generator,
   workspace and dashboard keep reading one target unchanged.

   Mirrors js/source-systems.js. SQL Server targets are read live via the
   backend (/api/db/metadata); file targets are parsed in-browser (xlsx) or
   extracted by the AI (/api/ai/extract-source).
   ========================================================================= */

let editingId = null;
let stagedEntities = null;   // entities[] loaded/extracted in the form, pending save
let activeEntity = null;     // entity currently shown in the browser grid
let stagedIsFreshExtract = false;   // true when stagedEntities came from a NEW load/extract (not a preload)
let activeDiff = null;       // computeSchemaDiff() for the active target (changes since last extract)

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("target-system.html");
  migrateLegacyTargetSchema();   // seed a connection from any legacy uploaded schema
  renderConnections();
  renderActiveBrowser();

  document.getElementById("addConnBtn").addEventListener("click", () => openForm(null));
  document.getElementById("cancelConnBtn").addEventListener("click", closeForm);
  document.getElementById("testConnBtn").addEventListener("click", testConnection);
  document.getElementById("loadTablesBtn").addEventListener("click", loadSqlTables);
  document.getElementById("extractFileBtn").addEventListener("click", loadFileTarget);
  document.getElementById("connForm").addEventListener("submit", saveConnectionForm);
  document.getElementById("cType").addEventListener("change", toggleTargetFields);
  document.getElementById("cAuth").addEventListener("change", toggleTargetFields);
  document.getElementById("targetSearch").addEventListener("input", debounce(renderTargetFields, 150));
  wireAddColumn();
  wireAddEntity();
  // Edit Column modal controls
  const ecSaveBtn = document.getElementById("ecSaveBtn");
  if(ecSaveBtn) ecSaveBtn.addEventListener("click", ecSave);
  const ecDeleteBtn = document.getElementById("ecDeleteBtn");
  if(ecDeleteBtn) ecDeleteBtn.addEventListener("click", ecDelete);
  const delEntBtn = document.getElementById("deleteEntityBtn");
  if(delEntBtn) delEntBtn.addEventListener("click", deleteActiveEntity);
  const ecTypeEl = document.getElementById("ecType");
  if(ecTypeEl) ecTypeEl.addEventListener("change", ecToggleLen);
  const ecFkEl = document.getElementById("ecFk");
  if(ecFkEl) ecFkEl.addEventListener("change", ecToggleFk);
  const inferBtn = document.getElementById("inferMetaBtn");
  if(inferBtn) inferBtn.addEventListener("click", runInferSelected);
  const selAllBtn = document.getElementById("ttSelectAllBtn");
  if(selAllBtn) selAllBtn.addEventListener("click", toggleSelectAllTables);
  const clearAiBtn = document.getElementById("clearAiFieldsBtn");
  if(clearAiBtn) clearAiBtn.addEventListener("click", clearAiFields);
});

// Which target columns had pk/fk/list/description AI/auto-populated -> highlighted for review.
// Shape: { "tablelower::collower": {pk:1, fk:1, isListTable:1, description:1} }
let activeAiFields = {};
// Entity names ticked in the tree (for "AI fill selected tables").
let targetSelected = new Set();

function isSqlServer(type){ return (type || "").toLowerCase().indexOf("sql server") !== -1; }
function isFileSystem(type){ return (type || "").toLowerCase() === "file system"; }

/* ---- connection config for backend calls ---- */
function connToConfig(c){
  return {
    driver: c.driver || "ODBC Driver 17 for SQL Server",
    server: c.server || c.host || "",
    database: c.database || c.db || "",
    schema: c.schema || null,
    trusted: !!c.trusted,
    username: c.username || "",
    password: c.password || ""
  };
}

/* ---- render connection cards ---- */
function renderConnections(){
  const list = getTargetConnections();
  const wrap = document.getElementById("connectionCards");
  if(!list.length){
    wrap.innerHTML = "";
    return;
  }
  const activeId = getActiveTargetId();
  wrap.innerHTML = list.map(c => {
    const type = c.type || "SQL Server";
    const file = isFileSystem(type);
    const isActive = c.id === activeId;
    const statusClass = (c.status === "Connected" || c.status === "Loaded") ? "badge-high" : (c.status === "Failed" ? "badge-low" : "badge-gray");
    const tbl = (c.tableCount != null ? c.tableCount : (Array.isArray(c.entities) ? c.entities.length : "-"));

    let line1, line2;
    if(file){
      line1 = '<i class="bi bi-file-earmark-text"></i> ' + escapeHtml(c.fileName || "uploaded file");
      line2 = '<i class="bi bi-table"></i> ' + tbl + ' tables &middot; ' + (c.columnCount != null ? c.columnCount : "-") + ' columns';
    } else {
      line1 = '<i class="bi bi-hdd-network"></i> ' + escapeHtml(c.server || c.host || "-");
      line2 = '<i class="bi bi-table"></i> ' + escapeHtml(c.database || c.db || "-") + ' &middot; ' + escapeHtml(c.schema || "-") + ' &middot; ' + tbl + ' tables';
    }

    const activeBadge = isActive
      ? '<span class="badge-soft badge-high"><i class="bi bi-check-circle-fill"></i> Active</span>'
      : '<span class="badge-soft ' + statusClass + '">' + (c.status || "Saved") + '</span>';

    const activateBtn = isActive
      ? '<button class="btn btn-sm btn-outline-soft flex-fill" disabled><i class="bi bi-check2"></i> Active</button>'
      : '<button class="btn btn-sm btn-primary flex-fill" onclick="activateConn(\'' + c.id + '\')"><i class="bi bi-check2-circle"></i> Set Active</button>';

    return '<div class="col-md-4"><div class="card-el h-100' + (isActive ? ' border-primary' : '') + '">' +
      '<div class="d-flex justify-content-between align-items-start mb-2">' +
        '<div><h5 class="mb-0">' + escapeHtml(c.name) + '</h5><span class="text-muted-2 text-xs">' + escapeHtml(type) + '</span></div>' +
        activeBadge +
      '</div>' +
      '<div class="text-xs text-muted-2 mb-2">' + line1 + '</div>' +
      '<div class="text-xs text-muted-2 mb-3">' + line2 + '</div>' +
      '<div class="d-flex gap-2 mb-2">' + activateBtn + '</div>' +
      '<div class="d-flex gap-2">' +
        '<button class="btn btn-sm btn-outline-soft flex-fill" onclick="editConn(\'' + c.id + '\')"><i class="bi bi-pencil"></i> Edit</button>' +
        '<button class="btn btn-sm btn-outline-soft flex-fill" onclick="deleteConn(\'' + c.id + '\')"><i class="bi bi-trash"></i> Delete</button>' +
      '</div>' +
    '</div></div>';
  }).join("");
}

/* ---- add / edit form ---- */
function openForm(id){
  editingId = id;
  stagedEntities = null;
  stagedIsFreshExtract = false;   // a preloaded schema is NOT a fresh extract
  const card = document.getElementById("connFormCard");
  const form = document.getElementById("connForm");
  form.reset();
  document.getElementById("testConnResult").innerHTML = "";
  document.getElementById("extractResult").innerHTML = "";
  document.getElementById("connFormTitle").innerHTML = id
    ? '<i class="bi bi-pencil-square"></i> Edit Target Connection'
    : '<i class="bi bi-hdd-network"></i> Target Connection Details';

  if(id){
    const c = getTargetConnection(id);
    if(c){
      document.getElementById("cName").value = c.name || "";
      document.getElementById("cType").value = c.type || "SQL Server";
      document.getElementById("cDriver").value = c.driver || "ODBC Driver 17 for SQL Server";
      document.getElementById("cHost").value = c.server || c.host || "";
      document.getElementById("cDb").value = c.database || c.db || "";
      document.getElementById("cSchema").value = c.schema || "";
      document.getElementById("cAuth").value = c.trusted ? "trusted" : "sql";
      document.getElementById("cUser").value = c.username || "";
      document.getElementById("cPass").value = c.password || "";
      if(c.entities && c.entities.length){
        stagedEntities = c.entities;
        const cols = c.entities.reduce((a,e)=>a+(e.fields||[]).length,0);
        document.getElementById("extractResult").innerHTML = infoNote("Using previously loaded schema: " +
          c.entities.length + " tables, " + cols + " columns. Load/extract again to replace it.");
      }
    }
  }
  toggleTargetFields();
  card.style.display = "block";
  card.scrollIntoView({behavior:"smooth", block:"center"});
}
function closeForm(){ document.getElementById("connFormCard").style.display = "none"; editingId = null; stagedEntities = null; stagedIsFreshExtract = false; }

function toggleTargetFields(){
  const type = document.getElementById("cType").value;
  const sql = isSqlServer(type);
  const file = isFileSystem(type);
  document.getElementById("driverGroup").style.display = sql ? "" : "none";
  const trusted = document.getElementById("cAuth").value === "trusted";
  document.getElementById("userGroup").style.display = (sql && !trusted) ? "" : "none";
  document.getElementById("passGroup").style.display = (sql && !trusted) ? "" : "none";
  document.getElementById("authGroup").style.display = sql ? "" : "none";
  // Server/DB/Schema only for database targets
  document.getElementById("cHost").closest(".form-group").style.display = file ? "none" : "";
  document.getElementById("cDb").closest(".form-group").style.display = file ? "none" : "";
  document.getElementById("cSchema").closest(".form-group").style.display = file ? "none" : "";
  // File uploader only for File System
  document.getElementById("fileGroup").style.display = file ? "" : "none";
  // Backend-only actions
  document.getElementById("testConnBtn").style.display = sql ? "" : "none";
  document.getElementById("loadTablesBtn").style.display = sql ? "" : "none";
  document.getElementById("sqlHint").style.display = sql ? "" : "none";
}

/* ---- SQL Server: test + load tables live ---- */
async function testConnection(){
  const cfg = readConfig();
  const el = document.getElementById("testConnResult");
  if(!cfg.server || !cfg.database){ el.innerHTML = failNote("Server and database are required."); return; }
  el.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span> Testing connection to ' + escapeHtml(cfg.server) + '...</div>';
  try{
    const res = await fetch("/api/db/test", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const out = await res.json();
    el.innerHTML = out.ok ? okNote("Connection successful. " + escapeHtml(out.version || "")) : failNote(out.error || "Connection failed.");
  }catch(err){ el.innerHTML = failNote("Backend not reachable. Start it with python server/app.py."); }
}

async function loadSqlTables(){
  const cfg = readConfig();
  const el = document.getElementById("testConnResult");
  if(!cfg.server || !cfg.database){ el.innerHTML = failNote("Server and database are required."); return; }
  el.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span> Reading tables &amp; columns from ' + escapeHtml(cfg.database) + '...</div>';
  try{
    const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const data = await res.json();
    if(!data.ok){ el.innerHTML = failNote(data.error || "Could not read metadata."); return; }
    stagedEntities = dbMetadataToEntities(data);
    stagedIsFreshExtract = true;   // diff against the previous extract on save
    const cols = stagedEntities.reduce((a,e)=>a+(e.fields||[]).length,0);
    el.innerHTML = okNote("Loaded " + stagedEntities.length + " tables, " + cols + " columns from " + escapeHtml(data.connection || cfg.database) + ". Save the target to keep it.");
    if(!document.getElementById("cName").value.trim()) document.getElementById("cName").value = data.connection || cfg.database;
  }catch(err){ el.innerHTML = failNote("Backend not reachable. Start it with python server/app.py."); }
}

/* ---- File System: parse xlsx in-browser, else AI-extract ---- */
async function loadFileTarget(){
  const input = document.getElementById("cFile");
  const el = document.getElementById("extractResult");
  const file = input.files && input.files[0];
  if(!file){ el.innerHTML = failNote("Choose a file first."); return; }
  const ext = file.name.split(".").pop().toLowerCase();
  el.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span> Reading ' + escapeHtml(file.name) + '...</div>';

  const forceAI = !!(document.getElementById("cForceAI") && document.getElementById("cForceAI").checked);
  try{
    if(!forceAI && (ext === "xlsx" || ext === "xls")){
      // In-browser parse (SheetJS) using the existing target-schema parser.
      const schema = await ingestTargetSchemaFile(file);   // also sets legacy blob; fine
      stagedEntities = schema.entities;
      el.innerHTML = okNote("Parsed " + schema.tableCount + " tables, " + schema.columnCount + " columns from " + escapeHtml(file.name) + ". Save the target to keep it.");
    } else {
      // Other formats (or "Use AI extraction" checked): backend + AI extract the structure,
      // with progress. In rich mode the AI also detects PK/FK/descriptions from the dictionary.
      const out = await streamExtractFile(file, (evt) => {
        if(evt.type === "start"){
          el.innerHTML = renderExtractProgress(0, evt.chunks || 0, 0, 0, "Starting…", evt.unit || "parts");
        } else if(evt.type === "progress"){
          el.innerHTML = renderExtractProgress(evt.done, evt.total, evt.tables, evt.columns, evt.label || "", "");
        }
      }, {rich: forceAI});
      stagedEntities = extractedToEntities(out.tables);
      const cols = stagedEntities.reduce((a,e)=>a+(e.fields||[]).length,0);
      el.innerHTML = okNote("Extracted " + stagedEntities.length + " tables, " + cols + " columns from " + escapeHtml(out.fileName || file.name) +
        (out.truncatedChunks ? " (file was large — capped at " + out.chunks + " parts)" : "") + ". Save the target to keep it.");
    }
    stagedIsFreshExtract = true;   // diff against the previous extract on save
    document.getElementById("cFile")._fileName = file.name;
    if(!document.getElementById("cName").value.trim()) document.getElementById("cName").value = file.name.replace(/\.[^.]+$/, "");
  }catch(err){
    el.innerHTML = failNote(err.message || "Could not read the file.");
  }
}

function readConfig(){
  return {
    driver: document.getElementById("cDriver").value,
    server: document.getElementById("cHost").value.trim(),
    database: document.getElementById("cDb").value.trim(),
    schema: document.getElementById("cSchema").value.trim() || null,
    trusted: document.getElementById("cAuth").value === "trusted",
    username: document.getElementById("cUser").value,
    password: document.getElementById("cPass").value
  };
}

function saveConnectionForm(e){
  e.preventDefault();
  const type = document.getElementById("cType").value;
  const name = document.getElementById("cName").value.trim() || "New Target";

  if(!stagedEntities || !stagedEntities.length){
    const where = isFileSystem(type) ? "Upload a file and click 'Load / Extract'" : "Click 'Load Tables'";
    document.getElementById(isFileSystem(type) ? "extractResult" : "testConnResult").innerHTML =
      failNote(where + " to read the target tables before saving.");
    return;
  }

  const existing = editingId ? getTargetConnection(editingId) : null;
  const cols = stagedEntities.reduce((a,e)=>a+(e.fields||[]).length,0);
  const conn = Object.assign({}, existing || {}, {
    name, type,
    driver: document.getElementById("cDriver").value,
    server: document.getElementById("cHost").value.trim(),
    database: document.getElementById("cDb").value.trim(),
    schema: document.getElementById("cSchema").value.trim() || null,
    trusted: document.getElementById("cAuth").value === "trusted",
    username: document.getElementById("cUser").value,
    password: document.getElementById("cPass").value,
    fileName: isFileSystem(type) ? (document.getElementById("cFile")._fileName || existing?.fileName || "") : "",
    entities: stagedEntities,
    tableCount: stagedEntities.length,
    columnCount: cols,
    status: isSqlServer(type) ? "Connected" : "Loaded",
    loadedAt: new Date().toISOString()
  });
  if(!conn.id) conn.id = uid("TGT");
  // On a fresh re-extract, snapshot the PREVIOUS extract's schema so we can show
  // "changes since last extract". Object.assign already carried existing.prevExtract
  // forward for non-extract saves; here we overwrite it with the pre-extract schema.
  if(stagedIsFreshExtract && existing && existing.entities && existing.entities.length){
    const snap = snapshotEntities(existing.entities);
    snap.at = existing.loadedAt || existing.uploadedAt || null;
    conn.prevExtract = snap;
  }
  // Never persist the DB password (target schema is already read into entities[]).
  rememberConnPassword(conn.id, conn.password);
  delete conn.password;
  upsertTargetConnection(conn);

  // Auto-activate if it's the first target, or if we edited the active one.
  const wasActive = getActiveTargetId() === conn.id;
  if(getTargetConnections().length === 1 || wasActive){ setActiveTarget(conn.id); }

  renderConnections();
  renderActiveBrowser();
  closeForm();
  let msg = "Target '" + conn.name + "' saved" + (getActiveTargetId() === conn.id ? " and set active." : ".");
  if(stagedIsFreshExtract && conn.prevExtract){
    const d = computeSchemaDiff(conn.prevExtract, conn.entities);
    msg += d.hasChanges ? "  Changes since last extract: " + diffSummaryText(d) + "."
                        : "  No schema changes since last extract.";
  }
  stagedIsFreshExtract = false;
  showNotification(msg, "success");
}

/* Compact "+2 tables, -1 col…" summary for the save toast. */
function diffSummaryText(d){
  const c = d.counts, p = [];
  if(c.tablesAdded)     p.push("+" + c.tablesAdded + " table" + (c.tablesAdded > 1 ? "s" : ""));
  if(c.tablesRemoved)   p.push("-" + c.tablesRemoved + " table" + (c.tablesRemoved > 1 ? "s" : ""));
  if(c.columnsAdded)    p.push("+" + c.columnsAdded + " col" + (c.columnsAdded > 1 ? "s" : ""));
  if(c.columnsRenamed)  p.push("⇄ " + c.columnsRenamed + " renamed");
  if(c.columnsModified) p.push("~" + c.columnsModified + " changed");
  if(c.columnsRemoved)  p.push("-" + c.columnsRemoved + " col" + (c.columnsRemoved > 1 ? "s" : ""));
  return p.join(", ");
}

function activateConn(id){
  setActiveTarget(id);
  renderConnections();
  renderActiveBrowser();
  const c = getTargetConnection(id);
  showNotification("'" + (c ? c.name : "Target") + "' is now the active target. AI mapping and the workspace will map into it.", "success");
}

function editConn(id){ openForm(id); }
async function deleteConn(id){
  const c = getTargetConnection(id);
  if(!c) return;
  const ok = await confirmDialog('Delete target "' + escapeHtml(c.name) + '"?', "Delete");
  if(!ok) return;
  deleteTargetConnection(id);
  renderConnections();
  renderActiveBrowser();
  showNotification("Target deleted.", "primary");
}

/* ---- active-target browser (entity tree + fields) ---- */
function renderActiveBrowser(){
  const meta = getTargetSchema();
  const has = meta && meta.entities && meta.entities.length;
  document.getElementById("activeTargetBar").style.display = has ? "" : "none";
  document.getElementById("browseLayout").style.display = has ? "" : "none";
  document.getElementById("noTargetState").style.display = (getTargetConnections().length ? "none" : (has ? "none" : ""));
  const addEntBtn = document.getElementById("addEntityBtn");
  if(addEntBtn) addEntBtn.style.display = has ? "" : "none";   // enable Add Entity once a target is loaded
  if(!has){ activeDiff = null; renderDiffPanel(null); return; }

  // Changes since last extract (Target only): diff the active connection's stored
  // pre-extract snapshot against the current schema.
  const activeConn = getTargetConnection(getActiveTargetId());
  activeDiff = (activeConn && activeConn.prevExtract) ? computeSchemaDiff(activeConn.prevExtract, meta.entities) : null;
  renderDiffPanel(activeDiff);

  // AI-populated highlights (pk/fk/list/description filled from schema file + dictionary).
  activeAiFields = lsGet("aims_target_ai_fields", {}) || {};
  const clearAiBtn = document.getElementById("clearAiFieldsBtn");
  if(clearAiBtn) clearAiBtn.style.display = Object.keys(activeAiFields).length ? "" : "none";

  document.getElementById("schemaMeta").innerHTML =
    '<span class="badge-soft badge-high"><i class="bi bi-hdd-network"></i> ' + escapeHtml(meta.application || "Target") + '</span> ' +
    '<span class="badge-soft badge-gray">' + escapeHtml(meta.version || "") + '</span> ' +
    '<span class="badge-soft badge-gray">' + meta.tableCount + ' tables</span> ' +
    '<span class="badge-soft badge-gray">' + meta.columnCount + ' columns</span>';

  renderTargetTree(meta);
  if(meta.entities.length) selectEntity(meta.entities[0].name);
}

/* ---- "Changes since last extract" panel (Target only) ---- */
function renderDiffPanel(diff){
  const panel = document.getElementById("targetDiffPanel");
  if(!panel) return;
  if(!diff || !diff.hasChanges){ panel.style.display = "none"; panel.innerHTML = ""; return; }
  const c = diff.counts, chips = [];
  if(c.tablesAdded)     chips.push('<span class="badge-soft badge-high">+' + c.tablesAdded + ' table' + (c.tablesAdded > 1 ? 's' : '') + '</span>');
  if(c.tablesRemoved)   chips.push('<span class="badge-soft badge-low">−' + c.tablesRemoved + ' table' + (c.tablesRemoved > 1 ? 's' : '') + '</span>');
  if(c.columnsAdded)    chips.push('<span class="badge-soft badge-high">+' + c.columnsAdded + ' column' + (c.columnsAdded > 1 ? 's' : '') + '</span>');
  if(c.columnsRenamed)  chips.push('<span class="badge-soft badge-medium">⇄ ' + c.columnsRenamed + ' renamed</span>');
  if(c.columnsModified) chips.push('<span class="badge-soft badge-medium">~' + c.columnsModified + ' changed</span>');
  if(c.columnsRemoved)  chips.push('<span class="badge-soft badge-low">−' + c.columnsRemoved + ' column' + (c.columnsRemoved > 1 ? 's' : '') + '</span>');
  const when = diff.at ? '<span class="text-xs text-muted-2 ms-2">since ' + escapeHtml(formatDateTime(diff.at)) + '</span>' : '';
  const sec = [];
  if(diff.tablesAdded.length)     sec.push(diffSection("New tables", "badge-high", diff.tablesAdded.map(escapeHtml)));
  if(diff.tablesRemoved.length)   sec.push(diffSection("Removed tables", "badge-low", diff.tablesRemoved.map(t => escapeHtml(t.name))));
  if(diff.columnsAdded.length)    sec.push(diffSection("New columns", "badge-high", diff.columnsAdded.map(x => escapeHtml(x.table + "." + x.col))));
  if(diff.columnsRenamed.length)  sec.push(diffSection("Renamed columns", "badge-medium", diff.columnsRenamed.map(x => escapeHtml(x.table + "." + x.from) + ' <span class="text-muted-2">→ ' + escapeHtml(x.to) + '</span>')));
  if(diff.columnsModified.length) sec.push(diffSection("Changed columns", "badge-medium", diff.columnsModified.map(x =>
        escapeHtml(x.table + "." + x.col) + ' <span class="text-muted-2">(' +
        x.changes.map(ch => escapeHtml(ch.attr + ": " + fmtVal(ch.from) + " → " + fmtVal(ch.to))).join(", ") + ')</span>')));
  if(diff.columnsRemoved.length)  sec.push(diffSection("Removed columns", "badge-low", diff.columnsRemoved.map(x => escapeHtml(x.table + "." + x.col.name))));
  panel.style.display = "";
  panel.innerHTML =
    '<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">' +
      '<div class="section-title mb-0"><i class="bi bi-clock-history"></i> Changes since last extract' + when + '</div>' +
      '<div class="d-flex align-items-center gap-2 flex-wrap">' + chips.join(" ") +
        '<button type="button" class="btn btn-sm btn-outline-soft" id="diffDismissBtn" title="Clear the change highlights"><i class="bi bi-check2 me-1"></i> Dismiss</button>' +
      '</div>' +
    '</div>' +
    '<div class="diff-details mt-2">' + sec.join("") + '</div>';
  const db = document.getElementById("diffDismissBtn");
  if(db) db.addEventListener("click", dismissTargetDiff);
}
function diffSection(title, badgeCls, items){
  if(!items.length) return "";
  return '<div class="diff-sec"><span class="badge-soft ' + badgeCls + ' diff-sec-label">' + title + ' (' + items.length + ')</span>' +
    '<ul class="diff-list">' + items.map(i => '<li class="mono">' + i + '</li>').join("") + '</ul></div>';
}
function fmtVal(v){ if(v == null || v === "") return "∅"; if(v === true) return "yes"; if(v === false) return "no"; return String(v); }

/* Re-baseline: set the snapshot to the current schema so the diff (and all
   highlights / ghosts) clears. The next re-extract diffs against this baseline. */
function dismissTargetDiff(){
  const conn = getTargetConnection(getActiveTargetId());
  if(!conn) return;
  const snap = snapshotEntities(conn.entities || []);
  snap.at = conn.loadedAt || new Date().toISOString();
  conn.prevExtract = snap;
  upsertTargetConnection(conn);
  activeDiff = null;
  renderActiveBrowser();
  showNotification("Change highlights cleared.", "primary", 1500);
}

function renderTargetTree(meta){
  const tree = document.getElementById("targetTree");
  const diff = activeDiff;
  let items = "";
  meta.entities.forEach(e => {
    const icon = e.isListTable ? "bi-list-ul" : "bi-diagram-2";
    const st = diff && diff.entityStatus[String(e.name).toLowerCase()];
    const cls = st === "added" ? " is-new" : st === "changed" ? " is-changed" : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
                : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    const chk = '<input type="checkbox" class="tt-check" data-check="' + escapeHtml(e.name) + '"' +
      (targetSelected.has(e.name) ? " checked" : "") + ' title="Select for AI fill" style="margin-right:6px;vertical-align:middle;">';
    items += '<li><div class="tree-node' + cls + '" data-entity="' + escapeHtml(e.name) + '" title="' + escapeHtml(e.name) + '">' + chk + '<i class="bi ' + icon + '"></i> <span class="tree-name">' + escapeHtml(e.name) + '</span>' + badge + '</div></li>';
  });
  // Ghost nodes for removed tables (visible even though they're gone from the schema).
  if(diff && diff.tablesRemoved.length){
    diff.tablesRemoved.forEach(t => {
      items += '<li><div class="tree-node is-removed" data-entity="' + escapeHtml(t.name) + '" data-ghost="1" title="Removed in last extract: ' + escapeHtml(t.name) + '"><i class="bi bi-diagram-2"></i> <span class="tree-name">' + escapeHtml(t.name) + '</span> <span class="badge-soft badge-low diff-badge">REMOVED</span></div></li>';
    });
  }
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-box"></i> ' + escapeHtml(meta.application || "Target Schema") + '</div>' +
      '<ul class="tree-children">' + items + '</ul>' +
    '</li>';
  document.querySelectorAll("[data-entity]").forEach(n => n.addEventListener("click", () => selectEntity(n.dataset.entity, n.dataset.ghost === "1")));
  // Checkboxes: toggle the selection set without triggering the node's select-entity click.
  tree.querySelectorAll(".tt-check").forEach(cb => {
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", () => {
      if(cb.checked) targetSelected.add(cb.dataset.check); else targetSelected.delete(cb.dataset.check);
      updateInferSelectedBtn();
    });
  });
  updateInferSelectedBtn();
}

/* Reflect the checked-table count on the "AI fill selected" button. */
function updateInferSelectedBtn(){
  const btn = document.getElementById("inferMetaBtn");
  if(!btn) return;
  const n = targetSelected.size;
  btn.innerHTML = '<i class="bi bi-stars me-1"></i> AI fill' + (n ? " (" + n + ")" : "");
}

/* Select-all / clear toggle for the tree checkboxes. */
function toggleSelectAllTables(){
  const meta = getTargetSchema();
  const all = (meta && meta.entities) ? meta.entities.map(e => e.name) : [];
  const allChecked = all.length && all.every(n => targetSelected.has(n));
  targetSelected = new Set(allChecked ? [] : all);
  document.querySelectorAll("#targetTree .tt-check").forEach(cb => { cb.checked = targetSelected.has(cb.dataset.check); });
  updateInferSelectedBtn();
}

function selectEntity(name, isGhost){
  const meta = getTargetSchema();
  if(isGhost){
    // A table removed in the last extract — synthesize a read-only ghost entity.
    const tl = String(name).toLowerCase();
    const removed = activeDiff && activeDiff.tablesRemoved.find(t => String(t.name).toLowerCase() === tl);
    activeEntity = { name: name, table: name, isListTable: false, fields: [], _ghost: true, _ghostCols: removed ? removed.cols : [] };
  } else {
    activeEntity = meta.entities.find(e => e.name === name);
    if(!activeEntity) return;
  }
  document.querySelectorAll("[data-entity]").forEach(n => n.classList.toggle("active", n.dataset.entity === name));
  document.getElementById("targetTitle").innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) +
    (activeEntity._ghost ? ' <span class="badge-soft badge-low">removed</span>'
                         : ' <span class="text-muted-2 text-xs">(' + escapeHtml(activeEntity.table || name) + ')</span>');
  const addBtn = document.getElementById("addColumnBtn");
  if(addBtn) addBtn.style.display = activeEntity._ghost ? "none" : "";   // no editing a removed table
  const delBtn = document.getElementById("deleteEntityBtn");
  if(delBtn) delBtn.style.display = activeEntity._ghost ? "none" : "";
  renderTargetFields();
}

function renderTargetFields(){
  if(!activeEntity) return;
  const search = (document.getElementById("targetSearch").value || "").toLowerCase();
  const body = document.getElementById("targetFieldsBody");
  const diff = activeDiff;
  const tl = String(activeEntity.name).toLowerCase();

  // Ghost entity (a removed table): show its former columns as read-only ghost rows.
  if(activeEntity._ghost){
    const cols = (activeEntity._ghostCols || []).filter(c => !search || c.name.toLowerCase().indexOf(search) !== -1);
    body.innerHTML = cols.length ? cols.map(c => ghostFieldRow(activeEntity.table || activeEntity.name, c)).join("")
      : '<tr><td colspan="13"><div class="empty-state"><i class="bi bi-trash"></i><h4>This table was removed in the last extract.</h4></div></td></tr>';
    return;
  }

  const fields = activeEntity.fields.filter(f => !search || f.name.toLowerCase().indexOf(search) !== -1);
  const removedCols = (diff && diff.removedByTable[tl]) ? diff.removedByTable[tl].filter(c => !search || c.name.toLowerCase().indexOf(search) !== -1) : [];
  if(!fields.length && !removedCols.length){
    body.innerHTML = '<tr><td colspan="13"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching fields</h4></div></td></tr>';
    return;
  }
  // Read-only display; a pencil (first column) opens the Edit Column modal to change
  // any property (the TABLE name stays fixed). NEW/CHANGED badges come from the diff.
  let rows = fields.map(f => {
    const st = diff && diff.columnStatus[tl + "::" + String(f.name).toLowerCase()];
    const cls = st === "added" ? "is-new" : (st === "changed" || st === "renamed") ? "is-changed" : "";
    const renamedFrom = st === "renamed" ? renameFrom(diff, tl, f.name) : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
                : st === "renamed" ? ' <span class="badge-soft badge-medium diff-badge">RENAMED</span>'
                : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    // Per-attribute changes → highlight the exact cell(s) and show "was <old>".
    const ch = (st === "changed") ? changeMap(diff, tl, f.name) : {};
    const hl = (attr) => ch[attr] ? ' cell-changed' : '';
    const was = (attr, fmt) => ch[attr] ? '<span class="was">was ' + escapeHtml(fmt(ch[attr].from)) + '</span>' : '';
    const fType = (v) => v || "∅";
    const fLen  = (v) => (v == null || v === "") ? "∅" : String(v);
    const fMand = (v) => v ? "Required" : "Optional";
    const fKey  = (v) => v ? "yes" : "no";
    // AI-populated cells (blue cue) — which attrs were auto-filled for this column.
    const ai = activeAiFields[tl + "::" + String(f.name).toLowerCase()] || {};
    const aiCls = (attr) => ai[attr] ? " cell-ai" : "";
    const aiBadge = Object.keys(ai).length ? ' <span class="badge-soft badge-ai diff-badge" title="Populated from the schema file / data dictionary — review">AI</span>' : '';
    return '<tr class="' + cls + (Object.keys(ai).length ? " is-ai" : "") + '" data-col="' + escapeHtml(f.name) + '">' +
      '<td class="cell-center"><button type="button" class="icon-btn ec-edit" data-edit="' + escapeHtml(f.name) + '" title="Edit column" style="width:30px;height:30px;"><i class="bi bi-pencil"></i></button></td>' +
      '<td class="mono">' + escapeHtml(activeEntity.table || "") + '</td>' +
      '<td class="mono' + (st === "renamed" ? " cell-changed" : "") + '">' + escapeHtml(f.name) + badge + aiBadge + (st === "renamed" && renamedFrom ? '<span class="was">was ' + escapeHtml(renamedFrom) + '</span>' : '') + '</td>' +
      '<td class="' + hl("dataType").trim() + '">' + escapeHtml(f.dataType || "") + was("dataType", fType) + '</td>' +
      '<td class="' + hl("length").trim() + '">' + (f.length ?? "-") + was("length", fLen) + '</td>' +
      '<td class="' + hl("mandatory").trim() + '">' + (f.mandatory ? '<span class="badge-soft badge-low">Required</span>' : '<span class="badge-soft badge-gray">Optional</span>') + was("mandatory", fMand) + '</td>' +
      '<td class="' + (hl("pk").trim() + aiCls("pk")).trim() + '">' + (f.pk ? '<i class="bi bi-key-fill text-warning" title="Primary Key"></i>' : "") + was("pk", fKey) + '</td>' +
      '<td class="' + ((hl("fk") || hl("fkReference")).trim() + aiCls("fk") + aiCls("fkReference")).trim() + '">' + (f.fk ? '<i class="bi bi-link-45deg text-primary" title="Foreign Key"></i>' + (f.fkReference ? ' <span class="text-xs mono">' + escapeHtml(f.fkReference) + '</span>' : "") : "") + was("fk", fKey) + was("fkReference", fType) + '</td>' +
      '<td class="' + aiCls("isListTable").trim() + '">' + (f.isListTable || activeEntity.isListTable ? '<span class="badge-soft badge-medium">List</span>' : '<span class="text-muted-2">-</span>') + '</td>' +
      '<td class="wrap' + aiCls("description") + '">' + escapeHtml(f.description || "") + '</td>' +
      '<td>' + escapeHtml(f.businessTerm || "-") + '</td>' +
      '<td class="wrap' + aiCls("accepted") + '">' + escapeHtml(f.accepted || "-") + '</td>' +
      '<td>' + escapeHtml(f.default ?? "-") + '</td>' +
    '</tr>';
  }).join("");
  // Ghost rows for columns removed since the last extract.
  rows += removedCols.map(c => ghostFieldRow(activeEntity.table || activeEntity.name, c)).join("");
  body.innerHTML = rows;
  // Wire the pencil buttons once (event delegation).
  if(!body._editWired){
    body.addEventListener("click", (e) => {
      const btn = e.target.closest(".ec-edit");
      if(btn) openEditColModal(btn.dataset.edit);
    });
    body._editWired = true;
  }
}

/* Map of {attr -> {attr, from, to}} for a modified column, to highlight the exact cells. */
function changeMap(diff, tl, name){
  const m = diff && (diff.columnsModified || []).find(x => x.table.toLowerCase() === tl && x.col.toLowerCase() === String(name).toLowerCase());
  const out = {};
  if(m) m.changes.forEach(ch => { out[ch.attr] = ch; });
  return out;
}
/* Old name for a renamed column (the current name is `name`). */
function renameFrom(diff, tl, name){
  const r = diff && (diff.columnsRenamed || []).find(x => x.table.toLowerCase() === tl && x.to.toLowerCase() === String(name).toLowerCase());
  return r ? r.from : "";
}

/* A greyed row for a column removed (red) or renamed-away (orange) in the last extract. */
function ghostFieldRow(table, c){
  const renamed = c._renamedTo;
  const rowCls = renamed ? "is-renamed" : "is-removed";
  const icon = renamed ? "bi-arrow-right" : "bi-trash";
  const badge = renamed ? '<span class="badge-soft badge-medium diff-badge">RENAMED → ' + escapeHtml(renamed) + '</span>'
                        : '<span class="badge-soft badge-low diff-badge">REMOVED</span>';
  return '<tr class="' + rowCls + '" title="' + (renamed ? 'Renamed to ' + escapeHtml(renamed) : 'Removed in last extract') + '">' +
    '<td class="cell-center"><i class="bi ' + icon + ' text-muted-2"></i></td>' +
    '<td class="mono">' + escapeHtml(table || "") + '</td>' +
    '<td class="mono">' + escapeHtml(c.name) + ' ' + badge + '</td>' +
    '<td>' + escapeHtml(c.dataType || "") + '</td>' +
    '<td>' + (c.length != null ? c.length : "-") + '</td>' +
    '<td>' + (c.mandatory ? '<span class="badge-soft badge-low">Required</span>' : '<span class="badge-soft badge-gray">Optional</span>') + '</td>' +
    '<td>' + (c.pk ? '<i class="bi bi-key-fill text-warning"></i>' : "") + '</td>' +
    '<td>' + (c.fk ? '<i class="bi bi-link-45deg text-primary"></i>' : "") + '</td>' +
    '<td><span class="text-muted-2">-</span></td>' +
    '<td class="wrap"></td>' +
    '<td>-</td>' +
    '<td class="wrap">-</td>' +
    '<td>-</td>' +
  '</tr>';
}

/* =========================================================================
   AI: infer target column metadata (PK / FK / List Table / Description) from the
   uploaded Product schema file (Schema File Explore -> aims_cmt_schema) + data
   dictionary. Keys/list are COPIED from the schema file (matched by name; AI only
   reconciles a non-exact name); descriptions come from the dictionary, else AI
   writes them. FILLS BLANKS ONLY and highlights every populated value for review.
   ========================================================================= */
function _aiNote(ok, msg){
  return '<div class="hint-note" style="background:var(--' + (ok ? "success" : "danger") + '-bg);color:var(--' +
    (ok ? "success" : "danger") + ');border-color:' + (ok ? "#bfe8cf" : "#f7c9c6") + ';"><i class="bi bi-' +
    (ok ? "check-circle" : "x-circle") + '"></i> ' + msg + '</div>';
}

const AI_MATCH_MIN_CONF = 0.9;   // "very high" — only apply a table match at/above this

function _normName(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

// Column-name affixes we strip for tolerant matching (after normalization).
const _COL_PREFIXES = ["cs", "cc", "pc", "bc", "pmt", "cmt", "ab", "am", "tbl", "t"];
function _baseName(s){
  let x = _normName(s);
  for(const p of _COL_PREFIXES){ if(x.length > p.length + 2 && x.startsWith(p)){ x = x.slice(p.length); break; } }
  if(x.length > 4 && x.endsWith("id")) x = x.slice(0, -2);   // trailing FK "…ID"
  return x;
}
// Typelist-name affixes (cctl_/pctl_/bctl_ …) stripped so a column's Type Key matches its typelist.
const _TL_PREFIXES = ["cctl", "pctl", "bctl", "cc", "pc", "bc"];
function _typelistBase(s){
  let x = _normName(s);
  for(const p of _TL_PREFIXES){ if(x.length > p.length + 2 && x.startsWith(p)){ x = x.slice(p.length); break; } }
  return x;
}
/* Build { typelistBase -> values[] } from the /api/lookups/snapshot sets. */
function _buildTypelistIndex(sets){
  const idx = {};
  (sets || []).forEach(s => { const k = _typelistBase(s.lookupName || ""); if(k && (s.values || []).length) idx[k] = s.values; });
  return idx;
}
function _lookupCodes(typelistIndex, typeKey){
  if(!typelistIndex || !typeKey) return null;
  return typelistIndex[_typelistBase(typeKey)] || null;
}
function _formatAccepted(codes){
  const parts = codes.slice(0, 15).map(v => v.code + (v.description && v.description !== v.code ? " = " + v.description : ""));
  return parts.join(", ") + (codes.length > 15 ? ", …(+" + (codes.length - 15) + " more)" : "");
}
/* Index a reference/dictionary column collection for exact + prefix/suffix-tolerant lookup. */
function _colIndex(names){
  const byNorm = {}, byBase = {};
  names.forEach(n => { byNorm[_normName(n)] = n; const b = _baseName(n); (byBase[b] = byBase[b] || []).push(n); });
  return { byNorm, byBase };
}
function _matchCol(idx, colName){
  const n = _normName(colName);
  if(idx.byNorm[n] !== undefined) return idx.byNorm[n];              // exact normalized
  const cand = idx.byBase[_baseName(colName)];                       // tolerant, unique only
  return (cand && cand.length === 1) ? cand[0] : null;
}

/* Copy pk/fk/list + Type Key + VERBATIM description + Accepted-Values typecodes from a
   matched schema-file entity onto a target entity (fill blanks only). Column names are
   matched exact-normalized, else prefix/suffix-tolerant (unique). Returns count filled. */
function _applyRefEntity(targetEntity, refEntity, aiFields, typelistIndex){
  const refByName = {};
  (refEntity.fields || []).forEach(f => { refByName[f.name] = f; });
  const idx = _colIndex(Object.keys(refByName));
  let filled = 0;
  const ekey = (targetEntity.name || targetEntity.table || "").toLowerCase();
  (targetEntity.fields || []).forEach(f => {
    const rn = _matchCol(idx, f.name);
    const r = rn != null ? refByName[rn] : null;
    if(!r) return;
    const key = ekey + "::" + String(f.name).toLowerCase();
    const mark = (attr) => { (aiFields[key] = aiFields[key] || {})[attr] = 1; };
    const isList = !!r.isListTable || !!((r.typeKey || "").trim());
    if(!f.pk && r.pk){ f.pk = true; mark("pk"); filled++; }
    if(!f.fk && r.fk){ f.fk = true; if(!f.fkReference && r.fkReference){ f.fkReference = r.fkReference; mark("fkReference"); } mark("fk"); filled++; }
    if(!f.isListTable && isList){ f.isListTable = true; mark("isListTable"); filled++; }
    if(!(f.typeKey || "").trim() && (r.typeKey || "").trim()) f.typeKey = r.typeKey;   // carry typelist name
    if(!(f.description || "").trim() && (r.description || "").trim()){ f.description = r.description; mark("description"); filled++; }
    // Accepted Values = the typelist's codes (via Type Key) — for the mapping AI.
    if(!(f.accepted || "").trim() && isList){
      const codes = _lookupCodes(typelistIndex, (r.typeKey || "").trim() || (f.typeKey || "").trim());
      if(codes && codes.length){ f.accepted = _formatAccepted(codes); mark("accepted"); filled++; }
    }
  });
  return filled;
}

/* Fill blank descriptions VERBATIM from a matched dictionary table
   (dictCols = { normColName: description }); tolerant column match. Returns count filled. */
function _applyDictDescriptions(targetEntity, dictCols, aiFields){
  const idx = _colIndex(Object.keys(dictCols));
  let filled = 0;
  const ekey = (targetEntity.name || targetEntity.table || "").toLowerCase();
  (targetEntity.fields || []).forEach(f => {
    if((f.description || "").trim()) return;              // don't overwrite
    const dn = _matchCol(idx, f.name);
    const d = dn != null ? dictCols[dn] : null;
    if(d && String(d).trim()){
      f.description = String(d);
      (aiFields[ekey + "::" + String(f.name).toLowerCase()] = aiFields[ekey + "::" + String(f.name).toLowerCase()] || {}).description = 1;
      filled++;
    }
  });
  return filled;
}

/* Resolve target tables -> candidate tables. Deterministic FIRST: exact-normalized,
   then unique prefix/suffix base match (cs_activity -> cc_activity). Only the tables
   that don't resolve deterministically are sent to the AI matcher. */
async function _resolveTableMatches(targetsSent, candidates){
  if(!candidates.length) return {};
  const baseIdx = {};
  candidates.forEach(c => { const b = _baseName(c); (baseIdx[b] = baseIdx[b] || []).push(c); });
  const out = {}, needAi = [];
  targetsSent.forEach(t => {
    const exact = candidates.find(c => _normName(c) === _normName(t));
    if(exact){ out[String(t).toLowerCase()] = {match: exact, confidence: 1}; return; }
    const cand = baseIdx[_baseName(t)];
    if(cand && cand.length === 1){ out[String(t).toLowerCase()] = {match: cand[0], confidence: 1}; return; }
    needAi.push(t);
  });
  if(needAi.length){
    try{
      const ai = await _matchTables(needAi, candidates);
      Object.keys(ai).forEach(k => { if(out[k] === undefined) out[k] = ai[k]; });
    }catch(e){ /* AI optional — deterministic matches still apply */ }
  }
  return out;
}

/* AI-match target tables to a candidate list (by meaning). Returns {targetLower -> match}. */
async function _matchTables(targetsSent, candidates){
  if(!candidates.length) return {};
  const res = await fetch("/api/ai/match-tables", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({targets: targetsSent, candidates: candidates})});
  const j = await res.json().catch(() => ({}));
  if(!res.ok || !j.ok) throw new Error((j && j.error) || "AI table matching failed.");
  const by = {}; (j.matches || []).forEach(m => { by[String(m.target).toLowerCase()] = m; });
  return by;
}

/* Core: for the given target entities, fill keys/list from the schema file and
   descriptions VERBATIM from the data dictionary — each matched to the target table
   by MEANING (high confidence only). Fills blanks only; highlights for review. */
async function inferFromDictionary(targetEntities, btn, btnLabel){
  const conn = getTargetConnection(getActiveTargetId());
  const entities = (conn && conn.entities) ? conn.entities : [];
  if(!entities.length){ showNotification("Load & activate a target first.", "warning"); return; }
  const ref = lsGet("aims_cmt_schema", null);                    // schema file -> keys/list (+ any desc)
  const dict = lsGet("aims_dict_descriptions", null);            // data dictionary -> descriptions
  const hasRef = !!(ref && ref.entities && ref.entities.length);
  const hasDict = !!(dict && Object.keys(dict).length);
  if(!hasRef && !hasDict){
    showNotification("Upload a schema file and/or a data-dictionary zip on Schema File Explore first.", "warning", 5000); return;
  }
  const box = document.getElementById("inferMetaResult");
  const targetsSent = targetEntities.map(e => e.table || e.name);

  // Candidate name lists for each source.
  const refByName = {}, refCandidates = [];
  if(hasRef) ref.entities.forEach(e => { const nm = e.table || e.name || ""; if(nm){ refCandidates.push(nm); refByName[nm.toLowerCase()] = e; } });
  const dictCandidates = hasDict ? Object.keys(dict) : [];
  const dictByName = {}; dictCandidates.forEach(nm => { dictByName[nm.toLowerCase()] = nm; });

  if(btn){ btn.disabled = true; btn.dataset._html = btn.innerHTML; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Matching…'; }
  try{
    // Typelist codes (for Accepted Values) come from the imported typelists.
    let typelistIndex = {};
    try{
      const sr = await fetch("/api/lookups/snapshot", {headers: {Accept: "application/json"}});
      if(sr.ok){ const sj = await sr.json().catch(() => ({})); if(sj && sj.ok) typelistIndex = _buildTypelistIndex(sj.sets); }
    }catch(e){ /* typecodes optional — proceed without */ }

    const [refMatch, dictMatch] = await Promise.all([_resolveTableMatches(targetsSent, refCandidates), _resolveTableMatches(targetsSent, dictCandidates)]);
    const aiFields = lsGet("aims_target_ai_fields", {}) || {};
    let matched = 0, filled = 0, descFilled = 0; const skipped = [];
    targetEntities.forEach(e => {
      const tk = String(e.table || e.name).toLowerCase();
      let hit = false;
      const rm = refMatch[tk];
      if(rm && rm.match && rm.confidence >= AI_MATCH_MIN_CONF){
        const refEntity = refByName[String(rm.match).toLowerCase()];
        if(refEntity){ filled += _applyRefEntity(e, refEntity, aiFields, typelistIndex); hit = true; }
      }
      const dm = dictMatch[tk];
      if(dm && dm.match && dm.confidence >= AI_MATCH_MIN_CONF && dict[dictByName[String(dm.match).toLowerCase()]]){
        const n = _applyDictDescriptions(e, dict[dictByName[String(dm.match).toLowerCase()]], aiFields);
        descFilled += n; filled += n; hit = true;
      }
      if(hit) matched++; else skipped.push(e.name);
    });

    upsertTargetConnection(conn); setActiveTarget(conn.id); lsSet("aims_target_ai_fields", aiFields);
    renderActiveBrowser();
    const msg = "Matched " + matched + " table" + (matched === 1 ? "" : "s") + ", filled " + filled + " value(s)" +
      (hasDict ? " (" + descFilled + " description(s) from the dictionary)" : "") + "." +
      (skipped.length ? " Skipped (low confidence): " + escapeHtml(skipped.join(", ")) + "." : "");
    if(box) box.innerHTML = _aiNote(matched > 0, msg);
    if(matched) showNotification("Filled " + filled + " value(s) — review the highlighted columns.", "success", 3500);
  }catch(e){ if(box) box.innerHTML = _aiNote(false, (e && e.message) || "Cannot reach the server."); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = btn.dataset._html || btnLabel; } }
}

/* Bar button — run for the TICKED tables only. */
function runInferSelected(){
  const conn = getTargetConnection(getActiveTargetId());
  const entities = (conn && conn.entities) ? conn.entities : [];
  const chosen = entities.filter(e => targetSelected.has(e.name));
  if(!chosen.length){ showNotification("Tick one or more tables in the Entities list first.", "warning"); return; }
  inferFromDictionary(chosen, document.getElementById("inferMetaBtn"));
}

/* (removed) per-table run — consolidated into the single checkbox-driven "AI fill selected". */
function _removed_runInferOpenTable(){
  if(!activeEntity || activeEntity._ghost){ showNotification("Open a table first.", "warning"); return; }
  inferFromDictionary([activeEntity], document.getElementById("inferTableBtn"));
}

function clearAiFields(){
  lsRemove("aims_target_ai_fields");
  activeAiFields = {};
  renderActiveBrowser();
  showNotification("AI highlights cleared.", "primary", 1400);
}

/* ---- Edit Column modal (all properties; table name stays read-only) ---- */
let ecModal = null;
let ecEditing = null;    // the column name currently being edited

function ecErr(msg){ const e = document.getElementById("ecError"); if(!e) return; if(msg){ e.innerHTML = failNote(msg); } else { e.innerHTML = ""; } }
function ecToggleLen(){
  const t = document.getElementById("ecType").value;
  document.getElementById("ecLenGroup").style.display = AC_LENGTH_TYPES.indexOf(t) !== -1 ? "" : "none";
}
function ecToggleFk(){ document.getElementById("ecFkGroup").style.display = document.getElementById("ecFk").checked ? "" : "none"; }

function openEditColModal(name){
  const field = (activeEntity.fields || []).find(f => f.name === name);
  if(!field){ showNotification("Column not found.", "danger"); return; }
  ecEditing = name;
  // Build the modal once.
  if(!document.getElementById("editColModal")) return;   // markup missing (page not updated)
  document.getElementById("ecType").innerHTML = AC_TYPES.map(t => '<option value="' + t + '">' + t + '</option>').join("");
  document.getElementById("ecTableName").textContent = activeEntity.table || activeEntity.name;
  document.getElementById("ecName").value = field.name || "";
  document.getElementById("ecType").value = (AC_TYPES.indexOf((field.dataType||"").toLowerCase()) !== -1) ? field.dataType.toLowerCase() : "varchar";
  document.getElementById("ecLen").value = (field.length != null ? field.length : "");
  document.getElementById("ecMandatory").value = field.mandatory ? "true" : "false";
  document.getElementById("ecPk").checked = !!field.pk;
  document.getElementById("ecFk").checked = !!field.fk;
  document.getElementById("ecList").checked = !!field.isListTable;
  document.getElementById("ecFkRef").value = field.fkReference || "";
  document.getElementById("ecDesc").value = field.description || "";
  document.getElementById("ecBT").value = field.businessTerm || "";
  document.getElementById("ecAcc").value = field.accepted || "";
  document.getElementById("ecDef").value = (field.default != null ? field.default : "");
  // FK-reference options from the whole schema
  const meta = getTargetSchema();
  const fkOpts = [];
  (meta.entities || []).forEach(e => (e.fields || []).forEach(f => fkOpts.push((e.table || e.name) + "." + f.name)));
  const dl = document.getElementById("ecFkRefList"); if(dl) dl.innerHTML = fkOpts.map(o => '<option value="' + escapeHtml(o) + '"></option>').join("");
  ecErr(null); ecToggleLen(); ecToggleFk();
  if(!ecModal) ecModal = new bootstrap.Modal(document.getElementById("editColModal"));
  ecModal.show();
  setTimeout(() => document.getElementById("ecName").focus(), 200);
}

function ecSave(){
  ecErr(null);
  const name = (document.getElementById("ecName").value || "").trim();
  const type = document.getElementById("ecType").value;
  const needsLen = AC_LENGTH_TYPES.indexOf(type) !== -1;
  const lenRaw = (document.getElementById("ecLen").value || "").trim();
  const fk = document.getElementById("ecFk").checked;
  const fkRef = (document.getElementById("ecFkRef").value || "").trim();

  if(!name){ ecErr("Column name is required."); return; }
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)){ ecErr("Use letters, numbers and underscores only (no spaces)."); return; }
  if((activeEntity.fields || []).some(f => f.name !== ecEditing && f.name.toLowerCase() === name.toLowerCase())){
    ecErr("A column named '" + name + "' already exists in this table."); return;
  }
  if(needsLen && lenRaw && !/^[1-9][0-9]*$/.test(lenRaw)){ ecErr("Length must be a positive integer."); return; }
  if(fk && !fkRef){ ecErr("Enter the referenced table.column, or untick Foreign Key."); return; }

  const patch = {
    name: name,
    dataType: type,
    length: needsLen && lenRaw ? parseInt(lenRaw, 10) : null,
    mandatory: document.getElementById("ecMandatory").value === "true",
    pk: document.getElementById("ecPk").checked,
    fk: fk,
    fkReference: fk ? fkRef : "",
    isListTable: document.getElementById("ecList").checked,
    description: (document.getElementById("ecDesc").value || "").trim(),
    businessTerm: (document.getElementById("ecBT").value || "").trim(),
    accepted: (document.getElementById("ecAcc").value || "").trim() || null,
    default: (document.getElementById("ecDef").value || "").trim() || null
  };
  const res = persistFieldEdit(ecEditing, patch);
  if(!res.ok){ ecErr(res.error || "Could not save the column."); return; }
  if(ecModal) ecModal.hide();
  renderActiveBrowser();
  selectEntity(activeEntity.name);
  flashRow(name);
  showNotification("Column '" + name + "' updated.", "success", 2500);
}

/* Delete the column currently open in the Edit Column modal (with confirmation). */
async function ecDelete(){
  if(!ecEditing){ return; }
  const name = ecEditing;
  const entity = activeEntity.name;
  const tableLabel = activeEntity.table || entity;
  if(ecModal) ecModal.hide();   // close the editor first to avoid a nested modal
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog('Delete column <strong>' + escapeHtml(name) + '</strong> from <strong>' +
        escapeHtml(tableLabel) + '</strong>? This removes it from the target schema.', "Delete column")
    : window.confirm("Delete column '" + name + "'?");
  if(!ok) return;
  removeColumn(entity, name);   // filters the field, updates count, persists, re-renders
  showNotification("Column '" + name + "' deleted.", "success", 2500);
}

/* Apply a full patch to a field on the active target connection and persist. */
function persistFieldEdit(oldName, patch){
  const activeId = getActiveTargetId();
  const conn = activeId ? getTargetConnection(activeId) : null;
  if(!conn || !conn.entities) return {ok:false, error:"No active target connection to modify."};
  const ent = conn.entities.find(e => e.name === activeEntity.name || e.table === activeEntity.name);
  if(!ent) return {ok:false, error:"Target table not found."};
  const field = (ent.fields || []).find(f => f.name === oldName);
  if(!field) return {ok:false, error:"Column '" + oldName + "' not found."};
  Object.assign(field, patch);
  conn.columnCount = (conn.entities || []).reduce((a,e) => a + (e.fields || []).length, 0);
  try{
    upsertTargetConnection(conn);
    if(getActiveTargetId() === conn.id) setActiveTarget(conn.id);   // re-materialize getTargetSchema()
  }catch(err){ return {ok:false, error:"Could not persist (storage full?): " + err.message}; }
  const meta = getTargetSchema();
  activeEntity = (meta.entities || []).find(e => e.name === activeEntity.name) || activeEntity;
  return {ok:true};
}

/* =========================================================================
   Add Column — append a new field (grid row) to the selected target table,
   manually or via a natural-language AI instruction. Persists to the ACTIVE
   target connection (localStorage) so it survives refresh and flows to the
   AI Generator / Workspace / Validation.
   ========================================================================= */
const AC_TYPES = ["varchar","nvarchar","char","text","int","bigint","smallint","tinyint",
  "decimal","numeric","money","float","bit","boolean","date","datetime","datetime2","time","uniqueidentifier"];
const AC_LENGTH_TYPES = ["varchar","nvarchar","char","decimal","numeric"];
let acModal = null;            // bootstrap.Modal instance
let acLastAdded = null;        // {entity, column} for Undo
let acProposedCols = [];       // AI-proposed columns (field shape) awaiting confirm

function wireAddColumn(){
  const openBtn = document.getElementById("addColumnBtn");
  if(openBtn) openBtn.addEventListener("click", openAddColumnModal);

  // type dropdown options
  const typeSel = document.getElementById("acType");
  if(typeSel) typeSel.innerHTML = AC_TYPES.map(t => '<option value="' + t + '">' + t + '</option>').join("");

  // tab toggle
  document.querySelectorAll("#acTabs [data-tab]").forEach(b => {
    b.addEventListener("click", () => acSwitchTab(b.dataset.tab));
  });
  const typeEl = document.getElementById("acType");
  if(typeEl) typeEl.addEventListener("change", acToggleLen);
  const fkEl = document.getElementById("acFk");
  if(fkEl) fkEl.addEventListener("change", acToggleFk);
  const nameEl = document.getElementById("acName");
  if(nameEl) nameEl.addEventListener("input", () => acClearErr("acName"));

  const parseBtn = document.getElementById("acParseBtn");
  if(parseBtn) parseBtn.addEventListener("click", acParse);
  const saveBtn = document.getElementById("acSaveBtn");
  if(saveBtn) saveBtn.addEventListener("click", acSave);
  // Enter in the manual form submits (not the AI textarea)
  const form = document.getElementById("acForm");
  if(form) form.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); acSave(); } });
}

function openAddColumnModal(){
  if(!activeEntity){ showNotification("Select a target table first.", "warning"); return; }
  const meta = getTargetSchema();
  // reset form
  document.getElementById("acForm").reset();
  document.getElementById("acType").value = "varchar";
  document.querySelectorAll(".acerr").forEach(e => e.textContent = "");
  document.getElementById("acAIError").innerHTML = "";
  document.getElementById("acAIStatus").textContent = "";
  document.getElementById("acInstruction").value = "";
  acProposedCols = [];
  acRenderProposed();
  document.getElementById("acTableName").textContent = activeEntity.name;

  // FK reference options: every table.column in the active schema
  const fkOpts = [];
  (meta.entities || []).forEach(e => (e.fields || []).forEach(f => fkOpts.push((e.table || e.name) + "." + f.name)));
  document.getElementById("acFkRefList").innerHTML = fkOpts.map(o => '<option value="' + escapeHtml(o) + '"></option>').join("");

  // Insert-position options: existing columns of THIS table
  document.getElementById("acAfter").innerHTML = '<option value="">At the end</option>' +
    (activeEntity.fields || []).map(f => '<option value="' + escapeHtml(f.name) + '">after ' + escapeHtml(f.name) + '</option>').join("");

  acSwitchTab("manual");
  acToggleLen();
  acToggleFk();

  if(!acModal) acModal = new bootstrap.Modal(document.getElementById("addColumnModal"));
  acModal.show();
  setTimeout(() => document.getElementById("acName").focus(), 200);
}

function acSwitchTab(tab){
  const ai = tab === "ai";
  document.getElementById("acAIPanel").style.display = ai ? "" : "none";
  // The single-column manual form is only for the Manual tab; hide it under AI
  // (AI mode uses the "Proposed columns" list instead).
  const form = document.getElementById("acForm");
  if(form) form.style.display = ai ? "none" : "";
  document.getElementById("acTabManual").classList.toggle("active", !ai);
  document.getElementById("acTabAI").classList.toggle("active", ai);
}

function acToggleLen(){
  const type = document.getElementById("acType").value;
  const needsLen = AC_LENGTH_TYPES.indexOf(type) !== -1;
  document.getElementById("acLenGroup").style.display = needsLen ? "" : "none";
}
function acToggleFk(){
  document.getElementById("acFkGroup").style.display = document.getElementById("acFk").checked ? "" : "none";
}

function acSetErr(field, msg){
  const el = document.querySelector('.acerr[data-for="' + field + '"]');
  if(el){ el.textContent = msg; el.style.color = "var(--danger)"; }
}
function acClearErr(field){ const el = document.querySelector('.acerr[data-for="' + field + '"]'); if(el) el.textContent = ""; }

/* ---- AI instruction -> prefill the form (preview/confirm) ---- */
async function acParse(){
  const instruction = (document.getElementById("acInstruction").value || "").trim();
  const status = document.getElementById("acAIStatus");
  const errBox = document.getElementById("acAIError");
  errBox.innerHTML = "";
  if(!instruction){ errBox.innerHTML = failNote("Type an instruction first."); return; }
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Parsing…';
  try{
    const payload = {
      instruction,
      tableName: activeEntity.name,
      existingColumns: (activeEntity.fields || []).map(f => ({name:f.name, dataType:f.dataType, pk:f.pk, fk:f.fk}))
    };
    const res = await fetch("/api/ai/parse-column", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    const data = await res.json();
    status.textContent = "";
    if(!data.ok){ errBox.innerHTML = failNote(data.error || "Could not parse the instruction."); return; }
    // The AI may propose ONE OR MORE columns; review them below before adding.
    const cols = (data.columns && data.columns.length) ? data.columns : (data.column ? [data.column] : []);
    if(!cols.length){ errBox.innerHTML = failNote("No columns were identified. Name the column(s) and their types, or use the Manual tab."); return; }
    if((data.confidence || 0) < 45){
      errBox.innerHTML = failNote("Not confident about that request" + (data.note ? ": " + data.note : ".") + " Review the columns below or rephrase.");
    }
    acProposedCols = cols.map(acColToField);
    acRenderProposed();
    acSwitchTab("ai");   // keep the AI tab visible with the proposed columns
    showNotification("AI proposed " + acProposedCols.length + " column(s) — review and click Add Column.", "primary", 2500);
  }catch(err){
    status.textContent = "";
    errBox.innerHTML = failNote("Backend not reachable. Start it with: cd server && python main.py");
  }
}

/* Convert a backend parse-column item (name is in `column`) to the UI field shape. */
function acColToField(c){
  const type = (AC_TYPES.indexOf((c.dataType||"").toLowerCase()) !== -1) ? c.dataType.toLowerCase() : "varchar";
  const needsLen = AC_LENGTH_TYPES.indexOf(type) !== -1;
  let length = null;
  if(needsLen) length = (c.length != null && c.length !== "") ? c.length : ((type==="decimal"||type==="numeric") ? 18 : 100);
  return {
    name: (c.column || "").trim(),
    dataType: type,
    length: length,
    mandatory: !!c.mandatory,
    pk: !!c.pk,
    fk: !!c.fk,
    fkReference: c.fk ? (c.fkReference || "") : "",
    description: c.description || "",
    businessTerm: "", accepted: null, default: null,
    _after: c.afterColumn || "",
    _dup: !!c.duplicate
  };
}

/* Render the proposed-columns preview (each removable). */
function acRenderProposed(){
  const box = document.getElementById("acColsPreview");
  const cnt = document.getElementById("acColsCount");
  if(cnt) cnt.textContent = acProposedCols.length
    ? ("(" + acProposedCols.length + " column" + (acProposedCols.length>1?"s":"") + ")") : "(none yet)";
  if(!box) return;
  if(!acProposedCols.length){ box.innerHTML = '<div class="text-xs text-muted-2">No columns proposed yet.</div>'; return; }
  box.innerHTML = acProposedCols.map((f, i) =>
    '<div class="d-flex align-items-center justify-content-between gap-2 py-1" style="border-bottom:1px solid var(--border);">' +
      '<span class="text-xs"><span class="mono">' + escapeHtml(f.name || "(unnamed)") + '</span> <span class="text-muted-2">' +
        escapeHtml(f.dataType + (f.length ? "(" + f.length + ")" : "")) +
        (f.pk ? " &middot; PK" : "") + (f.fk ? " &middot; FK" : "") + (f.mandatory ? " &middot; NOT NULL" : "") +
      '</span>' + (f._dup ? ' <span class="badge-soft badge-low">duplicate</span>' : '') + '</span>' +
      '<button type="button" class="btn btn-sm btn-outline-soft ac-col-rm" data-i="' + i + '" title="Remove column"><i class="bi bi-x"></i></button>' +
    '</div>'
  ).join("");
  box.querySelectorAll(".ac-col-rm").forEach(b => b.addEventListener("click", () => {
    acProposedCols.splice(parseInt(b.dataset.i, 10), 1);
    acRenderProposed();
  }));
}

/* ---- validate the manual/preview form ---- */
function acValidate(){
  document.querySelectorAll(".acerr").forEach(e => e.textContent = "");
  let ok = true;
  const name = (document.getElementById("acName").value || "").trim();
  const type = document.getElementById("acType").value;
  const needsLen = AC_LENGTH_TYPES.indexOf(type) !== -1;
  const lenRaw = (document.getElementById("acLen").value || "").trim();
  const fk = document.getElementById("acFk").checked;
  const fkRef = (document.getElementById("acFkRef").value || "").trim();

  if(!name){ acSetErr("acName", "Column name is required."); ok = false; }
  else if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)){ acSetErr("acName", "Use letters, numbers and underscores only (no spaces)."); ok = false; }
  else if((activeEntity.fields || []).some(f => f.name.toLowerCase() === name.toLowerCase())){ acSetErr("acName", "A column named '" + name + "' already exists in this table."); ok = false; }

  if(needsLen){
    if(!lenRaw){ acSetErr("acLen", "Length is required for " + type + "."); ok = false; }
    else if(!/^[1-9][0-9]*$/.test(lenRaw)){ acSetErr("acLen", "Length must be a positive integer."); ok = false; }
  }
  if(fk && !fkRef){ acSetErr("acFkRef", "Enter the referenced table.column."); ok = false; }
  else if(fk && fkRef){
    const meta = getTargetSchema();
    const exists = (meta.entities || []).some(e => (e.fields || []).some(f => ((e.table||e.name) + "." + f.name).toLowerCase() === fkRef.toLowerCase()));
    if(!exists) acSetErr("acFkRef", "Warning: '" + fkRef + "' isn't a known target table.column.");   // warn, not block
  }
  return ok;
}

/* ---- build field object from the form ---- */
function acFieldFromForm(){
  const type = document.getElementById("acType").value;
  const needsLen = AC_LENGTH_TYPES.indexOf(type) !== -1;
  const lenRaw = (document.getElementById("acLen").value || "").trim();
  const fk = document.getElementById("acFk").checked;
  return {
    name: (document.getElementById("acName").value || "").trim(),
    dataType: type,
    length: needsLen && lenRaw ? parseInt(lenRaw, 10) : null,
    mandatory: document.getElementById("acMandatory").value === "true",
    pk: document.getElementById("acPk").checked,
    fk: fk,
    fkReference: fk ? (document.getElementById("acFkRef").value || "").trim() : "",
    description: (document.getElementById("acDesc").value || "").trim(),
    businessTerm: "",
    accepted: null,
    default: null
  };
}

/* ---- save: persist to the active connection, refresh, highlight, undo ---- */
function acSave(){
  // AI tab with proposed columns -> add them all (multi-column). Manual tab -> single form.
  const aiMode = document.getElementById("acAIPanel").style.display !== "none";
  if(aiMode && acProposedCols.length){ acAddProposed(); return; }

  if(!acValidate()) return;
  const field = acFieldFromForm();
  const afterCol = document.getElementById("acAfter").value || "";

  // PK warning (allow composite, but confirm intent) — non-blocking.
  if(field.pk && (activeEntity.fields || []).some(f => f.pk)){
    // simple confirm; keep going if user accepts
    if(!window.confirm("This table already has a primary key. Add '" + field.name + "' as an additional PK (composite key)?")) return;
  }

  const res = persistColumn(activeEntity.name, field, afterCol);
  if(!res.ok){ showNotification(res.error || "Could not save the column.", "danger"); return; }

  if(acModal) acModal.hide();
  // refresh browser + counters, keep the same entity selected
  renderActiveBrowser();
  selectEntity(activeEntity.name);
  flashRow(field.name);
  acLastAdded = {entity: activeEntity.name, column: field.name};
  showColumnAddedToast(field.name, activeEntity.name);
}

/* Insert the field into the ACTIVE target connection's entity and re-persist. */
function persistColumn(entityName, field, afterCol){
  const activeId = getActiveTargetId();
  const conn = activeId ? getTargetConnection(activeId) : null;
  if(!conn || !conn.entities){ return {ok:false, error:"No active target connection to modify."}; }
  const ent = conn.entities.find(e => e.name === entityName || e.table === entityName);
  if(!ent){ return {ok:false, error:"Target table '" + entityName + "' was not found."}; }
  ent.fields = ent.fields || [];
  if(ent.fields.some(f => f.name.toLowerCase() === field.name.toLowerCase())){
    return {ok:false, error:"A column named '" + field.name + "' already exists."};
  }
  // insert after a given column, else append
  const at = afterCol ? ent.fields.findIndex(f => f.name === afterCol) : -1;
  if(at !== -1) ent.fields.splice(at + 1, 0, field); else ent.fields.push(field);

  conn.columnCount = (conn.entities || []).reduce((a,e) => a + (e.fields||[]).length, 0);
  conn.tableCount = (conn.entities || []).length;
  try{
    upsertTargetConnection(conn);
    if(getActiveTargetId() === conn.id) setActiveTarget(conn.id);   // re-materialize getTargetSchema()
  }catch(err){ return {ok:false, error:"Could not persist (storage full?): " + err.message}; }
  return {ok:true};
}

/* Remove a just-added column (Undo). */
function removeColumn(entityName, colName){
  const activeId = getActiveTargetId();
  const conn = activeId ? getTargetConnection(activeId) : null;
  if(!conn) return;
  const ent = (conn.entities || []).find(e => e.name === entityName || e.table === entityName);
  if(!ent) return;
  ent.fields = (ent.fields || []).filter(f => f.name !== colName);
  conn.columnCount = (conn.entities || []).reduce((a,e) => a + (e.fields||[]).length, 0);
  upsertTargetConnection(conn);
  if(getActiveTargetId() === conn.id) setActiveTarget(conn.id);
  renderActiveBrowser();
  selectEntity(entityName);
}

function flashRow(colName){
  const row = document.querySelector('#targetFieldsBody tr[data-col="' + (window.CSS && CSS.escape ? CSS.escape(colName) : colName) + '"]');
  if(row){ row.classList.add("row-flash"); row.scrollIntoView({behavior:"smooth", block:"center"}); setTimeout(() => row.classList.remove("row-flash"), 2200); }
}

/* success toast with an Undo action */
function showColumnAddedToast(colName, entityName){
  const stack = document.getElementById("toast-stack");
  if(!stack){ showNotification("Column '" + colName + "' added to " + entityName + ".", "success"); return; }
  const el = document.createElement("div");
  el.className = "toast-item success";
  el.innerHTML = '<div class="d-flex align-items-center justify-content-between gap-3">' +
    '<span><i class="bi bi-check-circle me-1"></i> Column <strong>' + escapeHtml(colName) + '</strong> added to ' + escapeHtml(entityName) + '.</span>' +
    '<button type="button" class="btn btn-sm btn-outline-soft acundo">Undo</button></div>';
  stack.appendChild(el);
  const remove = () => { if(el.parentNode) el.parentNode.removeChild(el); };
  el.querySelector(".acundo").addEventListener("click", () => {
    removeColumn(entityName, colName);
    remove();
    showNotification("Removed '" + colName + "'.", "primary", 1500);
  });
  setTimeout(remove, 7000);
}

/* Add ALL AI-proposed columns to the active entity (multi-column). Validates each,
   skips invalid/duplicate ones, and reports what was added vs skipped. */
function acAddProposed(){
  const entity = activeEntity.name;
  const errBox = document.getElementById("acAIError");
  const added = [], skipped = [];
  acProposedCols.forEach(f => {
    const nm = (f.name || "").trim();
    if(!nm || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)){ skipped.push((nm || "(unnamed)") + " — invalid name"); return; }
    const field = {
      name: nm, dataType: f.dataType, length: f.length, mandatory: !!f.mandatory,
      pk: !!f.pk, fk: !!f.fk, fkReference: f.fk ? (f.fkReference || "") : "",
      description: f.description || "", businessTerm: "", accepted: null, default: null
    };
    const after = (f._after && (activeEntity.fields || []).some(x => x.name === f._after)) ? f._after : "";
    const res = persistColumn(entity, field, after);
    if(res.ok) added.push(nm); else skipped.push(nm + " — " + (res.error || "not added"));
  });
  if(!added.length){ errBox.innerHTML = failNote("No columns added. " + (skipped.join("; ") || "")); return; }
  if(acModal) acModal.hide();
  renderActiveBrowser();
  selectEntity(entity);
  flashRow(added[0]);
  acLastAdded = {entity: entity, columns: added.slice()};
  if(added.length === 1) showColumnAddedToast(added[0], entity);
  else showColumnsAddedToast(added, entity);
  if(skipped.length) showNotification("Skipped " + skipped.length + " column(s): " + skipped.join("; "), "warning", 6000);
}

/* Success toast for a multi-column add, with an Undo-all action. */
function showColumnsAddedToast(cols, entityName){
  const stack = document.getElementById("toast-stack");
  if(!stack){ showNotification(cols.length + " columns added to " + entityName + ".", "success"); return; }
  const el = document.createElement("div");
  el.className = "toast-item success";
  el.innerHTML = '<div class="d-flex align-items-center justify-content-between gap-3">' +
    '<span><i class="bi bi-check-circle me-1"></i> <strong>' + cols.length + '</strong> columns added to ' + escapeHtml(entityName) + '.</span>' +
    '<button type="button" class="btn btn-sm btn-outline-soft acundo">Undo all</button></div>';
  stack.appendChild(el);
  const remove = () => { if(el.parentNode) el.parentNode.removeChild(el); };
  el.querySelector(".acundo").addEventListener("click", () => {
    cols.forEach(c => removeColumn(entityName, c));
    remove();
    showNotification("Removed " + cols.length + " columns.", "primary", 1500);
  });
  setTimeout(remove, 8000);
}

/* =========================================================================
   Add Entity (new target table) — manual or AI. Persists to the ACTIVE target
   connection's entities[] (mirrors Add Column, one level up). AI proposes the
   columns; you review/remove them before confirming.
   ========================================================================= */
let aeModal = null;
let aeProposedCols = [];   // proposed target fields for the new entity (from AI or empty)

function wireAddEntity(){
  const openBtn = document.getElementById("addEntityBtn");
  if(openBtn) openBtn.addEventListener("click", openAddEntityModal);
  document.querySelectorAll("#aeTabs [data-tab]").forEach(b => b.addEventListener("click", () => aeSwitchTab(b.dataset.tab)));
  const parseBtn = document.getElementById("aeParseBtn");
  if(parseBtn) parseBtn.addEventListener("click", aeParse);
  const saveBtn = document.getElementById("aeSaveBtn");
  if(saveBtn) saveBtn.addEventListener("click", aeSave);
  const nameEl = document.getElementById("aeName");
  if(nameEl) nameEl.addEventListener("input", () => aeClearErr("aeName"));
}

function openAddEntityModal(){
  if(!getActiveTargetId() || !hasTargetSchema()){ showNotification("Load or activate a target first.", "warning"); return; }
  document.getElementById("aeForm").reset();
  document.querySelectorAll(".aeerr").forEach(e => e.textContent = "");
  document.getElementById("aeAIError").innerHTML = "";
  document.getElementById("aeAIStatus").textContent = "";
  document.getElementById("aeInstruction").value = "";
  aeProposedCols = [];
  aeRenderCols();
  aeSwitchTab("manual");
  if(!aeModal) aeModal = new bootstrap.Modal(document.getElementById("addEntityModal"));
  aeModal.show();
  setTimeout(() => { const n = document.getElementById("aeName"); if(n) n.focus(); }, 200);
}

function aeSwitchTab(tab){
  const ai = tab === "ai";
  document.getElementById("aeAIPanel").style.display = ai ? "" : "none";
  document.getElementById("aeTabManual").classList.toggle("active", !ai);
  document.getElementById("aeTabAI").classList.toggle("active", ai);
}

function aeSetErr(field, msg){ const el = document.querySelector('.aeerr[data-for="' + field + '"]'); if(el){ el.textContent = msg; el.style.color = "var(--danger)"; } }
function aeClearErr(field){ const el = document.querySelector('.aeerr[data-for="' + field + '"]'); if(el) el.textContent = ""; }

/* Render the proposed-columns preview (each removable). */
function aeRenderCols(){
  const box = document.getElementById("aeColsPreview");
  const cnt = document.getElementById("aeColsCount");
  if(cnt) cnt.textContent = aeProposedCols.length ? ("(" + aeProposedCols.length + " column" + (aeProposedCols.length > 1 ? "s" : "") + ")") : "(none yet)";
  if(!box) return;
  if(!aeProposedCols.length){ box.innerHTML = '<div class="text-xs text-muted-2">No columns yet.</div>'; return; }
  box.innerHTML = aeProposedCols.map((f, i) =>
    '<div class="d-flex align-items-center justify-content-between gap-2 py-1" style="border-bottom:1px solid var(--border);">' +
      '<span class="text-xs"><span class="mono">' + escapeHtml(f.name) + '</span> <span class="text-muted-2">' +
        escapeHtml(f.dataType + (f.length ? "(" + f.length + ")" : "")) +
        (f.pk ? " &middot; PK" : "") + (f.fk ? " &middot; FK" : "") + (f.mandatory ? " &middot; NOT NULL" : "") +
      '</span></span>' +
      '<button type="button" class="btn btn-sm btn-outline-soft ae-col-rm" data-i="' + i + '" title="Remove column"><i class="bi bi-x"></i></button>' +
    '</div>'
  ).join("");
  box.querySelectorAll(".ae-col-rm").forEach(b => b.addEventListener("click", () => {
    aeProposedCols.splice(parseInt(b.dataset.i, 10), 1);
    aeRenderCols();
  }));
}

/* AI: describe a table -> prefill name/table/desc + propose columns for review. */
async function aeParse(){
  const instruction = (document.getElementById("aeInstruction").value || "").trim();
  const status = document.getElementById("aeAIStatus");
  const errBox = document.getElementById("aeAIError");
  errBox.innerHTML = "";
  if(!instruction){ errBox.innerHTML = failNote("Describe the table first."); return; }
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  try{
    const meta = getTargetSchema();
    const existingEntities = (meta.entities || []).map(e => e.name);
    const res = await fetch("/api/ai/parse-entity", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({instruction, existingEntities})});
    const data = await res.json();
    status.textContent = "";
    if(!data.ok){ errBox.innerHTML = failNote(data.error || "Could not parse the instruction."); return; }
    const en = data.entity;
    if((en.confidence || 0) < 45){
      errBox.innerHTML = failNote("Not confident about that request" + (en.note ? ": " + en.note : ".") + " Review/edit below or rephrase.");
    }
    document.getElementById("aeName").value = en.name || en.table || "";
    document.getElementById("aeDesc").value = en.description || "";
    aeProposedCols = (en.fields || []).slice();
    aeRenderCols();
    if(en.duplicate) aeSetErr("aeName", "An entity named '" + en.name + "' already exists.");
    aeSwitchTab("manual");   // show the pre-filled form + proposed columns to confirm
    showNotification("AI proposed " + aeProposedCols.length + " column(s) — review and click Add Entity.", "primary", 2500);
  }catch(err){
    status.textContent = "";
    errBox.innerHTML = failNote("Backend not reachable. Start it with: cd server && python main.py");
  }
}

function aeValidate(){
  document.querySelectorAll(".aeerr").forEach(e => e.textContent = "");
  let ok = true;
  const name = (document.getElementById("aeName").value || "").trim();
  const ents = (getTargetSchema() || {}).entities || [];
  if(!name){ aeSetErr("aeName", "Table name is required."); ok = false; }
  else if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)){ aeSetErr("aeName", "Use letters, numbers and underscores only (no spaces)."); ok = false; }
  // one value is both entity and table name -> reject if it clashes with either on any existing entity
  else if(ents.some(e => (e.name || "").toLowerCase() === name.toLowerCase() || ((e.table || e.name) || "").toLowerCase() === name.toLowerCase())){
    aeSetErr("aeName", "A table named '" + name + "' already exists."); ok = false;
  }
  return ok;
}

function aeEntityFromForm(){
  const name = (document.getElementById("aeName").value || "").trim();
  return {
    name: name,
    table: name,   // entity name and physical table name are the same
    description: (document.getElementById("aeDesc").value || "").trim(),
    isListTable: false,   // list/lookup flag is set only via dictionary upload, not here
    fields: aeProposedCols.slice()
  };
}

function aeSave(){
  if(!aeValidate()) return;
  const entity = aeEntityFromForm();
  const res = persistEntity(entity);
  if(!res.ok){ showNotification(res.error || "Could not add the entity.", "danger"); return; }
  if(aeModal) aeModal.hide();
  renderActiveBrowser();
  selectEntity(entity.name);   // renderActiveBrowser selects the first entity; re-select the new one
  showEntityAddedToast(entity.name, entity.fields.length);
}

/* Push the new entity into the ACTIVE target connection and re-materialise. */
function persistEntity(entity){
  const activeId = getActiveTargetId();
  const conn = activeId ? getTargetConnection(activeId) : null;
  if(!conn || !conn.entities){ return {ok:false, error:"No active target connection to modify."}; }
  const dup = conn.entities.some(e =>
    (e.name || "").toLowerCase() === entity.name.toLowerCase() ||
    ((e.table || e.name) || "").toLowerCase() === entity.table.toLowerCase());
  if(dup){ return {ok:false, error:"An entity/table named '" + entity.name + "' already exists."}; }
  conn.entities.push(entity);
  conn.columnCount = (conn.entities || []).reduce((a, e) => a + (e.fields || []).length, 0);
  conn.tableCount = (conn.entities || []).length;
  try{
    upsertTargetConnection(conn);
    if(getActiveTargetId() === conn.id) setActiveTarget(conn.id);   // re-materialise getTargetSchema()
  }catch(err){ return {ok:false, error:"Could not persist (storage full?): " + err.message}; }
  return {ok:true};
}

/* Remove a just-added entity (Undo). */
/* Delete the currently-selected entity (target table) with confirmation. */
async function deleteActiveEntity(){
  if(!activeEntity){ showNotification("Select a table first.", "warning"); return; }
  const name = activeEntity.name;
  const colCount = (activeEntity.fields || []).length;
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog('Delete table <strong>' + escapeHtml(name) + '</strong> and its <strong>' +
        colCount + '</strong> column' + (colCount === 1 ? '' : 's') +
        ' from the target schema? This cannot be undone.', "Delete table")
    : window.confirm("Delete table '" + name + "' and all its columns?");
  if(!ok) return;
  removeEntity(name);   // filters the entity, updates counts, persists, re-renders (selects first entity)
  showNotification("Table '" + name + "' deleted.", "success", 2500);
}

function removeEntity(name){
  const activeId = getActiveTargetId();
  const conn = activeId ? getTargetConnection(activeId) : null;
  if(!conn) return;
  conn.entities = (conn.entities || []).filter(e => e.name !== name);
  conn.columnCount = (conn.entities || []).reduce((a, e) => a + (e.fields || []).length, 0);
  conn.tableCount = (conn.entities || []).length;
  upsertTargetConnection(conn);
  if(getActiveTargetId() === conn.id) setActiveTarget(conn.id);
  renderActiveBrowser();
}

/* success toast with an Undo action */
function showEntityAddedToast(name, colCount){
  const stack = document.getElementById("toast-stack");
  const cols = colCount ? (" with " + colCount + " column" + (colCount > 1 ? "s" : "")) : " (no columns yet)";
  if(!stack){ showNotification("Entity '" + name + "' added" + cols + ".", "success"); return; }
  const el = document.createElement("div");
  el.className = "toast-item success";
  el.innerHTML = '<div class="d-flex align-items-center justify-content-between gap-3">' +
    '<span><i class="bi bi-check-circle me-1"></i> Entity <strong>' + escapeHtml(name) + '</strong> added' + escapeHtml(cols) + '.</span>' +
    '<button type="button" class="btn btn-sm btn-outline-soft aeundo">Undo</button></div>';
  stack.appendChild(el);
  const remove = () => { if(el.parentNode) el.parentNode.removeChild(el); };
  el.querySelector(".aeundo").addEventListener("click", () => {
    removeEntity(name);
    remove();
    showNotification("Removed '" + name + "'.", "primary", 1500);
  });
  setTimeout(remove, 7000);
}

/* ---- note helpers (match source-systems.js) ---- */
function okNote(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function failNote(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }
function infoNote(msg){ return '<div class="hint-note"><i class="bi bi-info-circle"></i> ' + msg + '</div>'; }
