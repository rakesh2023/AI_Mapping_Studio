/* =========================================================================
   mapping-workspace.js - Review the AI-generated mapping document.
   Left panel lists each target table that has mappings; selecting a table
   shows its field-level mapping grid (inline edit, approve/reject, drawer).
   Mappings come from the AI Mapping Generator (localStorage aims_ai_mappings),
   falling back to the bundled sample mappings.json when none exist.
   ========================================================================= */

const COLUMNS = [
  {key:"id", label:"Mapping ID"},
  {key:"targetTable", label:"Target Table"},
  {key:"targetColumn", label:"Target Column", editable:true},
  {key:"sourceTable", label:"Source Table"},
  {key:"sourceColumn", label:"Source Column"},
  {key:"sampleSourceValue", label:"Sample Value"},
  {key:"mappingType", label:"Mapping Type", editable:true, type:"select", options:["Direct","Derived","Lookup","Conditional","Constant","Default","Concatenation","Split","Format Conversion","Data Type Conversion","Calculation","Aggregation","Reference","Custom","Not Mapped"]},
  {key:"transformationRule", label:"Transformation Rule", editable:true, wrap:true},
  {key:"businessRule", label:"Business Rule", editable:true, wrap:true},
  {key:"defaultValue", label:"Default Value", editable:true},
  {key:"lookupTable", label:"Lookup Table", editable:true, wrap:true},
  {key:"nullHandling", label:"Null Handling", editable:true, wrap:true},
  {key:"confidence", label:"AI Confidence"},
  {key:"aiExplanation", label:"AI Explanation"},
  {key:"validationStatus", label:"Validation Status"},
  {key:"reviewStatus", label:"Review Status"},
  {key:"actions", label:"Actions"}
];

// Frozen (sticky) left columns -> class carries the cumulative left offset.
// fz0 = checkbox, then Mapping ID / Target Table / Target Column stay pinned
// while the rest of the grid scrolls horizontally.
const FREEZE = {
  id: "fz1",
  targetTable: "fz2",
  targetColumn: "fz3"
};
// Columns the user has hidden (persisted). Frozen columns can't be hidden.
const ALWAYS_ON = ["id","targetTable","targetColumn","actions"];
let hiddenColumns = new Set(lsGet("aims_ws_hidden_cols", []) || []);

const LS_WS_SET = "aims_workspace_set";  // remembers the last chosen mapping set (targetSystem key)

let targetMeta = null;
let allMappings = [];           // every generated mapping (with overrides applied)
let sourceSchemaCols = [];      // FULL source schema [{table,column,dataType}] for regenerate
let activeEntity = null;        // currently-selected target table (entity name)
let tableListFilter = "";
let joinConditions = {};        // entityName -> AI-identified join SQL (editable)

let state = {
  activeSet: null,              // currently-selected mapping set (a targetSystem name)
  all: [],                      // rows for the active table
  filtered: [],
  search: "",
  filters: {sourceTable:"", targetEntity:"", mappingType:"", confidence:"", reviewStatus:""},
  reviewOnly: false,
  sortKey: null,
  sortDir: 1,
  page: 1,
  pageSize: 25,
  selected: new Set()
};

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("mapping-workspace.html");
  targetMeta = getTargetSchema();

  // Use the AI-generated document if it exists (even when explicitly emptied via
  // Clear All — an empty array means "cleared", NOT "load the sample"). Only when the
  // key was never set (null) do we fall back to the bundled sample document.
  const aiRows = lsGet("aims_ai_mappings", null);
  allMappings = (aiRows !== null) ? applyOverrides(aiRows)
                                  : applyOverrides(await fetchJSON("mappings.json") || []);
  joinConditions = lsGet("aims_ai_joins", {}) || {};

  if(!allMappings.length){
    document.getElementById("emptyState").style.display = "";
    document.getElementById("reviewLayout").style.display = "none";
    return;
  }
  document.getElementById("emptyState").style.display = "none";
  document.getElementById("reviewLayout").style.display = "";

  // Load the full source schema in the background so "Regenerate" can search ALL
  // source columns (not just ones already mapped). Non-blocking.
  loadSourceSchema();

  buildHeader();
  wireGridControls();
  document.getElementById("tableListSearch").addEventListener("input", debounce((e) => {
    tableListFilter = (e.target.value||"").toLowerCase().trim(); renderTableList();
  }, 150));
  // persist manual edits to the join condition for the active table
  document.getElementById("joinCondition").addEventListener("input", debounce((e) => {
    if(!activeEntity) return;
    joinConditions[activeEntity] = e.target.value;
    lsSet("aims_ai_joins", joinConditions);
  }, 200));

  // Determine the mapping sets (hops) and pick the active one: the remembered set if it
  // still exists, otherwise the most-recently-generated set.
  const sets = mappingSets();
  const remembered = lsGet(LS_WS_SET, null);
  state.activeSet = (remembered && sets.some(s => s.key === remembered)) ? remembered
                  : (sets[0] ? sets[0].key : null);
  renderSetSelector();

  renderTableList();
  // auto-select the first table in the active set
  const first = entityGroups()[0];
  if(first) selectEntity(first.name);
});

/* ---------- mapping sets (Source -> Target hops) ---------- */
// A "set" is one migration hop, anchored on targetSystem (always present). Rows belong to a
// set purely by their targetSystem, so unmapped rows (blank sourceSystem) stay with their hop.
function mappingSets(){
  const map = {};
  allMappings.forEach(m => {
    const key = m.targetSystem || "(unknown target)";
    const s = (map[key] = map[key] || {key, sources:new Set(), count:0, lastUpdated:""});
    s.count++;
    if(m.sourceSystem) s.sources.add(m.sourceSystem);
    if(m.lastUpdated && m.lastUpdated > s.lastUpdated) s.lastUpdated = m.lastUpdated;
  });
  // Label with the real saved connection names (resolve the stored strings), keeping the
  // raw targetSystem as the set key so membership filtering (scoped()) still matches rows.
  const resolveName = (n) => { const c = findConnByName(n); return (c && c.name) || n; };
  return Object.values(map).map(s => {
    const srcLabel = s.sources.size
      ? Array.from(s.sources).map(resolveName).join(", ")
      : "(unmapped)";
    const tgtLabel = resolveName(s.key);
    return {key:s.key, label: srcLabel + " → " + tgtLabel, count:s.count, lastUpdated:s.lastUpdated};
  }).sort((a,b) => (b.lastUpdated||"").localeCompare(a.lastUpdated||""));
}

// Rows in the currently-selected set.
function scoped(){
  return allMappings.filter(m => (m.targetSystem || "(unknown target)") === state.activeSet);
}

function renderSetSelector(){
  const bar = document.getElementById("setBar");
  const sel = document.getElementById("mappingSetSelect");
  const count = document.getElementById("setCount");
  if(!bar || !sel) return;
  const sets = mappingSets();
  if(!sets.length){ bar.style.display = "none"; return; }
  bar.style.display = "";
  sel.innerHTML = sets.map(s =>
    '<option value="' + escapeHtml(s.key) + '"' + (s.key===state.activeSet?" selected":"") + '>' +
      escapeHtml(s.label) + '</option>').join("");
  const active = sets.find(s => s.key === state.activeSet);
  if(count) count.textContent = active ? "· " + active.count + " mapping" + (active.count===1?"":"s") : "";
  sel.onchange = () => {
    state.activeSet = sel.value;
    lsSet(LS_WS_SET, state.activeSet);
    activeEntity = null;
    tableListFilter = "";
    const tls = document.getElementById("tableListSearch"); if(tls) tls.value = "";
    renderSetSelector();       // refresh the count for the new set
    renderTableList();
    const first = entityGroups()[0];
    if(first) selectEntity(first.name);
    else { state.all = []; state.filtered = []; renderTable && renderTable(); }
  };
}

