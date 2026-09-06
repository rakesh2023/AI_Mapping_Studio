/* =========================================================================
   validation-report.js - Validation Report (graphical)
   Reuses the Data Validation page's saved config (aims_data_validation_cfg),
   runs the checks live against the active SQL Server target (/api/db/validate),
   and renders KPI cards + Chart.js charts (by type, by table) + a details table.
   ========================================================================= */

let vrSchema = null;
let vrConn = null;
let vrCanRun = false;
let vrFieldsByTable = {};
let vrTypelistIndex = {};
let vrTypelistNameByBase = {};
let vrIssues = [];
let vrCurrentSlice = [];   // issues rendered on the current page (indexed by <tr data-slot>)
let vrTablesChecked = 0;
let vrTablesSelected = 0;
let vrState = { page:1, pageSize:25, filters:{type:"", table:"", q:""} };
let chartTypeObj = null, chartTableObj = null;

const VR_TYPE_META = {
  duplicate:  {label:"Duplicates",      color:"#c0271f"},
  mandatory:  {label:"Mandatory Nulls", color:"#d04a02"},
  typelist:   {label:"Typelist",        color:"#ffb600"},
  foreignKey: {label:"Foreign Keys",    color:"#2563eb"},
  custom:     {label:"Custom Rules",    color:"#7c3aed"},
  passed:     {label:"Passed",          color:"#2e7d32"},
  error:      {label:"Errors",          color:"#8a94a6"}
};

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("validation-report.html");
  const ps = getSettings().pageSize;
  if(ps) vrState.pageSize = ps;

  vrSchema = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  indexSchema();
  resolveActiveTarget();

  document.getElementById("refreshBtn").addEventListener("click", runReport);
  const ib = document.getElementById("issuesBody");
  if(ib) ib.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.vr-row");
    if(!tr) return;
    e.preventDefault();
    const slot = parseInt(tr.getAttribute("data-slot"), 10);
    if(!isNaN(slot) && vrCurrentSlice[slot]) openIssueRows(vrCurrentSlice[slot]);
  });
  buildFilterBar();

  if(!hasConfig()){
    renderBanner("warning", "bi-clipboard-x",
      "No validation checks configured yet. Set up tables and column checks on the Data Validation page first, then come back here.");
    return;
  }
  if(!vrCanRun){
    renderBanner("warning", "bi-plug",
      "This report runs the checks live — activate a SQL Server target connection to generate it.");
    return;
  }
  await buildTypelistIndex();
  await runReport();
});

/* ---------- setup helpers (shared shape with data-validation.js) ---------- */
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
function indexSchema(){
  vrFieldsByTable = {};
  if(!vrSchema || !vrSchema.entities) return;
  vrSchema.entities.forEach(e => { vrFieldsByTable[e.table || e.name] = e.fields || []; });
}
function resolveActiveTarget(){
  vrConn = null; vrCanRun = false;
  try{
    const activeId = (typeof LS_ACTIVE_TARGET !== "undefined") ? lsGet(LS_ACTIVE_TARGET, null) : lsGet("aims_active_target", null);
    if(activeId && typeof getTargetConnection === "function") vrConn = getTargetConnection(activeId);
  }catch(e){ /* none */ }
  const isFile = vrConn && (vrConn.type || "").toLowerCase() === "file system";
  vrCanRun = !!vrConn && !isFile;
}
function hasConfig(){
  const cfg = lsGet(LS_KEYS.dataValidationCfg, null);
  if(!cfg) return false;
  if(cfg.selected && cfg.selected.length && cfg.checks) return true;
  return Array.isArray(cfg.customRules) && cfg.customRules.some(r => r.enabled !== false && (r.query || r.predicate));
}
function truthy(v){ return v === true || v === 1 || /^(y|yes|true|t|1|x)$/i.test(String(v || "").trim()); }
function vrBaseName(v){
  let s = (v || "").toString().toLowerCase().trim();
  s = s.replace(/^(typekey|typelist)[._]?/, "");
  s = s.replace(/^(cctl|pctl|bctl|cc|pc|bc)_?/, "");
  return s.replace(/[^a-z0-9]/g, "");
}
async function buildTypelistIndex(){
  vrTypelistIndex = {}; vrTypelistNameByBase = {};
  try{
    const r = await fetch("/api/lookups/snapshot", {headers:{Accept:"application/json"}});
    const j = await r.json().catch(() => ({}));
    if(j && j.ok) (j.sets || []).forEach(x => {
      if((x.values || []).length){ const b = vrBaseName(x.lookupName); vrTypelistIndex[b] = x.values; vrTypelistNameByBase[b] = x.lookupName; }
    });
  }catch(e){ /* fall back to accepted */ }
}
function resolveAllowed(field){
  const base = vrBaseName(field.typeKey || field.name);
  const codes = vrTypelistIndex[base];
  if(codes && codes.length) return codes.map(v => String(v.code)).filter(s => s !== "");
  const acc = (field.accepted || "").trim();
  if(acc) return acc.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}
