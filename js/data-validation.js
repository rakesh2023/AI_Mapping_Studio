/* =========================================================================
   data-validation.js - Data Validation page
   Two-panel: pick target tables (left) -> tick per-column checks (right).
   Checks: PK (uniqueness/duplicate key), Mandatory (not-null), TypeList
   (coded-domain membership), FK (foreign key orphans).

   Three actions:
     - AI Suggest Checks : POST /api/ai/validation-suggest -> pre-ticks boxes
       from each column's description / datatype / typelist.
     - Generate SQL      : POST /api/ai/validation-sql -> one combined T-SQL
       script the user runs on SQL Server themselves.
     - Run Validation    : POST /api/db/validate -> live results (optional path;
       needs a live SQL Server target connection).
   ========================================================================= */

let dvSchema = null;         // getTargetSchema()
let dvConn = null;           // active target connection object
let dvCanRunLive = false;    // live Run needs a SQL Server target connection
let dvFieldsByTable = {};    // table -> [field, ...]
let dvSelected = new Set();  // selected table names
let dvChecks = {};           // table -> col -> {pk, mandatory, typelist, fk}
let dvOrigin = {};           // table -> col -> {pk, mandatory, typelist, fk} each 'schema'|'ai'|'user'
let dvAllowed = {};          // table -> col -> [allowed value strings] (for typelist SQL)
let dvDomainName = {};       // table -> col -> domain source name (typelist name or "Accepted values")
let dvFk = {};               // table -> col -> {parentTable, parentColumn}
let dvTypelistIndex = {};    // normalized typelist base -> [{code,...}]
let dvTypelistNameByBase = {}; // normalized base -> physical typelist name (e.g. cctl_checkstatus)
let dvSql = "";              // last generated SQL
let dvColFilter = "";        // right-panel column-name search
let dvIssues = [];           // live-run results
let dvState = { page:1, pageSize:25, filters:{type:"", table:""} };

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-validation.html");
  const ps = getSettings().pageSize;
  if(ps) dvState.pageSize = ps;

  dvSchema = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  indexSchema();
  resolveActiveTarget();
  renderBanner();

  if(dvSchema && dvSchema.entities && dvSchema.entities.length){
    await buildTypelistIndex();
    loadConfig();
    buildTableList();
    renderCheckGrid();
  }

  // buttons
  document.getElementById("aiSuggestBtn").addEventListener("click", aiSuggest);
  document.getElementById("genSqlBtn").addEventListener("click", generateSql);
  document.getElementById("runValidationBtn").addEventListener("click", runValidation);
  document.getElementById("clearValidationBtn").addEventListener("click", clearResults);
  document.getElementById("copySqlBtn").addEventListener("click", copySql);
  document.getElementById("downloadSqlBtn").addEventListener("click", downloadSql);
  const search = document.getElementById("tableSearch");
  if(search) search.addEventListener("input", buildTableList);
  const colSearch = document.getElementById("colSearch");
  if(colSearch) colSearch.addEventListener("input", e => { dvColFilter = (e.target.value || "").toLowerCase().trim(); renderCheckGrid(); });
  const selAll = document.getElementById("selectAllTables");
  if(selAll) selAll.addEventListener("change", onSelectAll);

  buildFilterBar();
  renderIssues();
});

/* ---------- connection cfg (same shape as profiling.js) ---------- */
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

// POST JSON and classify the outcome so failures are actionable rather than a generic toast.
// Returns {netError} | {ok:false, status, error} | {ok:true, data}.
async function apiPost(url, payload){
  let res;
  try{
    res = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
  }catch(e){ return {netError:true}; }
  let data = null;
  try{ data = await res.json(); }catch(_){ /* non-JSON (404/500 HTML, etc.) */ }
  if(!data){
    // Reached the server but got no JSON — usually a 404 (endpoint missing → restart the
    // backend) or a 500 error page.
    const hint = res.status === 404
      ? "endpoint not found — restart the backend so it loads the new routes (cd server && python main.py)"
      : ("server error HTTP " + res.status);
    return {ok:false, status:res.status, error:hint};
  }
  if(!data.ok) return {ok:false, status:res.status, error:(data.error || ("HTTP " + res.status))};
  return {ok:true, data};
}