/* ---------- target-table list ---------- */
function entityGroups(){
  const map = {};
  scoped().forEach(m => {
    const k = m.targetEntity || "(unknown)";
    (map[k] = map[k] || {name:k, table:m.targetTable||"", rows:[]}).rows.push(m);
  });
  return Object.values(map).sort((a,b) => a.name.localeCompare(b.name));
}

function renderTableList(){
  const el = document.getElementById("tableList");
  let groups = entityGroups();
  if(tableListFilter){
    groups = groups.filter(g => g.name.toLowerCase().indexOf(tableListFilter) !== -1
                            || (g.table||"").toLowerCase().indexOf(tableListFilter) !== -1);
  }
  if(!groups.length){ el.innerHTML = '<div class="text-xs text-muted-2">No tables match.</div>'; return; }
  el.innerHTML = groups.map(g => {
    const total = g.rows.length;
    const approved = g.rows.filter(m => (m.reviewStatus||"").indexOf("Approved") === 0).length;
    const review = g.rows.filter(m => m.reviewStatus === "Needs Review" || m.reviewStatus === "In Review").length;
    const unmapped = g.rows.filter(m => m.mappingType === "Not Mapped").length;
    return '<div class="tl-item ' + (g.name===activeEntity?"active":"") + '" data-entity="' + escapeHtml(g.name) + '">' +
      '<div class="tl-name"><i class="bi bi-diagram-2"></i> ' + escapeHtml(g.name) + '</div>' +
      '<div class="tl-sub">' + escapeHtml(g.table||"") + '</div>' +
      '<div class="tl-stats">' +
        '<span class="tl-badge badge-gray">' + total + ' fields</span>' +
        (approved ? '<span class="tl-badge badge-high">' + approved + ' approved</span>' : '') +
        (review ? '<span class="tl-badge badge-medium">' + review + ' review</span>' : '') +
        (unmapped ? '<span class="tl-badge badge-low">' + unmapped + ' unmapped</span>' : '') +
      '</div>' +
    '</div>';
  }).join("");
  el.querySelectorAll(".tl-item").forEach(it => {
    it.addEventListener("click", () => selectEntity(it.dataset.entity));
    const g = groups.find(x => x.name === it.dataset.entity);
    if(g){
      const html = buildConnTip(g);
      it.addEventListener("mouseenter", () => showConnTip(it, html));
      it.addEventListener("mouseleave", hideConnTip);
    }
  });
}