function parseFkRef(ref, colName){
  const parts = String(ref || "").split(".").map(s => s.trim()).filter(Boolean);
  if(parts.length >= 2) return {parentTable: parts[parts.length - 2], parentColumn: parts[parts.length - 1]};
  if(parts.length === 1) return {parentTable: parts[0], parentColumn: colName};
  return null;
}

/* ---------- build the per-table check payload from the saved DV config ---------- */
function buildTablesPayload(){
  const cfg = lsGet(LS_KEYS.dataValidationCfg, null);
  if(!cfg || !cfg.selected || !cfg.checks) return [];
  const schema = (vrConn && vrConn.schema) || "dbo";
  const out = [];
  cfg.selected.forEach(t => {
    const fields = vrFieldsByTable[t]; if(!fields) return;
    const checks = cfg.checks[t] || {};
    const keyColumns = [], mandatoryColumns = [], typelistChecks = [], fkChecks = [];
    fields.forEach(f => {
      const st = checks[f.name]; if(!st) return;
      if(st.pk) keyColumns.push(f.name);
      if(st.mandatory) mandatoryColumns.push(f.name);
      if(st.typelist){ const av = resolveAllowed(f); if(av.length) typelistChecks.push({column: f.name, allowedValues: av}); }
      if(st.fk){ const p = parseFkRef(f.fkReference, f.name); if(p && p.parentTable && p.parentColumn) fkChecks.push({column: f.name, parentTable: p.parentTable, parentColumn: p.parentColumn, parentSchema: schema}); }
    });
    if(keyColumns.length || mandatoryColumns.length || typelistChecks.length || fkChecks.length)
      out.push({table: t, keyColumns, mandatoryColumns, typelistChecks, fkChecks});
  });
  return out;
}
// The main driving table of a query — the first table after FROM (strips schema/brackets).
function drivingTable(query){
  if(!query) return "";
  const m = /\bfrom\s+(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_]+)(?:\s*\.\s*(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_]+))?/i.exec(query);
  if(!m) return "";
  return (m[2] || m[1]).replace(/^[\["]|[\]"]$/g, "");
}
// Custom rules run as full queries (may span tables) via /api/db/validate-query.
function ruleFinalQuery(r, schema){
  if(r.query && r.query.trim()) return r.query.trim();
  if(r.predicate && r.predicate.trim()){ const t = (r.tables && r.tables[0]) || r.table; if(t) return "SELECT * FROM [" + schema + "].[" + t + "] WHERE (" + r.predicate.trim() + ")"; }
  return null;
}
function buildCustomQueries(schema){
  const cfg = lsGet(LS_KEYS.dataValidationCfg, null);
  if(!cfg || !Array.isArray(cfg.customRules)) return [];
  return cfg.customRules.filter(r => r.enabled !== false)
    .map(r => ({name: r.title || "Custom rule", query: ruleFinalQuery(r, schema), tables: r.tables || (r.table ? [r.table] : [])}))
    .filter(x => x.query);
}