function indexSchema(){
  dvFieldsByTable = {};
  if(!dvSchema || !dvSchema.entities) return;
  dvSchema.entities.forEach(e => { dvFieldsByTable[e.table || e.name] = e.fields || []; });
}

function resolveActiveTarget(){
  dvConn = null; dvCanRunLive = false;
  try{
    const activeId = (typeof LS_ACTIVE_TARGET !== "undefined") ? lsGet(LS_ACTIVE_TARGET, null) : lsGet("aims_active_target", null);
    if(activeId && typeof getTargetConnection === "function") dvConn = getTargetConnection(activeId);
  }catch(e){ /* no connection store */ }
  const isFile = dvConn && (dvConn.type || "").toLowerCase() === "file system";
  dvCanRunLive = !!dvConn && !isFile;
}

function renderBanner(){
  const el = document.getElementById("targetBanner");
  if(!el) return;
  const runBtn = document.getElementById("runValidationBtn");
  const aiBtn = document.getElementById("aiSuggestBtn");
  const sqlBtn = document.getElementById("genSqlBtn");
  const hasSchema = !!(dvSchema && dvSchema.entities && dvSchema.entities.length);

  if(!hasSchema){
    el.innerHTML = notice("warning", "bi-exclamation-triangle",
      "No active target schema. Configure a target on the Target System page, then return here.");
    [runBtn, aiBtn, sqlBtn].forEach(b => { if(b) b.disabled = true; });
    return;
  }
  // AI Suggest + Generate SQL work off the schema (no live DB needed).
  if(aiBtn) aiBtn.disabled = false;
  if(sqlBtn) sqlBtn.disabled = false;
  if(runBtn) runBtn.disabled = !dvCanRunLive;

  const name = dvConn ? (dvConn.name || dvConn.server || "") : "";
  const liveNote = dvCanRunLive
    ? '<span class="badge-soft badge-high ms-auto"><i class="bi bi-lightning-charge"></i> live Run enabled</span>'
    : '<span class="badge-soft badge-gray ms-auto">SQL-generation mode — connect a SQL Server target to enable live Run</span>';
  el.innerHTML =
    '<div class="card-el d-flex align-items-center gap-2" style="padding:.6rem .9rem;">' +
      '<i class="bi bi-hdd-network text-primary"></i>' +
      '<span>Target: <b>' + escapeHtml(name || "(schema only)") + '</b>' +
        (dvConn && dvConn.database ? ' &middot; <span class="text-muted-2">' + escapeHtml(dvConn.database) + '</span>' : '') + '</span>' +
      liveNote +
    '</div>';
}

function notice(kind, icon, text){
  return '<div class="card-el d-flex align-items-center gap-2" style="padding:.6rem .9rem;">' +
    '<i class="bi ' + icon + ' text-' + (kind === "warning" ? "warning" : "primary") + '"></i>' +
    '<span>' + escapeHtml(text) + '</span></div>';
}

/* ---------- typelist index (allowed values) ---------- */
function dvBaseName(v){
  let s = (v || "").toString().toLowerCase().trim();
  s = s.replace(/^(typekey|typelist)[._]?/, "");
  s = s.replace(/^(cctl|pctl|bctl|cc|pc|bc)_?/, "");
  return s.replace(/[^a-z0-9]/g, "");
}
async function buildTypelistIndex(){
  dvTypelistIndex = {}; dvTypelistNameByBase = {};
  try{
    const r = await fetch("/api/lookups/snapshot", {headers:{Accept:"application/json"}});
    const j = await r.json().catch(() => ({}));
    if(j && j.ok) (j.sets || []).forEach(x => {
      if((x.values || []).length){
        const base = dvBaseName(x.lookupName);
        dvTypelistIndex[base] = x.values;
        dvTypelistNameByBase[base] = x.lookupName;
      }
    });
  }catch(e){ /* leave empty -> typelist checks fall back to the 'accepted' column */ }
}
function resolveAllowed(field){
  const base = dvBaseName(field.typeKey || field.name);
  const codes = dvTypelistIndex[base];
  if(codes && codes.length) return codes.map(v => String(v.code)).filter(s => s !== "");
  const acc = (field.accepted || "").trim();
  if(acc) return acc.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}
