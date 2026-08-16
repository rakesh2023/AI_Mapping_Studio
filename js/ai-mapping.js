/* =========================================================================
   ai-mapping.js - AI Mapping Generator page
   Reads live source DB columns + the uploaded target schema, then calls the
   backend (/api/ai/generate-mappings) which uses Claude to produce the
   field-level mapping document. Generated mappings are stored as overrides
   and shown in the Mapping Workspace.
   ========================================================================= */

const STRATEGY_HINTS = {
  Conservative: "Conservative: only high-confidence mappings are generated; everything else is left unmapped for manual review.",
  Balanced: "Balanced: generate likely mappings and flag uncertain ones for review.",
  Aggressive: "Aggressive: generate as many candidate mappings as possible, including low-confidence guesses."
};

/* Apply the Settings "Default Mapping Strategy" to this page's dropdown on load.
   The user can still change it per run; this only sets the starting value + hint. */
function seedStrategyFromSettings(){
  const sel = document.getElementById("mappingStrategy");
  if(!sel || typeof getSettings !== "function") return;
  const def = getSettings().mappingStrategy;
  if(def && STRATEGY_HINTS[def]){
    sel.value = def;
    const hint = document.getElementById("strategyHint");
    if(hint) hint.textContent = STRATEGY_HINTS[def];
  }
}

const LS_AI_MAPPINGS = "aims_ai_mappings";   // generated mappings live here for the workspace
const LS_BIZ_CONTEXT = "aims_business_context";   // user-saved Business Context prompt
const LS_GEN_SYS_PROMPT = "aims_gen_system_prompt";  // user-edited AI system prompt (device pref)

// The prompt shipped in the HTML is the DEFAULT; captured on load so "Default" can
// restore it. A user-saved value (localStorage) overrides it until reset.
let defaultBizContext = "";

// The mapping system prompt comes from the backend (single source of truth). We fetch
// the default for the current strategy; a user edit (localStorage) overrides it and is
// sent verbatim to generation. Empty override => backend uses its strategy-driven default.
let defaultSystemPrompt = "";

let targetSchema = null;
let sourceCache = null;   // {connection, schema, tables:[...]} loaded from the chosen source
// Per-entity COLUMN selection: { entityName: Set<columnName> }. An entity counts as
// "selected" when it has at least one column chosen. Selecting a table chooses all its
// columns; individual columns can then be unchecked.
let selectedCols = {};              // { entityName: Set<colName> } — NEW picks to generate
let generatedCols = {};             // { entityName: Set<colName> } — already-mapped (locked)
let expandedEntities = new Set();   // entity cards whose column list is expanded
let tableFilter = "";               // search term for the target-table picker
let colFilters = {};                // per-entity column search term { entityName: "text" }
let focusColSearch = null;          // entity whose column-search box should re-focus after render

/* ---- selection helpers ---- */
function entityByName(name){ return (targetSchema.entities||[]).find(e => e.name === name); }
function isColGenerated(name, col){ return !!(generatedCols[name] && generatedCols[name].has(col)); }
function isColSelected(name, col){ return !!(selectedCols[name] && selectedCols[name].has(col)); }
// A column is "checked" in the UI if it's already generated (locked) OR newly selected.
function isColChecked(name, col){ return isColGenerated(name, col) || isColSelected(name, col); }
// Columns of an entity that are NOT yet generated (the ones we can still pick).
function pendingFields(e){ return (e.fields||[]).filter(f => !isColGenerated(e.name, f.name)); }

function isEntitySelected(name){ return !!(selectedCols[name] && selectedCols[name].size); }
function entityCheckedCount(name){
  // generated + newly-selected, de-duplicated
  const g = generatedCols[name] ? generatedCols[name].size : 0;
  const s = selectedCols[name] ? selectedCols[name].size : 0;
  return g + s;
}
// Select all NOT-yet-generated columns of an entity (generated ones are already locked).
function selectAllColumns(e){
  const pend = pendingFields(e).map(f => f.name);
  if(pend.length) selectedCols[e.name] = new Set(pend);
}
function toggleEntity(e){
  // Toggle only affects the pending (non-generated) columns.
  if(isEntitySelected(e.name)) delete selectedCols[e.name];
  else selectAllColumns(e);
}
function toggleColumn(entityName, colName){
  if(isColGenerated(entityName, colName)) return;   // locked — cannot change
  if(!selectedCols[entityName]) selectedCols[entityName] = new Set();
  const set = selectedCols[entityName];
  set.has(colName) ? set.delete(colName) : set.add(colName);
  if(!set.size) delete selectedCols[entityName];
}
function totalSelectedCols(){ return Object.values(selectedCols).reduce((a,s)=>a+s.size,0); }
function totalGeneratedCols(){ return Object.values(generatedCols).reduce((a,s)=>a+s.size,0); }
function selectedEntityNames(){ return Object.keys(selectedCols).filter(n => selectedCols[n] && selectedCols[n].size); }

