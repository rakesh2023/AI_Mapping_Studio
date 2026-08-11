/* =========================================================================
   metadata.js - Source Metadata Explorer
   Future API: GET /api/metadata/source?connectionId=
   ========================================================================= */

let sourceMeta = null;
let activeTable = null;
let sourceMode = "sample";   // "sample" | "live"

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("metadata-explorer.html");

  document.getElementById("colSearch").addEventListener("input", debounce(renderColumns, 150));
  document.getElementById("selAllCols").addEventListener("change", (e) => {
    document.querySelectorAll(".col-check").forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById("addScopeBtn").addEventListener("click", addSelectedToScope);
  wireConnectPanel();

  // Decide what to show: prefer a live source-system connection over sample data.
  const connectId = getQueryParam("connect");
  const conns = getDbConnections();
  // explicit ?connect=id, else a previously-Connected one, else the first saved.
  let target = connectId ? getDbConnection(connectId) : null;
  if(!target && conns.length){ target = conns.find(c => c.status === "Connected") || conns[0]; }

  if(target && (target.type || "").toLowerCase() === "file system"){
    // File System source: render its AI-extracted tables/columns (no live DB call).
    editingConnId = target.id;
    renderSavedConnections();
    loadFileObjects(target);
  } else if(target){
    document.getElementById("connectPanel").style.display = "";
    fillConnForm(target);
    editingConnId = target.id;
    renderSavedConnections();
    await loadLiveObjects();   // pulls tables/columns live from the source system
  } else {
    // No source system configured yet -> show a prompt (with sample as a fallback view).
    renderNoConnectionState();
  }
});

function renderNoConnectionState(){
  const badge = document.getElementById("sourceModeBadge");
  if(badge) badge.innerHTML = '<span class="badge-soft badge-medium"><i class="bi bi-exclamation-triangle"></i> No source system connected</span>';
  const tree = document.getElementById("sourceTree");
  if(tree) tree.innerHTML = '<li class="text-xs text-muted-2">No source database connected.</li>';
  const body = document.getElementById("columnTableBody");
  if(body) body.innerHTML =
    '<tr><td colspan="13"><div class="empty-state">' +
      '<i class="bi bi-database-add"></i>' +
      '<h4>No source system connected</h4>' +
      '<p class="text-xs text-muted-2">Add a source database on the Source Systems page (or click <strong>Connect to Database</strong> above) to explore its real tables and columns.</p>' +
      '<a class="btn btn-primary" href="source-systems.html"><i class="bi bi-database me-1"></i> Go to Source Systems</a>' +
      '<button class="btn btn-outline-soft ms-2" id="loadSampleBtn"><i class="bi bi-file-earmark me-1"></i> Load Sample Metadata</button>' +
    '</div></td></tr>';
  const sb = document.getElementById("loadSampleBtn");
  if(sb) sb.addEventListener("click", loadSampleMetadata);
}

async function loadSampleMetadata(){
  sourceMeta = await fetchJSON("source-metadata.json");
  if(sourceMeta){ sourceMode = "sample"; renderModeBadge(); renderTree(); if(sourceMeta.tables.length) selectTable(sourceMeta.tables[0].name); }
}

/* ================= Live DB connection ================= */
/* Connections are shared with the Source Systems page via common.js
   (getDbConnections / saveDbConnections / upsertDbConnection / deleteDbConnection). */
let editingConnId = null;   // id currently being edited, or null for "new"

function getConnections(){ return getDbConnections(); }
function saveConnections(list){ saveDbConnections(list); }