// The domain's source label for the hover tooltip: the physical typelist name when the
// values come from an imported Guidewire typelist, else "Accepted values", else "".
function resolveDomainName(field){
  const base = dvBaseName(field.typeKey || field.name);
  if(dvTypelistIndex[base] && dvTypelistIndex[base].length)
    return dvTypelistNameByBase[base] || (field.typeKey || "").replace(/^typekey\./i, "") || "Typelist";
  if((field.accepted || "").trim()) return "Accepted values";
  return "";
}
function truthy(v){ return v === true || v === 1 || /^(y|yes|true|t|1|x)$/i.test(String(v || "").trim()); }
function parseFkRef(ref, colName){
  const parts = String(ref || "").split(".").map(s => s.trim()).filter(Boolean);
  if(parts.length >= 2) return {parentTable: parts[parts.length - 2], parentColumn: parts[parts.length - 1]};
  if(parts.length === 1) return {parentTable: parts[0], parentColumn: colName};
  return null;
}

/* ---------- per-table check state ---------- */
function ensureTableState(table){
  if(dvChecks[table]){ ensureOrigin(table); return; }   // already initialized (or restored from saved cfg)
  const fields = dvFieldsByTable[table] || [];
  dvChecks[table] = {}; dvAllowed[table] = {}; dvFk[table] = {}; dvDomainName[table] = {};
  fields.forEach(f => {
    dvAllowed[table][f.name] = resolveAllowed(f);
    dvDomainName[table][f.name] = resolveDomainName(f);
    const p = truthy(f.fk) ? parseFkRef(f.fkReference, f.name) : null;
    if(p && p.parentTable && p.parentColumn) dvFk[table][f.name] = p;
    dvChecks[table][f.name] = {
      pk: truthy(f.pk),
      mandatory: truthy(f.mandatory),
      typelist: !!(dvAllowed[table][f.name].length) && !!((f.typeKey && String(f.typeKey).trim()) || (f.accepted && String(f.accepted).trim())),
      fk: !!(dvFk[table][f.name])
    };
  });
  ensureOrigin(table);
}
// Origin of each check ('schema' default, 'ai' from AI Suggest, 'user' from a manual toggle).
function ensureOrigin(table){
  if(dvOrigin[table]) return;
  dvOrigin[table] = {};
  (dvFieldsByTable[table] || []).forEach(f => {
    dvOrigin[table][f.name] = {pk:"schema", mandatory:"schema", typelist:"schema", fk:"schema"};
  });
}
function originClass(o){ return o === "ai" ? " origin-ai" : (o === "user" ? " origin-user" : ""); }
// Allowed/FK maps are needed even for saved-cfg tables (they aren't persisted).
function ensureDerived(table){
  if(dvAllowed[table] && dvFk[table] && dvDomainName[table]) return;
  const fields = dvFieldsByTable[table] || [];
  dvAllowed[table] = dvAllowed[table] || {}; dvFk[table] = dvFk[table] || {}; dvDomainName[table] = dvDomainName[table] || {};
  fields.forEach(f => {
    if(!(f.name in dvAllowed[table])) dvAllowed[table][f.name] = resolveAllowed(f);
    if(!(f.name in dvDomainName[table])) dvDomainName[table][f.name] = resolveDomainName(f);
    if(!(f.name in dvFk[table])){
      const p = truthy(f.fk) ? parseFkRef(f.fkReference, f.name) : null;
      if(p && p.parentTable && p.parentColumn) dvFk[table][f.name] = p;
    }
  });
}

