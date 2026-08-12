/* =========================================================================
   etl-code.js - ETL Code (SQL) Generator page.

   Lets the user pick target tables (that have generated mappings) and produces
   a SQL stored procedure per table, following the project's INSERT template:
   USE [<db>] / ALTER PROCEDURE [dbo].[INSERT_<db>_<Table>] / TRY..CATCH with
   CLAIM_CONVERSION_EXECUTION_LOG logging. Deterministic fill from the mapping
   document (no AI) — INSERT column list, SELECT (source col AS target col with
   transformation), and the entity's saved FROM/JOIN.
   ========================================================================= */

const LS_ETL_DB = "aims_etl_db";
const LS_ETL_INSTRUCTIONS = "aims_etl_instructions";

let etlGroups = [];              // [{name, entity, table, rows:[...], join}]
let etlSelected = new Set();     // selected target-table keys
let etlSearch = "";

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("etl-code.html");

  // Same mapping document the workspace uses (null = never generated -> sample).
  const aiRows = lsGet("aims_ai_mappings", null);
  const rawMappings = (aiRows !== null) ? aiRows : (await fetchJSON("mappings.json") || []);
  const mappings = (typeof applyOverrides === "function") ? applyOverrides(rawMappings || []) : (rawMappings || []);
  const joins = lsGet("aims_ai_joins", {}) || {};

  // KPI tiles
  setText("etlTotal", mappings.length);
  setText("etlApproved", mappings.filter(m => (m.reviewStatus || "").indexOf("Approved") === 0).length);
  setText("etlTables", new Set(mappings.map(m => m.targetEntity).filter(Boolean)).size);
  setText("etlJoins", Object.values(joins).filter(v => v && String(v).trim()).length);

  etlGroups = groupByTargetTable(mappings, joins);

  initDbName();
  initInstructions();
  renderTableList();
  wireControls();
});

/* ---- AI Processing Console (right-side column; hidden until you generate) ---- */
function etlConsoleShow(){
  const col = document.getElementById("etlConsoleCol");
  if(col) col.style.display = "";          // reveal the console column
  layoutEtlCols();
}
function etlConsoleHide(){
  const col = document.getElementById("etlConsoleCol");
  if(col) col.style.display = "none";      // collapse (re-opens on the next generate)
  layoutEtlCols();
}
// Recompute the widths of Target Tables / Generated SQL / Console based on which
// side panels are visible, so the SQL box always fills the remaining space.
function layoutEtlCols(){
  const panel = document.getElementById("etlPanelCol");
  const grid = document.getElementById("etlGridCol");
  const con = document.getElementById("etlConsoleCol");
  if(!grid) return;
  const p = panel && panel.style.display !== "none";
  const c = con && con.style.display !== "none";
  let gw;
  if(p && c) gw = 5; else if(!p && c) gw = 8; else if(p && !c) gw = 9; else gw = 12;
  grid.className = grid.className.replace(/\bcol-lg-\d+\b/g, "").replace(/\s+/g, " ").trim() + " col-lg-" + gw;
}
function etlLogReset(){
  const el = document.getElementById("etlLog");
  if(el){ el.style.display = ""; el.innerHTML = ""; }
}
function etlLogStep(text){
  const el = document.getElementById("etlLog");
  if(!el) return null;
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = '<span class="spin"><i class="bi bi-arrow-repeat"></i></span> ' + escapeHtml(text);
  el.appendChild(line);
  requestAnimationFrame(() => { line.style.opacity = "1"; el.scrollTop = el.scrollHeight; });
  return line;
}
function etlLogDone(line, text){
  if(!line) return;
  line.classList.add("done");
  line.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(text || line.textContent.trim());
}
function etlLogFail(line, text){
  if(!line) return;
  line.classList.add("error");
  line.innerHTML = '<i class="bi bi-x-circle-fill"></i> ' + escapeHtml(text || line.textContent.trim());
}
function etlLogInfo(text){
  const el = document.getElementById("etlLog");
  if(!el) return;
  const line = document.createElement("div");
  line.className = "log-line done";
  line.innerHTML = '<i class="bi bi-info-circle"></i> ' + escapeHtml(text);
  el.appendChild(line);
  requestAnimationFrame(() => { line.style.opacity = "1"; el.scrollTop = el.scrollHeight; });
}

/* Additional AI instructions for SQL generation — persisted with the project so
   they're ready when AI-assisted generation is enabled. */