/* ---------- connection-details hover tooltip (left table cards) ---------- */
// A hop's source can itself be a prior target, so resolve names against BOTH stores.
function findConnByName(name){
  if(!name) return null;
  const n = String(name).trim().toLowerCase();
  const src = (typeof getDbConnections === "function" ? getDbConnections() : []) || [];
  const tgt = (typeof getTargetConnections === "function" ? getTargetConnections() : []) || [];
  const all = src.concat(tgt);
  const eq = (v) => String(v || "").trim().toLowerCase() === n;
  // The stored source/target *name* string doesn't always equal a connection's name
  // (SQL sources often store the database/connection string). Match name, then database, then file.
  return all.find(c => eq(c.name))
      || all.find(c => eq(c.database))
      || all.find(c => eq(c.fileName) || eq((c.fileName || "").replace(/\.[^.]+$/, "")))
      || null;
}
function connLine(conn){
  if(!conn) return "";
  if(conn.type === "File System") return "File System" + (conn.fileName ? " · " + conn.fileName : "");
  const bits = [];
  if(conn.server) bits.push(conn.server);
  if(conn.database) bits.push(conn.database);
  if(conn.schema) bits.push("schema " + conn.schema);
  return (conn.type || "Database") + (bits.length ? " · " + bits.join(" / ") : "");
}
function buildConnTip(group){
  const rows = group.rows || [];
  const targetSys = (rows.find(m => m.targetSystem) || {}).targetSystem || state.activeSet || "—";
  const srcNames = Array.from(new Set(rows.map(m => m.sourceSystem).filter(Boolean)));
  const srcConn = findConnByName(srcNames[0]);
  const tgtConn = findConnByName(targetSys);
  const e = escapeHtml;
  // Show the resolved connection's name; fall back to the name stored on the mapping rows.
  const srcName = (srcConn && srcConn.name) || (srcNames.length ? srcNames.join(", ") : "—");
  const tgtName = (tgtConn && tgtConn.name) || targetSys || "—";
  let h = '<div class="wt-sec"><div class="wt-h"><i class="bi bi-box-arrow-up-right"></i> Source</div>' +
          '<div class="wt-name">' + e(srcName) + '</div>';
  if(srcConn) h += '<div class="wt-line">' + e(connLine(srcConn)) + '</div>';
  h += '</div>';
  h += '<div class="wt-sec"><div class="wt-h"><i class="bi bi-box-arrow-in-down-right"></i> Target</div>' +
       '<div class="wt-name">' + e(tgtName) + '</div>';
  if(tgtConn) h += '<div class="wt-line">' + e(connLine(tgtConn)) + '</div>';
  h += '</div>';
  return h;
}
let wsTipEl = null;
function ensureConnTip(){
  if(wsTipEl) return wsTipEl;
  wsTipEl = document.createElement("div");
  wsTipEl.className = "ws-hovertip";
  wsTipEl.style.display = "none";
  document.body.appendChild(wsTipEl);
  window.addEventListener("scroll", hideConnTip, true);   // hide on any scroll (incl. the list)
  return wsTipEl;
}
function showConnTip(anchor, html){
  const tip = ensureConnTip();
  tip.innerHTML = html;
  tip.style.display = "block";
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = r.right + 12;
  if(left + tw > window.innerWidth - 8) left = r.left - tw - 12;   // flip to the left if no room
  if(left < 8) left = 8;
  let top = Math.max(8, r.top);
  if(top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideConnTip(){ if(wsTipEl) wsTipEl.style.display = "none"; }

function selectEntity(name){
  activeEntity = name;
  state.all = scoped().filter(m => m.targetEntity === name);
  state.selected.clear();
  state.page = 1;
  state.search = "";
  state.filters = {sourceTable:"", targetEntity:"", mappingType:"", confidence:"", reviewStatus:""};
  const g = entityGroups().find(x => x.name === name);
  document.getElementById("gridTitle").innerHTML = '<i class="bi bi-grid-3x3-gap"></i> ' + escapeHtml(name) +
    (g && g.table ? ' <span class="text-muted-2 text-xs mono">(' + escapeHtml(g.table) + ')</span>' : '') +
    ' <span class="text-muted-2 text-xs">· ' + state.all.length + ' fields</span>';
  // show this entity's AI-identified join condition (editable)
  const jb = document.getElementById("joinBox"), jc = document.getElementById("joinCondition");
  if(jb && jc){ jb.style.display = ""; jc.value = joinConditions[name] || ""; }
  buildFilterBar();
  applyPipeline();
  renderTableList();   // refresh active highlight
}

function buildHeader(){
  const row = document.getElementById("mappingHeaderRow");
  let ths = '<th class="freeze fz0"><input type="checkbox" id="selAllRows"></th>';
  COLUMNS.forEach(c => {
    const fz = FREEZE[c.key] ? " freeze " + FREEZE[c.key] : "";
    ths += '<th class="' + fz.trim() + '" data-key="' + c.key + '" data-col="' + c.key + '">' + c.label + ' <i class="bi bi-arrow-down-up"></i></th>';
  });
  row.innerHTML = ths;
  document.getElementById("selAllRows").addEventListener("change", (e) => {
    getPageRows().map(r => r.id).forEach(id => e.target.checked ? state.selected.add(id) : state.selected.delete(id));
    renderTable();
  });
  row.querySelectorAll("th[data-key]").forEach(th => th.addEventListener("click", () => sortMappings(th.dataset.key)));
  applyColumnVisibility();
}

// Hide columns via a [data-col] attribute selector (every th/td is tagged with its
// column key), injected as a single <style> so it survives tbody re-renders.
function applyColumnVisibility(){
  const sel = [];
  hiddenColumns.forEach(key => sel.push('#mappingTable [data-col="' + key + '"]'));
  let styleEl = document.getElementById("colVisStyle");
  if(!styleEl){ styleEl = document.createElement("style"); styleEl.id = "colVisStyle"; document.head.appendChild(styleEl); }
  styleEl.textContent = sel.length ? (sel.join(",") + "{display:none !important;}") : "";
}

function buildColumnsMenu(){
  const menu = document.getElementById("columnsMenu");
  if(!menu) return;
  const items = COLUMNS.filter(c => ALWAYS_ON.indexOf(c.key) === -1).map(c => {
    const on = !hiddenColumns.has(c.key);
    return '<label class="col-menu-item"><input type="checkbox" data-col="' + c.key + '" ' + (on?"checked":"") + '> ' + escapeHtml(c.label) + '</label>';
  }).join("");
  menu.innerHTML =
    '<div class="col-menu-head">Show columns</div>' + items +
    '<div class="col-menu-actions"><button class="btn btn-sm btn-outline-soft" id="colShowAll">Show all</button></div>';
  menu.querySelectorAll("input[data-col]").forEach(cb => cb.addEventListener("change", () => {
    const key = cb.dataset.col;
    cb.checked ? hiddenColumns.delete(key) : hiddenColumns.add(key);
    lsSet("aims_ws_hidden_cols", Array.from(hiddenColumns));
    applyColumnVisibility();
  }));
  const showAll = document.getElementById("colShowAll");
  if(showAll) showAll.addEventListener("click", () => {
    hiddenColumns.clear(); lsSet("aims_ws_hidden_cols", []);
    applyColumnVisibility(); buildColumnsMenu();
  });
}

function buildFilterBar(){
  const el = document.getElementById("filterBar");
  const sourceTables = Array.from(new Set(state.all.map(m => m.sourceTable).filter(Boolean)));
  const mappingTypes = Array.from(new Set(state.all.map(m => m.mappingType)));
  const sourceOpts = sourceTables.map(t => "<option>" + t + "</option>").join("");
  const typeOpts = mappingTypes.map(t => "<option>" + t + "</option>").join("");

  el.innerHTML =
    '<input type="text" id="searchInput" placeholder="Search field, rule..." style="width:210px;">' +
    '<select id="filterSourceTable"><option value="">All Source Tables</option>' + sourceOpts + '</select>' +
    '<select id="filterMappingType"><option value="">All Mapping Types</option>' + typeOpts + '</select>' +
    '<select id="filterConfidence"><option value="">All Confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>' +
    '<select id="filterReviewStatus"><option value="">All Review Status</option>' +
      '<option>AI Generated</option><option>Needs Review</option><option>In Review</option><option>Approved</option><option>Rejected</option><option>Modified by User</option><option>Approved After Modification</option>' +
    '</select>' +
    '<button class="btn btn-sm btn-outline-soft" id="clearFiltersBtn">Clear</button>';

  document.getElementById("searchInput").value = state.search;
  el.querySelectorAll("input,select").forEach(input => input.addEventListener("input", debounce(() => {
    state.search = document.getElementById("searchInput").value;
    state.filters.sourceTable = document.getElementById("filterSourceTable").value;
    state.filters.mappingType = document.getElementById("filterMappingType").value;
    state.filters.confidence = document.getElementById("filterConfidence").value;
    state.filters.reviewStatus = document.getElementById("filterReviewStatus").value;
    state.page = 1;
    applyPipeline();
  }, 150)));
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.search=""; state.filters = {sourceTable:"", targetEntity:"", mappingType:"", confidence:"", reviewStatus:""};
    buildFilterBar(); applyPipeline();
  });
}

function filterMappings(list){
  return list.filter(m => {
    if(state.filters.sourceTable && m.sourceTable !== state.filters.sourceTable) return false;
    if(state.filters.mappingType && m.mappingType !== state.filters.mappingType) return false;
    if(state.filters.confidence && confidenceLevel(m.confidence) !== state.filters.confidence) return false;
    if(state.filters.reviewStatus && m.reviewStatus !== state.filters.reviewStatus) return false;
    if(state.reviewOnly && !(m.reviewStatus === "Needs Review" || m.reviewStatus === "In Review")) return false;
    return true;
  });
}
function searchMappings(list){
  if(!state.search) return list;
  const q = state.search.toLowerCase();
  return list.filter(m => {
    const fields = [m.id, m.sourceTable, m.sourceColumn, m.targetEntity, m.targetTable, m.targetColumn, m.businessRule, m.transformationRule];
    return fields.some(v => (v||"").toLowerCase().indexOf(q) !== -1);
  });
}
function sortMappings(key){
  if(state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = 1; }
  applyPipeline();
}
function applySort(list){
  if(!state.sortKey) return list;
  const k = state.sortKey;
  return list.slice().sort((a,b) => {
    const av = a[k] ?? "", bv = b[k] ?? "";
    if(typeof av === "number" && typeof bv === "number") return (av-bv)*state.sortDir;
    return String(av).localeCompare(String(bv)) * state.sortDir;
  });
}
function applyPipeline(){
  let list = filterMappings(state.all);
  list = searchMappings(list);
  list = applySort(list);
  state.filtered = list;
  renderTable();
}
function getPageRows(){
  const start = (state.page - 1) * state.pageSize;
  return state.filtered.slice(start, start + state.pageSize);
}

function renderTable(){
  const body = document.getElementById("mappingBody");
  const rows = getPageRows();
  if(!rows.length){
    body.innerHTML = '<tr><td colspan="' + (COLUMNS.length+1) + '"><div class="empty-state"><i class="bi bi-inbox"></i>' +
      '<h4>No mappings match the current filters.</h4></div></td></tr>';
  } else {
    body.innerHTML = rows.map(rowHTML).join("");
    wireRowEvents();
  }
  renderPaginationBar();
}

