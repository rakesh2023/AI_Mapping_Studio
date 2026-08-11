/* =========================================================================
   source-systems.js
   Source database connections. Shares one store with the Metadata Explorer
   (aims_db_connections via common.js). No hardcoded/seed connections:
   everything shown here is what the user has added. SQL Server connections
   are tested live against the local backend (server/app.py).
   ========================================================================= */

let editingId = null;
let extractedTables = null;   // File System: tables[] from the last AI extraction

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("source-systems.html");
  renderConnections();

  document.getElementById("addConnBtn").addEventListener("click", () => openForm(null));
  document.getElementById("cancelConnBtn").addEventListener("click", closeForm);
  document.getElementById("testConnBtn").addEventListener("click", testConnection);
  document.getElementById("connForm").addEventListener("submit", saveConnectionForm);
  document.getElementById("cType").addEventListener("change", toggleAuthFields);
  document.getElementById("extractFileBtn").addEventListener("click", extractSourceFile);
  const authSel = document.getElementById("cAuth");
  if(authSel) authSel.addEventListener("change", toggleAuthFields);
});

function isFileSystem(type){ return (type || "").toLowerCase() === "file system"; }

/* ---- helpers to map stored shape <-> form ---- */
function connToConfig(c){
  // shape used by the backend /api/db/* and Metadata Explorer
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
function isSqlServer(type){ return (type || "").toLowerCase().indexOf("sql server") !== -1; }

/* ---- render cards ---- */
function renderConnections(){
  const list = getDbConnections();
  const wrap = document.getElementById("connectionCards");
  if(!list.length){
    wrap.innerHTML = '<div class="col-12"><div class="empty-state"><i class="bi bi-database-x"></i>' +
      '<h4>No source systems configured yet.</h4>' +
      '<p class="text-xs text-muted-2">Add a source system to begin. SQL Server connections can be tested and explored live.</p>' +
      '<button class="btn btn-primary" onclick="document.getElementById(\'addConnBtn\').click()">Add Source System</button>' +
    '</div></div>';
    return;
  }
  wrap.innerHTML = list.map(c => {
    const type = c.type || "SQL Server";
    const file = isFileSystem(type);
    const statusClass = (c.status === "Connected" || c.status === "Loaded") ? "badge-high" : (c.status === "Failed" ? "badge-low" : "badge-gray");
    const tbl = (c.tableCount != null ? c.tableCount : (Array.isArray(c.tables) ? c.tables.length : "-"));

    // Line 1 + line 2 differ for file vs database sources.
    let line1, line2;
    if(file){
      line1 = '<i class="bi bi-file-earmark-text"></i> ' + escapeHtml(c.fileName || "uploaded file");
      line2 = '<i class="bi bi-table"></i> ' + tbl + ' tables &middot; ' + (c.columnCount != null ? c.columnCount : "-") + ' columns';
    } else {
      line1 = '<i class="bi bi-hdd-network"></i> ' + escapeHtml(c.server || c.host || "-");
      line2 = '<i class="bi bi-table"></i> ' + escapeHtml(c.database || c.db || "-") + ' &middot; ' + escapeHtml(c.schema || "-") + ' &middot; ' + tbl + ' tables';
    }

    // File sources have no live test; the first action is Extract-refresh via Edit.
    const testBtn = file
      ? '<button class="btn btn-sm btn-outline-soft flex-fill" onclick="editConn(\'' + c.id + '\')"><i class="bi bi-arrow-repeat"></i> Re-extract</button>'
      : '<button class="btn btn-sm btn-outline-soft flex-fill" onclick="quickTest(\'' + c.id + '\')"><i class="bi bi-broadcast"></i> Test</button>';

    return '<div class="col-md-4"><div class="card-el h-100">' +
      '<div class="d-flex justify-content-between align-items-start mb-2">' +
        '<div><h5 class="mb-0">' + escapeHtml(c.name) + '</h5><span class="text-muted-2 text-xs">' + escapeHtml(type) + '</span></div>' +
        '<span class="badge-soft ' + statusClass + '">' + (c.status || "Not Tested") + '</span>' +
      '</div>' +
      '<div class="text-xs text-muted-2 mb-2">' + line1 + '</div>' +
      '<div class="text-xs text-muted-2 mb-3">' + line2 + '</div>' +
      '<div class="d-flex gap-2 mb-2">' +
        testBtn +
        '<button class="btn btn-sm btn-primary flex-fill" onclick="exploreConn(\'' + c.id + '\')"><i class="bi bi-search"></i> Explore</button>' +
      '</div>' +
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
  extractedTables = null;
  const card = document.getElementById("connFormCard");
  const form = document.getElementById("connForm");
  form.reset();
  document.getElementById("testConnResult").innerHTML = "";
  document.getElementById("extractResult").innerHTML = "";
  document.getElementById("connFormTitle").innerHTML = id
    ? '<i class="bi bi-pencil-square"></i> Edit Connection'
    : '<i class="bi bi-plug"></i> Connection Details';

  if(id){
    const c = getDbConnection(id);
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
      // File System: carry the previously extracted tables so a save without
      // re-extracting keeps them.
      if(isFileSystem(c.type) && c.tables && c.tables.length){
        extractedTables = {fileName: c.fileName || "", tables: c.tables,
          tableCount: c.tableCount != null ? c.tableCount : c.tables.length,
          columnCount: c.columnCount != null ? c.columnCount : c.tables.reduce((a,t)=>a+(t.columns||[]).length,0)};
        document.getElementById("extractResult").innerHTML = infoNote("Using previously extracted schema: " +
          extractedTables.tableCount + " tables, " + extractedTables.columnCount + " columns" +
          (c.fileName ? " (" + escapeHtml(c.fileName) + ")" : "") + ". Upload a new file to replace it.");
      }
    }
  }
  toggleAuthFields();
  card.style.display = "block";
  card.scrollIntoView({behavior:"smooth", block:"center"});
}
function closeForm(){ document.getElementById("connFormCard").style.display = "none"; editingId = null; }

function toggleAuthFields(){
  const type = document.getElementById("cType").value;
  const sql = isSqlServer(type);
  const file = isFileSystem(type);
  // driver + live auth only relevant for SQL Server
  document.getElementById("driverGroup").style.display = sql ? "" : "none";
  const trusted = document.getElementById("cAuth").value === "trusted";
  document.getElementById("userGroup").style.display = (sql && !trusted) ? "" : "none";
  document.getElementById("passGroup").style.display = (sql && !trusted) ? "" : "none";
  document.getElementById("authGroup").style.display = sql ? "" : "none";
  // File System: hide the server/host + database fields, show the file uploader.
  document.getElementById("cHost").closest(".form-group").style.display = file ? "none" : "";
  document.getElementById("cDb").closest(".form-group").style.display = file ? "none" : "";
  document.getElementById("cSchema").closest(".form-group").style.display = file ? "none" : "";
  document.getElementById("fileGroup").style.display = file ? "" : "none";
  document.getElementById("testConnBtn").style.display = file ? "none" : "";
  document.getElementById("sqlHint").style.display = file ? "none" : "";
}

/* ---- File System: send the file to the backend for AI extraction ---- */
async function extractSourceFile(){
  const input = document.getElementById("cFile");
  const resultEl = document.getElementById("extractResult");
  const file = input.files && input.files[0];
  if(!file){ resultEl.innerHTML = failNote("Choose a file first."); return; }
  const btn = document.getElementById("extractFileBtn");
  if(btn) btn.disabled = true;
  resultEl.innerHTML = renderExtractProgress(0, 0, 0, 0, "Reading " + file.name + "…", "");
  try{
    const out = await streamExtractFile(file, (evt) => {
      if(evt.type === "start"){
        resultEl.innerHTML = renderExtractProgress(0, evt.chunks || 0, 0, 0, "Starting…", evt.unit || "parts");
      } else if(evt.type === "progress"){
        resultEl.innerHTML = renderExtractProgress(evt.done, evt.total, evt.tables, evt.columns, evt.label || "", "");
      }
    });
    extractedTables = {fileName: out.fileName || file.name, tables: out.tables,
      tableCount: out.tableCount, columnCount: out.columnCount};
    resultEl.innerHTML = okNote("Extracted " + out.tableCount + " tables, " + out.columnCount + " columns from " + escapeHtml(out.fileName || file.name) +
      (out.truncatedChunks ? " (file was large — capped at " + out.chunks + " parts)" : "") + ". Save the connection to keep it.");
    const nameEl = document.getElementById("cName");
    if(!nameEl.value.trim()) nameEl.value = (out.fileName || file.name).replace(/\.[^.]+$/, "");
  }catch(err){
    resultEl.innerHTML = failNote(err.message || "Extraction failed.");
  }finally{
    if(btn) btn.disabled = false;
  }
}

function readForm(){
  const type = document.getElementById("cType").value;
  const base = {
    name: document.getElementById("cName").value.trim() || "New Connection",
    type: type,
    driver: document.getElementById("cDriver").value,
    server: document.getElementById("cHost").value.trim(),
    database: document.getElementById("cDb").value.trim(),
    schema: document.getElementById("cSchema").value.trim() || null,
    trusted: document.getElementById("cAuth").value === "trusted",
    username: document.getElementById("cUser").value,
    password: document.getElementById("cPass").value
  };
  if(isFileSystem(type) && extractedTables){
    base.fileName = extractedTables.fileName || "";
    base.tables = extractedTables.tables;
    base.tableCount = extractedTables.tableCount;
    base.columnCount = extractedTables.columnCount;
    base.status = "Loaded";
  }
  return base;
}

function saveConnectionForm(e){
  e.preventDefault();
  const type = document.getElementById("cType").value;
  if(isFileSystem(type) && !(extractedTables && extractedTables.tables && extractedTables.tables.length)){
    document.getElementById("extractResult").innerHTML = failNote("Upload a file and click 'Extract with AI' before saving a File System source.");
    return;
  }
  const data = readForm();
  const existing = editingId ? getDbConnection(editingId) : null;
  const conn = Object.assign({}, existing || {}, data);
  if(!conn.id) conn.id = uid("CONN");
  if(!conn.status) conn.status = "Not Tested";
  upsertDbConnection(conn);
  renderConnections();
  closeForm();
  showNotification("Connection '" + conn.name + "' saved.", "success");
}

/* ---- real (or simulated) test ---- */
async function testConnection(){
  const data = readForm();
  const resultEl = document.getElementById("testConnResult");
  if(!data.server){
    resultEl.innerHTML = failNote("Server / host is required.");
    return;
  }
  if(!isSqlServer(data.type)){
    resultEl.innerHTML = infoNote("Live testing is available for SQL Server. '" + escapeHtml(data.type) + "' connections are saved without a live check in this prototype.");
    return;
  }
  resultEl.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span> Testing connection against ' + escapeHtml(data.server) + '...</div>';
  try{
    const res = await fetch("/api/db/test", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(connToConfig(data))});
    const out = await res.json();
    if(out.ok){
      resultEl.innerHTML = okNote("Connection successful. " + escapeHtml(out.version || ""));
      showNotification("Connection successful.", "success");
    } else {
      resultEl.innerHTML = failNote(out.error || "Connection failed.");
    }
  }catch(err){
    resultEl.innerHTML = failNote("Backend not reachable. Start it with python server/app.py.");
  }
}

async function quickTest(id){
  const c = getDbConnection(id);
  if(!c) return;
  if(!isSqlServer(c.type)){ showNotification("Live testing is only available for SQL Server connections.", "warning"); return; }
  showNotification("Testing '" + c.name + "'...", "primary", 1500);
  try{
    const res = await fetch("/api/db/test", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(connToConfig(c))});
    const out = await res.json();
    c.status = out.ok ? "Connected" : "Failed";
    upsertDbConnection(c);
    renderConnections();
    showNotification(out.ok ? ("'" + c.name + "' connected successfully.") : ("Connection failed: " + (out.error||"")), out.ok ? "success" : "danger");
  }catch(err){
    c.status = "Failed"; upsertDbConnection(c); renderConnections();
    showNotification("Backend not reachable. Start it with python server/app.py.", "danger");
  }
}