// Build the LOCKED set from columns that already have generated mappings, so returning
// to this page shows what was mapped (greyed + checked) and we never re-generate them.
// Only counts columns that still exist in the active target.
function loadGeneratedCols(){
  generatedCols = {};
  const rows = lsGet(LS_AI_MAPPINGS, []) || [];
  if(!rows.length || !targetSchema) return;
  const valid = {};
  (targetSchema.entities||[]).forEach(e => { valid[e.name] = new Set((e.fields||[]).map(f => f.name)); });
  rows.forEach(r => {
    const ent = r.targetEntity, col = r.targetColumn;
    if(!ent || !col || !valid[ent] || !valid[ent].has(col)) return;
    if(!generatedCols[ent]) generatedCols[ent] = new Set();
    generatedCols[ent].add(col);
  });
}

/* ---- Business Context persistence ----
   The prompt in the HTML is the default. A saved value (localStorage) is
   restored on load and used for generation; it survives reloads/navigation and
   is cleared only by a full application reset (which wipes all aims_* keys). */
function initBizContext(){
  const ta = document.getElementById("bizContext");
  if(!ta) return;
  defaultBizContext = ta.value;                 // capture the shipped default
  const saved = lsGet(LS_BIZ_CONTEXT, null);
  if(saved !== null && saved !== undefined){ ta.value = saved; }
  bizCtxState(saved !== null && saved !== undefined ? "saved" : "default");

  const saveBtn = document.getElementById("saveBizCtxBtn");
  const resetBtn = document.getElementById("resetBizCtxBtn");
  if(saveBtn) saveBtn.addEventListener("click", () => {
    lsSet(LS_BIZ_CONTEXT, ta.value);
    bizCtxState("saved");
    if(typeof showNotification === "function") showNotification("Business Context saved. It will persist until you reset the application.", "success");
  });
  if(resetBtn) resetBtn.addEventListener("click", () => {
    ta.value = defaultBizContext;
    lsRemove(LS_BIZ_CONTEXT);
    bizCtxState("default");
    if(typeof showNotification === "function") showNotification("Business Context restored to the default prompt.", "primary");
  });
  // mark as "unsaved edits" while typing so the user knows to save
  ta.addEventListener("input", () => {
    const cur = lsGet(LS_BIZ_CONTEXT, null);
    bizCtxState(cur !== null && cur === ta.value ? "saved" : (ta.value === defaultBizContext ? "default" : "unsaved"));
  });
}

function bizCtxState(state){
  const el = document.getElementById("bizCtxState");
  if(!el) return;
  if(state === "saved"){ el.textContent = "Saved"; el.className = "text-xs"; el.style.color = "var(--success)"; }
  else if(state === "unsaved"){ el.textContent = "Unsaved changes"; el.className = "text-xs"; el.style.color = "var(--warning)"; }
  else { el.textContent = "Using default"; el.className = "text-xs text-muted-2"; el.style.color = ""; }
}

/* ---- Editable AI system prompt ----
   The default lives on the backend (GET /api/ai/mapping-prompt?strategy=...), so the
   textbox always mirrors what the server would use. An edit is saved per-device and
   sent as `systemPrompt` to generation; leaving it at the default sends nothing, so the
   Strategy dropdown stays authoritative. */
async function fetchDefaultSysPrompt(){
  const sel = document.getElementById("mappingStrategy");
  const strat = sel ? sel.value : "Balanced";
  try{
    const r = await fetch("/api/ai/mapping-prompt?strategy=" + encodeURIComponent(strat));
    const d = await r.json();
    return d && d.prompt ? d.prompt : defaultSystemPrompt;
  }catch(e){ return defaultSystemPrompt; }
}

function sysPromptState(state){
  const el = document.getElementById("sysPromptState");
  if(!el) return;
  if(state === "edited"){ el.textContent = "Edited"; el.style.color = "var(--warning)"; }
  else { el.textContent = "Using default"; el.style.color = ""; }
}