/* ---------- run ---------- */
async function runReport(){
  if(!vrCanRun){ showNotification("Activate a SQL Server target to run the report.", "warning"); return; }
  if(!Object.keys(vrTypelistIndex).length) await buildTypelistIndex();
  const tSchema = (vrConn && vrConn.schema) || "dbo";
  const tables = buildTablesPayload();
  const customQueries = buildCustomQueries(tSchema);
  const savedCfg = lsGet(LS_KEYS.dataValidationCfg, null);
  vrTablesSelected = (savedCfg && savedCfg.selected) ? savedCfg.selected.filter(t => vrFieldsByTable[t]).length : 0;
  if(!tables.length && !customQueries.length){
    renderBanner("warning", "bi-clipboard-x", "No checks are configured on the Data Validation page — nothing to report.");
    return;
  }
  const btn = document.getElementById("refreshBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  try{
    const pw = await ensureConnPassword(vrConn);
    if(pw === null){ showNotification("Cancelled — a password is required.", "warning"); return; }
    const base = connToConfig(Object.assign({}, vrConn, {password: pw}));
    vrIssues = []; let done = 0, failed = 0;
    const total = tables.length + customQueries.length;
    let step = 0;
    for(const t of tables){
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> ' + (++step) + '/' + total;
      const cfg = Object.assign({}, base, {
        schema: tSchema, table: t.table,
        keyColumns: t.keyColumns, mandatoryColumns: t.mandatoryColumns,
        typelistChecks: t.typelistChecks, fkChecks: t.fkChecks, sampleLimit: 10
      });
      try{
        const res = await fetch("/api/db/validate", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
        const data = await res.json();
        if(!data || !data.ok){ failed++; continue; }
        collectIssues(t.table, data); done++;
      }catch(err){ failed++; }
    }
    // custom rules — full queries that may span tables, counted read-only
    for(const cq of customQueries){
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> ' + (++step) + '/' + total;
      const cqTable = drivingTable(cq.query) || (cq.tables || [])[0] || "—";
      try{
        const res = await fetch("/api/db/validate-query", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(Object.assign({}, base, {query: cq.query, sampleLimit: 10}))});
        const data = await res.json();
        if(data && data.ok){
          if((data.count || 0) > 0) vrIssues.push({table: cqTable, type:"custom", columns:"", detail:cq.name, count:data.count, samples:"", drillable:true, spec:{query:cq.query}});
          else vrIssues.push({table: cqTable, type:"passed", columns:"", detail:cq.name + " — no violations found", count:0, samples:"", drillable:false, spec:{}});
          done++;
        }
        else {
          // Surface the rule's SQL error in the report instead of failing silently.
          failed++;
          vrIssues.push({table: cqTable, type:"error", columns:"",
            detail: "Custom rule “" + cq.name + "” failed: " + ((data && data.error) || "the query could not run"),
            count:0, samples:"", drillable:false, spec:{}});
        }
      }catch(err){
        failed++;
        vrIssues.push({table: cqTable, type:"error", columns:"",
          detail: "Custom rule “" + cq.name + "” failed: backend not reachable.",
          count:0, samples:"", drillable:false, spec:{}});
      }
    }
    vrTablesChecked = done;
    vrState.page = 1;
    renderBanner("primary", "bi-hdd-network",
      "Report for " + (vrConn.name || vrConn.database || "target") + " — " + done + " check(s) run" + (failed ? (", " + failed + " failed") : "") + ".");
    renderAll();
    if(failed) showNotification("Report generated — " + failed + " of " + total + " checks failed to run.", failed === total ? "danger" : "warning");
    else showNotification("Report generated.", "success");
  }catch(err){
    showNotification("Backend not reachable — is the server running? (cd server && python main.py)", "danger");
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
  }
}
// A few sample values, escaped as plain text (context alongside the drill-down).
function vrSamples(list){
  return (list || []).map(s => escapeHtml(String(s.value)) + " ×" + s.count).join("  ·  ");
}
// The client's product foreign-key column on child tables: claim→claimid, policy→policyid, billing→billingid.
function productKeyColumn(){
  const p = (typeof getActiveClientProduct === "function") ? (getActiveClientProduct() || "") : "";
  return p ? (p.toLowerCase() + "id") : "";
}