function initInstructions(){
  const ta = document.getElementById("etlInstructions");
  if(!ta) return;
  const saved = lsGet(LS_ETL_INSTRUCTIONS, null);
  if(saved != null) ta.value = saved;
  ta.addEventListener("input", () => lsSet(LS_ETL_INSTRUCTIONS, ta.value));
}
function currentEtlInstructions(){
  const ta = document.getElementById("etlInstructions");
  return ta ? (ta.value || "").trim() : "";
}

/* ---- group mapping rows by target table ---- */
function groupByTargetTable(mappings, joins){
  const map = {};
  const order = [];
  (mappings || []).forEach(m => {
    const key = (m.targetTable || m.targetEntity || "").trim();
    if(!key) return;
    if(!map[key]){
      map[key] = {name:key, entity:(m.targetEntity||key), table:(m.targetTable||key), rows:[], join:""};
      order.push(key);
    }
    map[key].rows.push(m);
  });
  order.forEach(k => {
    const g = map[k];
    g.join = (joins[g.entity] || joins[g.name] || "").trim();
  });
  return order.map(k => map[k]).sort((a,b) => a.name.localeCompare(b.name));
}

/* ---- left panel: selectable table cards (like the workspace Target Tables) ---- */
function renderTableList(){
  const el = document.getElementById("etlTableList");
  if(!el) return;
  let groups = etlGroups;
  if(etlSearch){
    groups = groups.filter(g => g.name.toLowerCase().indexOf(etlSearch) !== -1
                            || (g.table||"").toLowerCase().indexOf(etlSearch) !== -1);
  }
  const info = document.getElementById("etlPickInfo");
  if(info) info.textContent = etlSelected.size ? (etlSelected.size + " selected") : (etlGroups.length + " tables");

  if(!etlGroups.length){
    el.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><h4>No mappings yet</h4>' +
      '<p class="text-xs text-muted-2">Generate mappings first, then return here.</p></div>';
    return;
  }
  if(!groups.length){ el.innerHTML = '<div class="text-xs text-muted-2">No tables match.</div>'; return; }

  el.innerHTML = groups.map(g => {
    const total = g.rows.length;
    const approved = g.rows.filter(m => (m.reviewStatus||"").indexOf("Approved") === 0).length;
    const review = g.rows.filter(m => m.reviewStatus === "Needs Review" || m.reviewStatus === "In Review").length;
    const unmapped = g.rows.filter(m => m.mappingType === "Not Mapped").length;
    const on = etlSelected.has(g.name);
    return '<div class="tl-item etl-pick ' + (on?"active":"") + '" data-etl="' + escapeHtml(g.name) + '">' +
      '<div class="tl-name">' +
        '<input type="checkbox" class="etl-pick-cb" ' + (on?"checked":"") + '>' +
        '<i class="bi bi-diagram-2"></i> ' + escapeHtml(g.name) + '</div>' +
      '<div class="tl-sub">' + escapeHtml(g.table||"") + '</div>' +
      '<div class="tl-stats">' +
        '<span class="tl-badge badge-gray">' + total + ' fields</span>' +
        (approved ? '<span class="tl-badge badge-high">' + approved + ' approved</span>' : '') +
        (review ? '<span class="tl-badge badge-medium">' + review + ' review</span>' : '') +
        (unmapped ? '<span class="tl-badge badge-low">' + unmapped + ' unmapped</span>' : '') +
        (g.join ? '' : '<span class="tl-badge badge-gray">no join</span>') +
      '</div>' +
    '</div>';
  }).join("");

  el.querySelectorAll(".etl-pick").forEach(it => {
    it.addEventListener("click", () => { toggleEtlTable(it.dataset.etl); });
  });
}

function toggleEtlTable(name){
  if(etlSelected.has(name)) etlSelected.delete(name); else etlSelected.add(name);
  renderTableList();
  updateGenerateBtn();
}