async function initSystemPrompt(){
  const ta = document.getElementById("genSystemPrompt");
  if(!ta) return;
  defaultSystemPrompt = await fetchDefaultSysPrompt();
  const saved = lsGet(LS_GEN_SYS_PROMPT, null);
  if(saved !== null && saved !== undefined && saved !== ""){
    ta.value = saved; sysPromptState(saved === defaultSystemPrompt ? "default" : "edited");
  } else {
    ta.value = defaultSystemPrompt; sysPromptState("default");
  }

  const resetBtn = document.getElementById("resetSysPromptBtn");
  if(resetBtn) resetBtn.addEventListener("click", async () => {
    defaultSystemPrompt = await fetchDefaultSysPrompt();
    ta.value = defaultSystemPrompt;
    lsRemove(LS_GEN_SYS_PROMPT);
    sysPromptState("default");
    if(typeof showNotification === "function") showNotification("AI prompt restored to the default.", "primary");
  });

  ta.addEventListener("input", () => {
    if(ta.value === defaultSystemPrompt){ lsRemove(LS_GEN_SYS_PROMPT); sysPromptState("default"); }
    else { lsSet(LS_GEN_SYS_PROMPT, ta.value); sysPromptState("edited"); }
  });

  // Keep the prompt in sync with the Strategy dropdown while it is unedited.
  const strat = document.getElementById("mappingStrategy");
  if(strat) strat.addEventListener("change", async () => {
    const wasDefault = (ta.value === defaultSystemPrompt);
    defaultSystemPrompt = await fetchDefaultSysPrompt();
    if(wasDefault){ ta.value = defaultSystemPrompt; sysPromptState("default"); }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("ai-mapping-generator.html");
  if(typeof migrateLegacyTargetSchema === "function") migrateLegacyTargetSchema();
  targetSchema = (typeof getTargetSchema === "function") ? getTargetSchema() : null;

  loadGeneratedCols();   // lock+check columns already mapped
  seedStrategyFromSettings();  // apply the Settings "Default Mapping Strategy" (user can still change it)
  initBizContext();      // restore a saved Business Context (falls back to the default)
  initSystemPrompt();    // load the editable AI system prompt (default from backend)
  buildSourceOptions();
  buildTargetSummary();
  renderTablePicker();
  await checkAiStatus();

  const selAll = document.getElementById("selectAllTablesBtn");
  const clr = document.getElementById("clearTablesBtn");
  // "Select All" respects the current search filter — selects all columns of visible tables.
  if(selAll) selAll.addEventListener("click", () => { visibleEntities().forEach(e => selectAllColumns(e)); renderTablePicker(); });
  if(clr) clr.addEventListener("click", () => { selectedCols = {}; renderTablePicker(); });
  const search = document.getElementById("tableSearch");
  if(search) search.addEventListener("input", debounce((e) => { tableFilter = (e.target.value||"").toLowerCase().trim(); renderTablePicker(); }, 150));


  document.getElementById("mappingStrategy").addEventListener("change", (e) => {
    document.getElementById("strategyHint").textContent = STRATEGY_HINTS[e.target.value];
  });
  document.getElementById("sourceSelect").addEventListener("change", () => { sourceCache = null; });
  // Top and bottom action buttons share the same handler.
  ["generateBtn","generateBtnTop"].forEach(id => { const b = document.getElementById(id); if(b) b.addEventListener("click", generateMappings); });

  // Hide the AI Processing Console column so the configuration area gets full width.
  const hideBtn = document.getElementById("hideConsoleBtn");
  const showBtn = document.getElementById("showConsoleBtn");
  if(hideBtn) hideBtn.addEventListener("click", () => setConsoleHidden(true));
  if(showBtn) showBtn.addEventListener("click", () => setConsoleHidden(false));
  if(lsGet("aims_console_hidden", false)) setConsoleHidden(true);   // restore preference
});

// Show/hide the AI Processing Console column; config column widens when hidden.
function setConsoleHidden(hidden){
  const configCol = document.getElementById("configCol");
  const consoleCol = document.getElementById("consoleCol");
  const showBtn = document.getElementById("showConsoleBtn");
  if(!configCol || !consoleCol) return;
  consoleCol.style.display = hidden ? "none" : "";
  configCol.classList.toggle("col-lg-7", !hidden);
  configCol.classList.toggle("col-lg-12", hidden);
  if(showBtn) showBtn.style.display = hidden ? "" : "none";
  lsSet("aims_console_hidden", hidden);
}

/* ---------- inputs ---------- */
function buildSourceOptions(){
  const sel = document.getElementById("sourceSelect");
  const conns = (typeof getDbConnections === "function") ? getDbConnections() : [];
  if(!conns.length){
    sel.innerHTML = '<option value="">No source system configured</option>';
    return;
  }
  sel.innerHTML = conns.map(c => '<option value="' + c.id + '">' + escapeHtml(c.name) + ' (' + escapeHtml(c.type||"SQL Server") + ')</option>').join("");
  const connected = conns.find(c => c.status === "Connected");
  if(connected) sel.value = connected.id;
}

function buildTargetSummary(){
  const el = document.getElementById("targetSummary");
  if(targetSchema && targetSchema.entities && targetSchema.entities.length){
    const isDb = (targetSchema.version || "").toLowerCase().indexOf("database") !== -1;
    const icon = isDb ? "bi-hdd-network" : "bi-file-earmark-excel";
    el.innerHTML = '<span class="badge-soft badge-high"><i class="bi ' + icon + '"></i> ' +
      escapeHtml(targetSchema.application || targetSchema.sourceFileName || "target") + '</span> ' +
      '<span class="badge-soft badge-gray">' + targetSchema.tableCount + ' tables</span> ' +
      '<span class="badge-soft badge-gray">' + targetSchema.columnCount + ' fields</span> ' +
      '<a href="target-system.html" class="text-xs" style="text-decoration:none;">change target</a>';
  } else {
    el.innerHTML = '<span class="badge-soft badge-medium"><i class="bi bi-exclamation-triangle"></i> No active target — add one on <a href="target-system.html">Target System</a>.</span>';
  }
}

// Entities matching the current search filter (by entity name or table name).
function visibleEntities(){
  const all = (targetSchema && targetSchema.entities) || [];
  if(!tableFilter) return all;
  return all.filter(e => (e.name||"").toLowerCase().indexOf(tableFilter) !== -1
                      || (e.table||"").toLowerCase().indexOf(tableFilter) !== -1);
}

function renderTablePicker(){
  const grid = document.getElementById("targetTablePick");
  if(!grid) return;
  if(!targetSchema || !targetSchema.entities || !targetSchema.entities.length){
    grid.innerHTML = '<div class="text-xs text-muted-2">No target schema uploaded yet.</div>';
    return;
  }
  // Preserve the scroll position of each expanded column list so ticking a column
  // that's mid-list or at the bottom doesn't jump the list back to the top on re-render.
  const savedScroll = {};
  grid.querySelectorAll(".entity-card").forEach(card => {
    const cols = card.querySelector(".ec-cols");
    if(cols && cols.style.display !== "none") savedScroll[card.dataset.entity] = cols.scrollTop;
  });
  const rows = visibleEntities();
  const info = document.getElementById("tablePickInfo");
  if(info){
    const total = targetSchema.entities.length;
    info.textContent = (tableFilter ? ("Showing " + rows.length + " of " + total) : ("" + total + " tables"))
      + " · " + totalSelectedCols() + " new column(s) selected"
      + (totalGeneratedCols() ? (" · " + totalGeneratedCols() + " already mapped") : "");
  }
  if(!rows.length){
    grid.innerHTML = '<div class="text-xs text-muted-2">No tables match "' + escapeHtml(tableFilter) + '".</div>';
    return;
  }
  grid.innerHTML = rows.map(e => {
    const total = (e.fields||[]).length;
    const genCount = generatedCols[e.name] ? generatedCols[e.name].size : 0;
    const selCount = selectedCols[e.name] ? selectedCols[e.name].size : 0;
    const checkedCount = genCount + selCount;
    // card state: fully checked / partially / none
    const state = checkedCount === 0 ? "" : (checkedCount >= total ? "selected" : "partial");
    const checkIcon = checkedCount === 0 ? "" : (checkedCount >= total ? '<i class="bi bi-check-lg"></i>' : '<i class="bi bi-dash-lg"></i>');
    const open = expandedEntities.has(e.name);
    const allGenerated = genCount >= total && total > 0;   // whole table already mapped

    // Per-table column search: match ANYWHERE in the column name (substring, case-insensitive).
    const cf = (colFilters[e.name] || "").toLowerCase();
    const visibleFields = cf
      ? (e.fields||[]).filter(f => (f.name||"").toLowerCase().indexOf(cf) !== -1)
      : (e.fields||[]);

    const colRows = visibleFields.map(f => {
      const locked = isColGenerated(e.name, f.name);
      const on = locked || isColSelected(e.name, f.name);
      return '<label class="ec-col' + (locked ? " locked" : "") + '" data-col="' + escapeHtml(f.name) + '"' +
        (locked ? ' title="Already mapped — clear the document to regenerate"' : '') + '>' +
        '<input type="checkbox" class="ec-col-cb" ' + (on?"checked":"") + (locked?" disabled":"") + '>' +
        '<span class="ec-col-name mono">' + escapeHtml(f.name) + '</span>' +
        '<span class="ec-col-type">' + (locked ? '<i class="bi bi-lock-fill" title="mapped"></i> ' : '') + escapeHtml(f.dataType || "") + '</span>' +
      '</label>';
    }).join("");

    // Search box + (when filtering) a small result count / empty note.
    const colSearchBox =
      '<div class="ec-col-search">' +
        '<i class="bi bi-search"></i>' +
        '<input type="text" class="ec-col-search-input" data-colsearch="' + escapeHtml(e.name) + '"' +
          ' placeholder="Search columns..." value="' + escapeHtml(colFilters[e.name] || "") + '">' +
      '</div>' +
      (cf
        ? (visibleFields.length
            ? '<div class="ec-col-count text-xs text-muted-2">' + visibleFields.length + ' of ' + total + ' columns</div>'
            : '<div class="ec-col-count text-xs text-muted-2">No columns match "' + escapeHtml(colFilters[e.name]) + '".</div>')
        : "");

    return '<div class="entity-card ' + state + '" data-entity="' + escapeHtml(e.name) + '">' +
      '<div class="ec-head">' +
        '<div class="ec-name" title="' + escapeHtml(e.name) + '"><i class="bi bi-diagram-2"></i> <span class="ec-name-text">' + escapeHtml(e.name) + '</span>' + (allGenerated ? ' <span class="badge-soft badge-high" style="font-size:.6rem;padding:1px 6px;">mapped</span>' : '') + '</div>' +
        '<div class="ec-check ' + (state==="partial"?"partial":"") + '">' + checkIcon + '</div>' +
      '</div>' +
      '<div class="ec-table" title="' + escapeHtml(e.table||"") + '">' + escapeHtml(e.table||"") + '</div>' +
      '<div class="ec-meta">' +
        '<span><i class="bi bi-list-columns"></i> ' + checkedCount + ' / ' + total + ' cols' + (genCount ? ' (' + genCount + ' mapped)' : '') + '</span>' +
        '<button type="button" class="ec-expand" data-expand="' + escapeHtml(e.name) + '">' +
          '<i class="bi bi-chevron-' + (open?"up":"down") + '"></i> ' + (open?"hide":"columns") + '</button>' +
      '</div>' +
      '<div class="ec-cols" style="display:' + (open?"block":"none") + ';">' + colSearchBox + colRows + '</div>' +
    '</div>';
  }).join("");

  // Card header toggles whole-table selection (but not when clicking the expand button or a column).
  grid.querySelectorAll(".entity-card").forEach(card => {
    const name = card.dataset.entity;
    card.querySelector(".ec-head").addEventListener("click", () => { toggleEntity(entityByName(name)); renderTablePicker(); });
    const expandBtn = card.querySelector("[data-expand]");
    if(expandBtn) expandBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      expandedEntities.has(name) ? expandedEntities.delete(name) : expandedEntities.add(name);
      renderTablePicker();
    });
    card.querySelectorAll(".ec-col").forEach(lbl => {
      lbl.addEventListener("click", (ev) => ev.stopPropagation());   // don't bubble to header
      const cb = lbl.querySelector(".ec-col-cb");
      if(cb) cb.addEventListener("change", () => { toggleColumn(name, lbl.dataset.col); renderTablePicker(); });
    });
    // Per-table column search: filter as you type. Re-render, then restore focus +
    // caret to the search box (re-render replaces the input node).
    const colSearch = card.querySelector("[data-colsearch]");
    if(colSearch){
      colSearch.addEventListener("click", (ev) => ev.stopPropagation());   // don't toggle the card
      colSearch.addEventListener("input", (ev) => {
        colFilters[name] = ev.target.value || "";
        focusColSearch = name;   // tell the next render to refocus this box
        renderTablePicker();
      });
    }
    // restore this card's column-list scroll position
    if(savedScroll[name] != null){
      const cols = card.querySelector(".ec-cols");
      if(cols) cols.scrollTop = savedScroll[name];
    }
  });

  // Restore focus to the column-search box that triggered this render (keeps typing smooth).
  if(focusColSearch){
    const box = grid.querySelector('[data-colsearch="' + (window.CSS && CSS.escape ? CSS.escape(focusColSearch) : focusColSearch) + '"]');
    if(box){ const v = box.value; box.focus(); try{ box.setSelectionRange(v.length, v.length); }catch(e){} }
    focusColSearch = null;
  }
  updateSelCount();
}