function collectIssues(table, data){
  const fields = vrFieldsByTable[table] || [];
  const tSchema = (vrConn && vrConn.schema) || "dbo";
  (data.checks || []).forEach(c => {
    if(c.error){ vrIssues.push({table, type:c.type, columns:(c.columns||[]).join(", "), detail:"Check error: " + c.error, count:0, samples:"", drillable:false}); return; }
    if(c.type === "duplicate"){
      if((c.count||0) <= 0) return;   // clean check — don't show a "0 duplicates" row
      vrIssues.push({table, type:"duplicate", columns:(c.columns||[]).join(", "),
        detail:(c.groupCount||0) + " duplicate key group(s)", count:c.count || 0,
        samples:(c.samples||[]).map(s => "[" + escapeHtml(String(s.key)) + "] ×" + s.count).join("  ·  "),
        drillable:(c.count||0) > 0, spec:{keyColumns:(c.columns||[])}});
    }else if(c.type === "mandatory"){
      vrIssues.push({table, type:"mandatory", columns:(c.columns||[]).join(", "), detail:"NULLs in required column", count:c.count || 0, samples:"",
        drillable:(c.count||0) > 0, spec:{column:(c.columns||[])[0]}});
    }else if(c.type === "typelist"){
      const col = (c.columns||[])[0];
      const field = fields.find(f => (f.name||"") === col) || fields.find(f => (f.name||"").toLowerCase() === String(col||"").toLowerCase());
      const allowed = field ? resolveAllowed(field) : [];
      const base = field ? vrBaseName(field.typeKey || field.name) : "";
      const typelistName = vrTypelistNameByBase[base] || "";
      vrIssues.push({table, type:"typelist", columns:(c.columns||[]).join(", "), detail:"values outside the typelist domain" + (typelistName ? (" (" + typelistName + ")") : ""), count:c.count || 0,
        samples:vrSamples(c.samples),
        drillable:(c.count||0) > 0 && allowed.length > 0, spec:{column:col, allowedValues:allowed, typelistName:typelistName}});
    }else if(c.type === "foreignKey"){
      const fk = parseFkRef(c.reference, (c.columns||[])[0]) || {};
      vrIssues.push({table, type:"foreignKey", columns:(c.columns||[]).join(", "), detail:"orphans → " + (c.reference || ""), count:c.count || 0,
        samples:vrSamples(c.samples),
        drillable:(c.count||0) > 0, spec:{column:(c.columns||[])[0], parentTable:fk.parentTable, parentColumn:fk.parentColumn, parentSchema:tSchema}});
    }else if(c.type === "custom"){
      vrIssues.push({table, type:"custom", columns:"", detail:(c.name || "Custom rule"), count:c.count || 0, samples:"", drillable:false, spec:{}});
    }
  });
}

function injectIssueModal(){
  if(document.getElementById("vrIssueModal")) return;
  document.body.insertAdjacentHTML("beforeend",
    '<div class="modal fade" id="vrIssueModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered modal-xl">' +
    '<div class="modal-content"><div class="modal-header">' +
      '<h5 class="modal-title"><i class="bi bi-list-columns-reverse me-1"></i> Offending records <span id="vrIssueTitle" class="text-muted-2 fw-normal ms-1"></span></h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
    '<div class="modal-body" id="vrIssueBody" style="max-height:70vh;overflow:auto;"></div>' +
    '<div class="modal-footer"><button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Close</button></div>' +
    '</div></div></div>');
}

// Value of a named column in a returned row (case-insensitive), or "" if absent.
function cellVal(cols, row, name){
  if(!name) return "";
  const i = (cols || []).findIndex(c => String(c).toLowerCase() === String(name).toLowerCase());
  return i >= 0 ? row[i] : "";
}
// A plain-English explanation of why a given row is an offending record.
function issueRowMessage(issue, cols, row){
  const spec = issue.spec || {};
  const val = cellVal(cols, row, spec.column);
  const q = v => '"' + String(v) + '"';
  switch(issue.type){
    case "foreignKey":
      return spec.column + " " + q(val) + " is not available in " +
        (spec.parentTable || "the referenced table") + (spec.parentColumn ? ("." + spec.parentColumn) : "") +
        " — orphaned reference.";
    case "mandatory":
      return "Required column " + q(spec.column) + " is missing (NULL) for this record.";
    case "typelist":
      return q(val) + " in " + spec.column + " is not an allowed value" +
        (spec.typelistName ? (" as per typelist " + spec.typelistName) : "") + ".";
    case "duplicate": {
      const n = cellVal(cols, row, "duplicate_count");
      return "This " + ((spec.keyColumns || []).join(", ") || "key") + " combination occurs " +
        (n ? (n + " times") : "more than once") + " (must be unique).";
    }
    case "custom":
      return "Violates rule: " + (issue.detail || "custom rule") + ".";
    default:
      return "";
  }
}