// Row tint by review status: approved -> green, AI-generated -> orange,
// rejected -> red, needs-review/modified -> amber.
// Not-Mapped rows are left uncolored (no source was found — nothing to review yet).
function rowStatusClass(m){
  if(m.mappingType === "Not Mapped") return "";
  const s = m.reviewStatus || "";
  if(s.indexOf("Approved") === 0) return "row-approved";
  if(s === "Rejected") return "row-rejected";
  if(s === "AI Generated") return "row-ai";
  if(s === "Needs Review" || s === "In Review" || s === "Modified by User") return "row-review";
  return "";
}

function rowHTML(m){
  const selected = state.selected.has(m.id) ? "row-selected" : "";
  return '<tr class="' + (rowStatusClass(m) + ' ' + selected).trim() + '" data-id="' + m.id + '">' +
    '<td class="freeze fz0"><input type="checkbox" class="row-check" data-id="' + m.id + '" ' + (state.selected.has(m.id)?"checked":"") + '></td>' +
    '<td class="freeze fz1 mono" data-col="id"><a href="#" class="row-open" data-id="' + m.id + '">' + m.id + '</a></td>' +
    '<td class="freeze fz2 mono" data-col="targetTable">' + (m.targetTable||"-") + '</td>' +
    '<td class="freeze fz3 editable-cell" data-col="targetColumn" data-field="targetColumn" data-id="' + m.id + '">' + m.targetColumn + '</td>' +
    '<td class="mono" data-col="sourceTable">' + (m.sourceTable||"-") + '</td>' +
    '<td class="mono" data-col="sourceColumn">' + (m.sourceColumn||"-") + '</td>' +
    '<td class="mono" data-col="sampleSourceValue">' + escapeHtml(m.sampleSourceValue||"-") + '</td>' +
    '<td data-col="mappingType"><span class="mapping-type-chip editable-cell" data-field="mappingType" data-id="' + m.id + '">' + m.mappingType + '</span></td>' +
    '<td class="wrap editable-cell" data-col="transformationRule" data-field="transformationRule" data-id="' + m.id + '">' + escapeHtml(m.transformationRule||"None") + '</td>' +
    '<td class="wrap editable-cell" data-col="businessRule" data-field="businessRule" data-id="' + m.id + '">' + escapeHtml(m.businessRule||"-") + '</td>' +
    '<td class="editable-cell" data-col="defaultValue" data-field="defaultValue" data-id="' + m.id + '">' + escapeHtml(m.defaultValue||"-") + '</td>' +
    '<td class="wrap editable-cell" data-col="lookupTable" data-field="lookupTable" data-id="' + m.id + '">' + escapeHtml(m.lookupTable||"-") + '</td>' +
    '<td class="wrap editable-cell" data-col="nullHandling" data-field="nullHandling" data-id="' + m.id + '">' + escapeHtml(m.nullHandling||"-") + '</td>' +
    '<td data-col="confidence">' + confidenceBar(m.confidence) + '</td>' +
    '<td data-col="aiExplanation"><button class="why-btn" data-why="' + m.id + '"><i class="bi bi-question-circle"></i> Why?</button></td>' +
    '<td data-col="validationStatus">' + statusBadge(m.validationStatus === "Passed" ? "Approved" : m.validationStatus) + '</td>' +
    '<td data-col="reviewStatus">' + statusBadge(m.reviewStatus) + '</td>' +
    '<td class="text-nowrap" data-col="actions">' +
      '<button class="btn btn-sm btn-outline-soft" data-approve="' + m.id + '" title="Approve"><i class="bi bi-check-lg"></i></button>' +
      '<button class="btn btn-sm btn-outline-soft" data-reject="' + m.id + '" title="Reject"><i class="bi bi-x-lg"></i></button>' +
      '<button class="btn btn-sm btn-outline-soft" data-regen="' + m.id + '" title="Regenerate"><i class="bi bi-arrow-repeat"></i></button>' +
    '</td></tr>';
}

function wireRowEvents(){
  document.querySelectorAll(".row-check").forEach(cb => cb.addEventListener("change", (e) => {
    e.target.checked ? state.selected.add(cb.dataset.id) : state.selected.delete(cb.dataset.id);
    e.target.closest("tr").classList.toggle("row-selected", e.target.checked);
  }));
  document.querySelectorAll(".row-open").forEach(a => a.addEventListener("click", (e) => { e.preventDefault(); showMappingDetails(a.dataset.id); }));
  document.querySelectorAll("[data-why]").forEach(btn => btn.addEventListener("click", () => showWhyPanel(btn.dataset.why)));
  document.querySelectorAll("[data-approve]").forEach(btn => btn.addEventListener("click", () => approveMapping(btn.dataset.approve)));
  document.querySelectorAll("[data-reject]").forEach(btn => btn.addEventListener("click", () => rejectMapping(btn.dataset.reject)));
  document.querySelectorAll("[data-regen]").forEach(btn => btn.addEventListener("click", () => regenerateMapping(btn.dataset.regen)));
  document.querySelectorAll(".editable-cell").forEach(cell => cell.addEventListener("click", () => makeCellEditable(cell)));
}

function renderPaginationBar(){
  const total = state.filtered.length;
  const start = total ? (state.page-1)*state.pageSize + 1 : 0;
  const end = Math.min(state.page*state.pageSize, total);
  document.getElementById("pgInfo").textContent = "Displaying " + start + "-" + end + " of " + total + " mappings";
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const controls = document.getElementById("pgControls");
  let html = '<button ' + (state.page===1?"disabled":"") + ' id="pgPrev">Prev</button>';
  for(let p=1;p<=totalPages;p++){
    if(p===1 || p===totalPages || Math.abs(p-state.page)<=1){
      html += '<button class="' + (p===state.page?"active":"") + '" data-pg="' + p + '">' + p + '</button>';
    } else if(p===2 || p===totalPages-1){ html += '<span>...</span>'; }
  }
  html += '<button ' + (state.page===totalPages?"disabled":"") + ' id="pgNext">Next</button>';
  controls.innerHTML = html;
  const prevBtn = document.getElementById("pgPrev"), nextBtn = document.getElementById("pgNext");
  if(prevBtn) prevBtn.addEventListener("click", () => { state.page--; renderTable(); });
  if(nextBtn) nextBtn.addEventListener("click", () => { state.page++; renderTable(); });
  controls.querySelectorAll("[data-pg]").forEach(btn => btn.addEventListener("click", () => { state.page = +btn.dataset.pg; renderTable(); }));
}

