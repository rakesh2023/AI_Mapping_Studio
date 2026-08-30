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
let dvCustomRules = [];      // [{id, table, prompt, title, interpretation, predicate, enabled}]
let dvRuleDraft = null;      // {title, interpretation} from the last AI interpretation in the editor

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-validation.html");

  dvSchema = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  indexSchema();
  resolveActiveTarget();
  renderBanner();

  if(dvSchema && dvSchema.entities && dvSchema.entities.length){
    await buildTypelistIndex();
    loadConfig();
    buildTableList();
    renderCheckGrid();
    renderCustomRules();
  }

  // buttons
  document.getElementById("aiSuggestBtn").addEventListener("click", aiSuggest);
  document.getElementById("genSqlBtn").addEventListener("click", generateSql);
  document.getElementById("clearValidationBtn").addEventListener("click", clearConfig);
  document.getElementById("copySqlBtn").addEventListener("click", copySql);
  document.getElementById("downloadSqlBtn").addEventListener("click", downloadSql);
  const addRuleBtn = document.getElementById("addRuleBtn");
  if(addRuleBtn) addRuleBtn.addEventListener("click", () => openRuleEditor(null));
  const search = document.getElementById("tableSearch");
  if(search) search.addEventListener("input", buildTableList);
  const colSearch = document.getElementById("colSearch");
  if(colSearch) colSearch.addEventListener("input", e => { dvColFilter = (e.target.value || "").toLowerCase().trim(); renderCheckGrid(); });
  const selAll = document.getElementById("selectAllTables");
  if(selAll) selAll.addEventListener("change", onSelectAll);
});

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
  const aiBtn = document.getElementById("aiSuggestBtn");
  const sqlBtn = document.getElementById("genSqlBtn");
  const hasSchema = !!(dvSchema && dvSchema.entities && dvSchema.entities.length);

  if(!hasSchema){
    el.innerHTML = notice("warning", "bi-exclamation-triangle",
      "No active target schema. Configure a target on the Target System page, then return here.");
    [aiBtn, sqlBtn].forEach(b => { if(b) b.disabled = true; });
    return;
  }
  if(aiBtn) aiBtn.disabled = false;
  if(sqlBtn) sqlBtn.disabled = false;

  const name = dvConn ? (dvConn.name || dvConn.server || "") : "";
  el.innerHTML =
    '<div class="card-el d-flex align-items-center gap-2" style="padding:.6rem .9rem;">' +
      '<i class="bi bi-hdd-network text-primary"></i>' +
      '<span>Target: <b>' + escapeHtml(name || "(schema only)") + '</b>' +
        (dvConn && dvConn.database ? ' &middot; <span class="text-muted-2">' + escapeHtml(dvConn.database) + '</span>' : '') + '</span>' +
      '<span class="badge-soft badge-gray ms-auto">Configure checks, then open the Validation Report to run</span>' +
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
  try{ lsSet(LS_KEYS.dataValidationCfg, {selected: Array.from(dvSelected), checks, origin, customRules: dvCustomRules}); }catch(e){ /* ignore quota */ }
}
function loadConfig(){
  const saved = lsGet(LS_KEYS.dataValidationCfg, null);
  if(!saved) return;
  dvCustomRules = (Array.isArray(saved.customRules) ? saved.customRules : []).map(normalizeRule);
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
      if(st.typelist && ((dvAllowed[t] || {})[c] || []).length) typelistChecks.push({column: c, allowedValues: dvAllowed[t][c]});
      if(st.fk && (dvFk[t] || {})[c]) fkChecks.push({column: c, parentTable: dvFk[t][c].parentTable, parentColumn: dvFk[t][c].parentColumn});
    });
    if(keyColumns.length || mandatoryColumns.length || typelistChecks.length || fkChecks.length)
      out.push({table: t, keyColumns, mandatoryColumns, typelistChecks, fkChecks});
  });
  return out;
}
async function generateSql(){
  const schema = (dvConn && dvConn.schema) || "dbo";
  const tables = buildTablesPayload();
  const customQueries = buildCustomQueries(schema);
  if(!tables.length && !customQueries.length){ showNotification("Tick at least one check or add a custom rule first.", "warning"); return; }
  const btn = document.getElementById("genSqlBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  try{
    const r = await apiPost("/api/ai/validation-sql", {schema, tables, customQueries});
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

/* ---------- custom validation rules (NL prompt over 1+ tables -> reviewable SQL query) ---------- */
// Normalize a stored rule to the current shape (migrates legacy {table, predicate} rules).
function normalizeRule(r){
  const tables = Array.isArray(r.tables) ? r.tables : (r.table ? [r.table] : []);
  return {
    id: r.id || ("r" + Date.now() + Math.floor(Math.random() * 1000)),
    tables, prompt: r.prompt || "", title: r.title || "Custom rule",
    interpretation: r.interpretation || "", query: r.query || "", predicate: r.predicate || "",
    enabled: r.enabled !== false
  };
}
// The main driving table of a query — the first table after FROM (strips schema/brackets).
function drivingTable(query){
  if(!query) return "";
  const m = /\bfrom\s+(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_]+)(?:\s*\.\s*(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_]+))?/i.exec(query);
  if(!m) return "";
  return (m[2] || m[1]).replace(/^[\["]|[\]"]$/g, "");
}
function ruleFinalQuery(r, schema){
  if(r.query && r.query.trim()) return r.query.trim();
  if(r.predicate && r.predicate.trim() && r.tables && r.tables[0])
    return "SELECT * FROM [" + schema + "].[" + r.tables[0] + "] WHERE (" + r.predicate.trim() + ")";
  return null;
}
function buildCustomQueries(schema){
  return dvCustomRules.filter(r => r.enabled)
    .map(r => ({name: r.title || "Custom rule", query: ruleFinalQuery(r, schema), tables: r.tables || []}))
    .filter(x => x.query);
}

function renderCustomRules(){
  const list = document.getElementById("customRulesList");
  if(!list) return;
  if(!dvCustomRules.length){ list.innerHTML = '<div class="text-xs text-muted-2">No custom rules yet. Click &ldquo;Add rule&rdquo; to describe one in plain English (it can span multiple tables).</div>'; return; }
  list.innerHTML = dvCustomRules.map(r =>
    '<div class="dv-rule">' +
      '<input type="checkbox" class="dv-rule-en" data-id="' + escapeHtml(r.id) + '"' + (r.enabled ? " checked" : "") + ' title="Include in validation / SQL">' +
      '<div class="dv-rule-body">' +
        '<div class="dv-rule-title">' + escapeHtml(r.title || "Custom rule") + ' <span class="text-xs text-muted-2">&middot; ' + escapeHtml(drivingTable(r.query) || (r.tables || [])[0] || "") + '</span></div>' +
        (r.interpretation ? '<div class="text-xs text-muted-2">' + escapeHtml(r.interpretation) + '</div>' : '') +
        '<div class="dv-pred">' + escapeHtml(r.query || r.predicate || "(no SQL)") + '</div>' +
      '</div>' +
      '<div class="dv-rule-actions">' +
        '<button class="btn btn-sm btn-outline-soft dv-rule-edit" data-id="' + escapeHtml(r.id) + '" title="Edit"><i class="bi bi-pencil"></i></button>' +
        '<button class="btn btn-sm btn-outline-soft dv-rule-del" data-id="' + escapeHtml(r.id) + '" title="Delete"><i class="bi bi-trash"></i></button>' +
      '</div>' +
    '</div>').join("");
  list.querySelectorAll(".dv-rule-en").forEach(cb => cb.addEventListener("change", e => toggleRule(e.target.getAttribute("data-id"), e.target.checked)));
  list.querySelectorAll(".dv-rule-edit").forEach(b => b.addEventListener("click", e => openRuleEditor(e.currentTarget.getAttribute("data-id"))));
  list.querySelectorAll(".dv-rule-del").forEach(b => b.addEventListener("click", e => deleteRule(e.currentTarget.getAttribute("data-id"))));
}
function toggleRule(id, on){ const r = dvCustomRules.find(x => x.id === id); if(r){ r.enabled = on; persistConfig(); } }
function deleteRule(id){ dvCustomRules = dvCustomRules.filter(x => x.id !== id); persistConfig(); renderCustomRules(); closeRuleEditor(); }
function closeRuleEditor(){ const e = document.getElementById("ruleEditor"); if(e) e.innerHTML = ""; dvRuleDraft = null; }

function openRuleEditor(id){
  const tables = Object.keys(dvFieldsByTable);
  if(!tables.length){ showNotification("Load a target schema first.", "warning"); return; }
  const editing = id ? dvCustomRules.find(x => x.id === id) : null;
  dvRuleDraft = editing ? {title: editing.title, interpretation: editing.interpretation} : null;
  const ruleSel = new Set(editing ? (editing.tables || []) : Array.from(dvSelected));
  const ed = document.getElementById("ruleEditor");
  ed.innerHTML =
    '<div class="dv-rule-editor">' +
      '<div class="d-flex align-items-center" id="ruleTablesHdr" style="cursor:pointer;">' +
        '<label style="margin:0;cursor:pointer;">Tables — select one or more</label>' +
        '<span class="text-xs text-muted-2 ms-2" id="ruleSelCountHdr"></span>' +
        '<i class="bi bi-chevron-up ms-auto" id="ruleTablesChev"></i>' +
      '</div>' +
      '<div id="ruleTablesWrap">' +
        '<input type="text" class="form-control form-control-sm mb-1 mt-1" id="ruleTableSearch" placeholder="Search tables…">' +
        '<label class="d-flex align-items-center gap-2" style="text-transform:none;letter-spacing:0;font-size:.78rem;color:var(--text-main);margin:.1rem 0 .3rem;"><input type="checkbox" id="ruleSelectAll"> <span>Select all</span> <span class="ms-auto text-muted-2" id="ruleSelCount"></span></label>' +
        '<div class="dv-rule-tables" id="ruleTables"></div>' +
      '</div>' +
      '<label class="mt-2">Rule (plain English)</label>' +
      '<textarea class="form-control form-control-sm" id="rulePrompt" rows="2" placeholder="e.g. if a claim is closed, its exposures must also be closed">' + escapeHtml(editing ? (editing.prompt || "") : "") + '</textarea>' +
      '<div class="d-flex gap-2 mt-2">' +
        '<button class="btn btn-sm btn-primary" id="ruleInterpretBtn"><i class="bi bi-stars me-1"></i> Interpret with AI</button>' +
        '<button class="btn btn-sm btn-outline-soft" id="ruleCancelBtn">Cancel</button>' +
      '</div>' +
      '<div id="ruleResult" class="mt-2"' + (editing && editing.query ? "" : ' style="display:none;"') + '>' +
        '<label>AI interpretation</label><div class="text-xs mb-2" id="ruleInterp">' + escapeHtml(editing ? (editing.interpretation || "") : "") + '</div>' +
        '<label>SQL query — returns offending rows (editable)</label>' +
        '<textarea class="form-control form-control-sm dv-pred" id="ruleQuery" rows="4">' + escapeHtml(editing ? (editing.query || "") : "") + '</textarea>' +
        '<div class="d-flex gap-2 mt-2"><button class="btn btn-sm btn-primary" id="ruleSaveBtn"><i class="bi bi-check2 me-1"></i> Save rule</button></div>' +
      '</div>' +
    '</div>';
  function updateRuleSelState(filtered){
    const sel = filtered.filter(t => ruleSel.has(t)).length;
    const sa = document.getElementById("ruleSelectAll");
    if(sa){ sa.checked = filtered.length > 0 && sel === filtered.length; sa.indeterminate = sel > 0 && sel < filtered.length; }
    const label = ruleSel.size ? (ruleSel.size + " selected") : "";
    const cnt = document.getElementById("ruleSelCount");
    if(cnt) cnt.textContent = label;
    const cntH = document.getElementById("ruleSelCountHdr");
    if(cntH) cntH.textContent = ruleSel.size ? ("(" + ruleSel.size + " selected)") : "(none selected)";
  }
  function renderRuleTables(){
    const q = (document.getElementById("ruleTableSearch").value || "").toLowerCase().trim();
    const filtered = tables.filter(t => !q || t.toLowerCase().includes(q));
    const box = document.getElementById("ruleTables");
    box.innerHTML = filtered.map(t =>
      '<label class="dv-rule-tbl"><input type="checkbox" class="rule-tbl-cb" value="' + escapeHtml(t) + '"' + (ruleSel.has(t) ? " checked" : "") + '> ' + escapeHtml(t) + '</label>').join("") ||
      '<div class="text-xs text-muted-2" style="padding:.3rem;">No tables match.</div>';
    box.querySelectorAll(".rule-tbl-cb").forEach(cb => cb.addEventListener("change", e => {
      if(e.target.checked) ruleSel.add(e.target.value); else ruleSel.delete(e.target.value);
      updateRuleSelState(filtered);
    }));
    updateRuleSelState(filtered);
  }
  renderRuleTables();
  document.getElementById("ruleTableSearch").addEventListener("input", renderRuleTables);
  document.getElementById("ruleSelectAll").addEventListener("change", e => {
    const q = (document.getElementById("ruleTableSearch").value || "").toLowerCase().trim();
    const filtered = tables.filter(t => !q || t.toLowerCase().includes(q));
    if(e.target.checked) filtered.forEach(t => ruleSel.add(t)); else filtered.forEach(t => ruleSel.delete(t));
    renderRuleTables();
  });
  // collapse the table list to give the rule text room; header toggles it back
  const tablesWrap = document.getElementById("ruleTablesWrap");
  const chev = document.getElementById("ruleTablesChev");
  function setTablesCollapsed(collapsed){
    tablesWrap.style.display = collapsed ? "none" : "";
    if(chev) chev.className = "bi ms-auto " + (collapsed ? "bi-chevron-down" : "bi-chevron-up");
  }
  document.getElementById("ruleTablesHdr").addEventListener("click", () => setTablesCollapsed(tablesWrap.style.display !== "none"));
  document.getElementById("rulePrompt").addEventListener("focus", () => setTablesCollapsed(true));
  document.getElementById("ruleInterpretBtn").addEventListener("click", () => interpretRule(ruleSel));
  document.getElementById("ruleCancelBtn").addEventListener("click", closeRuleEditor);
  const saveBtn = document.getElementById("ruleSaveBtn");
  if(saveBtn) saveBtn.addEventListener("click", () => saveRule(editing ? editing.id : null, ruleSel));
}

async function interpretRule(ruleSel){
  const tablesSel = Array.from(ruleSel);
  const prompt = (document.getElementById("rulePrompt").value || "").trim();
  if(!tablesSel.length){ showNotification("Select at least one table.", "warning"); return; }
  if(!prompt){ showNotification("Type the rule in plain English first.", "warning"); return; }
  const schema = (dvConn && dvConn.schema) || "dbo";
  const tablesPayload = tablesSel.map(t => ({
    name: t,
    columns: (dvFieldsByTable[t] || []).map(f => ({
      name: f.name, dataType: f.dataType || "", description: f.description || "",
      typeKey: f.typeKey || "", accepted: f.accepted || "", allowedValues: resolveAllowed(f).slice(0, 50)
    }))
  }));
  const btn = document.getElementById("ruleInterpretBtn");
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Interpreting…';
  try{
    const r = await apiPost("/api/ai/custom-rule", {schema, tables: tablesPayload, prompt});
    if(r.netError){ showNotification("Backend not reachable — is the server running?", "danger"); return; }
    if(!r.ok){ showNotification("Could not interpret rule: " + r.error, "danger"); return; }
    const rule = r.data.rule || {};
    if(!rule.violationQuery){
      showNotification("AI couldn't express this from the selected tables" + (rule.note ? (": " + rule.note) : "") + ".", "warning");
      return;
    }
    dvRuleDraft = {title: rule.title || prompt.slice(0, 48), interpretation: rule.interpretation || ""};
    document.getElementById("ruleInterp").textContent = rule.interpretation || "";
    document.getElementById("ruleQuery").value = rule.violationQuery;
    document.getElementById("ruleResult").style.display = "";
  }catch(err){
    showNotification("Interpret error: " + (err && err.message ? err.message : err), "danger");
  }finally{ btn.disabled = false; btn.innerHTML = orig; }
}

function saveRule(existingId, ruleSel){
  const tablesSel = Array.from(ruleSel);
  const prompt = (document.getElementById("rulePrompt").value || "").trim();
  const query = (document.getElementById("ruleQuery").value || "").trim();
  if(!query){ showNotification("Interpret the rule (or enter a SQL query) before saving.", "warning"); return; }
  const title = (dvRuleDraft && dvRuleDraft.title) || prompt.slice(0, 48) || "Custom rule";
  const interpretation = (dvRuleDraft && dvRuleDraft.interpretation) || "";
  if(existingId){
    const r = dvCustomRules.find(x => x.id === existingId);
    if(r) Object.assign(r, {tables: tablesSel, prompt, query, predicate: "", title, interpretation});
  }else{
    dvCustomRules.push({id: "r" + Date.now() + Math.floor(Math.random() * 1000), tables: tablesSel, prompt, query, predicate: "", title, interpretation, enabled: true});
  }
  persistConfig();
  renderCustomRules();
  closeRuleEditor();
  showNotification("Custom rule saved.", "success");
}

/* ---------- clear the whole configuration on this page ---------- */
async function clearConfig(){
  const ok = await confirmDialog("Clear all selected tables, ticked checks, and custom rules on this page? This cannot be undone.", "Clear Configuration");
  if(!ok) return;
  dvSelected = new Set();
  dvChecks = {}; dvOrigin = {}; dvAllowed = {}; dvFk = {}; dvDomainName = {};
  dvCustomRules = [];
  dvSql = "";
  persistConfig();
  const selAll = document.getElementById("selectAllTables"); if(selAll) selAll.checked = false;
  const sqlCard = document.getElementById("sqlCard"); if(sqlCard) sqlCard.style.display = "none";
  buildTableList();
  renderCheckGrid();
  renderCustomRules();
  showNotification("Configuration cleared.", "primary");
}
