/* =========================================================================
   metadata.js - Source Metadata Explorer
   Future API: GET /api/metadata/source?connectionId=
   ========================================================================= */

let sourceMeta = null;       // the view model (base + user edits overlaid)
let baseSourceMeta = null;   // the raw load result before overrides (for a clean Reset)
let activeTable = null;
let sourceMode = "sample";   // "sample" | "live" | "file"
let editMode = true;         // metadata is always editable inline (pencil modal + inline PK/FK)
let smSort = {key:null, dir:1, type:"str"};   // active column sort (Excel-like header sorting)
let smColsFrozen = false;                     // once true, table-layout is fixed & widths are explicit
// Sensible starting widths (px) so columns don't auto-stretch to content (FK kept compact but resizable).
const SM_DEFAULT_W = {name:160, dataType:95, length:55, nullable:60, pk:48, fkReference:150, default:110, businessTerm:150, sample:150, description:280};

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("metadata-explorer.html");

  document.getElementById("colSearch").addEventListener("input", debounce(renderColumns, 150));
  wireConnectPanel();
  wireTreeCollapse();
  enhanceColumnTable();

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
    '<tr><td colspan="11"><div class="empty-state">' +
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
    '<tr><td colspan="11"><div class="empty-state">' +
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
  const raw = await fetchJSON("source-metadata.json");
  if(raw){ _setSourceMeta(raw); sourceMode = "sample"; renderModeBadge(); renderTree(); if(sourceMeta.tables.length) selectTable(sourceMeta.tables[0].name); }
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

/* Collapse/expand the left Source-Database (tree) panel to give the column grid full
   width. State is a device-local UI pref (like the global sidebar), not per-client. */
function wireTreeCollapse(){
  const collapseBtn = document.getElementById("collapseTreeBtn");
  const showBtn = document.getElementById("showTreeBtn");
  if(collapseBtn) collapseBtn.addEventListener("click", () => setTreeCollapsed(true));
  if(showBtn) showBtn.addEventListener("click", () => setTreeCollapsed(false));
  setTreeCollapsed(lsGet("aims_meta_tree_collapsed", false) === true, true);   // restore, no re-save
}
function setTreeCollapsed(collapsed, skipSave){
  const row = document.getElementById("metadataRow");
  const showBtn = document.getElementById("showTreeBtn");
  if(row) row.classList.toggle("tree-collapsed", !!collapsed);
  if(showBtn) showBtn.style.display = collapsed ? "" : "none";
  if(!skipSave) lsSet("aims_meta_tree_collapsed", !!collapsed);
}

/* ---- Excel-like column headers: click to sort, drag the right edge to resize.
   Enhances the static thead once; sort re-renders the tbody, widths persist (device-local). */
function enhanceColumnTable(){
  const table = document.getElementById("columnTable");
  if(!table) return;
  table.querySelectorAll("thead th[data-sortkey]").forEach(th => {
    const key = th.dataset.sortkey;
    th.classList.add("sortable");
    // caret placeholder
    const caret = document.createElement("span"); caret.className = "sort-caret"; th.appendChild(caret);
    // sort on header click (ignore clicks that start on the resizer)
    th.addEventListener("click", (e) => {
      if(e.target.closest(".col-resizer")) return;
      const type = th.dataset.sorttype || "str";
      if(smSort.key === key){ smSort.dir = -smSort.dir; }
      else { smSort.key = key; smSort.dir = 1; smSort.type = type; }
      updateSortCarets();
      renderColumns();
    });
    // drag-to-resize handle
    const r = document.createElement("div"); r.className = "col-resizer";
    r.addEventListener("click", (e) => e.stopPropagation());
    r.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      smFreezeColumnWidths();                       // ensure table-layout:fixed so widths take effect
      const startX = e.pageX, startW = th.offsetWidth;
      document.body.classList.add("sm-col-resizing");
      const onMove = (ev) => { th.style.width = Math.max(44, startW + (ev.pageX - startX)) + "px"; };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("sm-col-resizing");
        const w = lsGet("aims_meta_col_widths", {}) || {};
        w[key] = th.offsetWidth; lsSet("aims_meta_col_widths", w);   // persist (device-local)
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    th.appendChild(r);
  });
  updateSortCarets();
}

