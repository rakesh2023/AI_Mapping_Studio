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
    editingConnId = target.id;
    renderSavedConnections();
    await loadLiveObjects(target);   // pulls tables/columns live from the source system
  } else {
    // No source configured yet -> show a prompt (with sample as a fallback view).
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
      '<p class="text-xs text-muted-2">Add a source on the Source Systems page, then click <strong>Saved Sources</strong> above and Explore it to view its real tables and columns.</p>' +
      '<a class="btn btn-primary" href="source-systems.html"><i class="bi bi-database me-1"></i> Go to Source Systems</a>' +
      '<button class="btn btn-outline-soft ms-2" id="loadSampleBtn"><i class="bi bi-file-earmark me-1"></i> Load Sample Metadata</button>' +
    '</div></td></tr>';
  const sb = document.getElementById("loadSampleBtn");
  if(sb) sb.addEventListener("click", loadSampleMetadata);
}

/* Inline "processing" state shown while live metadata is being read (replaces the
   old load-time toasts). Cleared by renderModeBadge/renderTree on success, or by
   the error / no-connection states on failure. */
function renderLoadingState(name){
  const label = name ? escapeHtml(name) : "the source";
  const badge = document.getElementById("sourceModeBadge");
  if(badge) badge.innerHTML =
    '<span class="badge-soft badge-medium"><span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> Reading objects…</span>';
  const title = document.getElementById("sourceCardTitle");
  if(title) title.innerHTML = '<i class="bi bi-diagram-3"></i> ' + label;
  const tree = document.getElementById("sourceTree");
  if(tree) tree.innerHTML =
    '<li class="text-xs text-muted-2 d-flex align-items-center gap-2 p-2">' +
      '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
      '<span>Loading tables from ' + label + '…</span>' +
    '</li>';
  const body = document.getElementById("columnTableBody");
  if(body) body.innerHTML =
    '<tr><td colspan="12"><div class="empty-state">' +
      '<div class="spinner-border text-primary mb-2" role="status" aria-hidden="true"></div>' +
      '<h4>Reading objects from ' + label + '…</h4>' +
      '<p class="text-xs text-muted-2">Fetching tables and columns from the live database.</p>' +
    '</div></td></tr>';
}

/* After a failed/empty (re)load, undo the loading state: restore the previous view
   if we already had one, otherwise show the no-connection prompt. */
function restoreSourceView(){
  if(sourceMeta){
    renderModeBadge();
    renderTree();
    if(activeTable) selectTable(activeTable.name);
  } else {
    renderNoConnectionState();
  }
}

async function loadSampleMetadata(){
  sourceMeta = await fetchJSON("source-metadata.json");
  if(sourceMeta){ sourceMode = "sample"; renderModeBadge(); renderTree(); if(sourceMeta.tables.length) selectTable(sourceMeta.tables[0].name); }
}

/* ================= Live DB connection ================= */
/* Connections are shared with the Source Systems page via common.js
   (getDbConnections / saveDbConnections / upsertDbConnection / deleteDbConnection). */
let editingConnId = null;   // id of the source currently being explored (for highlight)

/* The Explorer no longer CREATES connections — that's done on Source Systems. Here we
   only list saved sources and let the user Connect (explore) one. */
function wireConnectPanel(){
  const panel = document.getElementById("connectPanel");
  document.getElementById("openConnectBtn").addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "" : "none";
  });
  renderSavedConnections();
}

function connectFromSaved(id){
  const c = getDbConnection(id);
  if(!c) return;
  editingConnId = id;
  renderSavedConnections();   // refresh the active highlight
  // File System sources have no live DB — render their AI-extracted tables directly.
  if((c.type || "").toLowerCase() === "file system"){
    loadFileObjects(c);
    showNotification("Exploring '" + c.name + "' (file source).", "primary", 1500);
    return;
  }
  loadLiveObjects(c);
}