/* Row drill-down: query the live target for ALL offending records of one issue and show them. */
async function openIssueRows(issue){
  if(!issue || !issue.drillable) return;
  if(!vrConn){ showNotification("No active SQL Server target to query.", "warning"); return; }
  const meta = VR_TYPE_META[issue.type] || {label:issue.type};
  injectIssueModal();
  const body = document.getElementById("vrIssueBody");
  const titleEl = document.getElementById("vrIssueTitle");
  if(titleEl) titleEl.textContent = "· " + issue.table + " · " + meta.label;
  new bootstrap.Modal(document.getElementById("vrIssueModal")).show();
  body.innerHTML = '<div class="text-center text-muted-2 py-4"><span class="spinner-border spinner-border-sm me-2"></span>Reading offending records from ' + escapeHtml(issue.table) + ' …</div>';

  const pw = await ensureConnPassword(vrConn);
  if(pw === null){ body.innerHTML = '<div class="text-xs text-muted-2">Cancelled — a password is required to query the target.</div>'; return; }
  const schema = (vrConn && vrConn.schema) || "dbo";
  const fields = vrFieldsByTable[issue.table] || [];
  const hasCol = name => fields.some(f => (f.name||"").toLowerCase() === String(name||"").toLowerCase());
  const spec = issue.spec || {};

  // selectColumns: product key (claimid/policyid) if present, the offending column, then publicid.
  const sel = [];
  const pk = productKeyColumn();
  const hasPk = pk && hasCol(pk);
  if(hasPk) sel.push(pk);
  if(spec.column && sel.map(s=>s.toLowerCase()).indexOf(String(spec.column).toLowerCase()) === -1) sel.push(spec.column);
  if(hasCol("publicid") && sel.map(s=>s.toLowerCase()).indexOf("publicid") === -1) sel.push("publicid");

  const payload = Object.assign(connToConfig(Object.assign({}, vrConn, {password: pw})), {
    schema: schema, table: issue.table, type: issue.type,
    selectColumns: sel,
    orderBy: hasPk ? pk : "",   // group offending rows by the client's product key (claimid/policyid)
    column: spec.column, parentTable: spec.parentTable, parentColumn: spec.parentColumn, parentSchema: spec.parentSchema,
    allowedValues: spec.allowedValues, keyColumns: spec.keyColumns, predicate: spec.predicate, query: spec.query,
    limit: 200
  });
  try{
    const res = await fetch("/api/db/issue-rows", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){
      body.innerHTML = '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' +
        escapeHtml((j && j.error) || "Could not read the offending rows.") + '</div>';
      return;
    }
    const cols = j.columns || [], rows = j.rows || [];
    const note = '<div class="text-xs text-muted-2 mb-2">' +
      (rows.length ? ('Showing ' + rows.length + (j.truncated ? ("+ of " + Number(issue.count||0).toLocaleString()) : (" of " + Number(issue.count||0).toLocaleString())) + ' offending record(s).') : '') +
      '</div>';
    if(!rows.length){
      body.innerHTML = '<div class="hint-note"><i class="bi bi-info-circle"></i> No offending rows returned.</div>';
      return;
    }
    const head = '<tr><th>ErrorType</th><th>Issue</th>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join("") + '</tr>';
    const trs = rows.map(r =>
      '<tr><td><span class="badge-soft" style="background:' + (meta.color||"#8a94a6") + '22;color:' + (meta.color||"#8a94a6") + ';">' + escapeHtml(meta.label) + '</span></td>' +
      '<td class="text-xs">' + escapeHtml(issueRowMessage(issue, cols, r)) + '</td>' +
      r.map(v => '<td class="mono text-xs">' + escapeHtml(String(v)) + '</td>').join("") + '</tr>').join("");
    body.innerHTML = note +
      '<div class="table-responsive-el"><table class="grid-table"><thead>' + head + '</thead><tbody>' + trs + '</tbody></table></div>';
  }catch(e){ body.innerHTML = '<div class="text-xs text-muted-2">Cannot reach the server.</div>'; }
}