/* ---- explore: open Metadata Explorer already pointed at this connection ---- */
function exploreConn(id){
  const c = getDbConnection(id);
  if(!c) return;
  if(!isSqlServer(c.type) && !isFileSystem(c.type)){
    showNotification("Exploration is available for SQL Server and File System sources in this prototype.", "warning");
    return;
  }
  const href = "metadata-explorer.html?connect=" + encodeURIComponent(id);
  // Inside the persistent shell, navigate the shell frame; else normal navigation.
  try{
    if(window.self !== window.top && window.top.AIMS_SHELL && typeof window.top.aimsShellGoto === "function"){
      window.top.aimsShellGoto(href); return;
    }
  }catch(e){}
  window.location.href = href;
}

function editConn(id){ openForm(id); }
async function deleteConn(id){
  const c = getDbConnection(id);
  if(!c) return;
  const ok = await confirmDialog('Delete source system "' + escapeHtml(c.name) + '"?', "Delete");
  if(!ok) return;
  deleteDbConnection(id);
  renderConnections();
  showNotification("Connection deleted.", "primary");
}

/* ---- small note helpers ---- */
function okNote(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function failNote(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }
function infoNote(msg){ return '<div class="hint-note"><i class="bi bi-info-circle"></i> ' + msg + '</div>'; }