function renderSavedConnections(){
  const el = document.getElementById("savedConnList");
  if(!el) return;
  const list = getDbConnections();
  if(!list.length){
    el.innerHTML = '<div class="text-xs text-muted-2">No saved sources yet. Add one on the ' +
      '<a href="source-systems.html">Source Systems</a> page, then return here to explore it.</div>';
    return;
  }
  el.innerHTML = list.map(c => {
    const file = (c.type || "").toLowerCase() === "file system";
    const detail = file
      ? ('<i class="bi bi-file-earmark-text"></i> ' + escapeHtml(c.fileName || "file") + ' &middot; ' +
         (c.tableCount != null ? c.tableCount : (Array.isArray(c.tables) ? c.tables.length : "-")) + ' tables')
      : (escapeHtml(c.server || c.host || "-") + ' &middot; ' + escapeHtml(c.database || c.db || "-") +
         (c.schema ? " &middot; " + escapeHtml(c.schema) : ""));
    return '<div class="saved-conn ' + (c.id===editingConnId?"editing":"") + '">' +
      '<div class="sc-info">' +
        '<div class="sc-name"><i class="bi ' + (file ? "bi-file-earmark-text" : "bi-hdd-network") + '"></i> ' + escapeHtml(c.name) +
          ' <span class="text-muted-2 text-xs">(' + escapeHtml(c.type || "SQL Server") + ')</span></div>' +
        '<div class="sc-detail mono">' + detail + '</div>' +
      '</div>' +
      '<div class="sc-actions">' +
        '<button class="btn btn-sm btn-primary" data-conn-connect="' + c.id + '"><i class="bi bi-search"></i> Explore</button>' +
      '</div>' +
    '</div>';
  }).join("");
  el.querySelectorAll("[data-conn-connect]").forEach(b => b.addEventListener("click", () => connectFromSaved(b.dataset.connConnect)));
}

// Explore a SQL Server source's tables/columns live. Takes the connection object.
async function loadLiveObjects(conn){
  const cfg = {
    driver: conn.driver || "ODBC Driver 17 for SQL Server",
    server: conn.server || conn.host || "",
    database: conn.database || conn.db || "",
    schema: conn.schema || null,
    trusted: !!conn.trusted,
    username: conn.username || "",
    password: conn.password || ""
  };
  if(!cfg.server || !cfg.database){
    showNotification("'" + conn.name + "' has no server/database to explore. Edit it on Source Systems.", "warning");
    if(!sourceMeta) renderNoConnectionState();
    return;
  }
  const pw = await ensureConnPassword(conn);
  if(pw === null) return;   // cancelled
  cfg.password = pw;
  renderLoadingState(conn.name || cfg.database);
  try{
    const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const data = await res.json();
    if(!data.ok){
      showNotification("Could not read metadata: " + (data.error||""), "danger");
      markConnStatus("Failed");
      restoreSourceView();
      return;
    }
    if(!data.tables.length){
      showNotification("No base tables found in " + (data.schema||"the database") + ".", "warning");
      restoreSourceView();
      return;
    }
    sourceMeta = {connection: data.connection, schema: data.schema, tables: data.tables};
    sourceMode = "live";
    renderModeBadge();
    renderTree();
    selectTable(sourceMeta.tables[0].name);
    // reflect live result back onto the saved connection (shared with Source Systems)
    const c = getDbConnection(conn.id);
    if(c){ c.status = "Connected"; c.tableCount = data.tableCount; c.columnCount = data.columnCount; c.schema = data.schema; upsertDbConnection(c); renderSavedConnections(); }
  }catch(err){
    showNotification("Backend not reachable. Start it with python server/app.py.", "danger");
    restoreSourceView();
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
    tableItems += '<li><div class="tree-node" data-table="' + escapeHtml(t.name) + '" title="' + escapeHtml(t.name) + '"><i class="bi bi-table"></i> <span class="tree-name">' + escapeHtml(t.name) + '</span></div></li>';
  });
  tree.innerHTML =
    '<li><div class="tree-node" title="' + escapeHtml(sourceMeta.connection || "") + '"><i class="bi bi-hdd-network"></i> <span class="tree-name">' + escapeHtml(sourceMeta.connection || "") + '</span></div>' +
      '<ul class="tree-children">' +
        '<li><div class="tree-node" title="' + escapeHtml(sourceMeta.schema || "") + '"><i class="bi bi-folder2"></i> <span class="tree-name">' + escapeHtml(sourceMeta.schema || "") + '</span></div>' +
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