/* Pin every column to an explicit width and switch the table to fixed layout so a
   dragged width actually sticks (auto layout otherwise redistributes and ignores it).
   Uses saved widths first, then compact defaults, then the measured width. */
function smFreezeColumnWidths(){
  const table = document.getElementById("columnTable");
  if(!table || smColsFrozen) return;
  const saved = lsGet("aims_meta_col_widths", {}) || {};
  table.querySelectorAll("thead th").forEach(th => {
    const key = th.dataset.sortkey;
    let w;
    if(key && saved[key]) w = saved[key];
    else if(key && SM_DEFAULT_W[key]) w = SM_DEFAULT_W[key];
    else w = th.offsetWidth || 44;                 // col-actions / fallback
    th.style.width = w + "px";
  });
  table.style.tableLayout = "fixed";
  table.style.width = "auto";
  table.style.minWidth = "0";                       // override the CSS min-width so widths are exact
  table.classList.add("sm-fixed");
  smColsFrozen = true;
}

// Sort the (already-filtered) columns by the active header, or return as-is when unsorted.
function smSortCols(cols){
  if(!smSort.key) return cols;
  const {key, type, dir} = smSort;
  const val = (c) => {
    if(type === "num"){ const n = c[key]; return (n == null || n === "") ? -Infinity : Number(n); }
    if(type === "bool"){ return c[key] ? 1 : 0; }
    return (c[key] == null ? "" : String(c[key])).toLowerCase();
  };
  return cols.slice().sort((a, b) => { const va = val(a), vb = val(b); return va < vb ? -dir : va > vb ? dir : 0; });
}

// Paint the ▲/▼ indicator on the active sort column, clear the rest.
function updateSortCarets(){
  const table = document.getElementById("columnTable");
  if(!table) return;
  table.querySelectorAll("thead th[data-sortkey] .sort-caret").forEach(el => {
    const th = el.closest("th");
    el.textContent = (th.dataset.sortkey === smSort.key) ? (smSort.dir === 1 ? " ▲" : " ▼") : "";
  });
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
    _setSourceMeta({connection: data.connection, schema: data.schema, tables: data.tables});
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
  _setSourceMeta({connection: conn.name, schema: conn.fileName || "file", tables: conn.tables});
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
  document.getElementById("tableTitle").innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) + ' <span class="text-muted-2 text-xs">(' + rc + ' rows)</span>';
  renderTableDesc();
  renderColumns();
}

