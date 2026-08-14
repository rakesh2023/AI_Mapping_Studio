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
});

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
function closeForm(){ document.getElementById("connFormCard").style.display = "none"; editingId = null; stagedEntities = null; }

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

  try{
    if(ext === "xlsx" || ext === "xls"){
      // In-browser parse (SheetJS) using the existing target-schema parser.
      const schema = await ingestTargetSchemaFile(file);   // also sets legacy blob; fine
      stagedEntities = schema.entities;
      el.innerHTML = okNote("Parsed " + schema.tableCount + " tables, " + schema.columnCount + " columns from " + escapeHtml(file.name) + ". Save the target to keep it.");
    } else {
      // Other formats: let the backend + AI extract the structure, with progress.
      const out = await streamExtractFile(file, (evt) => {
        if(evt.type === "start"){
          el.innerHTML = renderExtractProgress(0, evt.chunks || 0, 0, 0, "Starting…", evt.unit || "parts");
        } else if(evt.type === "progress"){
          el.innerHTML = renderExtractProgress(evt.done, evt.total, evt.tables, evt.columns, evt.label || "", "");
        }
      });
      stagedEntities = extractedToEntities(out.tables);
      const cols = stagedEntities.reduce((a,e)=>a+(e.fields||[]).length,0);
      el.innerHTML = okNote("Extracted " + stagedEntities.length + " tables, " + cols + " columns from " + escapeHtml(out.fileName || file.name) +
        (out.truncatedChunks ? " (file was large — capped at " + out.chunks + " parts)" : "") + ". Save the target to keep it.");
    }
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
  showNotification("Target '" + conn.name + "' saved" + (getActiveTargetId() === conn.id ? " and set active." : "."), "success");
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
  if(!has) return;

  document.getElementById("schemaMeta").innerHTML =
    '<span class="badge-soft badge-high"><i class="bi bi-hdd-network"></i> ' + escapeHtml(meta.application || "Target") + '</span> ' +
    '<span class="badge-soft badge-gray">' + escapeHtml(meta.version || "") + '</span> ' +
    '<span class="badge-soft badge-gray">' + meta.tableCount + ' tables</span> ' +
    '<span class="badge-soft badge-gray">' + meta.columnCount + ' columns</span>';

  renderTargetTree(meta);
  if(meta.entities.length) selectEntity(meta.entities[0].name);
}

function renderTargetTree(meta){
  const tree = document.getElementById("targetTree");
  let items = "";
  meta.entities.forEach(e => {
    const icon = e.isListTable ? "bi-list-ul" : "bi-diagram-2";
    items += '<li><div class="tree-node" data-entity="' + escapeHtml(e.name) + '"><i class="bi ' + icon + '"></i> ' + escapeHtml(e.name) + '</div></li>';
  });
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-box"></i> ' + escapeHtml(meta.application || "Target Schema") + '</div>' +
      '<ul class="tree-children">' + items + '</ul>' +
    '</li>';
  document.querySelectorAll("[data-entity]").forEach(n => n.addEventListener("click", () => selectEntity(n.dataset.entity)));
}

function selectEntity(name){
  const meta = getTargetSchema();
  activeEntity = meta.entities.find(e => e.name === name);
  if(!activeEntity) return;
  document.querySelectorAll("[data-entity]").forEach(n => n.classList.toggle("active", n.dataset.entity === name));
  document.getElementById("targetTitle").innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) +
    ' <span class="text-muted-2 text-xs">(' + escapeHtml(activeEntity.table || name) + ')</span>';
  const addBtn = document.getElementById("addColumnBtn");
  if(addBtn) addBtn.style.display = "";   // an entity is selected -> allow adding a column
  renderTargetFields();
}

function renderTargetFields(){
  if(!activeEntity) return;
  const search = (document.getElementById("targetSearch").value || "").toLowerCase();
  const fields = activeEntity.fields.filter(f => !search || f.name.toLowerCase().indexOf(search) !== -1);
  const body = document.getElementById("targetFieldsBody");
  if(!fields.length){
    body.innerHTML = '<tr><td colspan="13"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching fields</h4></div></td></tr>';
    return;
  }
  body.innerHTML = fields.map(f =>
    '<tr data-col="' + escapeHtml(f.name) + '">' +
      '<td>' + escapeHtml(activeEntity.name) + '</td>' +
      '<td class="mono">' + escapeHtml(activeEntity.table || "") + '</td>' +
      '<td class="mono">' + escapeHtml(f.name) + '</td>' +
      '<td>' + escapeHtml(f.dataType || "") + '</td>' +
      '<td>' + (f.length ?? "-") + '</td>' +
      '<td>' + (f.mandatory ? '<span class="badge-soft badge-low">Required</span>' : '<span class="badge-soft badge-gray">Optional</span>') + '</td>' +
      '<td>' + (f.pk ? '<i class="bi bi-key-fill text-warning" title="Primary Key"></i>' : "") + '</td>' +
      '<td>' + (f.fk ? '<i class="bi bi-link-45deg text-primary" title="Foreign Key"></i>' + (f.fkReference ? ' <span class="text-xs mono">' + escapeHtml(f.fkReference) + '</span>' : "") : "") + '</td>' +
      '<td>' + (f.isListTable || activeEntity.isListTable ? '<span class="badge-soft badge-medium">List</span>' : '<span class="text-muted-2">-</span>') + '</td>' +
      '<td class="wrap">' + escapeHtml(f.description || "") + '</td>' +
      '<td>' + escapeHtml(f.businessTerm || "-") + '</td>' +
      '<td class="wrap">' + escapeHtml(f.accepted || "-") + '</td>' +
      '<td>' + escapeHtml(f.default ?? "-") + '</td>' +
    '</tr>'
  ).join("");
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
    const c = data.column;
    if((c.confidence || 0) < 45){
      errBox.innerHTML = failNote("Not confident about that request" + (c.note ? ": " + c.note : ".") + " Edit the form below or rephrase.");
    }
    // prefill the shared form (preview — user confirms with Add Column)
    document.getElementById("acName").value = c.column || "";
    document.getElementById("acType").value = AC_TYPES.indexOf((c.dataType||"").toLowerCase()) !== -1 ? c.dataType.toLowerCase() : "varchar";
    acToggleLen();
    if(c.length != null) document.getElementById("acLen").value = c.length;
    document.getElementById("acMandatory").value = c.mandatory ? "true" : "false";
    document.getElementById("acPk").checked = !!c.pk;
    document.getElementById("acFk").checked = !!c.fk;
    acToggleFk();
    document.getElementById("acFkRef").value = c.fkReference || "";
    document.getElementById("acDesc").value = c.description || "";
    document.getElementById("acAfter").value = (c.afterColumn && (activeEntity.fields||[]).some(f => f.name === c.afterColumn)) ? c.afterColumn : "";
    acSwitchTab("manual");   // show the pre-filled form to confirm
    if(c.duplicate) acSetErr("acName", "A column named '" + c.column + "' already exists.");
    showNotification("AI filled the form — review and click Add Column.", "primary", 2500);
  }catch(err){
    status.textContent = "";
    errBox.innerHTML = failNote("Backend not reachable. Start it with: cd server && python main.py");
  }
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