/* ---------- render ---------- */
function renderAll(){ renderKpis(); renderCharts(); buildFilterBar(); renderTable(); }

function sumByType(type){ return vrIssues.filter(i => i.type === type).reduce((a, i) => a + (i.count || 0), 0); }

function renderKpis(){
  const dup = sumByType("duplicate"), man = sumByType("mandatory"), tl = sumByType("typelist"), fk = sumByType("foreignKey");
  document.getElementById("kpiTables").textContent = vrTablesSelected;
  document.getElementById("kpiTotal").textContent = (dup + man + tl + fk).toLocaleString();
  document.getElementById("kpiDuplicates").textContent = dup.toLocaleString();
  document.getElementById("kpiMandatory").textContent = man.toLocaleString();
  document.getElementById("kpiTypelist").textContent = tl.toLocaleString();
  document.getElementById("kpiForeignKey").textContent = fk.toLocaleString();
}

function themeText(){ return document.body.classList.contains("theme-dark") ? "#e8e8e8" : "#252525"; }
function themeGrid(){ return document.body.classList.contains("theme-dark") ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.08)"; }

function renderCharts(){
  if(typeof Chart === "undefined") return;   // CDN blocked — KPIs + table still work
  Chart.defaults.color = themeText();
  Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  // Issues by type (doughnut)
  const types = ["duplicate", "mandatory", "typelist", "foreignKey", "custom"];
  const typeVals = types.map(sumByType);
  const typeCtx = document.getElementById("chartType");
  if(chartTypeObj) chartTypeObj.destroy();
  const hasType = typeVals.some(v => v > 0);
  chartTypeObj = new Chart(typeCtx, {
    type: "doughnut",
    data: {
      labels: types.map(t => VR_TYPE_META[t].label),
      datasets: [{ data: hasType ? typeVals : types.map(() => 1),
                   backgroundColor: types.map(t => VR_TYPE_META[t].color),
                   borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { enabled: hasType, callbacks: { label: (c) => c.label + ": " + Number(c.raw).toLocaleString() } }
      }
    }
  });

  // Issues by table (horizontal bar, worst first, top 15)
  const byTable = {};
  vrIssues.forEach(i => { byTable[i.table] = (byTable[i.table] || 0) + (i.count || 0); });
  const rows = Object.keys(byTable).map(t => [t, byTable[t]]).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const tableCtx = document.getElementById("chartTable");
  if(chartTableObj) chartTableObj.destroy();
  chartTableObj = new Chart(tableCtx, {
    type: "bar",
    data: {
      labels: rows.map(r => r[0]),
      datasets: [{ label: "Issues (rows)", data: rows.map(r => r[1]), backgroundColor: "#d04a02", borderRadius: 4 }]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => Number(c.raw).toLocaleString() + " rows" } } },
      scales: {
        x: { beginAtZero: true, grid: { color: themeGrid() }, ticks: { precision: 0 } },
        y: { grid: { display: false } }
      }
    }
  });
}