function renderColumns(){
  if(!activeTable) return;
  const search = (document.getElementById("colSearch").value || "").toLowerCase();
  const cols = activeTable.columns.filter(c => !search || c.name.toLowerCase().indexOf(search) !== -1 || (c.businessTerm||"").toLowerCase().indexOf(search) !== -1);
  const body = document.getElementById("columnTableBody");
  if(!cols.length){
    body.innerHTML = '<tr><td colspan="11"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching columns</h4></div></td></tr>';
    return;
  }
  const ed = editMode;
  // Per-field provenance (set by applySourceMetaOverrides): green "Edited" for the
  // user, blue "Suggested" for convention-inferred PK/FK.
  // Match the Mapping Workspace convention: changed value shown as green TEXT (no box, no badge).
  const originCls = (c, f) => (c._edited && c._edited[f]) ? " cell-user-text" : "";
  const dash = (v) => v || (ed ? '<span class="text-muted-2">-</span>' : "-");

  body.innerHTML = smSortCols(cols).map(c => {
    const pkCell = c.pk ? '<i class="bi bi-key-fill text-warning"></i>' : (ed ? '<span class="text-muted-2">-</span>' : "");
    const fkCell = c.fk
      ? '<i class="bi bi-link-45deg text-primary"></i>' + (c.fkReference ? ' <span class="text-xs mono">' + escapeHtml(c.fkReference) + '</span>' : "")
      : (ed ? '<span class="text-muted-2">-</span>' : "");
    // A pencil in the leading action column opens the Edit-column modal (roomy editor for
    // description / business term). The column is shown only in edit mode (CSS .col-actions).
    const pencil = '<button type="button" class="icon-btn sm-edit-btn" data-smcol="' + escapeHtml(c.name) + '" title="Edit this column" aria-label="Edit column"><i class="bi bi-pencil"></i></button>';
    // Editable-cell attributes for PK / FK (inline).
    const edit = (f, base, title) => {
      const cls = (base + originCls(c, f) + (ed ? " sm-edit" : "")).trim();
      return 'class="' + cls + '"' + (ed ? ' data-smfield="' + f + '" data-smcol="' + escapeHtml(c.name) + '" title="' + title + '"' : "");
    };
    return '<tr>' +
      '<td class="col-actions cell-center">' + pencil + '</td>' +
      '<td class="mono">' + escapeHtml(c.name) + '</td>' +
      '<td>' + escapeHtml(c.dataType || "") + '</td>' +
      '<td>' + (c.length ?? "-") + '</td>' +
      '<td>' + (c.nullable ? "Yes" : "No") + '</td>' +
      '<td ' + edit("pk", "cell-center", "Click to set Primary Key") + '>' + pkCell + '</td>' +
      '<td ' + edit("fk", "", "Click to set FK (table.column; blank = none)") + '>' + fkCell + '</td>' +
      '<td>' + escapeHtml(c.default ?? "-") + '</td>' +
      '<td class="' + originCls(c, "businessTerm").trim() + '">' + dash(escapeHtml(c.businessTerm || "")) + '</td>' +
      '<td class="mono">' + escapeHtml(c.sample ?? "-") + '</td>' +
      '<td class="wrap' + originCls(c, "description") + '">' + escapeHtml(c.description || "") + '</td>' +
    '</tr>';
  }).join("");

  if(!smColsFrozen) smFreezeColumnWidths();   // pin widths on first real render so resizing works

  // Row pencil -> modal; inline PK/FK cell click -> in-cell editor (event-delegated, wired once).
  if(!body._smEditWired){
    body.addEventListener("click", (e) => {
      const btn = e.target.closest(".sm-edit-btn");
      if(btn){ openSourceColModal(btn.dataset.smcol); return; }
      if(!editMode) return;
      const cell = e.target.closest("td.sm-edit");
      if(cell && !cell.querySelector("input,select")) smMakeCellEditable(cell);
    });
    body._smEditWired = true;
  }
}

/* ===================== Source structure editing ===================== */
/* Edits (table/column descriptions, business terms, PK, FK) are stored as a
   non-destructive overlay (aims_source_meta_overrides, see common.js) keyed by
   connection id, applied over whatever base schema is loaded. Nothing mutates the
   live DB read; the same overlay feeds AI Mapping Generation downstream. */

// The connection whose edits we read/write. Real sources use their id; sample uses a sentinel.
function currentConnId(){ return editingConnId || "__sample__"; }

// Set the view model from a fresh load: keep the pristine base for a clean Reset, overlay edits.
function _setSourceMeta(raw){
  baseSourceMeta = raw;
  sourceMeta = applySourceMetaOverrides(raw, currentConnId());
}

// Re-overlay edits onto the pristine base and refresh the active-table reference.
function reapplyOverrides(){
  const name = activeTable && activeTable.name;
  sourceMeta = applySourceMetaOverrides(baseSourceMeta, currentConnId());
  if(name) activeTable = (sourceMeta.tables || []).find(t => t.name === name) || activeTable;
}