function wireGridControls(){
  document.getElementById("pageSizeSelect").addEventListener("change", (e) => { state.pageSize = +e.target.value; state.page = 1; renderTable(); });
  document.getElementById("reviewOnlyToggle").addEventListener("change", (e) => { state.reviewOnly = e.target.checked; state.page = 1; applyPipeline(); });
  document.getElementById("bulkApproveBtn").addEventListener("click", () => bulkAction("approve"));
  document.getElementById("bulkRejectBtn").addEventListener("click", () => bulkAction("reject"));
  document.getElementById("bulkDeleteBtn").addEventListener("click", deleteSelectedMappings);
  document.getElementById("exportMappingBtn").addEventListener("click", downloadMappingCsv);
  document.getElementById("clearAllBtn").addEventListener("click", clearAllMappings);
  document.getElementById("hidePanelBtn").addEventListener("click", () => togglePanel(false));
  document.getElementById("showPanelBtn").addEventListener("click", () => togglePanel(true));
  // Columns show/hide menu
  buildColumnsMenu();
  applyColumnVisibility();
  const columnsBtn = document.getElementById("columnsBtn");
  const columnsMenu = document.getElementById("columnsMenu");
  if(columnsBtn) columnsBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    columnsMenu.style.display = columnsMenu.style.display === "none" ? "" : "none";
  });
  document.addEventListener("click", (ev) => {
    if(columnsMenu && columnsMenu.style.display !== "none" && !ev.target.closest(".col-menu-wrap")) columnsMenu.style.display = "none";
  });
  document.getElementById("drawerCloseBtn").addEventListener("click", closeDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", () => { closeDrawer(); closeWhyPanel(); });
  document.getElementById("whyCloseBtn").addEventListener("click", closeWhyPanel);
  // restore the user's last panel state
  if(lsGet("aims_ws_panel_hidden", false)) togglePanel(false);
}

// Show/hide the Target Tables panel; the grid column widens to fill the space.
function togglePanel(show){
  const panel = document.getElementById("tablePanelCol");
  const grid = document.getElementById("gridCol");
  const showBtn = document.getElementById("showPanelBtn");
  if(show){
    panel.style.display = "";
    grid.classList.remove("col-lg-12"); grid.classList.add("col-lg-9");
    showBtn.style.display = "none";
    lsSet("aims_ws_panel_hidden", false);
  } else {
    panel.style.display = "none";
    grid.classList.remove("col-lg-9"); grid.classList.add("col-lg-12");
    showBtn.style.display = "";
    lsSet("aims_ws_panel_hidden", true);
  }
}

// Remove every generated mapping (plus joins + inline edits) from the workspace.
async function clearAllMappings(){
  const ok = await confirmDialog("Remove ALL " + allMappings.length + " mappings from the workspace? "
    + "This clears the generated mapping document, join conditions, and your inline edits. This cannot be undone.", "Clear All");
  if(!ok) return;
  const clearedCount = allMappings.length;
  // Audit the clear-all as a single self-contained entry before wiping the document.
  if(typeof addHistoryRecord === "function"){
    addHistoryRecord("ALL", {changeType:"Rejected", previousValue: clearedCount + " mappings", newValue:"Cleared",
      reason:"Cleared all mappings from the workspace", user:currentUserName(), source:"User",
      sourceField:"—", targetField:"(all tables)"});
  }
  // Store an explicit EMPTY document (not remove the key) so the page doesn't fall
  // back to the bundled sample mappings.json on reload — cleared must stay cleared.
  lsSet("aims_ai_mappings", []);
  localStorage.removeItem("aims_ai_joins");
  if(typeof clearMappingOverrides === "function") clearMappingOverrides();
  allMappings = [];
  joinConditions = {};
  activeEntity = null;
  state.activeSet = null;
  state.all = []; state.filtered = []; state.selected.clear();
  const setBar = document.getElementById("setBar"); if(setBar) setBar.style.display = "none";
  document.getElementById("reviewLayout").style.display = "none";
  document.getElementById("emptyState").style.display = "";
  showNotification("All mappings cleared.", "primary");
}

async function bulkAction(action){
  if(!state.selected.size){ showNotification("Select at least one mapping row first.", "warning"); return; }
  const ok = await confirmDialog("Apply \"" + action + "\" to " + state.selected.size + " selected mapping(s)?");
  if(!ok) return;
  state.selected.forEach(id => {
    if(action === "approve") approveMapping(id, true);
    if(action === "reject") rejectMapping(id, true);
  });
  showNotification("Bulk " + action + " applied to " + state.selected.size + " mapping(s).", "success");
  state.selected.clear();
  applyPipeline();
}

// Permanently remove the selected mapping rows from the workspace + stored document.
async function deleteSelectedMappings(){
  if(!state.selected.size){ showNotification("Select at least one mapping row first.", "warning"); return; }
  const n = state.selected.size;
  const ok = await confirmDialog("Delete " + n + " selected mapping(s)? This removes them from the mapping document and cannot be undone.", "Delete");
  if(!ok) return;

  const toDelete = new Set(state.selected);

  // Drop from the persisted generated-mapping document.
  const stored = lsGet("aims_ai_mappings", null);
  if(stored && stored.length){
    const kept = stored.filter(r => !toDelete.has(r.id));
    lsSet("aims_ai_mappings", kept);
  }
  // Drop any inline overrides for the deleted rows.
  if(typeof getMappingOverrides === "function"){
    const ov = getMappingOverrides();
    let changed = false;
    toDelete.forEach(id => { if(ov[id]){ delete ov[id]; changed = true; } });
    if(changed) lsSet(LS_KEYS.overrides, ov);
  }

  // Purge each deleted mapping's prior history (so no orphan '-.-' rows linger),
  // then record ONE self-contained delete entry that embeds the field names — so it
  // survives even though the mapping no longer exists.
  toDelete.forEach(id => {
    const m = allMappings.find(x => x.id === id);
    if(typeof removeHistoryFor === "function") removeHistoryFor(id);
    if(typeof addHistoryRecord === "function"){
      addHistoryRecord(id, {changeType:"Rejected", previousValue:(m && m.mappingType) || "-", newValue:"Deleted",
        reason:"Mapping deleted from workspace", user:currentUserName(), source:"User",
        sourceField: m ? ((m.sourceTable||"-") + "." + (m.sourceColumn||"-")) : "-",
        targetField: m ? ((m.targetEntity||"-") + "." + (m.targetColumn||"-")) : "-"});
    }
  });

  // Update in-memory state.
  allMappings = allMappings.filter(m => !toDelete.has(m.id));
  state.all = state.all.filter(m => !toDelete.has(m.id));
  state.selected.clear();

  if(!allMappings.length){
    // Nothing left at all -> show the empty state.
    activeEntity = null;
    document.getElementById("reviewLayout").style.display = "none";
    document.getElementById("emptyState").style.display = "";
    showNotification(n + " mapping(s) deleted. No mappings remain.", "primary");
    return;
  }

  // The active set may have lost all its rows -> re-point to the most-recent remaining set.
  const sets = mappingSets();
  if(!sets.some(s => s.key === state.activeSet)){
    state.activeSet = sets[0] ? sets[0].key : null;
    lsSet(LS_WS_SET, state.activeSet);
    activeEntity = null;
  }
  renderSetSelector();

  // If the active table lost all its rows, fall back to the first remaining table in the set.
  renderTableList();
  if(!activeEntity || !state.all.length){
    const groups = entityGroups();
    if(groups.length) selectEntity(groups[0].name);
  } else {
    applyPipeline();
  }
  showNotification(n + " mapping(s) deleted.", "success");
}

function findMapping(id){ return state.all.find(m => m.id === id); }