function wireControls(){
  const search = document.getElementById("etlTableSearch");
  if(search) search.addEventListener("input", debounce(e => { etlSearch = (e.target.value||"").toLowerCase().trim(); renderTableList(); }, 150));
  const selAll = document.getElementById("etlSelectAll");
  const clr = document.getElementById("etlClearSel");
  if(selAll) selAll.addEventListener("click", () => {
    // select all currently-visible (filtered) tables
    let groups = etlGroups;
    if(etlSearch) groups = groups.filter(g => g.name.toLowerCase().indexOf(etlSearch) !== -1 || (g.table||"").toLowerCase().indexOf(etlSearch) !== -1);
    groups.forEach(g => etlSelected.add(g.name));
    renderTableList(); updateGenerateBtn();
  });
  if(clr) clr.addEventListener("click", () => { etlSelected.clear(); renderTableList(); updateGenerateBtn(); });

  ["generateEtlBtn","generateEtlBtn2"].forEach(id => {
    const b = document.getElementById(id);
    if(b) b.addEventListener("click", (e) => { e.preventDefault(); generateEtl(); });
  });
  ["generateDdlBtn","generateDdlBtn2"].forEach(id => {
    const b = document.getElementById(id);
    if(b) b.addEventListener("click", (e) => { e.preventDefault(); generateDdl(); });
  });
  const copyBtn = document.getElementById("copyEtlBtn");
  if(copyBtn) copyBtn.addEventListener("click", (e) => { e.preventDefault(); copyEtl(); });
  const dl = document.getElementById("downloadEtlBtn");
  if(dl) dl.addEventListener("click", (e) => { e.preventDefault(); downloadEtl(); });
  const clrOut = document.getElementById("clearEtlBtn");
  if(clrOut) clrOut.addEventListener("click", (e) => { e.preventDefault(); clearEtl(); });

  const hide = document.getElementById("etlHidePanelBtn");
  const show = document.getElementById("etlShowPanelBtn");
  if(hide) hide.addEventListener("click", (e) => { e.preventDefault(); toggleEtlPanel(false); });
  if(show) show.addEventListener("click", (e) => { e.preventDefault(); toggleEtlPanel(true); });
  if(lsGet("aims_etl_panel_hidden", false)) toggleEtlPanel(false);   // restore preference

  // AI console close button (re-opens automatically on the next generate)
  const conBtn = document.getElementById("etlConsoleToggle");
  if(conBtn) conBtn.addEventListener("click", (e) => { e.preventDefault(); etlConsoleHide(); });

  updateGenerateBtn();
}

// Collapse/expand the Target Tables panel; the SQL column widens to fill the space.
function toggleEtlPanel(show){
  const panel = document.getElementById("etlPanelCol");
  const showBtn = document.getElementById("etlShowPanelBtn");
  if(!panel) return;
  if(show){
    panel.style.display = "";
    if(showBtn) showBtn.style.display = "none";
    lsSet("aims_etl_panel_hidden", false);
  } else {
    panel.style.display = "none";
    if(showBtn) showBtn.style.display = "";
    lsSet("aims_etl_panel_hidden", true);
  }
  layoutEtlCols();
}

function updateGenerateBtn(){
  const n = etlSelected.size;
  const cnt = n ? (' (' + n + ')') : '';
  ["generateEtlBtn","generateEtlBtn2"].forEach(id => {
    const gen = document.getElementById(id);
    if(gen){ gen.disabled = n === 0; gen.innerHTML = '<i class="bi bi-magic me-1"></i> Generate ETL Code' + cnt; }
  });
  const ddlTop = document.getElementById("generateDdlBtn");
  if(ddlTop){ ddlTop.disabled = n === 0; ddlTop.innerHTML = '<i class="bi bi-table me-1"></i> Generate Create Table Script' + cnt; }
  const ddlPanel = document.getElementById("generateDdlBtn2");
  if(ddlPanel){ ddlPanel.disabled = n === 0; ddlPanel.innerHTML = '<i class="bi bi-table me-1"></i> Create Table' + cnt; }
}

/* ---- SQL generation (deterministic template fill) ---- */
let etlLastSql = "";     // ETL stored-procedure output buffer
let ddlLastSql = "";     // CREATE TABLE output buffer
let etlView = "etl";     // which buffer the panel shows: "etl" | "ddl"

function currentSql(){ return etlView === "ddl" ? ddlLastSql : etlLastSql; }
function outputPlaceholder(){ return '-- Select one or more target tables on the left, then click "Generate ETL Code" or "Create Table".'; }