// Table description under the title — editable (click to edit) in edit mode, plain text otherwise.
function renderTableDesc(){
  const el = document.getElementById("tableDesc");
  if(!el) return;
  const d = (activeTable && activeTable.description) || "";
  if(!editMode || !activeTable){ el.textContent = d; return; }
  el.innerHTML = '<span class="sm-tabledesc' + (activeTable._descEdited ? ' cell-user-text' : '') + '" title="Click to edit table description" style="cursor:text;border-bottom:1px dashed var(--border-soft, #cbd2dc);">' +
    (escapeHtml(d) || '<span class="text-muted-2">click to add a table description…</span>') + '</span>';
  el.querySelector(".sm-tabledesc").addEventListener("click", () => {
    const inp = document.createElement("input"); inp.type = "text"; inp.className = "form-control form-control-sm";
    inp.value = d; el.innerHTML = ""; el.appendChild(inp); inp.focus();
    const commit = () => {
      const v = inp.value.trim();
      if(v !== d){
        saveSourceMetaTableOverride(currentConnId(), activeTable.name, {description: v});
        reapplyOverrides();
        activeTable._descEdited = true;
        showNotification("Table description saved.", "success", 1500);
      }
      renderTableDesc();
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => { if(e.key === "Enter") inp.blur(); if(e.key === "Escape") renderTableDesc(); });
  });
}

/* ---- Modal editor for one source column (like the Target System page). Table &
   column names are NOT editable; Type/Length/Nullable are shown read-only. ---- */
let smEcModal = null;          // bootstrap.Modal instance
let smEcColName = null;        // column currently open in the modal

function openSourceColModal(colName){
  const c = (activeTable && activeTable.columns || []).find(x => x.name === colName);
  if(!c) return;
  if(!document.getElementById("smEditModal")) return;   // markup missing (page not updated)
  smEcColName = colName;
  document.getElementById("smEcCol").textContent = c.name;
  document.getElementById("smEcTable").textContent = activeTable.name;
  document.getElementById("smEcName").value = c.name || "";
  document.getElementById("smEcType").value = (c.dataType || "") + (c.length != null ? "(" + c.length + ")" : "");
  document.getElementById("smEcPk").checked = !!c.pk;
  document.getElementById("smEcFk").checked = !!c.fk;
  document.getElementById("smEcFkRef").value = c.fkReference || "";
  document.getElementById("smEcBT").value = c.businessTerm || "";
  document.getElementById("smEcDesc").value = c.description || "";
  smEcToggleFkGroup();

  if(!smEcModal){
    smEcModal = new bootstrap.Modal(document.getElementById("smEditModal"));
    document.getElementById("smEcFk").addEventListener("change", smEcToggleFkGroup);
    document.getElementById("smEcSaveBtn").addEventListener("click", saveSourceColModal);
    attachAutocomplete(document.getElementById("smEcFkRef"), sourceFkSuggestions, {});   // suggestions from the source's tables
  }
  smEcModal.show();
  setTimeout(() => document.getElementById("smEcBT").focus(), 200);
}

function smEcToggleFkGroup(){
  const on = document.getElementById("smEcFk").checked;
  document.getElementById("smEcFkGroup").style.display = on ? "" : "none";
}

/* Inline in-cell editor for PK / FK (kept in the grid for quick edits; description &
   business term use the modal for space). Builds the editor, commits a patch. */
function smMakeCellEditable(cell){
  const field = cell.dataset.smfield;
  const colName = cell.dataset.smcol;
  const c = (activeTable && activeTable.columns || []).find(x => x.name === colName);
  if(!c) return;
  const commit = (patch) => smCommitCol(colName, patch);
  const cancel = () => renderColumns();
  // Let the editor overflow a narrow (fixed-width) column and float above neighbours.
  cell.classList.add("sm-editing-cell");

  if(field === "pk"){
    const sel = document.createElement("select"); sel.className = "form-select form-select-sm";
    sel.style.width = "88px";
    sel.innerHTML = '<option value="true"' + (c.pk ? " selected" : "") + '>PK</option>' +
                    '<option value="false"' + (!c.pk ? " selected" : "") + '>—</option>';
    cell.innerHTML = ""; cell.appendChild(sel); sel.focus();
    sel.addEventListener("change", () => commit({pk: sel.value === "true"}));
    sel.addEventListener("blur", cancel);
  } else if(field === "fk"){
    const inp = document.createElement("input"); inp.type = "text"; inp.className = "form-control form-control-sm mono";
    inp.placeholder = "table.column"; inp.value = c.fkReference || ""; inp.style.width = "280px";
    cell.innerHTML = ""; cell.appendChild(inp); inp.focus();
    attachAutocomplete(inp, sourceFkSuggestions, { onSelect: () => inp.blur() });   // suggestions from the source's tables
    inp.addEventListener("blur", () => { const v = inp.value.trim(); commit({fk: !!v, fkReference: v}); });
    inp.addEventListener("keydown", (e) => { if(e.key === "Enter") inp.blur(); if(e.key === "Escape") cancel(); });
  }
}