function approveMapping(id, silent){
  const m = findMapping(id);
  const prevStatus = m.reviewStatus;
  const newStatus = prevStatus === "Modified by User" ? "Approved After Modification" : "Approved";
  saveMappingOverride(id, {reviewStatus: newStatus, updatedBy: currentUserName(), lastUpdated: new Date().toISOString()});
  addHistoryRecord(id, {changeType:"Approved", previousValue: prevStatus, newValue: newStatus, reason:"Manual approval", user:currentUserName(), source:"User"});
  m.reviewStatus = newStatus;
  if(!silent){ showNotification(id + " approved.", "success"); applyPipeline(); }
}
async function rejectMapping(id, silent){
  const m = findMapping(id);
  if(!silent){
    const ok = await confirmDialog("Reject mapping " + id + "? It will be flagged for redesign.");
    if(!ok) return;
  }
  const prevStatus = m.reviewStatus;
  saveMappingOverride(id, {reviewStatus:"Rejected", updatedBy:currentUserName(), lastUpdated:new Date().toISOString()});
  addHistoryRecord(id, {changeType:"Rejected", previousValue: prevStatus, newValue:"Rejected", reason:"Manual rejection", user:currentUserName(), source:"User"});
  m.reviewStatus = "Rejected";
  if(!silent){ showNotification(id + " rejected.", "danger"); applyPipeline(); }
}

// Load the source schema (every table & column) so a per-field REGENERATE can find
// columns that aren't in the current mapping yet. Searches ALL *saved* source
// connections (deleted ones are already gone from the store), but orders the source
// that these mappings actually came from FIRST so it's the preferred match. Never
// includes made-up tables — only what's really configured.
async function loadSourceSchema(){
  const out = [], seen = new Set();
  const add = (tbl, col, dt) => {
    const k = (tbl||"") + "." + (col||"");
    if(tbl && col && !seen.has(k)){ seen.add(k); out.push({table:tbl, column:col, dataType:dt||""}); }
  };
  const readConn = async (c) => {
    try{
      if((c.type||"").toLowerCase() === "file system"){
        (c.tables||[]).forEach(t => (t.columns||[]).forEach(col => add(t.name, col.name, col.dataType)));
      } else {
        const cfg = {driver:c.driver||"ODBC Driver 17 for SQL Server", server:c.server||c.host||"",
          database:c.database||c.db||"", schema:c.schema||null, trusted:!!c.trusted,
          username:c.username||"", password:c.password||""};
        if(!cfg.server || !cfg.database) return;
        const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
        const data = await res.json();
        if(data.ok) (data.tables||[]).forEach(t => (t.columns||[]).forEach(col => add(t.name, col.name, col.dataType)));
      }
    }catch(e){ /* skip unreachable source */ }
  };

  const conns = (typeof getDbConnections === "function") ? getDbConnections() : [];
  // The connection these mappings came from (by name) goes first = preferred source.
  const usedNames = new Set(allMappings.map(m => m.sourceSystem).filter(Boolean));
  const preferred = conns.filter(c => usedNames.has(c.name));
  const rest = conns.filter(c => !usedNames.has(c.name));
  for(const c of preferred) await readConn(c);   // preferred source's columns first
  for(const c of rest) await readConn(c);         // then the other saved sources
  sourceSchemaCols = out;
}

// Distinct source tables currently used by a target entity's mappings (join context).
function entitySourceTables(entity){
  const seen = new Set();
  allMappings.forEach(m => {
    if(m.targetEntity === entity && m.sourceTable) seen.add(m.sourceTable);
  });
  return Array.from(seen);
}

// Source columns to ground the AI regenerate: the FULL source schema if loaded,
// otherwise fall back to columns already present in the mapping document.
function knownSourceColumns(){
  if(sourceSchemaCols && sourceSchemaCols.length) return sourceSchemaCols;
  const seen = new Set(), out = [];
  allMappings.forEach(m => {
    if(m.sourceTable && m.sourceColumn && m.sourceColumn !== "(no source equivalent)"){
      const key = m.sourceTable + "." + m.sourceColumn;
      if(!seen.has(key)){ seen.add(key); out.push({table:m.sourceTable, column:m.sourceColumn, dataType:m.sourceDataType||""}); }
    }
  });
  return out;
}

// Real single-mapping regenerate via Claude, honoring the user's instruction.
async function regenerateMapping(id, silent, extraInstructions){
  const m = findMapping(id);
  if(!m) return;
  const prev = {mappingType:m.mappingType, businessRule:m.businessRule, confidence:m.confidence};
  showNotification("Regenerating " + id + " with AI...", "primary", 2500);
  try{
    const res = await fetch("/api/ai/regenerate-mapping", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        mapping: {
          targetEntity:m.targetEntity, targetColumn:m.targetColumn, targetDataType:m.targetDataType,
          sourceTable:m.sourceTable, sourceColumn:m.sourceColumn, mappingType:m.mappingType,
          transformationRule:m.transformationRule, businessRule:m.businessRule,
          lookupTable:m.lookupTable, defaultValue:m.defaultValue, nullHandling:m.nullHandling
        },
        sourceColumns: knownSourceColumns(),
        instruction: extraInstructions || "",
        currentJoin: joinConditions[m.targetEntity] || "",
        entitySourceTables: entitySourceTables(m.targetEntity)
      })
    });
    const data = await res.json();
    if(!data.ok || !data.mapping || !data.mapping.mappingType){
      showNotification("Regenerate failed: " + (data.error || "no mapping returned"), "danger");
      return;
    }
    const r = data.mapping;
    const unmapped = r.mappingType === "Not Mapped" || !r.sourceColumn;
    const changes = {
      sourceTable: unmapped ? "" : (r.sourceTable || ""),
      sourceColumn: unmapped ? "(no source equivalent)" : (r.sourceColumn || ""),
      sourceSystem: unmapped ? "" : (m.sourceSystem || ""),
      mappingType: r.mappingType,
      transformationRule: r.transformationRule || "",
      businessRule: r.businessRule || "",
      lookupTable: r.lookupTable || "",
      defaultValue: r.defaultValue || "",
      nullHandling: r.nullHandling || m.nullHandling || "",
      confidence: Math.max(0, Math.min(100, r.confidence || 0)),
      aiExplanation: (m.aiExplanation||[]).concat([r.explanation || "Regenerated per user instruction."]),
      reviewStatus: "AI Generated", updatedBy: "AI Engine (Claude)", lastUpdated: new Date().toISOString()
    };
    saveMappingOverride(id, changes);
    addHistoryRecord(id, {changeType:"Regenerated",
      previousValue: prev.mappingType + " @ " + prev.confidence + "% — " + (prev.businessRule||""),
      newValue: changes.mappingType + " @ " + changes.confidence + "% — " + changes.businessRule,
      reason: extraInstructions || "Regenerate request", user:"AI Engine (Claude)", source:"AI"});
    Object.assign(m, changes);

    // Update the entity's FROM/JOIN if the AI adjusted it (e.g. the new source column
    // came from a table not previously in the join).
    const newJoin = (r.joinCondition || "").trim();
    if(newJoin && newJoin !== (joinConditions[m.targetEntity] || "").trim()){
      const prevJoin = joinConditions[m.targetEntity] || "";
      joinConditions[m.targetEntity] = newJoin;
      lsSet("aims_ai_joins", joinConditions);
      // reflect it in the join box if this entity is currently shown
      if(activeEntity === m.targetEntity){
        const jc = document.getElementById("joinCondition");
        if(jc) jc.value = newJoin;
      }
      addHistoryRecord(id, {changeType:"Modified", previousValue: prevJoin || "(none)",
        newValue: newJoin, reason:"Join condition updated during regenerate for " + m.targetEntity,
        user:"AI Engine (Claude)", source:"AI"});
    }

    if(!silent){ showNotification(id + " regenerated → " + changes.mappingType + " (" + changes.confidence + "%)" + (newJoin ? "; join updated" : "") + ".", "success"); applyPipeline(); }
  }catch(err){
    showNotification("Backend not reachable during regenerate.", "danger");
  }
}