function wireConnectPanel(){
  const panel = document.getElementById("connectPanel");
  document.getElementById("openConnectBtn").addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "" : "none";
  });
  // Collapse / expand the New Connection form body via the header caret.
  document.getElementById("connFormToggle").addEventListener("click", () => {
    const collapsed = document.getElementById("connFormBody").style.display === "none";
    setConnFormCollapsed(!collapsed);
  });
  document.getElementById("dbAuth").addEventListener("change", (e) => {
    const trusted = e.target.value === "trusted";
    document.getElementById("dbUserGroup").style.display = trusted ? "none" : "";
    document.getElementById("dbPassGroup").style.display = trusted ? "none" : "";
  });
  document.getElementById("testConnBtn").addEventListener("click", testConnection);
  document.getElementById("saveConnBtn").addEventListener("click", () => { if(saveCurrentConnection()) showNotification("Connection saved.", "success"); });
  document.getElementById("loadObjectsBtn").addEventListener("click", loadLiveObjects);
  document.getElementById("cancelEditBtn").addEventListener("click", resetConnForm);
  renderSavedConnections();
}

function readConnConfig(){
  const auth = document.getElementById("dbAuth").value;
  return {
    name: document.getElementById("dbConnName").value.trim(),
    driver: document.getElementById("dbDriver").value,
    server: document.getElementById("dbServer").value.trim(),
    database: document.getElementById("dbName").value.trim(),
    schema: document.getElementById("dbSchema").value.trim() || null,
    trusted: auth === "trusted",
    username: document.getElementById("dbUser").value,
    password: document.getElementById("dbPass").value
  };
}

function fillConnForm(c){
  document.getElementById("dbConnName").value = c.name || "";
  document.getElementById("dbDriver").value = c.driver || "ODBC Driver 17 for SQL Server";
  document.getElementById("dbServer").value = c.server || "";
  document.getElementById("dbName").value = c.database || "";
  document.getElementById("dbSchema").value = c.schema || "";
  document.getElementById("dbAuth").value = c.trusted ? "trusted" : "sql";
  document.getElementById("dbUser").value = c.username || "";
  document.getElementById("dbPass").value = c.password || "";
  const trusted = !!c.trusted;
  document.getElementById("dbUserGroup").style.display = trusted ? "none" : "";
  document.getElementById("dbPassGroup").style.display = trusted ? "none" : "";
}

function resetConnForm(){
  editingConnId = null;
  fillConnForm({driver:"ODBC Driver 17 for SQL Server"});
  document.getElementById("connFormTitle").innerHTML = '<i class="bi bi-database-add"></i> New Connection';
  document.getElementById("cancelEditBtn").style.display = "none";
  document.getElementById("saveConnBtn").innerHTML = '<i class="bi bi-save me-1"></i> Save Connection';
  document.getElementById("loadObjectsBtn").innerHTML = '<i class="bi bi-box-arrow-in-down me-1"></i> Save &amp; Load Objects';
}

// Save the form as a new/updated connection. Returns the saved record or null.
// Merges onto any existing record so shared fields (type, status) are kept.
function saveCurrentConnection(){
  const cfg = readConnConfig();
  if(!cfg.name){ setConnStatus('<span class="badge-soft badge-medium">Enter a connection name to save.</span>'); return null; }
  if(!cfg.server || !cfg.database){ setConnStatus('<span class="badge-soft badge-medium">Server and database are required.</span>'); return null; }
  const list = getConnections();
  let idx = editingConnId ? list.findIndex(c => c.id === editingConnId) : -1;
  if(idx === -1) idx = list.findIndex(c => c.name.toLowerCase() === cfg.name.toLowerCase());
  let record;
  if(idx !== -1){ record = Object.assign({}, list[idx], cfg); record.id = list[idx].id; list[idx] = record; }
  else { record = Object.assign({type:"SQL Server", status:"Not Tested"}, cfg); record.id = uid("CONN"); list.push(record); }
  saveConnections(list);
  editingConnId = record.id;
  renderSavedConnections();
  return record;
}

function editConnection(id){
  const c = getConnections().find(x => x.id === id);
  if(!c) return;
  editingConnId = id;
  fillConnForm(c);
  document.getElementById("connFormTitle").innerHTML = '<i class="bi bi-pencil-square"></i> Edit Connection';
  document.getElementById("cancelEditBtn").style.display = "";
  document.getElementById("saveConnBtn").innerHTML = '<i class="bi bi-save me-1"></i> Update Connection';
  document.getElementById("loadObjectsBtn").innerHTML = '<i class="bi bi-box-arrow-in-down me-1"></i> Update &amp; Load Objects';
  document.getElementById("connStatus").innerHTML = "";
  setConnFormCollapsed(false);   // reveal the form when editing
  renderSavedConnections();
  document.getElementById("dbConnName").focus();
}