// Persist an inline PK/FK edit (only the changed fields), re-overlay, re-render.
function smCommitCol(colName, patch){
  const c = (activeTable && activeTable.columns || []).find(x => x.name === colName);
  if(!c) return;
  const norm = (v) => (v == null ? "" : (typeof v === "boolean" ? (v ? "1" : "0") : String(v)));
  const changed = Object.keys(patch).filter(k => norm(patch[k]) !== norm(c[k]));
  if(!changed.length){ renderColumns(); return; }   // no-op
  const by = {}; changed.forEach(k => { by[k] = "user"; });
  const stored = {_by: by}; changed.forEach(k => { stored[k] = patch[k]; });
  saveSourceMetaColOverride(currentConnId(), activeTable.name, colName, stored);
  reapplyOverrides();
  renderColumns();
  showNotification("Saved edit to " + activeTable.name + "." + colName + ".", "success", 1400);
}

// Persist the modal's edits as a single merged patch (marked user-authored), re-overlay, re-render.
function saveSourceColModal(){
  const colName = smEcColName;
  const c = (activeTable && activeTable.columns || []).find(x => x.name === colName);
  if(!c) return;
  const fk = document.getElementById("smEcFk").checked;
  const patch = {
    description: (document.getElementById("smEcDesc").value || "").trim(),
    businessTerm: (document.getElementById("smEcBT").value || "").trim(),
    pk: document.getElementById("smEcPk").checked,
    fk: fk,
    fkReference: fk ? (document.getElementById("smEcFkRef").value || "").trim() : ""
  };
  const norm = (v) => (v == null ? "" : (typeof v === "boolean" ? (v ? "1" : "0") : String(v)));
  const changed = Object.keys(patch).filter(k => norm(patch[k]) !== norm(c[k]));
  if(!changed.length){ if(smEcModal) smEcModal.hide(); return; }   // no-op
  const by = {}; changed.forEach(k => { by[k] = "user"; });
  // Only persist the fields that actually changed (keeps the overlay minimal & badges accurate).
  const stored = {_by: by}; changed.forEach(k => { stored[k] = patch[k]; });
  saveSourceMetaColOverride(currentConnId(), activeTable.name, colName, stored);
  reapplyOverrides();
  renderColumns();
  if(smEcModal) smEcModal.hide();
  showNotification("Saved edits to " + activeTable.name + "." + colName + ".", "success", 1600);
}

/* FK suggestions from the CURRENT source: each table, its table.<key>, and every
   table.column (de-duped) — the source-shaped analogue of the Target System picker. */
function sourceFkSuggestions(){
  const tables = (sourceMeta && sourceMeta.tables) || [];
  const opts = [];
  tables.forEach(t => {
    const cols = t.columns || [];
    const key = _smKeyCol(t);
    opts.push(t.name);
    if(key) opts.push(t.name + "." + key);
    cols.forEach(col => opts.push(t.name + "." + col.name));
  });
  const seen = {}, uniq = [];
  opts.forEach(o => { if(o && !seen[o]){ seen[o] = 1; uniq.push(o); } });
  return uniq;
}

// A table's key column for the FK picker: an existing PK, else "id", else the first *_ID column.
function _smKeyCol(t){
  const cols = (t && t.columns) || [];
  return (cols.find(c => c.pk) ||
          cols.find(c => (c.name || "").toLowerCase() === "id") ||
          cols.find(c => /id$/i.test(c.name || "")) || {}).name || null;
}