/* ---------- left panel: table list ---------- */
function buildTableList(){
  const wrap = document.getElementById("tableList");
  if(!wrap) return;
  const q = (document.getElementById("tableSearch").value || "").toLowerCase().trim();
  const tables = Object.keys(dvFieldsByTable).filter(t => !q || t.toLowerCase().includes(q));
  wrap.innerHTML = tables.map(t =>
    '<label class="dv-tbl-item' + (dvSelected.has(t) ? " active" : "") + '">' +
      '<input type="checkbox" class="dv-tbl-cb" data-t="' + escapeHtml(t) + '"' + (dvSelected.has(t) ? " checked" : "") + '>' +
      '<span class="dv-tbl-name">' + escapeHtml(t) + '</span>' +
      '<span class="dv-tbl-meta">' + (dvFieldsByTable[t] || []).length + '</span>' +
    '</label>').join("") || '<div class="dv-empty">No tables match.</div>';
  wrap.querySelectorAll(".dv-tbl-cb").forEach(cb => cb.addEventListener("change", onTableToggle));
  updateSelCount();
}
function onTableToggle(e){
  const t = e.target.getAttribute("data-t");
  if(e.target.checked){ dvSelected.add(t); ensureTableState(t); ensureDerived(t); }
  else dvSelected.delete(t);
  e.target.closest(".dv-tbl-item").classList.toggle("active", e.target.checked);
  updateSelCount();
  persistConfig();
  renderCheckGrid();
}
function onSelectAll(e){
  const q = (document.getElementById("tableSearch").value || "").toLowerCase().trim();
  const tables = Object.keys(dvFieldsByTable).filter(t => !q || t.toLowerCase().includes(q));
  if(e.target.checked) tables.forEach(t => { dvSelected.add(t); ensureTableState(t); ensureDerived(t); });
  else tables.forEach(t => dvSelected.delete(t));
  buildTableList();
  persistConfig();
  renderCheckGrid();
}
function updateSelCount(){
  const el = document.getElementById("selCount");
  if(el) el.textContent = dvSelected.size ? (dvSelected.size + " selected") : "";
}

/* ---------- right panel: column check grid ---------- */
function renderCheckGrid(){
  const body = document.getElementById("checkBody");
  if(!body) return;
  const tables = Object.keys(dvFieldsByTable).filter(t => dvSelected.has(t));
  if(!tables.length){
    body.innerHTML = '<tr><td colspan="6" class="dv-empty">Select one or more tables on the left to configure their column checks.</td></tr>';
    return;
  }
  let html = "";
  let anyRow = false;
  tables.forEach(t => {
    ensureTableState(t); ensureDerived(t);
    ensureOrigin(t);
    const fields = (dvFieldsByTable[t] || []).filter(f =>
      !dvColFilter || (f.name || "").toLowerCase().includes(dvColFilter));
    if(!fields.length) return;   // no columns in this table match the search
    anyRow = true;
    fields.forEach((f, i) => {
      const st = dvChecks[t][f.name] || {};
      const og = dvOrigin[t][f.name] || {};
      const fkRef = dvFk[t][f.name];
      // typelist: only meaningful when a domain exists. No domain -> plain disabled box, no text.
      const tlVals = dvAllowed[t][f.name] || [];
      const tlCount = tlVals.length;
      const tlName = (dvDomainName[t] && dvDomainName[t][f.name]) || "";
      const tlTip = tlCount
        ? (tlName ? tlName + " — " : "") + tlVals.slice(0, 5).join(", ") + (tlCount > 5 ? " …(+" + (tlCount - 5) + " more)" : "")
        : "";
      html +=
        '<tr' + (i === 0 ? ' style="border-top:2px solid var(--border);"' : '') + '>' +
          '<td class="dv-tname-cell">' + (i === 0 ? escapeHtml(t) : '') + '</td>' +
          '<td class="dv-colname">' + escapeHtml(f.name) +
            (f.dataType ? ' <span class="text-muted-2 text-xs">' + escapeHtml(String(f.dataType)) + '</span>' : '') + '</td>' +
          checkCell(t, f.name, "pk", st.pk, og.pk, {}) +
          checkCell(t, f.name, "mandatory", st.mandatory, og.mandatory, {}) +
          checkCell(t, f.name, "typelist", st.typelist, og.typelist, {disabled: !tlCount, tip: tlTip}) +
          '<td class="dv-check' + originClass(og.fk) + '"' + (fkRef ? ' title="' + escapeHtml(fkRef.parentTable + "." + fkRef.parentColumn) + '"' : '') + '>' +
            '<input type="checkbox" class="dv-chk" data-t="' + escapeHtml(t) + '" data-c="' + escapeHtml(f.name) + '" data-k="fk"' +
              (st.fk ? " checked" : "") + (fkRef ? "" : " disabled") + '>' +
            (fkRef ? '<div class="dv-fkref">' + escapeHtml(fkRef.parentTable + "." + fkRef.parentColumn) + '</div>' : '') +
          '</td>' +
        '</tr>';
    });
  });
  if(!anyRow){
    body.innerHTML = '<tr><td colspan="6" class="dv-empty">No columns match &ldquo;' + escapeHtml(dvColFilter) + '&rdquo;.</td></tr>';
    return;
  }
  body.innerHTML = html;
  body.querySelectorAll(".dv-chk").forEach(cb => cb.addEventListener("change", onCheckToggle));
}
// opts: {disabled, tip, label}. tip -> hover title on the cell; label -> small text under the box.
function checkCell(t, col, k, checked, origin, opts){
  opts = opts || {};
  const tip = opts.tip ? ' title="' + escapeHtml(opts.tip) + '"' : '';
  return '<td class="dv-check' + originClass(origin) + '"' + tip + '>' +
    '<input type="checkbox" class="dv-chk" data-t="' + escapeHtml(t) + '" data-c="' + escapeHtml(col) + '" data-k="' + k + '"' +
      (checked ? " checked" : "") + (opts.disabled ? " disabled" : "") + '>' +
    (opts.label ? '<div class="dv-fkref">' + escapeHtml(opts.label) + '</div>' : '') +
  '</td>';
}
function onCheckToggle(e){
  const t = e.target.getAttribute("data-t"), c = e.target.getAttribute("data-c"), k = e.target.getAttribute("data-k");
  if(!dvChecks[t]) dvChecks[t] = {};
  if(!dvChecks[t][c]) dvChecks[t][c] = {pk:false, mandatory:false, typelist:false, fk:false};
  dvChecks[t][c][k] = e.target.checked;
  // a manual change turns this cell green
  ensureOrigin(t);
  if(!dvOrigin[t][c]) dvOrigin[t][c] = {pk:"schema", mandatory:"schema", typelist:"schema", fk:"schema"};
  dvOrigin[t][c][k] = "user";
  const td = e.target.closest("td");
  if(td){ td.classList.remove("origin-ai"); td.classList.add("origin-user"); }
  persistConfig();
}