function setConnFormCollapsed(collapsed){
  const body = document.getElementById("connFormBody");
  const caret = document.querySelector("#connFormCaret i");
  if(body) body.style.display = collapsed ? "none" : "";
  if(caret) caret.className = collapsed ? "bi bi-chevron-down" : "bi bi-chevron-up";
}

async function deleteConnection(id){
  const c = getConnections().find(x => x.id === id);
  if(!c) return;
  const ok = await confirmDialog('Delete saved connection "' + escapeHtml(c.name) + '"?', "Delete");
  if(!ok) return;
  saveConnections(getConnections().filter(x => x.id !== id));
  if(editingConnId === id) resetConnForm();
  renderSavedConnections();
  showNotification("Connection deleted.", "primary");
}

function connectFromSaved(id){
  const c = getConnections().find(x => x.id === id);
  if(!c) return;
  editingConnId = id;
  // File System sources have no live DB — render their AI-extracted tables directly.
  if((c.type || "").toLowerCase() === "file system"){
    renderSavedConnections();   // refresh (in case selection styling changes)
    loadFileObjects(c);
    showNotification("Exploring '" + c.name + "' (file source).", "primary", 1500);
    return;
  }
  fillConnForm(c);
  loadLiveObjects();
}

function renderSavedConnections(){
  const el = document.getElementById("savedConnList");
  if(!el) return;
  const list = getConnections();
  if(!list.length){
    el.innerHTML = '<div class="text-xs text-muted-2">No saved connections yet. Fill in the form below and click <strong>Save Connection</strong>.</div>';
    return;
  }
  el.innerHTML = list.map(c =>
    '<div class="saved-conn ' + (c.id===editingConnId?"editing":"") + '">' +
      '<div class="sc-info">' +
        '<div class="sc-name"><i class="bi bi-hdd-network"></i> ' + escapeHtml(c.name) + '</div>' +
        '<div class="sc-detail mono">' + escapeHtml(c.server) + ' &middot; ' + escapeHtml(c.database) +
          (c.schema ? " &middot; " + escapeHtml(c.schema) : "") +
          ' &middot; ' + (c.trusted ? "Windows Auth" : "SQL Login") + '</div>' +
      '</div>' +
      '<div class="sc-actions">' +
        '<button class="btn btn-sm btn-primary" data-conn-connect="' + c.id + '"><i class="bi bi-plug"></i> Connect</button>' +
        '<button class="btn btn-sm btn-outline-soft" data-conn-edit="' + c.id + '" title="Edit"><i class="bi bi-pencil"></i></button>' +
        '<button class="btn btn-sm btn-outline-soft" data-conn-delete="' + c.id + '" title="Delete"><i class="bi bi-trash"></i></button>' +
      '</div>' +
    '</div>'
  ).join("");
  el.querySelectorAll("[data-conn-connect]").forEach(b => b.addEventListener("click", () => connectFromSaved(b.dataset.connConnect)));
  el.querySelectorAll("[data-conn-edit]").forEach(b => b.addEventListener("click", () => editConnection(b.dataset.connEdit)));
  el.querySelectorAll("[data-conn-delete]").forEach(b => b.addEventListener("click", () => deleteConnection(b.dataset.connDelete)));
}

function setConnStatus(html){ document.getElementById("connStatus").innerHTML = html; }