function updateSelCount(){
  const n = selectedEntityNames().length;
  const cols = totalSelectedCols();
  const label = n
    ? '<i class="bi bi-stars me-1"></i> Generate Mapping for ' + cols + ' new column' + (cols>1?'s':'') + ' in ' + n + ' table' + (n>1?'s':'')
    : '<i class="bi bi-stars me-1"></i> Generate Mapping with AI';
  ["generateBtn","generateBtnTop"].forEach(id => { const b = document.getElementById(id); if(b) b.innerHTML = label; });
}
function setGenerateDisabled(disabled){
  ["generateBtn","generateBtnTop"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = disabled; });
}

async function checkAiStatus(){
  const el = document.getElementById("aiStatus");
  try{
    const res = await fetch("/api/ai/status");
    const data = await res.json();
    if(data.ok){ el.innerHTML = '<span class="badge-soft badge-high"><i class="bi bi-cpu"></i> AI engine ready (Claude)</span>'; }
    else { el.innerHTML = '<span class="badge-soft badge-low"><i class="bi bi-exclamation-circle"></i> ' + escapeHtml(data.reason||"AI unavailable") + '</span>'; }
  }catch(err){
    el.innerHTML = '<span class="badge-soft badge-low"><i class="bi bi-plug"></i> Backend not reachable. Start it with python server/app.py.</span>';
  }
}

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