const SELECT_FIELDS = {mappingType: COLUMNS.find(c=>c.key==="mappingType").options};
function makeCellEditable(cell){
  if(cell.querySelector("input,select")) return;
  const id = cell.dataset.id, field = cell.dataset.field;
  const m = findMapping(id);
  const currentVal = m[field] || "";
  let input;
  if(SELECT_FIELDS[field]){
    input = document.createElement("select");
    input.innerHTML = SELECT_FIELDS[field].map(o => '<option ' + (o===currentVal?"selected":"") + '>' + o + '</option>').join("");
  } else { input = document.createElement("input"); input.value = currentVal; }
  cell.innerHTML = ""; cell.appendChild(input); input.focus();
  const commit = () => editMapping(id, field, input.value);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => { if(e.key === "Enter") input.blur(); });
}
function editMapping(id, field, newValue){
  const m = findMapping(id);
  const oldValue = m[field];
  if(oldValue === newValue){ applyPipeline(); return; }
  const changes = {reviewStatus:"Modified by User", updatedBy:currentUserName(), lastUpdated:new Date().toISOString()};
  changes[field] = newValue;
  saveMappingOverride(id, changes);
  addHistoryRecord(id, {changeType:"Modified", previousValue:String(oldValue), newValue:String(newValue), reason:"Field '" + field + "' edited inline", user:currentUserName(), source:"User"});
  Object.assign(m, changes);
  showNotification(id + " updated - status set to Modified by User.", "primary");
  applyPipeline();
}

function showWhyPanel(id){
  const m = findMapping(id);
  const explanationItems = (m.aiExplanation||[]).map(e => "<li>" + escapeHtml(e) + "</li>").join("");
  document.getElementById("whyBody").innerHTML =
    '<p class="text-xs text-muted-2 mb-3">AI selected <strong>' + m.targetEntity + '.' + m.targetColumn + '</strong> for <strong>' + (m.sourceTable||"-") + '.' + (m.sourceColumn || "(no source)") + '</strong> because:</p>' +
    '<ul class="explain-list">' + explanationItems + '</ul>' +
    '<div class="mt-3">' + confidenceBadge(m.confidence) + '</div>';
  document.getElementById("drawerBackdrop").classList.add("show");
  document.getElementById("whyPanel").classList.add("show");
}
function closeWhyPanel(){
  document.getElementById("whyPanel").classList.remove("show");
  if(!document.getElementById("detailDrawer").classList.contains("show")) document.getElementById("drawerBackdrop").classList.remove("show");
}

function showMappingDetails(id){
  const m = findMapping(id);
  document.getElementById("drawerTitle").textContent = "Mapping Detail - " + id;
  const history = getHistoryFor(id);
  const explanationItems = (m.aiExplanation||[]).map(e => "<li>" + escapeHtml(e) + "</li>").join("");
  const commentItems = (m.comments||[]).map(c => '<div class="mb-2 text-xs"><strong>' + c.user + '</strong> - ' + formatDate(c.date) + '<br>' + escapeHtml(c.text) + '</div>').join("") || '<p class="text-xs text-muted-2">No comments yet.</p>';
  const historyItems = history.length ? history.map(h =>
    '<div class="mb-2 text-xs" style="border-left:3px solid var(--primary);padding-left:8px;">' +
      '<strong>' + h.changeType + '</strong> by ' + h.user + ' (' + h.source + ') - ' + formatDateTime(h.date) + '<br>' +
      '<span class="text-muted-2">' + escapeHtml(h.previousValue||"") + ' -&gt; ' + escapeHtml(h.newValue||"") + '</span><br>' +
      '<span class="text-muted-2">Reason: ' + escapeHtml(h.reason||"-") + '</span></div>'
  ).join("") : '<p class="text-xs text-muted-2">No changes recorded yet.</p>';

  document.getElementById("drawerBody").innerHTML =
    '<div class="drawer-section"><h6>Target Metadata</h6>' +
      '<div class="kv-list">' +
        '<span class="k">System</span><span>' + (m.targetSystem||"-") + '</span>' +
        '<span class="k">Entity / Table</span><span>' + m.targetEntity + ' / <span class="mono">' + m.targetTable + '</span></span>' +
        '<span class="k">Column</span><span class="mono">' + m.targetColumn + '</span>' +
        '<span class="k">Type / Length</span><span>' + m.targetDataType + ' (' + (m.targetLength ?? "-") + ')</span>' +
        '<span class="k">Description</span><span>' + escapeHtml(m.targetDescription||"-") + '</span>' +
      '</div></div>' +
    '<div class="drawer-section"><h6>Discovered Source</h6>' +
      '<div class="kv-list">' +
        '<span class="k">System</span><span>' + (m.sourceSystem||"-") + '</span>' +
        '<span class="k">Table</span><span class="mono">' + (m.sourceTable||"-") + '</span>' +
        '<span class="k">Column</span><span class="mono">' + (m.sourceColumn||"-") + '</span>' +
        '<span class="k">Type / Length</span><span>' + (m.sourceDataType||"-") + ' (' + (m.sourceLength ?? "-") + ')</span>' +
        '<span class="k">Sample Value</span><span class="mono">' + escapeHtml(m.sampleSourceValue||"-") + '</span>' +
      '</div></div>' +
    '<div class="drawer-section"><h6>Mapping Rule</h6>' +
      '<div class="kv-list">' +
        '<span class="k">Mapping Type</span><span>' + m.mappingType + '</span>' +
        '<span class="k">Transformation</span><span class="mono">' + escapeHtml(m.transformationRule||"None") + '</span>' +
        '<span class="k">Business Rule</span><span>' + escapeHtml(m.businessRule||"-") + '</span>' +
        '<span class="k">Default Value</span><span>' + escapeHtml(m.defaultValue||"-") + '</span>' +
        '<span class="k">Lookup Table</span><span>' + escapeHtml(m.lookupTable||"-") + '</span>' +
        '<span class="k">Null Handling</span><span>' + escapeHtml(m.nullHandling||"-") + '</span>' +
        '<span class="k">Sample Target</span><span class="mono">' + escapeHtml(transformSample(m)) + '</span>' +
      '</div></div>' +
    '<div class="drawer-section"><h6>AI Confidence &amp; Explanation</h6>' + confidenceBadge(m.confidence) +
      '<ul class="explain-list mt-2">' + explanationItems + '</ul></div>' +
    '<div class="drawer-section"><h6>Additional Instructions for AI</h6>' +
      '<textarea class="form-control" id="drawerInstructions" rows="3" placeholder="e.g. Use lookup table instead of constant mapping..."></textarea>' +
      '<button class="btn btn-sm btn-primary mt-2" id="drawerRegenBtn"><i class="bi bi-arrow-repeat me-1"></i> Regenerate Selected Mapping</button></div>' +
    '<div class="drawer-section"><h6>Review Comments</h6>' +
      '<div id="drawerComments">' + commentItems + '</div>' +
      '<textarea class="form-control mt-2" id="newCommentInput" rows="2" placeholder="Add a comment..."></textarea>' +
      '<button class="btn btn-sm btn-outline-soft mt-2" id="addCommentBtn"><i class="bi bi-chat-left-text me-1"></i> Add Comment</button></div>' +
    '<div class="drawer-section"><h6>Mapping History</h6>' + historyItems + '</div>';

  document.getElementById("drawerFooter").innerHTML =
    '<button class="btn btn-outline-soft" id="drawerRejectBtn"><i class="bi bi-x-lg"></i> Reject</button>' +
    '<button class="btn btn-primary" id="drawerApproveBtn"><i class="bi bi-check-lg"></i> Approve</button>';

  document.getElementById("drawerApproveBtn").addEventListener("click", () => { approveMapping(id); showMappingDetails(id); });
  document.getElementById("drawerRejectBtn").addEventListener("click", async () => { await rejectMapping(id); showMappingDetails(id); });
  document.getElementById("drawerRegenBtn").addEventListener("click", async () => {
    const instructions = document.getElementById("drawerInstructions").value.trim();
    const btn = document.getElementById("drawerRegenBtn");
    btn.disabled = true; btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i> Regenerating...';
    await regenerateMapping(id, false, instructions || null);
    showMappingDetails(id);   // re-render drawer with the updated mapping
  });
  document.getElementById("addCommentBtn").addEventListener("click", () => {
    const text = document.getElementById("newCommentInput").value.trim();
    if(!text) return;
    const comments = (m.comments||[]).concat([{user:currentUserName(), text, date:new Date().toISOString()}]);
    saveMappingOverride(id, {comments}); m.comments = comments;
    addHistoryRecord(id, {changeType:"Modified", previousValue:"-", newValue:text, reason:"Comment added", user:currentUserName(), source:"User"});
    showMappingDetails(id); applyPipeline();
  });

  document.getElementById("drawerBackdrop").classList.add("show");
  document.getElementById("detailDrawer").classList.add("show");
}
function closeDrawer(){
  document.getElementById("detailDrawer").classList.remove("show");
  if(!document.getElementById("whyPanel").classList.contains("show")) document.getElementById("drawerBackdrop").classList.remove("show");
}