// Render the active buffer into the panel; keep the view toggle + toolbar buttons in sync.
function renderOutput(){
  const out = document.getElementById("etlOutput");
  if(out) out.innerHTML = '<code>' + escapeHtml(currentSql() || outputPlaceholder()) + '</code>';
  updateViewToggle();
  updateOutputButtons();
}
function setEtlView(v){ etlView = (v === "ddl") ? "ddl" : "etl"; renderOutput(); }
function updateViewToggle(){ /* view toggle removed — the panel shows the last-generated output */ }
function updateOutputButtons(){
  const has = !!currentSql();
  ["copyEtlBtn","downloadEtlBtn","clearEtlBtn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !has; });
}

async function generateEtl(){
  const selected = etlGroups.filter(g => etlSelected.has(g.name));
  if(!selected.length){ showNotification("Select at least one target table.", "warning"); return; }
  const db = currentEtlDb();
  const instr = currentEtlInstructions();
  const out = document.getElementById("etlOutput");
  const info = document.getElementById("etlOutInfo");

  // Reveal + reset the console for this run.
  etlConsoleShow(true);
  etlLogReset();

  // No instructions -> fast deterministic template fill (no AI needed).
  if(!instr){
    etlLogInfo("Deterministic template fill (no AI instructions provided).");
    selected.forEach(g => {
      const line = etlLogStep("Building " + g.name + " …");
      etlLogDone(line, "Built " + g.name + " (" + g.rows.length + " columns)");
    });
    etlLastSql = selected.map(g => buildProc(g, db)).join("\n\nGO\n\n\n");
    etlView = "etl"; renderOutput();
    if(info) info.textContent = selected.length + " procedure(s)";
    etlLogInfo("Done — " + selected.length + " procedure(s) generated.");
    showNotification("Generated SQL for " + selected.length + " table(s).", "success");
    return;
  }

  // Instructions present -> AI-generate each table's proc (fall back to the
  // deterministic build for any table whose AI call fails).
  setEtlBusy(true, "etl");
  if(info) info.textContent = "Generating with AI…";
  etlLogInfo("AI generation with your instructions. This takes a few seconds per table…");
  const parts = [];
  let aiCount = 0, fbCount = 0;
  const errors = [];
  try{
    for(let i = 0; i < selected.length; i++){
      const g = selected[i];
      if(info) info.textContent = "AI generating " + (i+1) + " / " + selected.length + " (" + g.name + ")…";
      const line = etlLogStep("[" + (i+1) + "/" + selected.length + "] AI generating " + g.name + " …");
      let sql = null;
      try{
        sql = await aiGenerateProc(g, db, instr);
      }catch(e){ sql = null; errors.push(g.name + ": " + (e && e.message ? e.message : e)); }
      if(sql && sql.trim()){
        parts.push(sql.trim()); aiCount++;
        etlLogDone(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " generated by AI");
      } else {
        parts.push(buildProc(g, db)); fbCount++;   // fallback keeps output complete
        etlLogFail(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " AI failed — used template. " + (errors.length ? errors[errors.length-1] : ""));
      }
    }
    etlLastSql = parts.join("\n\nGO\n\n\n");
    etlView = "etl"; renderOutput();
    if(info) info.textContent = selected.length + " procedure(s)" + (fbCount ? (" · " + fbCount + " fallback") : "");
    if(fbCount){
      const reason = errors.length ? (" Reason: " + errors[0]) : "";
      etlLogInfo("Finished with " + fbCount + " fallback(s). See errors above.");
      showNotification("AI generation failed for " + fbCount + " table(s); used the deterministic template instead." + reason, "danger", 8000);
      if(errors.length) console.error("ETL AI generation errors:\n" + errors.join("\n"));
    } else {
      etlLogInfo("Done — " + aiCount + " procedure(s) generated by AI.");
      showNotification("AI-generated SQL for " + aiCount + " table(s) with your instructions.", "success");
    }
  }finally{
    setEtlBusy(false);
  }
}

// Call the backend to AI-generate one table's stored proc honoring instructions.
async function aiGenerateProc(g, db, instructions){
  const payload = {
    database: db,
    targetTable: g.name,
    targetEntity: g.entity,
    joinCondition: g.join || "",
    instructions: instructions || "",
    mappings: g.rows.map(m => ({
      targetColumn: m.targetColumn, sourceTable: m.sourceTable, sourceColumn: m.sourceColumn,
      mappingType: m.mappingType, transformationRule: m.transformationRule,
      businessRule: m.businessRule, lookupTable: m.lookupTable, defaultValue: m.defaultValue,
      nullHandling: m.nullHandling, targetDataType: m.targetDataType
    }))
  };
  let res;
  try{
    res = await fetch("/api/ai/generate-etl", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
  }catch(netErr){
    throw new Error("Cannot reach the backend (is python server/main.py running?)");
  }
  let data;
  try{ data = await res.json(); }
  catch(parseErr){ throw new Error("HTTP " + res.status + " - non-JSON response from server"); }
  if(!res.ok || !data.ok) throw new Error(data && data.error ? data.error : ("HTTP " + res.status));
  return data.sql;
}

// Toggle a "running" state; disables ALL generate buttons (no concurrent runs),
// spinner shows on the buttons for the mode being run ("etl" | "ddl").
function setEtlBusy(busy, which){
  const all = ["generateEtlBtn","generateEtlBtn2","generateDdlBtn","generateDdlBtn2"];
  all.forEach(id => {
    const b = document.getElementById(id);
    if(!b) return;
    const isDdl = id.indexOf("Ddl") !== -1;
    const running = busy && ((which === "ddl") === isDdl);
    b.disabled = busy || etlSelected.size === 0;
    b.classList.toggle("btn-running", running);
    if(running) b.innerHTML = '<i class="bi bi-hourglass-split me-1"></i> Generating…';
  });
  if(!busy) updateGenerateBtn();
}

// Short table name for the SP / log TableName: strip a leading CMT_/PMT_ prefix.
function sqlShortName(name){ return String(name || "").replace(/^(CMT_|PMT_)/i, ""); }

// One SELECT line per mapped column: "<expr> AS <TargetColumn>[ -- note]".
function selectLine(m){
  const tgt = m.targetColumn || "";
  const type = m.mappingType || "";
  const st = (m.sourceTable || "").trim();
  const sc = (m.sourceColumn || "").trim();
  let expr, note = "";
  if(type === "Constant" || type === "Default"){
    const v = (m.defaultValue != null && m.defaultValue !== "") ? m.defaultValue : "";
    expr = "CONSTANT('" + String(v).replace(/'/g, "''") + "')"; note = type;
  } else if(type === "Not Mapped" || !sc){
    expr = "NULL"; note = "Not Mapped - review";
  } else {
    const qualified = st ? (st + "." + sc) : sc;
    if(type === "Data Type Conversion" || type === "Format Conversion"){
      expr = "CAST(" + qualified + " AS " + (m.targetDataType || "varchar") + ")"; note = type;
    } else if(type === "Lookup"){
      expr = qualified; note = "Lookup" + (m.lookupTable ? " via " + m.lookupTable : "");
    } else {
      expr = qualified; if(type && type !== "Direct") note = type;
    }
  }
  const pad = expr.length < 34 ? " ".repeat(34 - expr.length) : " ";
  return "        " + expr + pad + "AS " + tgt + (note ? "   -- " + note : "");
}

function buildProc(g, db){
  const shortName = sqlShortName(g.name);
  const procName = "INSERT_" + db + "_" + shortName;
  // mapped columns only (skip Not Mapped for the INSERT list, but keep in SELECT as NULL)
  const cols = g.rows.map(m => m.targetColumn).filter(Boolean);
  const insertCols = cols.join(",\n        ");
  const selectLines = g.rows.map(selectLine).join(",\n").replace(/,\n$/, "");
  const fromJoin = g.join ? g.join : ("FROM " + (g.rows[0] && g.rows[0].sourceTable ? g.rows[0].sourceTable : "<source table>"));

  return "USE [" + db + "]\n" +
"GO\n" +
"SET ANSI_NULLS ON\n" +
"GO\n" +
"SET QUOTED_IDENTIFIER ON\n" +
"GO\n\n" +
"ALTER   PROCEDURE [dbo].[" + procName + "]\n" +
"@DSMName varchar(255)\n" +
"AS\n" +
"BEGIN\n" +
"    SET NOCOUNT ON;\n" +
"    SET XACT_ABORT, QUOTED_IDENTIFIER, ANSI_NULLS, ANSI_PADDING,\n" +
"        ANSI_WARNINGS, ARITHABORT, CONCAT_NULL_YIELDS_NULL ON;\n" +
"    SET NUMERIC_ROUNDABORT OFF;\n" +
"    DECLARE @ProcName Varchar(200)=Object_Name(@@PROCID)\n" +
"            Declare @StartTime datetime =Getdate()\n" +
"    DECLARE @localTran bit\n" +
"    DECLARE @RowInserted INT\n" +
"    IF @@TRANCOUNT = 0\n" +
"    BEGIN\n" +
"        SET @localTran = 1\n" +
"        BEGIN TRANSACTION LocalTran\n" +
"    END\n\n" +
"    BEGIN TRY\n" +
"    INSERT INTO " + g.name + "\n" +
"    (\n        " + insertCols + "\n    )\n" +
"    SELECT\n" + selectLines + "\n" +
"    " + fromJoin + "\n" +
"    ;\n" +
"    --End of Logic\n\n" +
"    SET @RowInserted=@@ROWCOUNT\n\n" +
"    IF @localTran = 1 AND XACT_STATE() = 1\n" +
"        Insert into CLAIM_CONVERSION_EXECUTION_LOG\n" +
"            (DSM_Name,ExecutionStartTime,SpName,TableName,RecordsInserted,Status,ErrorMessage)\n" +
"        values(@DSMName,@StartTime,@ProcName,'" + shortName + "',@RowInserted,'Successful',null)\n" +
"        COMMIT TRANSACTION LocalTran\n" +
"    END TRY\n" +
"    BEGIN CATCH\n" +
"        DECLARE @ErrorMessage NVARCHAR(4000)\n" +
"        DECLARE @ErrorSeverity INT\n" +
"        DECLARE @ErrorState INT\n" +
"        SELECT  @ErrorMessage = ERROR_MESSAGE(),\n" +
"                @ErrorSeverity = ERROR_SEVERITY(),\n" +
"                @ErrorState = ERROR_STATE()\n" +
"        IF @localTran = 1 AND XACT_STATE() <> 0\n" +
"        ROLLBACK TRAN\n" +
"        Insert into CLAIM_CONVERSION_EXECUTION_LOG\n" +
"            (DSM_NAME,ExecutionStartTime,SpName,TableName,RecordsInserted,Status,ErrorMessage)\n" +
"        values(@DSMName,@StartTime,@ProcName,'" + shortName + "',0,'Failed',@ErrorMessage)\n" +
"        RAISERROR ( @ErrorMessage, @ErrorSeverity, @ErrorState)\n" +
"    END CATCH\n" +
"END;";
}

/* =========================================================================
   CREATE TABLE (DDL) generation — deterministic from the target schema, or
   AI-assisted with the shared instruction box. Mirrors the ETL flow.
   ========================================================================= */

// Resolve a target table's full column set: prefer the authoritative target
// schema (all columns w/ type/len/PK/FK); fall back to the mapped columns.
function targetColumnsFor(g){
  let fields = null;
  try{
    if(typeof getTargetSchema === "function"){
      const meta = getTargetSchema();
      if(meta && meta.entities){
        const ent = meta.entities.find(e =>
          e.name === g.entity || e.name === g.name || e.table === g.table || e.table === g.name);
        if(ent && ent.fields && ent.fields.length) fields = ent.fields;
      }
    }
  }catch(e){ /* fall back below */ }

  if(fields){
    return {source: "schema", columns: fields.map(f => ({
      name: f.name,
      dataType: (f.dataType || "varchar"),
      length: (f.length != null && !isNaN(+f.length)) ? +f.length : null,
      mandatory: !!f.mandatory, pk: !!f.pk, fk: !!f.fk, fkReference: f.fkReference || ""
    }))};
  }
  // fallback: mapped target columns (best-effort — no PK/FK/len metadata)
  return {source: "mapped", columns: (g.rows || []).map(m => ({
    name: m.targetColumn,
    dataType: (m.targetDataType || "varchar"),
    length: (m.targetLength != null && !isNaN(+m.targetLength)) ? +m.targetLength : null,
    mandatory: String(m.nullHandling || "").toLowerCase().indexOf("not null") !== -1,
    pk: false, fk: false, fkReference: ""
  })).filter(c => c.name)};
}

// "cs_claim.id" / "[cs_claim].[id]" -> {table, column}; null if not table.column
function parseFkRef(ref){
  if(!ref) return null;
  const parts = String(ref).replace(/[\[\]]/g, "").trim().split(".");
  if(parts.length >= 2) return {table: parts[parts.length - 2], column: parts[parts.length - 1]};
  return null;
}

// Deterministic T-SQL CREATE TABLE for one table.
// Returns {sql, columns:<count>, source:"schema"|"mapped", columns_meta:[...]}.
function buildCreateTable(g){
  const info = targetColumnsFor(g);
  const cols = info.columns;
  const tbl = g.name;
  const short = sqlShortName(tbl);
  const lenTypes = /^(char|varchar|nvarchar|nchar|decimal|numeric)$/i;

  const lines = cols.map(c => {
    let type = c.dataType || "varchar";
    if(c.length && lenTypes.test(type)) type += "(" + c.length + ")";
    return "    [" + c.name + "] " + type + (c.mandatory ? " NOT NULL" : " NULL");
  });
  const constraints = [];
  const pkCols = cols.filter(c => c.pk).map(c => "[" + c.name + "]");
  if(pkCols.length) constraints.push("    CONSTRAINT [PK_" + short + "] PRIMARY KEY (" + pkCols.join(", ") + ")");
  cols.filter(c => c.fk && c.fkReference).forEach(c => {
    const ref = parseFkRef(c.fkReference);
    if(ref) constraints.push("    CONSTRAINT [FK_" + short + "_" + c.name + "] FOREIGN KEY ([" + c.name + "]) REFERENCES [" + ref.table + "] ([" + ref.column + "])");
  });
  const note = info.source === "mapped"
    ? "-- (columns derived from mapped fields; full target schema not found for this table)\n" : "";
  const sql = note + "CREATE TABLE [dbo].[" + tbl + "] (\n" + lines.concat(constraints).join(",\n") + "\n);";
  return {sql: sql, columns: cols.length, source: info.source, columns_meta: cols};
}

async function generateDdl(){
  const selected = etlGroups.filter(g => etlSelected.has(g.name));
  if(!selected.length){ showNotification("Select at least one target table.", "warning"); return; }
  const db = currentEtlDb();
  const instr = currentEtlInstructions();
  const info = document.getElementById("etlOutInfo");

  etlConsoleShow(true);
  etlLogReset();

  // Deterministic mode (no instructions).
  if(!instr){
    etlLogInfo("Deterministic CREATE TABLE from the target schema (no AI instructions).");
    let mapped = 0;
    const parts = selected.map(g => {
      const line = etlLogStep("Building CREATE TABLE for " + g.name + " …");
      const built = buildCreateTable(g);
      if(built.source === "mapped") mapped++;
      etlLogDone(line, "Built " + g.name + " (" + built.columns + " columns" + (built.source === "mapped" ? ", from mapped fields" : "") + ")");
      return "-- Table: " + g.name + "\n" + built.sql;
    });
    ddlLastSql = "USE [" + db + "]\nGO\n\n" + parts.join("\n\nGO\n\n\n");
    etlView = "ddl"; renderOutput();
    if(info) info.textContent = selected.length + " CREATE TABLE statement(s)";
    etlLogInfo("Done — " + selected.length + " statement(s)." + (mapped ? (" " + mapped + " used mapped columns (no full schema).") : ""));
    showNotification("Generated CREATE TABLE for " + selected.length + " table(s).", "success");
    return;
  }

  // AI mode.
  setEtlBusy(true, "ddl");
  if(info) info.textContent = "Generating CREATE TABLE with AI…";
  etlLogInfo("AI CREATE TABLE with your instructions. A few seconds per table…");
  const parts = [];
  let aiCount = 0, fbCount = 0;
  const errors = [], warns = [];
  try{
    for(let i = 0; i < selected.length; i++){
      const g = selected[i];
      if(info) info.textContent = "AI generating " + (i+1) + " / " + selected.length + " (" + g.name + ")…";
      const line = etlLogStep("[" + (i+1) + "/" + selected.length + "] AI CREATE TABLE " + g.name + " …");
      const baseline = buildCreateTable(g);
      let out2 = null;
      try{ out2 = await aiGenerateDdl(g, db, instr, baseline); }
      catch(e){ out2 = null; errors.push(g.name + ": " + (e && e.message ? e.message : e)); }
      if(out2 && out2.sql && out2.sql.trim()){
        parts.push("-- Table: " + g.name + "\n" + out2.sql.trim()); aiCount++;
        if(out2.warnings && out2.warnings.length){
          warns.push(g.name + ": " + out2.warnings.join(", "));
          etlLogFail(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " generated — unknown identifiers: " + out2.warnings.join(", "));
        } else {
          etlLogDone(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " generated by AI");
        }
      } else {
        parts.push("-- Table: " + g.name + "\n" + baseline.sql); fbCount++;
        etlLogFail(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " AI failed — used template. " + (errors.length ? errors[errors.length-1] : ""));
      }
    }
    ddlLastSql = parts.join("\n\nGO\n\n\n");
    etlView = "ddl"; renderOutput();
    if(info) info.textContent = selected.length + " CREATE TABLE" + (fbCount ? (" · " + fbCount + " fallback") : "") + (warns.length ? " · " + warns.length + " warning(s)" : "");
    if(fbCount){
      etlLogInfo("Finished with " + fbCount + " fallback(s). See errors above.");
      showNotification("AI CREATE TABLE failed for " + fbCount + " table(s); used the template instead." + (errors.length ? (" Reason: " + errors[0]) : ""), "danger", 8000);
      if(errors.length) console.error("DDL AI errors:\n" + errors.join("\n"));
    } else if(warns.length){
      showNotification("Generated with warnings — the AI referenced identifiers not in the schema: " + warns[0] + ". Review before running.", "warning", 9000);
    } else {
      etlLogInfo("Done — " + aiCount + " CREATE TABLE statement(s) generated by AI.");
      showNotification("AI-generated CREATE TABLE for " + aiCount + " table(s).", "success");
    }
  }finally{
    setEtlBusy(false);
  }
}

async function aiGenerateDdl(g, db, instructions, baseline){
  const payload = {
    database: db, targetTable: g.name,
    columns: baseline.columns_meta, baselineDdl: baseline.sql,
    instructions: instructions || ""
  };
  let res;
  try{
    res = await fetch("/api/ai/generate-ddl", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
  }catch(netErr){
    throw new Error("Cannot reach the backend (is python server/main.py running?)");
  }
  let data;
  try{ data = await res.json(); }
  catch(parseErr){ throw new Error("HTTP " + res.status + " - non-JSON response from server"); }
  if(!res.ok || !data.ok) throw new Error(data && data.error ? data.error : ("HTTP " + res.status));
  return {sql: data.sql, warnings: data.warnings || []};
}

function copyEtl(){
  const sql = currentSql();
  if(!sql) return;
  navigator.clipboard.writeText(sql)
    .then(() => showNotification("SQL copied to clipboard.", "success"))
    .catch(() => showNotification("Could not copy to clipboard.", "danger"));
}

function downloadEtl(){
  const sql = currentSql();
  if(!sql) return;
  const blob = new Blob([sql], {type:"text/sql"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fname = (etlView === "ddl" ? "create_tables_" : "etl_") + currentEtlDb() + (etlView === "ddl" ? ".sql" : "_procedures.sql");
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Clear ONLY the currently-shown output buffer (does NOT touch the table selection).
function clearEtl(){
  if(etlView === "ddl") ddlLastSql = ""; else etlLastSql = "";
  renderOutput();
  const info = document.getElementById("etlOutInfo");
  if(info) info.textContent = "";
  showNotification("Cleared the " + (etlView === "ddl" ? "CREATE TABLE" : "ETL") + " output.", "primary", 1200);
}

/* ---- Target database name ---- */
function initDbName(){
  const input = document.getElementById("etlDbName");
  if(!input) return;
  const saved = lsGet(LS_ETL_DB, null);
  if(saved) input.value = saved;
  applyDbName(input.value);
  input.addEventListener("input", () => {
    lsSet(LS_ETL_DB, input.value);
    applyDbName(input.value);
    // refresh whichever output is currently shown (SP names / USE depend on the DB name)
    if(etlView === "ddl" && ddlLastSql) generateDdl();
    else if(etlLastSql) generateEtl();
  });
}
function applyDbName(name){
  const clean = currentEtlDb();
  const dbEcho = document.getElementById("dbEcho");
  const spEcho = document.getElementById("spEcho");
  if(dbEcho) dbEcho.textContent = clean;
  if(spEcho) spEcho.textContent = "INSERT_" + clean + "_<Table>";
}
function currentEtlDb(){
  const input = document.getElementById("etlDbName");
  const raw = input ? input.value : (lsGet(LS_ETL_DB, "CommonStage") || "CommonStage");
  return (raw || "").trim().replace(/[^A-Za-z0-9_]/g, "") || "CommonStage";
}

function setText(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = (val != null ? Number(val).toLocaleString() : "0");
}