/* ---------- details table ---------- */
function buildFilterBar(){
  const bar = document.getElementById("filterBar");
  if(!bar) return;
  const tables = Array.from(new Set(vrIssues.map(i => i.table))).sort();
  const typeOpts = ['<option value="">All validations</option>'].concat(
    Object.keys(VR_TYPE_META).map(k => '<option value="' + k + '"' + (vrState.filters.type === k ? " selected" : "") + '>' + VR_TYPE_META[k].label + '</option>')).join("");
  const tblOpts = ['<option value="">All tables</option>'].concat(
    tables.map(t => '<option value="' + escapeHtml(t) + '"' + (vrState.filters.table === t ? " selected" : "") + '>' + escapeHtml(t) + '</option>')).join("");
  bar.innerHTML =
    '<select class="form-select form-select-sm" id="fltType" style="max-width:170px;">' + typeOpts + '</select>' +
    '<select class="form-select form-select-sm" id="fltTable" style="max-width:220px;">' + tblOpts + '</select>' +
    '<input type="text" class="form-control form-control-sm" id="fltQ" placeholder="Search column…" style="max-width:200px;" value="' + escapeHtml(vrState.filters.q) + '">';
  document.getElementById("fltType").addEventListener("change", e => { vrState.filters.type = e.target.value; vrState.page = 1; renderTable(); });
  document.getElementById("fltTable").addEventListener("change", e => { vrState.filters.table = e.target.value; vrState.page = 1; renderTable(); });
  document.getElementById("fltQ").addEventListener("input", e => { vrState.filters.q = (e.target.value || "").toLowerCase().trim(); vrState.page = 1; renderTable(); });
}
function filteredIssues(){
  return vrIssues.filter(i =>
    (!vrState.filters.type || i.type === vrState.filters.type) &&
    (!vrState.filters.table || i.table === vrState.filters.table) &&
    (!vrState.filters.q || (i.columns || "").toLowerCase().includes(vrState.filters.q)));
}
function renderTable(){
  const body = document.getElementById("issuesBody");
  if(!body) return;
  const all = filteredIssues();
  if(!all.length){
    vrCurrentSlice = [];
    body.innerHTML = '<tr><td colspan="7" class="vr-empty">' +
      (vrIssues.length ? "No issues match the current filter." : "No issues found — run the report, or your data is clean. 🎉") + '</td></tr>';
    document.getElementById("pgInfo").textContent = "";
    document.getElementById("pgControls").innerHTML = "";
    return;
  }
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / vrState.pageSize));
  if(vrState.page > pages) vrState.page = pages;
  const start = (vrState.page - 1) * vrState.pageSize;
  const slice = all.slice(start, start + vrState.pageSize);
  vrCurrentSlice = slice;
  body.innerHTML = slice.map((i, slot) => {
    const meta = VR_TYPE_META[i.type] || {label:i.type, color:"#8a94a6"};
    const view = i.drillable
      ? '<a href="#" class="vr-drill" title="Show all offending records"><i class="bi bi-search"></i> View</a>'
      : '<span class="text-muted-2 text-xs">—</span>';
    return '<tr' + (i.drillable ? ' class="vr-row" data-slot="' + slot + '"' : '') + '>' +
      '<td>' + view + '</td>' +
      '<td>' + escapeHtml(i.table) + '</td>' +
      '<td><span class="badge-soft" style="background:' + meta.color + '22;color:' + meta.color + ';">' + escapeHtml(meta.label) + '</span></td>' +
      '<td class="mono">' + escapeHtml(i.columns) + '</td>' +
      '<td>' + escapeHtml(i.detail) + '</td>' +
      '<td>' + Number(i.count || 0).toLocaleString() + '</td>' +
      '<td class="text-xs">' + (i.samples || "") + '</td>' +
    '</tr>';
  }).join("");
  document.getElementById("pgInfo").textContent = "Showing " + (start + 1) + "–" + Math.min(start + vrState.pageSize, total) + " of " + total;
  const ctrl = document.getElementById("pgControls");
  ctrl.innerHTML =
    '<button class="btn btn-sm btn-outline-soft" ' + (vrState.page <= 1 ? "disabled" : "") + ' id="pgPrev">Prev</button>' +
    '<span class="mx-2 text-xs">Page ' + vrState.page + ' / ' + pages + '</span>' +
    '<button class="btn btn-sm btn-outline-soft" ' + (vrState.page >= pages ? "disabled" : "") + ' id="pgNext">Next</button>';
  const prev = document.getElementById("pgPrev"), next = document.getElementById("pgNext");
  if(prev) prev.addEventListener("click", () => { if(vrState.page > 1){ vrState.page--; renderTable(); } });
  if(next) next.addEventListener("click", () => { if(vrState.page < pages){ vrState.page++; renderTable(); } });
}

function renderBanner(kind, icon, text){
  const el = document.getElementById("reportBanner");
  if(!el) return;
  el.innerHTML = '<div class="card-el d-flex align-items-center gap-2" style="padding:.6rem .9rem;">' +
    '<i class="bi ' + icon + ' text-' + (kind === "warning" ? "warning" : "primary") + '"></i>' +
    '<span>' + escapeHtml(text) + '</span></div>';
}