async function testConnection(){
  const cfg = readConnConfig();
  if(!cfg.server || !cfg.database){ setConnStatus('<span class="badge-soft badge-medium">Enter server and database first.</span>'); return; }
  setConnStatus('<span class="text-xs text-muted-2"><i class="bi bi-arrow-repeat"></i> Testing connection...</span>');
  try{
    const res = await fetch("/api/db/test", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const data = await res.json();
    if(data.ok){ setConnStatus('<span class="badge-soft badge-high"><i class="bi bi-check-circle-fill"></i> ' + escapeHtml(data.message) + '</span> <span class="text-xs text-muted-2">' + escapeHtml(data.version||"") + '</span>'); }
    else { setConnStatus('<span class="badge-soft badge-low"><i class="bi bi-x-circle-fill"></i> ' + escapeHtml(data.error||"Connection failed") + '</span>'); }
  }catch(err){
    setConnStatus('<span class="badge-soft badge-low"><i class="bi bi-plug"></i> Backend not reachable. Start it with <code>python server/app.py</code>.</span>');
  }
}

async function loadLiveObjects(){
  const cfg = readConnConfig();
  if(!cfg.server || !cfg.database){
    setConnStatus('<span class="badge-soft badge-medium">Enter server and database first.</span>');
    showNotification("This connection has no server/database to explore. For file sources, re-extract on Source Systems.", "warning");
    return;
  }
  // Persist the connection if it has a name, so it appears in Saved Connections.
  if(cfg.name){ saveCurrentConnection(); }
  setConnStatus('<span class="text-xs text-muted-2"><i class="bi bi-arrow-repeat"></i> Reading objects from database...</span>');
  try{
    const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const data = await res.json();
    if(!data.ok){
      setConnStatus('<span class="badge-soft badge-low"><i class="bi bi-x-circle-fill"></i> ' + escapeHtml(data.error||"Failed to read metadata") + '</span>');
      markConnStatus("Failed");
      if(!sourceMeta) renderNoConnectionState();
      return;
    }
    if(!data.tables.length){
      setConnStatus('<span class="badge-soft badge-medium">No base tables found in ' + escapeHtml(data.schema) + '.</span>');
      if(!sourceMeta) renderNoConnectionState();
      return;
    }
    sourceMeta = {connection: data.connection, schema: data.schema, tables: data.tables};
    sourceMode = "live";
    renderModeBadge();
    renderTree();
    selectTable(sourceMeta.tables[0].name);
    // reflect live result back onto the saved connection (shared with Source Systems)
    if(editingConnId){
      const c = getDbConnection(editingConnId);
      if(c){ c.status = "Connected"; c.tableCount = data.tableCount; c.columnCount = data.columnCount; c.schema = data.schema; upsertDbConnection(c); renderSavedConnections(); }
    }
    setConnStatus('<span class="badge-soft badge-high"><i class="bi bi-check-circle-fill"></i> Loaded ' + data.tableCount + ' tables, ' + data.columnCount + ' columns from live database.</span>');
    showNotification("Loaded " + data.tableCount + " tables from " + data.connection + " (live).", "success");
  }catch(err){
    setConnStatus('<span class="badge-soft badge-low"><i class="bi bi-plug"></i> Backend not reachable. Start it with <code>python server/app.py</code>, then reload.</span>');
    if(!sourceMeta) renderNoConnectionState();
  }
}

function markConnStatus(status){
  if(!editingConnId) return;
  const c = getDbConnection(editingConnId);
  if(c){ c.status = status; upsertDbConnection(c); renderSavedConnections(); }
}

/* Render a File System source's AI-extracted tables/columns (no backend call). */
function loadFileObjects(conn){
  if(!conn.tables || !conn.tables.length){
    renderNoConnectionState();
    showNotification("This File System source has no extracted schema yet. Re-extract it on Source Systems.", "warning");
    return;
  }
  sourceMeta = {connection: conn.name, schema: conn.fileName || "file", tables: conn.tables};
  sourceMode = "file";
  renderModeBadge();
  renderTree();
  selectTable(sourceMeta.tables[0].name);
}

function renderModeBadge(){
  const el = document.getElementById("sourceModeBadge");
  if(!el) return;
  if(sourceMode === "live") el.innerHTML = '<span class="badge-soft badge-high"><i class="bi bi-plug-fill"></i> Live database</span>';
  else if(sourceMode === "file") el.innerHTML = '<span class="badge-soft badge-high"><i class="bi bi-file-earmark-text"></i> File source (AI-extracted)</span>';
  else el.innerHTML = '<span class="badge-soft badge-gray"><i class="bi bi-file-earmark"></i> Sample metadata</span>';
  const title = document.getElementById("sourceCardTitle");
  if(title && sourceMeta) title.innerHTML = '<i class="bi bi-diagram-3"></i> ' + escapeHtml(sourceMeta.connection || "Source Database");
}

function renderTree(){
  const tree = document.getElementById("sourceTree");
  let tableItems = "";
  sourceMeta.tables.forEach(t => {
    tableItems += '<li><div class="tree-node" data-table="' + t.name + '"><i class="bi bi-table"></i> ' + t.name + '</div></li>';
  });
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-hdd-network"></i> ' + sourceMeta.connection + '</div>' +
      '<ul class="tree-children">' +
        '<li><div class="tree-node"><i class="bi bi-folder2"></i> ' + sourceMeta.schema + '</div>' +
          '<ul class="tree-children" id="tableList">' + tableItems + '</ul>' +
        '</li>' +
      '</ul>' +
    '</li>';
  document.querySelectorAll("[data-table]").forEach(node => {
    node.addEventListener("click", () => selectTable(node.dataset.table));
  });
}

function selectTable(name){
  activeTable = sourceMeta.tables.find(t => t.name === name);
  document.querySelectorAll("[data-table]").forEach(n => n.classList.toggle("active", n.dataset.table === name));
  const rc = (activeTable.rowCount != null ? Number(activeTable.rowCount).toLocaleString() : "?");
  document.getElementById("tableTitle").innerHTML = '<i class="bi bi-table"></i> ' + name + ' <span class="text-muted-2 text-xs">(' + rc + ' rows)</span>';
  document.getElementById("tableDesc").textContent = activeTable.description || "";
  renderColumns();
}

function renderColumns(){
  if(!activeTable) return;
  const search = (document.getElementById("colSearch").value || "").toLowerCase();
  const cols = activeTable.columns.filter(c => !search || c.name.toLowerCase().indexOf(search) !== -1 || (c.businessTerm||"").toLowerCase().indexOf(search) !== -1);
  const body = document.getElementById("columnTableBody");
  if(!cols.length){
    body.innerHTML = '<tr><td colspan="12"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching columns</h4></div></td></tr>';
    return;
  }
  body.innerHTML = cols.map(c =>
    '<tr>' +
      '<td><input type="checkbox" class="col-check" data-col="' + c.name + '"></td>' +
      '<td class="mono">' + c.name + '</td>' +
      '<td>' + c.dataType + '</td>' +
      '<td>' + (c.length ?? "-") + '</td>' +
      '<td>' + (c.nullable ? "Yes" : "No") + '</td>' +
      '<td>' + (c.pk ? '<i class="bi bi-key-fill text-warning"></i>' : "") + '</td>' +
      '<td>' + (c.fk ? '<i class="bi bi-link-45deg text-primary"></i>' : "") + '</td>' +
      '<td>' + (c.default ?? "-") + '</td>' +
      '<td>' + (c.businessTerm || "-") + '</td>' +
      '<td class="mono">' + escapeHtml(c.sample ?? "-") + '</td>' +
      '<td>' + (c.distinctCount != null ? c.distinctCount.toLocaleString() : "-") + '</td>' +
      '<td>' + (c.nullPct ?? 0) + '%</td>' +
      '<td class="wrap">' + escapeHtml(c.description || "") + '</td>' +
    '</tr>'
  ).join("");
}

function addSelectedToScope(){
  const checked = Array.from(document.querySelectorAll(".col-check:checked")).map(cb => cb.dataset.col);
  if(!checked.length){ showNotification("Select at least one column to add to mapping scope.", "warning"); return; }
  const scope = lsGet(LS_KEYS.scope, {});
  const existing = scope[activeTable.name] || [];
  scope[activeTable.name] = Array.from(new Set(existing.concat(checked)));
  lsSet(LS_KEYS.scope, scope);
  showNotification(checked.length + " column(s) from " + activeTable.name + " added to mapping scope.", "success");
}