/* ---------- mapping document CSV export ---------- */
function downloadMappingCsv(){
  // Export the CURRENT target table's full mapping (every target column),
  // ignoring the search box / filters / review-only toggle.
  if(!activeEntity){ showNotification("Select a target table first, then download its mapping.", "warning"); return; }
  const rows = scoped().filter(m => m.targetEntity === activeEntity);
  if(!rows.length){ showNotification("No mapping rows to export for " + activeEntity + ".", "warning"); return; }

  const join = joinConditions[activeEntity] || "";
  // Target-first ordering: since we map INTO the target table, target details lead,
  // then the source/legacy details that feed each target column, then the rule metadata.
  const EXPORT_COLS = [
    {key:"id",                 label:"Mapping ID"},
    {key:"targetEntity",       label:"Target Entity"},
    {key:"targetTable",        label:"Target Table"},
    {key:"targetColumn",       label:"Target Column"},
    {key:"sourceTable",        label:"Source (Legacy) Table"},
    {key:"sourceColumn",       label:"Source (Legacy) Column"},
    {key:"sampleSourceValue",  label:"Sample Source Value"},
    {key:"mappingType",        label:"Mapping Type"},
    {key:"transformationRule", label:"Transformation Rule"},
    {key:"businessRule",       label:"Business Rule"},
    {key:"defaultValue",       label:"Default Value"},
    {key:"lookupTable",        label:"Lookup Table"},
    {key:"nullHandling",       label:"Null Handling"},
    {key:"confidence",         label:"AI Confidence"},
    {key:"aiExplanation",      label:"AI Explanation"},
    {key:"validationStatus",   label:"Validation Status"},
    {key:"reviewStatus",       label:"Review Status"},
    {key:"__join",             label:"Join Condition"}
  ];
  const header = EXPORT_COLS.map(c => c.label);
  const lines = [header.join(",")];
  rows.forEach(m => {
    const row = EXPORT_COLS.map(c =>
      c.key === "__join" ? csvCell(join)
      : c.key === "targetEntity" ? csvCell(activeEntity)
      : csvCell(m[c.key]));
    lines.push(row.join(","));
  });
  const safe = String(activeEntity).replace(/[^A-Za-z0-9_-]+/g, "_");
  downloadFile("mapping-" + safe + ".csv", lines.join("\n"), "text/csv");
  showNotification("Mapping for " + activeEntity + " exported (" + rows.length + " target columns).", "success");
}
function csvCell(v){
  if(v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? '"' + s + '"' : s;
}
function downloadFile(name, content, mime){
  const blob = new Blob([content], {type:mime});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

/* ================================================================
   STEP 4 - SAMPLE DATA
   ================================================================ */

// Parse "PolicyStatusXref: A-Active, C-Cancelled" -> {A:"Active", C:"Cancelled"}
function parseLookup(lookupTable){
  const out = {};
  if(!lookupTable) return out;
  const body = lookupTable.indexOf(":") !== -1 ? lookupTable.slice(lookupTable.indexOf(":")+1) : lookupTable;
  body.split(",").forEach(pair => {
    const idx = pair.indexOf("-");
    if(idx !== -1){ out[pair.slice(0,idx).trim()] = pair.slice(idx+1).trim(); }
  });
  return out;
}

// Apply the mapping rule to its stored sample source value -> target value (best-effort simulation).
function transformSample(m){
  const src = (m.sampleSourceValue || "").trim();
  switch(m.mappingType){
    case "Not Mapped": return "(no source — manual entry)";
    case "Constant": {
      const mm = /CONSTANT\('([^']*)'\)/i.exec(m.transformationRule||"");
      return mm ? mm[1] : (m.defaultValue || "US");
    }
    case "Default": return src || m.defaultValue || "";
    case "Lookup": {
      const map = parseLookup(m.lookupTable);
      return map[src] || m.defaultValue || map["NULL"] || "Unknown";
    }
    case "Conditional": {
      // IF X='I' THEN 'Person' ELSEIF X='C' THEN 'Company' ELSE 'Unknown'
      const rule = m.transformationRule || "";
      const branches = [...rule.matchAll(/'([^']+)'\s+THEN\s+'([^']+)'/gi)];
      for(const b of branches){ if(b[1] === src) return b[2]; }
      const els = /ELSE\s+'([^']+)'/i.exec(rule);
      return els ? els[1] : (m.defaultValue || "Unknown");
    }
    case "Format Conversion":
    case "Data Type Conversion": {
      const rule = m.transformationRule || "";
      const concat = /CONCAT\('([^']*)'\s*,/i.exec(rule);
      if(concat) return concat[1] + src;
      return src.replace(/,/g, "");   // e.g. strip thousands separators
    }
    case "Derived":
    case "Concatenation":
      return src;   // sample already holds the composite (e.g. "Sarah J Whitfield")
    default:        // Direct / Reference / etc.
      return src || (m.defaultValue || "");
  }
}