/* ---------- load live source columns ---------- */
async function loadSource(){
  const id = document.getElementById("sourceSelect").value;
  const conn = getDbConnection(id);
  if(!conn) throw new Error("Select a source system first.");
  if(sourceCache && sourceCache._id === id) return sourceCache;

  // File System sources carry their extracted tables on the connection — no live DB call.
  if((conn.type || "").toLowerCase() === "file system"){
    if(!conn.tables || !conn.tables.length){
      throw new Error("This File System source has no extracted schema. Open it in Source Systems and click 'Extract with AI'.");
    }
    sourceCache = {_id:id, connection: conn.name, schema: conn.schema || null, tables: conn.tables};
    return sourceCache;
  }

  const pw = await ensureConnPassword(conn);
  if(pw === null) throw new Error("A password is required to read this source.");
  const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(connToConfig(Object.assign({}, conn, {password: pw})))});
  const data = await res.json();
  if(!data.ok) throw new Error(data.error || "Could not read source metadata.");
  sourceCache = {_id:id, connection:data.connection, schema:data.schema,
    tables:data.tables.map(t => ({name:t.name, columns:(t.columns||[]).map(c => ({
      name:c.name, dataType:c.dataType, length:c.length,
      businessTerm:c.businessTerm||"", description:c.description||"", sample:c.sample
    }))}))};
  return sourceCache;
}