/* ---------- persistence (device-local) ---------- */
function persistConfig(){
  const checks = {}, origin = {};
  dvSelected.forEach(t => { if(dvChecks[t]) checks[t] = dvChecks[t]; if(dvOrigin[t]) origin[t] = dvOrigin[t]; });
  try{ lsSet(LS_KEYS.dataValidationCfg, {selected: Array.from(dvSelected), checks, origin}); }catch(e){ /* ignore quota */ }
}
function loadConfig(){
  const saved = lsGet(LS_KEYS.dataValidationCfg, null);
  if(!saved) return;
  (saved.selected || []).forEach(t => { if(dvFieldsByTable[t]) dvSelected.add(t); });
  const checks = saved.checks || {};
  const origin = saved.origin || {};
  Object.keys(checks).forEach(t => {
    if(!dvFieldsByTable[t]) return;
    dvChecks[t] = checks[t];
    if(origin[t]) dvOrigin[t] = origin[t];
    ensureDerived(t);
  });
}

/* ---------- AI Suggest Checks ---------- */
async function aiSuggest(){
  const tables = Object.keys(dvFieldsByTable).filter(t => dvSelected.has(t));
  if(!tables.length){ showNotification("Select at least one table first.", "warning"); return; }
  const columns = [];
  tables.forEach(t => (dvFieldsByTable[t] || []).forEach(f => columns.push({
    table: t, name: f.name, dataType: f.dataType || "", description: f.description || "",
    typeKey: f.typeKey || "", accepted: f.accepted || "", fkReference: f.fkReference || "",
    pk: truthy(f.pk), fk: truthy(f.fk), mandatory: truthy(f.mandatory)
  })));

  const btn = document.getElementById("aiSuggestBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Analyzing…';
  try{
    const r = await apiPost("/api/ai/validation-suggest", {columns});
    if(r.netError){ showNotification("Backend not reachable — is the server running? (cd server && python main.py)", "danger"); return; }
    if(!r.ok){ showNotification("AI suggest failed: " + r.error, "danger"); return; }
    const data = r.data;
    let applied = 0;
    (data.columns || []).forEach(sc => {
      const t = sc.table, c = sc.name;
      if(!dvChecks[t] || !dvChecks[t][c]) return;
      const tlOk = (dvAllowed[t] && (dvAllowed[t][c] || []).length) ? !!sc.typelist : false;
      const fkOk = (dvFk[t] && dvFk[t][c]) ? !!sc.fk : false;
      dvChecks[t][c] = {pk: !!sc.pk, mandatory: !!sc.mandatory, typelist: tlOk, fk: fkOk};
      // an AI suggestion turns these cells blue (skip cells with no applicable check)
      ensureOrigin(t);
      const hasDomain = (dvAllowed[t] && (dvAllowed[t][c] || []).length);
      const hasFk = (dvFk[t] && dvFk[t][c]);
      dvOrigin[t][c] = {
        pk:"ai", mandatory:"ai",
        typelist: hasDomain ? "ai" : (dvOrigin[t][c] ? dvOrigin[t][c].typelist : "schema"),
        fk: hasFk ? "ai" : (dvOrigin[t][c] ? dvOrigin[t][c].fk : "schema")
      };
      applied++;
    });
    persistConfig();
    renderCheckGrid();
    showNotification("AI suggested checks for " + applied + " column(s).", "success");
  }catch(err){
    showNotification("AI suggest error: " + (err && err.message ? err.message : err), "danger");
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
  }
}

/* ---------- Generate SQL ---------- */
function buildTablesPayload(){
  const out = [];
  Object.keys(dvFieldsByTable).filter(t => dvSelected.has(t)).forEach(t => {
    const checks = dvChecks[t] || {};
    const keyColumns = [], mandatoryColumns = [], typelistChecks = [], fkChecks = [];
    Object.keys(checks).forEach(c => {
      const st = checks[c];
      if(st.pk) keyColumns.push(c);
      if(st.mandatory) mandatoryColumns.push(c);
      if(st.typelist && (dvAllowed[t][c] || []).length) typelistChecks.push({column: c, allowedValues: dvAllowed[t][c]});
      if(st.fk && dvFk[t][c]) fkChecks.push({column: c, parentTable: dvFk[t][c].parentTable, parentColumn: dvFk[t][c].parentColumn});
    });
    if(keyColumns.length || mandatoryColumns.length || typelistChecks.length || fkChecks.length)
      out.push({table: t, keyColumns, mandatoryColumns, typelistChecks, fkChecks});
  });
  return out;
}
async function generateSql(){
  const tables = buildTablesPayload();
  if(!tables.length){ showNotification("Tick at least one check box first.", "warning"); return; }
  const schema = (dvConn && dvConn.schema) || "dbo";
  const btn = document.getElementById("genSqlBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  try{
    const r = await apiPost("/api/ai/validation-sql", {schema, tables});
    if(r.netError){ showNotification("Backend not reachable — is the server running? (cd server && python main.py)", "danger"); return; }
    if(!r.ok){ showNotification("SQL generation failed: " + r.error, "danger"); return; }
    dvSql = r.data.sql || "";
    document.getElementById("sqlOut").textContent = dvSql;
    const card = document.getElementById("sqlCard");
    card.style.display = "block";   // override the stylesheet's #sqlCard{display:none}
    card.scrollIntoView({behavior:"smooth", block:"nearest"});
    showNotification("SQL generated. Review, then run it on SQL Server.", "success");
  }catch(err){
    showNotification("SQL generation error: " + (err && err.message ? err.message : err), "danger");
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
  }
}
async function copySql(){
  if(!dvSql){ showNotification("Nothing to copy — generate SQL first.", "warning"); return; }
  try{ await navigator.clipboard.writeText(dvSql); showNotification("SQL copied to clipboard.", "success"); }
  catch(e){ showNotification("Copy failed — select the text manually.", "warning"); }
}
function downloadSql(){
  if(!dvSql){ showNotification("Nothing to download — generate SQL first.", "warning"); return; }
  const blob = new Blob([dvSql], {type:"text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "data-validation.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- Run Validation (live path) ---------- */
async function runValidation(){
  if(!dvCanRunLive){ showNotification("Live Run needs a SQL Server target connection. Use Generate SQL instead.", "warning"); return; }
  const tables = buildTablesPayload();
  if(!tables.length){ showNotification("Tick at least one check box first.", "warning"); return; }
  const tSchema = (dvConn && dvConn.schema) || "dbo";
  const btn = document.getElementById("runValidationBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  try{
    const pw = await ensureConnPassword(dvConn);
    if(pw === null){ showNotification("Cancelled — a password is required.", "warning"); return; }
    const base = connToConfig(Object.assign({}, dvConn, {password: pw}));
    dvIssues = [];
    let done = 0, failed = 0;
    for(const t of tables){
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> ' + (done + 1) + '/' + tables.length;
      const cfg = Object.assign({}, base, {
        schema: tSchema, table: t.table,
        keyColumns: t.keyColumns, mandatoryColumns: t.mandatoryColumns,
        typelistChecks: t.typelistChecks, fkChecks: t.fkChecks, sampleLimit: 10
      });
      try{
        const res = await fetch("/api/db/validate", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
        const data = await res.json();
        if(!data.ok){ failed++; continue; }
        collectIssues(t.table, data); done++;
      }catch(err){ failed++; }
    }
    dvState.page = 1;
    updateKpis(done);
    buildFilterBar();
    renderIssues();
    const issueCount = dvIssues.length;
    if(failed) showNotification("Validated " + done + " of " + tables.length + " tables (" + failed + " failed).", failed === tables.length ? "danger" : "warning");
    else showNotification(issueCount ? ("Validation complete — " + issueCount + " issue type(s) found.") : "Validation complete — no issues found.", issueCount ? "warning" : "success");
  }catch(err){
    showNotification("Backend not reachable. Start it with: cd server && python main.py", "danger");
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
  }
}
function collectIssues(table, data){
  (data.checks || []).forEach(c => {
    if(c.error){
      dvIssues.push({table, type:c.type, columns:(c.columns||[]).join(", "), detail:"Check error: " + c.error, count:null, samples:""});
      return;
    }
    if(c.type === "duplicate"){
      dvIssues.push({table, type:"duplicate", columns:(c.columns||[]).join(", "),
        detail:(c.groupCount||0) + " duplicate key group(s)", count:c.count || 0,
        samples:(c.samples||[]).map(s => "[" + escapeHtml(String(s.key)) + "] ×" + s.count).join("  ·  ")});
    }else if(c.type === "mandatory"){
      dvIssues.push({table, type:"mandatory", columns:(c.columns||[]).join(", "),
        detail:"NULLs in required column", count:c.count || 0, samples:""});
    }else if(c.type === "typelist"){
      dvIssues.push({table, type:"typelist", columns:(c.columns||[]).join(", "),
        detail:"values outside the typelist domain", count:c.count || 0,
        samples:(c.samples||[]).map(s => escapeHtml(String(s.value)) + " ×" + s.count).join("  ·  ")});
    }else if(c.type === "foreignKey"){
      dvIssues.push({table, type:"foreignKey", columns:(c.columns||[]).join(", "),
        detail:"orphans → " + (c.reference || ""), count:c.count || 0,
        samples:(c.samples||[]).map(s => escapeHtml(String(s.value)) + " ×" + s.count).join("  ·  ")});
    }
  });
}
function updateKpis(tablesChecked){
  const sum = (type) => dvIssues.filter(i => i.type === type && i.count).reduce((a, i) => a + (i.count || 0), 0);
  document.getElementById("statTables").textContent = tablesChecked;
  document.getElementById("statDuplicates").textContent = sum("duplicate").toLocaleString();
  document.getElementById("statMandatory").textContent = sum("mandatory").toLocaleString();
  document.getElementById("statTypelist").textContent = sum("typelist").toLocaleString();
  document.getElementById("statForeignKey").textContent = sum("foreignKey").toLocaleString();
}

/* ---------- results grid ---------- */
const DV_TYPE_LABELS = {duplicate:"Duplicate", mandatory:"Mandatory Null", typelist:"Typelist", foreignKey:"Foreign Key", error:"Error"};
function buildFilterBar(){
  const bar = document.getElementById("filterBar");
  if(!bar) return;
  const tables = Array.from(new Set(dvIssues.map(i => i.table))).sort();
  const typeOpts = ['<option value="">All checks</option>'].concat(
    Object.keys(DV_TYPE_LABELS).map(k => '<option value="' + k + '"' + (dvState.filters.type === k ? " selected" : "") + '>' + DV_TYPE_LABELS[k] + '</option>')).join("");
  const tblOpts = ['<option value="">All tables</option>'].concat(
    tables.map(t => '<option value="' + escapeHtml(t) + '"' + (dvState.filters.table === t ? " selected" : "") + '>' + escapeHtml(t) + '</option>')).join("");
  bar.innerHTML =
    '<select class="form-select form-select-sm" id="fltType" style="max-width:180px;">' + typeOpts + '</select>' +
    '<select class="form-select form-select-sm" id="fltTable" style="max-width:220px;">' + tblOpts + '</select>';
  document.getElementById("fltType").addEventListener("change", e => { dvState.filters.type = e.target.value; dvState.page = 1; renderIssues(); });
  document.getElementById("fltTable").addEventListener("change", e => { dvState.filters.table = e.target.value; dvState.page = 1; renderIssues(); });
}
function filteredIssues(){
  return dvIssues.filter(i =>
    (!dvState.filters.type || i.type === dvState.filters.type) &&
    (!dvState.filters.table || i.table === dvState.filters.table));
}
function renderIssues(){
  const body = document.getElementById("issuesBody");
  if(!body) return;
  const all = filteredIssues();
  if(!all.length){
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted-2" style="padding:1.4rem;">' +
      (dvIssues.length ? "No issues match the current filter." : "No live results yet — tick checks and click Run Validation (or use Generate SQL to run on SQL Server yourself).") + '</td></tr>';
    document.getElementById("pgInfo").textContent = "";
    document.getElementById("pgControls").innerHTML = "";
    return;
  }
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / dvState.pageSize));
  if(dvState.page > pages) dvState.page = pages;
  const start = (dvState.page - 1) * dvState.pageSize;
  const slice = all.slice(start, start + dvState.pageSize);
  body.innerHTML = slice.map(i => {
    const sevCls = i.type === "error" ? "badge-gray" : (i.type === "duplicate" || i.type === "mandatory" ? "badge-low" : "badge-med");
    return '<tr>' +
      '<td>' + escapeHtml(i.table) + '</td>' +
      '<td><span class="badge-soft ' + sevCls + '">' + (DV_TYPE_LABELS[i.type] || i.type) + '</span></td>' +
      '<td class="mono">' + escapeHtml(i.columns) + '</td>' +
      '<td>' + escapeHtml(i.detail) + '</td>' +
      '<td>' + (i.count == null ? "—" : Number(i.count).toLocaleString()) + '</td>' +
      '<td class="text-xs">' + (i.samples || "") + '</td>' +
    '</tr>';
  }).join("");
  document.getElementById("pgInfo").textContent = "Showing " + (start + 1) + "–" + Math.min(start + dvState.pageSize, total) + " of " + total;
  const ctrl = document.getElementById("pgControls");
  ctrl.innerHTML =
    '<button class="btn btn-sm btn-outline-soft" ' + (dvState.page <= 1 ? "disabled" : "") + ' id="pgPrev">Prev</button>' +
    '<span class="mx-2 text-xs">Page ' + dvState.page + ' / ' + pages + '</span>' +
    '<button class="btn btn-sm btn-outline-soft" ' + (dvState.page >= pages ? "disabled" : "") + ' id="pgNext">Next</button>';
  const prev = document.getElementById("pgPrev"), next = document.getElementById("pgNext");
  if(prev) prev.addEventListener("click", () => { if(dvState.page > 1){ dvState.page--; renderIssues(); } });
  if(next) next.addEventListener("click", () => { if(dvState.page < pages){ dvState.page++; renderIssues(); } });
}

async function clearResults(){
  const ok = await confirmDialog("Clear the live validation results? Your table/column selections and generated SQL are kept.", "Clear Results");
  if(!ok) return;
  dvIssues = [];
  dvState.page = 1;
  updateKpis(0);
  buildFilterBar();
  renderIssues();
  showNotification("Results cleared.", "primary");
}