/* ---------- live progress-log helpers (per-table status) ---------- */
function logReset(containerId){ const el = document.getElementById(containerId); if(el) el.innerHTML = ""; return el; }
function logStep(containerId, text){
  // Append a new spinning line; return it so it can be marked done/error later.
  const el = document.getElementById(containerId);
  if(!el) return null;
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = '<span class="spin"><i class="bi bi-arrow-repeat"></i></span> ' + escapeHtml(text);
  el.appendChild(line);
  requestAnimationFrame(() => { line.style.opacity = "1"; el.scrollTop = el.scrollHeight; });
  return line;
}
function logDone(line, text){
  if(!line) return;
  line.classList.add("done");
  line.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(text || line.textContent.trim());
}
function logFail(line, text){
  if(!line) return;
  line.classList.add("error");
  line.innerHTML = '<i class="bi bi-x-circle-fill"></i> ' + escapeHtml(text || line.textContent.trim());
}
function logInfo(containerId, text){
  const line = logStep(containerId, text);
  if(line){ line.classList.remove("log-line"); line.className = "log-line done"; line.innerHTML = '<i class="bi bi-info-circle"></i> ' + escapeHtml(text); }
  return line;
}

/* ---------- generate (real LLM call, one table at a time) ---------- */
async function generateMappings(){
  if(!targetSchema || !targetSchema.entities.length){ showNotification("Upload a target schema first.", "warning"); return; }
  if(!selectedEntityNames().length){ showNotification("Select at least one NEW target column to map. Already-mapped columns are locked — use Clear All in the Workspace to regenerate them.", "warning"); return; }
  setConsoleHidden(false);   // make sure the processing console is visible while generating
  setGenerateDisabled(true);
  document.getElementById("aiResultBox").innerHTML = "";
  logReset("aiLog");

  let src;
  try{
    const l = logStep("aiLog", "Loading source system...");
    src = await loadSource();
    logDone(l, "Source loaded: " + src.tables.length + " tables, " +
      src.tables.reduce((a,t)=>a+t.columns.length,0) + " columns from " + src.connection);
  }catch(err){
    logFail(logStep("aiLog", "Loading source system..."), "Source error: " + err.message);
    showNotification(err.message, "danger");
    setGenerateDisabled(false);
    return;
  }

  // Build the list to generate: each selected entity, but ONLY its selected columns.
  const chosen = selectedEntityNames().map(name => {
    const e = entityByName(name);
    const set = selectedCols[name];
    const fields = (e.fields||[]).filter(f => set.has(f.name));   // preserve original order
    return {name: e.name, table: e.table, fields: fields, totalFields: (e.fields||[]).length};
  });
  const commonSource = {connection: src.connection, schema: src.schema, tables: src.tables};
  const businessContext = document.getElementById("bizContext").value;
  const strategy = document.getElementById("mappingStrategy").value;
  // Send the edited system prompt only when it differs from the current default, so an
  // untouched box lets the backend interpolate the chosen strategy itself.
  const sysBox = document.getElementById("genSystemPrompt");
  const systemPrompt = (sysBox && sysBox.value.trim() && sysBox.value !== defaultSystemPrompt) ? sysBox.value : "";

  const allNewRows = [];
  const joins = {};   // join conditions for THIS run's tables only
  let totalIn = 0, totalOut = 0;

  try{
    // Process each selected table in its own request so we can show which one is
    // running and stop with a clear error the moment any table's model call fails.
    for(let i = 0; i < chosen.length; i++){
      const e = chosen[i];
      const nFields = (e.fields||[]).length;
      const line = logStep("aiLog", "[" + (i+1) + "/" + chosen.length + "] Mapping '" + e.name + "' (" + nFields + " of " + e.totalFields + " columns)...");

      // Guard: nothing selected for this table (shouldn't happen, but be safe).
      if(!nFields){
        logFail(line, "[" + (i+1) + "/" + chosen.length + "] '" + e.name + "' has no selected columns.");
        throw new Error("Target table '" + e.name + "' has no selected columns to map.");
      }

      const payload = {
        source: commonSource,
        targetEntities: [{
          name: e.name, table: e.table,
          fields: e.fields.map(f => ({name:f.name, dataType:f.dataType, length:f.length,
            mandatory:f.mandatory, pk:f.pk, fk:f.fk, fkReference:f.fkReference, accepted:f.accepted, description:f.description}))
        }],
        businessContext, strategy, systemPrompt
      };

      let res, data;
      try{
        res = await fetch("/api/ai/generate-mappings", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
      }catch(netErr){
        logFail(line, "[" + (i+1) + "/" + chosen.length + "] '" + e.name + "' — backend not reachable. Start it with python server/app.py.");
        throw new Error("Backend not reachable while mapping '" + e.name + "'. Start it with python server/app.py.");
      }
      try{ data = await res.json(); }
      catch(parseErr){ data = {ok:false, error:"Server returned an invalid response (HTTP " + res.status + ")."}; }

      if(!res.ok || !data.ok){
        const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
        logFail(line, "[" + (i+1) + "/" + chosen.length + "] '" + e.name + "' FAILED — " + msg);
        throw new Error("AI model failed while mapping '" + e.name + "': " + msg);
      }

      const rows = buildMappingRows(data.mappings);
      allNewRows.push({entity: e.name, rows: rows});
      (data.joins || []).forEach(j => { if(j && j.targetEntity) joins[j.targetEntity] = j.joinCondition || ""; });
      if(data.usage){ totalIn += data.usage.input_tokens||0; totalOut += data.usage.output_tokens||0; }

      const mapped = rows.filter(r => r.mappingType !== "Not Mapped").length;
      logDone(line, "[" + (i+1) + "/" + chosen.length + "] '" + e.name + "' done — " + mapped + "/" + rows.length + " columns mapped");
    }

    // ACCUMULATE into the existing document at COLUMN granularity: new rows for a
    // (table, column) replace any prior row for that column; every other prior row is
    // kept. Nothing is removed until the user clicks "Clear All" in the Workspace.
    const flatNew = allNewRows.flatMap(x => x.rows);
    const keyOf = r => (r.targetEntity || "") + "||" + (r.targetColumn || "");
    const merged = (lsGet(LS_AI_MAPPINGS, []) || []).slice();
    const indexByKey = {};
    merged.forEach((r, idx) => { indexByKey[keyOf(r)] = idx; });
    flatNew.forEach(r => {
      const k = keyOf(r);
      if(indexByKey[k] !== undefined) merged[indexByKey[k]] = r;   // replace this column
      else { indexByKey[k] = merged.length; merged.push(r); }      // add new column
    });
    merged.forEach((r,i) => { r.id = "AI-" + String(i+1).padStart(4,"0"); });
    lsSet(LS_AI_MAPPINGS, merged);

    // Merge joins: overwrite this run's tables, keep the rest.
    const allJoins = lsGet("aims_ai_joins", {}) || {};
    Object.keys(joins).forEach(k => { allJoins[k] = joins[k]; });
    lsSet("aims_ai_joins", allJoins);

    // Lock the columns we just generated (move them from "selected" -> "generated")
    // so they show greyed+checked and are excluded from the next Generate.
    chosen.forEach(e => {
      if(!generatedCols[e.name]) generatedCols[e.name] = new Set();
      e.fields.forEach(f => generatedCols[e.name].add(f.name));
      delete selectedCols[e.name];   // clear the new-selection for this table
    });
    renderTablePicker();

    // Audit trail: record one entry per generated table (keyed by a row in that table).
    if(typeof addHistoryRecord === "function"){
      allNewRows.forEach(x => {
        if(!x.rows.length) return;
        const mapped = x.rows.filter(r => r.mappingType !== "Not Mapped").length;
        addHistoryRecord(x.rows[0].id, {
          changeType: "Regenerated",
          previousValue: "-",
          newValue: mapped + "/" + x.rows.length + " columns mapped",
          reason: "AI generated mappings for " + x.entity,
          user: (typeof currentUserName === "function" ? currentUserName() : "User"),
          source: "AI"
        });
      });
    }

    logInfo("aiLog", "Done. " + flatNew.length + " column(s) added/updated; document now has " + merged.length + " rows.");
    renderResult(flatNew, {input_tokens: totalIn, output_tokens: totalOut}, chosen.length, merged.length);
    showNotification("AI generated " + flatNew.length + " column mapping(s); document now has " + merged.length + " rows.", "success");
  }catch(err){
    showNotification(err.message || "Mapping generation failed.", "danger");
  }finally{
    setGenerateDisabled(false);
  }
}

// Turn the model output into the app's mapping-row shape.
function buildMappingRows(items){
  const entIndex = {};
  (targetSchema.entities||[]).forEach(e => { entIndex[e.name] = e; });
  // Index source columns by "table||column" so we can attach the real source
  // data type/length to each row (needed for the validation type/length rules).
  const srcIndex = {};
  ((sourceCache && sourceCache.tables) || []).forEach(t =>
    (t.columns||[]).forEach(c => { srcIndex[(t.name||"") + "||" + (c.name||"")] = c; }));

  return (items||[]).map((m, i) => {
    const ent = entIndex[m.targetEntity] || {};
    const field = (ent.fields||[]).find(f => f.name === m.targetColumn) || {};
    const unmapped = m.mappingType === "Not Mapped" || !m.sourceColumn;
    const srcCol = (!unmapped && srcIndex[(m.sourceTable||"") + "||" + (m.sourceColumn||"")]) || {};
    return {
      id: "AI-" + String(i+1).padStart(4,"0"),
      targetSystem: targetSchema.application || "Target",
      targetEntity: m.targetEntity, targetTable: ent.table || "",
      targetColumn: m.targetColumn, targetDataType: field.dataType || "", targetLength: field.length ?? null,
      targetDescription: field.description || "",
      sourceSystem: unmapped ? "" : (sourceCache ? sourceCache.connection : ""),
      sourceSchema: "", sourceTable: unmapped ? "" : m.sourceTable,
      sourceColumn: unmapped ? "(no source equivalent)" : m.sourceColumn,
      sourceDataType: srcCol.dataType || "", sourceLength: srcCol.length ?? null, sampleSourceValue: srcCol.sample ?? "",
      mappingType: m.mappingType, transformationRule: m.transformationRule || "",
      businessRule: m.businessRule || "", defaultValue: field.default || "", lookupTable: "",
      nullHandling: m.nullHandling || (field.mandatory ? "Reject null" : "Allow null"),
      confidence: Math.max(0, Math.min(100, m.confidence || 0)),
      aiExplanation: m.explanation ? [m.explanation] : [],
      // Confidence-based status from the Settings thresholds (not a hardcoded cutoff):
      // "Passed"/Approved requires >= High; below the Medium threshold always needs review.
      validationStatus: autoValidationStatus({mappingType: m.mappingType, confidence: m.confidence}),
      reviewStatus: unmapped ? "Needs Review" : (m.confidence >= getSettings().mediumConfidence ? "AI Generated" : "Needs Review"),
      createdBy: "AI Engine (Claude)", updatedBy: "AI Engine (Claude)",
      lastUpdated: new Date().toISOString(), comments: []
    };
  });
}

function renderResult(rows, usage, tableCount, totalInDoc){
  const box = document.getElementById("aiResultBox");
  const s = getSettings();
  const high = rows.filter(m => m.confidence >= s.highConfidence).length;
  const review = rows.filter(m => m.reviewStatus === "Needs Review").length;
  const unmapped = rows.filter(m => m.mappingType === "Not Mapped").length;
  box.innerHTML =
    '<div class="hint-note mb-2"><i class="bi bi-check-circle"></i> Claude generated <strong>' + rows.length + '</strong> field mappings for <strong>' + tableCount + '</strong> table(s).</div>' +
    '<div class="kv-list mb-2">' +
      '<span class="k">High Confidence</span><span>' + high + '</span>' +
      '<span class="k">Needs Review</span><span>' + review + '</span>' +
      '<span class="k">Unmapped Target Fields</span><span>' + unmapped + '</span>' +
      '<span class="k">Total in Document</span><span>' + totalInDoc + '</span>' +
      (usage ? '<span class="k">Tokens (in/out)</span><span>' + usage.input_tokens + ' / ' + usage.output_tokens + '</span>' : '') +
    '</div>' +
    '<p class="text-xs text-muted-2">Tip: generated columns are added to the document and kept until you click <strong>Clear All</strong> in the Mapping Workspace. Expand a table to map only specific columns.</p>' +
    '<a href="mapping-workspace.html?source=ai" class="btn btn-primary w-100"><i class="bi bi-grid-3x3-gap me-1"></i> Open in Mapping Workspace</a>';
}
