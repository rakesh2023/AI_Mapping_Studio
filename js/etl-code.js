/* =========================================================================
   etl-code.js - ETL Code (SQL) Generator page.

   Lets the user pick target tables (that have generated mappings) and produces
   a SQL stored procedure per table, following the project's INSERT template:
   drop-if-exists + CREATE PROCEDURE [dbo].[INSERT_<db>_<Table>] / TRY..CATCH with
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

  // Same per-client mapping document the workspace uses. No sample fallback (multi-tenant):
  // a client with nothing generated yet shows empty.
  const aiRows = lsGet("aims_ai_mappings", null);
  const rawMappings = (aiRows !== null) ? aiRows : [];
  const mappings = (typeof applyOverrides === "function") ? applyOverrides(rawMappings || []) : (rawMappings || []);
  const joins = lsGet("aims_ai_joins", {}) || {};

  // KPI tiles
  setText("etlTotal", mappings.length);
  setText("etlApproved", mappings.filter(m => (m.reviewStatus || "").indexOf("Approved") === 0).length);
  setText("etlTables", new Set(mappings.map(m => m.targetEntity).filter(Boolean)).size);
  setText("etlJoins", Object.values(joins).filter(v => v && String(v).trim()).length);

  etlGroups = groupByTargetTable(mappings, joins);

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
  const outEl = document.getElementById("etlOutput");
  if(outEl) outEl.addEventListener("input", onOutputEdited);

  const hide = document.getElementById("etlHidePanelBtn");
  const show = document.getElementById("etlShowPanelBtn");
  if(hide) hide.addEventListener("click", (e) => { e.preventDefault(); toggleEtlPanel(false); });
  if(show) show.addEventListener("click", (e) => { e.preventDefault(); toggleEtlPanel(true); });
  if(lsGet("aims_etl_panel_hidden", false)) toggleEtlPanel(false);   // restore preference

  // AI console close button (re-opens automatically on the next generate)
  const conBtn = document.getElementById("etlConsoleToggle");
  if(conBtn) conBtn.addEventListener("click", (e) => { e.preventDefault(); etlConsoleHide(); });

  // Deploy to SQL Server
  const depBtn = document.getElementById("deployBtn");
  if(depBtn) depBtn.addEventListener("click", (e) => {
    e.preventDefault();
    // Surface any unexpected error instead of silently failing to open.
    try{ openDeployModal(); }
    catch(err){
      console.error("openDeployModal failed:", err);
      showNotification("Could not open the deploy dialog: " + (err && err.message ? err.message : err), "danger", 8000);
    }
  });
  const depRun = document.getElementById("deployRunBtn");
  if(depRun) depRun.addEventListener("click", (e) => { e.preventDefault(); runDeploy(); });
  const depAuth = document.getElementById("depAuth");
  if(depAuth) depAuth.addEventListener("change", toggleDeployAuth);
  // After EVERY hide of the deploy modal (incl. the programmatic hide() in
  // runDeploy), scrub any leftover backdrop so the page never gets stuck behind
  // an invisible overlay — the classic cause of "can't open/deploy again".
  const depModalEl = document.getElementById("deployModal");
  if(depModalEl) depModalEl.addEventListener("hidden.bs.modal", () => scrubModalBackdrop());
  const clrHist = document.getElementById("clearDeployHistoryBtn");
  if(clrHist) clrHist.addEventListener("click", (e) => { e.preventDefault(); clearDeployHistory(); });

  renderDeployHistory();
  updateDeployBtn();
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

// Render the active buffer into the (editable) panel; keep toolbar buttons in sync.
function renderOutput(){
  const out = document.getElementById("etlOutput");
  if(out) out.value = currentSql() || "";   // empty -> placeholder shows
  updateViewToggle();
  updateOutputButtons();
}
// The output is user-editable: write manual edits straight back into the active buffer
// so Copy / Download / Deploy all use exactly what's shown.
function onOutputEdited(){
  const out = document.getElementById("etlOutput");
  if(!out) return;
  if(etlView === "ddl") ddlLastSql = out.value; else etlLastSql = out.value;
  updateOutputButtons();
}
function setEtlView(v){ etlView = (v === "ddl") ? "ddl" : "etl"; renderOutput(); }
function updateViewToggle(){ /* view toggle removed — the panel shows the last-generated output */ }
function updateOutputButtons(){
  const has = !!currentSql();
  ["copyEtlBtn","downloadEtlBtn","clearEtlBtn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = !has; });
  updateDeployBtn();
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

  // Always generate with AI (default = SQL Server format; the deterministic template
  // is used only as a fallback if an AI call fails). Instructions, when provided,
  // can change the dialect/structure (e.g. "generate in Oracle").

  // Instructions present -> AI-generate each table's proc (fall back to the
  // deterministic build for any table whose AI call fails).
  setEtlBusy(true, "etl");
  if(info) info.textContent = "Generating with AI…";
  etlLogInfo(instr ? "AI generation with your instructions. This takes a few seconds per table…"
                   : "AI generation (default SQL Server format). This takes a few seconds per table…");
  const parts = [];
  let aiCount = 0, fbCount = 0, incompleteCount = 0;
  const errors = [];
  try{
    for(let i = 0; i < selected.length; i++){
      const g = selected[i];
      if(info) info.textContent = "AI generating " + (i+1) + " / " + selected.length + " (" + g.name + ")…";
      const line = etlLogStep("[" + (i+1) + "/" + selected.length + "] AI generating " + g.name + " …");
      let out = null;
      try{
        out = await aiGenerateProc(g, db, instr);
      }catch(e){ out = null; errors.push(g.name + ": " + (e && e.message ? e.message : e)); }
      if(out && out.sql && out.sql.trim()){
        parts.push(out.sql.trim()); aiCount++;
        if(out.incomplete){
          incompleteCount++;
          // Surface truncation/dropped-columns loudly — do NOT let it look "done".
          etlLogFail(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " — INCOMPLETE: " + (out.warnings[0] || "columns missing"));
        } else {
          etlLogDone(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " generated by AI");
        }
      } else {
        parts.push(buildProc(g, db)); fbCount++;   // fallback keeps output complete
        etlLogFail(line, "[" + (i+1) + "/" + selected.length + "] " + g.name + " AI failed — used template. " + (errors.length ? errors[errors.length-1] : ""));
      }
    }
    etlLastSql = parts.join("\n\nGO\n\n\n");
    etlView = "etl"; renderOutput();
    if(info) info.textContent = selected.length + " procedure(s)"
      + (fbCount ? (" · " + fbCount + " fallback") : "") + (incompleteCount ? (" · " + incompleteCount + " incomplete") : "");
    if(fbCount){
      const reason = errors.length ? (" Reason: " + errors[0]) : "";
      etlLogInfo("Finished with " + fbCount + " fallback(s). See errors above.");
      showNotification("AI generation failed for " + fbCount + " table(s); used the deterministic template instead." + reason, "danger", 8000);
      if(errors.length) console.error("ETL AI generation errors:\n" + errors.join("\n"));
    } else if(incompleteCount){
      etlLogInfo("Warning — " + incompleteCount + " procedure(s) are INCOMPLETE (columns were dropped). Review before deploying.");
      showNotification(incompleteCount + " procedure(s) came back INCOMPLETE (some columns missing). Do not deploy as-is — regenerate or use the deterministic build.", "danger", 10000);
    } else {
      etlLogInfo("Done — " + aiCount + " procedure(s) generated by AI.");
      showNotification("AI-generated SQL for " + aiCount + " table(s)" + (instr ? " with your instructions." : " (SQL Server format)."), "success");
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
  return {sql: data.sql, incomplete: !!data.incomplete, warnings: data.warnings || [], missingColumns: data.missingColumns || []};
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
  // Return the code and the note SEPARATELY so the caller can place the list comma
  // BEFORE the inline "-- note" comment (a comma after "--" is commented out -> breaks SQL).
  return {code: "        " + expr + pad + "AS " + tgt, note: note};
}

function buildProc(g, db){
  const shortName = sqlShortName(g.name);
  const procName = "INSERT_" + db + "_" + shortName;
  // mapped columns only (skip Not Mapped for the INSERT list, but keep in SELECT as NULL)
  const cols = g.rows.map(m => m.targetColumn).filter(Boolean);
  const insertCols = cols.join(",\n        ");
  // Comma BEFORE the inline comment: "<expr> AS <col>,   -- note" (last line gets no comma).
  const sel = g.rows.map(selectLine);
  const selectLines = sel.map((r, i) =>
    r.code + (i < sel.length - 1 ? "," : "") + (r.note ? "   -- " + r.note : "")
  ).join("\n");
  const fromJoin = g.join ? g.join : ("FROM " + (g.rows[0] && g.rows[0].sourceTable ? g.rows[0].sourceTable : "<source table>"));

  return "SET ANSI_NULLS ON\n" +
"GO\n" +
"SET QUOTED_IDENTIFIER ON\n" +
"GO\n\n" +
"IF OBJECT_ID('[dbo].[" + procName + "]', 'P') IS NOT NULL\n" +
"    DROP PROCEDURE [dbo].[" + procName + "];\n" +
"GO\n\n" +
"CREATE PROCEDURE [dbo].[" + procName + "]\n" +
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
      mandatory: !!f.mandatory, pk: !!f.pk, fk: !!f.fk, fkReference: f.fkReference || "",
      default: (f.default != null ? String(f.default) : "")
    }))};
  }
  // fallback: mapped target columns (best-effort — no PK/FK/len metadata).
  // Defaults are intentionally NOT taken from the mapping — a column's DEFAULT
  // comes only from the target schema.
  return {source: "mapped", columns: (g.rows || []).map(m => ({
    name: m.targetColumn,
    dataType: (m.targetDataType || "varchar"),
    length: (m.targetLength != null && !isNaN(+m.targetLength)) ? +m.targetLength : null,
    mandatory: String(m.nullHandling || "").toLowerCase().indexOf("not null") !== -1,
    pk: false, fk: false, fkReference: "",
    default: ""
  })).filter(c => c.name)};
}

// Turn a column's schema `default` into a SQL DEFAULT expression, or null to skip.
// Descriptive placeholders (e.g. "auto-generated") are intentionally skipped — they
// aren't real SQL. Numbers, quoted strings, NULL and function calls pass through; a
// bare single-word value is treated as a string literal.
function sqlDefaultLiteral(raw){
  if(raw == null) return null;
  const v = String(raw).trim();
  if(!v) return null;
  const low = v.toLowerCase();
  const descriptive = ["auto-generated","auto generated","autogenerated","system generated",
    "system-generated","generated","identity","sequence","n/a","na","none","tbd","unknown"];
  if(descriptive.indexOf(low) !== -1) return null;
  if(/^'.*'$/.test(v)) return v;                                  // already a string literal
  if(/^-?\d+(\.\d+)?$/.test(v)) return v;                         // number
  if(low === "null") return "NULL";
  if(/^[a-z_][a-z0-9_]*\(\s*\)$/i.test(v)) return v;              // func call e.g. GETDATE()
  if(low === "current_timestamp") return v;
  if(!/\s/.test(v) && !/[();']/.test(v)) return "'" + v.replace(/'/g, "''") + "'"; // bare word -> string
  return null;                                                    // complex/ambiguous -> let AI decide
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
    const lit = sqlDefaultLiteral(c.default);
    const def = lit ? (" DEFAULT (" + lit + ")") : "";
    return "    [" + c.name + "] " + type + (c.mandatory ? " NOT NULL" : " NULL") + def;
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
  // Drop-and-recreate by default: if the table exists it is replaced. DROP and
  // CREATE stay in ONE batch (no GO between them) so a single table deploys as a
  // single batch — DROP TABLE + CREATE TABLE are both valid in the same batch.
  const drop = "IF OBJECT_ID('[dbo].[" + tbl + "]', 'U') IS NOT NULL\n    DROP TABLE [dbo].[" + tbl + "];\n";
  const sql = note + drop + "CREATE TABLE [dbo].[" + tbl + "] (\n" + lines.concat(constraints).join(",\n") + "\n);";
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

  // Always generate with AI (default = SQL Server T-SQL; deterministic build is the
  // fallback on AI failure). Instructions can switch dialect (e.g. Oracle/Postgres).
  setEtlBusy(true, "ddl");
  if(info) info.textContent = "Generating CREATE TABLE with AI…";
  etlLogInfo(instr ? "AI CREATE TABLE with your instructions. A few seconds per table…"
                   : "AI CREATE TABLE (default SQL Server format). A few seconds per table…");
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

/* =========================================================================
   Deploy to SQL Server — runs the shown SQL in a background job on the backend,
   polls status every 2s, self-corrects failures via AI (up to 3 tries), and
   keeps history in localStorage. Credentials come from the active SQL Server
   target connection and are sent only in the request body (never stored here).
   ========================================================================= */
const LS_DEPLOY_HISTORY = "aims_deploy_history";
let deployPoll = null;
let deployLogShown = 0;        // how many job.log lines already mirrored to the AI console
let deployFixesShown = false;  // whether the "AI fixes applied" line was added this run

// Append one line to the AI Processing Console (kind: "info" | "done" | "error").
function etlConsoleAppend(text, kind){
  const el = document.getElementById("etlLog");
  if(!el) return;
  const line = document.createElement("div");
  line.className = "log-line done" + (kind === "error" ? " error" : "");
  const icon = kind === "error" ? "bi-x-circle-fill" : kind === "done" ? "bi-check-circle-fill" : "bi-info-circle";
  line.innerHTML = '<i class="bi ' + icon + '"></i> ' + escapeHtml(text);
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// Mirror any NEW backend deploy-log lines into the AI console, styling failures red
// and success/fix lines green so the deploy process reads clearly.
function mirrorDeployLog(job){
  const logs = job.log || [];
  for(let i = deployLogShown; i < logs.length; i++){
    const msg = (logs[i] && logs[i].message) || "";
    const l = msg.toLowerCase();
    let kind = "info";
    if(l.indexOf("failed") !== -1 || l.indexOf("could not") !== -1 || l.indexOf("unchanged") !== -1) kind = "error";
    else if(l.indexOf("corrected") !== -1 || l.indexOf("committed") !== -1 || l.indexOf("successfully") !== -1) kind = "done";
    etlConsoleAppend(msg, kind);
  }
  deployLogShown = logs.length;
}

// Build a pyodbc-style cfg from the ACTIVE target — only for SQL Server targets.
function activeTargetCfg(){
  try{
    if(typeof getActiveTargetId !== "function") return null;
    const id = getActiveTargetId();
    const c = id ? getTargetConnection(id) : null;
    if(!c) return null;
    if((c.type || "").toLowerCase().indexOf("sql server") === -1) return null;   // deploy is SQL Server only
    if(!(c.server || c.host) || !(c.database || c.db)) return null;
    return {
      driver: c.driver || "ODBC Driver 17 for SQL Server",
      server: c.server || c.host || "", database: c.database || c.db || "",
      schema: c.schema || null, trusted: !!c.trusted,
      username: c.username || "", password: c.password || ""
    };
  }catch(e){ return null; }
}

function updateDeployBtn(){
  const btn = document.getElementById("deployBtn");
  if(!btn) return;
  const hasSql = !!currentSql();
  btn.disabled = !hasSql || !!deployPoll;
  btn.title = !hasSql ? "Generate SQL first" : (deployPoll ? "A deployment is already running" : "Deploy the shown SQL to a SQL Server database");
}

let deployModal = null;

// Remove any orphaned Bootstrap modal backdrop + body lock. A lingering backdrop
// sits over the WHOLE page (z-index ~1050) and silently eats every click — the
// root cause of "can't deploy again" after a programmatic modal .hide(). Guarded
// so it never strips the backdrop of a modal that is legitimately open.
function scrubModalBackdrop(){
  if(document.querySelector(".modal.show")) return;   // a modal is genuinely open — leave it alone
  document.querySelectorAll(".modal-backdrop").forEach(b => b.remove());
  document.body.classList.remove("modal-open");
  document.body.style.removeProperty("padding-right");
  document.body.style.removeProperty("overflow");
}

// Open the deploy dialog; prefill from the active SQL Server target if there is one.
function openDeployModal(){
  const sql = currentSql();
  if(!sql){ showNotification("Generate SQL first.", "warning"); return; }
  document.querySelectorAll(".deperr").forEach(e => e.textContent = "");
  const errBox0 = document.getElementById("deployFormError");
  if(errBox0) errBox0.innerHTML = "";
  // NOTE: #deployKind lives INSIDE #deployScopeNote, whose innerHTML we rewrite
  // below — so after the first open that span no longer exists. Guard against
  // null (the unguarded access here used to throw on the 2nd open and abort the
  // whole function before the dialog could show). The rewritten note already
  // states the kind, so this is only a nicety when the span is present.
  const kindEl = document.getElementById("deployKind");
  if(kindEl) kindEl.textContent = (etlView === "ddl" ? "Create Table script" : "ETL stored procedures");
  // Create Table scripts DROP-and-recreate, so warn that existing tables are replaced.
  const note = document.getElementById("deployScopeNote");
  if(note){
    if(etlView === "ddl"){
      note.innerHTML = '<i class="bi bi-exclamation-triangle"></i> This <span class="mono">Create Table script</span> will <strong>DROP and recreate</strong> the selected table(s) on the database below — any existing table (and its data) will be <strong>replaced</strong>. Runs in one transaction (rolls back on any error). Credentials are used only for this connection and are never stored or logged.';
      note.style.color = "var(--warning)";
    } else {
      note.innerHTML = '<i class="bi bi-info-circle"></i> Runs the <span class="mono">ETL stored procedures</span> against the database below, in a single transaction (rolls back entirely on any error). Credentials are used only for this connection and are never stored or logged.';
      note.style.color = "";
    }
  }

  const pre = activeTargetCfg();   // active target cfg (or null) — convenience prefill
  document.getElementById("depServer").value = pre ? pre.server : "";
  document.getElementById("depDatabase").value = pre ? pre.database : "";
  document.getElementById("depDriver").value = (pre && pre.driver) || "ODBC Driver 17 for SQL Server";
  document.getElementById("depAuth").value = (pre && pre.trusted) ? "trusted" : "sql";
  document.getElementById("depUser").value = pre ? (pre.username || "") : "";
  document.getElementById("depPass").value = pre ? (pre.password || "") : "";
  document.getElementById("depDryRun").checked = false;
  toggleDeployAuth();

  showDeployModal();
  setTimeout(() => { const s = document.getElementById("depServer"); if(s) s.focus(); }, 200);
}

// Bulletproof (re)open: Bootstrap's show() is a NO-OP if the cached instance's
// internal _isShown/_isTransitioning is left inconsistent by a prior programmatic
// hide() — which makes the dialog silently fail to reopen. So we fully dispose the
// old instance, hard-reset the modal element + body/backdrop state, then create a
// FRESH instance and show it. A fresh instance always has clean state.
function showDeployModal(){
  const el = document.getElementById("deployModal");
  if(!el || !window.bootstrap || !bootstrap.Modal){ return; }

  const prior = bootstrap.Modal.getInstance(el);
  if(prior){ try{ prior.dispose(); }catch(e){} }

  // Hard-reset the modal DOM so a stale "shown" state can't suppress the next show.
  el.classList.remove("show");
  el.style.display = "";
  el.setAttribute("aria-hidden", "true");
  el.removeAttribute("aria-modal");
  el.removeAttribute("role");
  // Remove any orphaned backdrop + body scroll-lock (guard-free: we are about to show).
  document.querySelectorAll(".modal-backdrop").forEach(b => b.remove());
  document.body.classList.remove("modal-open");
  document.body.style.removeProperty("padding-right");
  document.body.style.removeProperty("overflow");

  deployModal = new bootstrap.Modal(el);
  deployModal.show();
}

// Close the deploy dialog RELIABLY. Bootstrap's hide() fades out via a CSS
// transition and only removes the backdrop on transitionend — but the heavy DOM
// work we do right after (rendering the status card) can interrupt that
// transition, so hidden.bs.modal never fires and a full-page .modal-backdrop is
// left covering everything, silently eating every click (the Deploy button
// included = "button looks normal, nothing happens"). So we ask Bootstrap to
// hide, then unconditionally force the modal closed + strip ALL backdrops.
function hideDeployModal(){
  const el = document.getElementById("deployModal");
  const inst = (el && window.bootstrap && bootstrap.Modal) ? bootstrap.Modal.getInstance(el) : null;
  if(inst){ try{ inst.hide(); }catch(e){} }
  setTimeout(() => {
    if(el){
      el.classList.remove("show");
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
      el.removeAttribute("aria-modal");
      el.removeAttribute("role");
    }
    document.querySelectorAll(".modal-backdrop").forEach(b => b.remove());
    document.body.classList.remove("modal-open");
    document.body.style.removeProperty("padding-right");
    document.body.style.removeProperty("overflow");
  }, 350);
}

function toggleDeployAuth(){
  const trusted = document.getElementById("depAuth").value === "trusted";
  document.getElementById("depUserGroup").style.display = trusted ? "none" : "";
  document.getElementById("depPassGroup").style.display = trusted ? "none" : "";
}

function _depErr(field, msg){ const el = document.querySelector('.deperr[data-for="' + field + '"]'); if(el){ el.textContent = msg; el.style.color = "var(--danger)"; } }

function validateDeployForm(){
  document.querySelectorAll(".deperr").forEach(e => e.textContent = "");
  let ok = true;
  const server = document.getElementById("depServer").value.trim();
  const db = document.getElementById("depDatabase").value.trim();
  const trusted = document.getElementById("depAuth").value === "trusted";
  const user = document.getElementById("depUser").value.trim();
  if(!server){ _depErr("depServer", "Server / host is required."); ok = false; }
  if(!db){ _depErr("depDatabase", "Database is required."); ok = false; }
  if(!trusted && !user){ _depErr("depUser", "Username is required for SQL Login (or switch to Windows auth)."); ok = false; }
  return ok;
}

// Read the modal, confirm, POST /api/deploy, start polling, close the modal.
async function runDeploy(){
  if(!validateDeployForm()) return;
  const sql = currentSql();
  if(!sql){ showNotification("Generate SQL first.", "warning"); return; }

  const trusted = document.getElementById("depAuth").value === "trusted";
  const cfg = {
    driver: document.getElementById("depDriver").value,
    server: document.getElementById("depServer").value.trim(),
    database: document.getElementById("depDatabase").value.trim(),
    schema: null,
    trusted: trusted,
    username: trusted ? "" : document.getElementById("depUser").value.trim(),
    password: trusted ? "" : document.getElementById("depPass").value
  };
  const dry = document.getElementById("depDryRun").checked;

  const errBox = document.getElementById("deployFormError");
  errBox.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-1"></span> Starting…</div>';
  try{
    const res = await fetch("/api/deploy", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({connection: cfg, sql: sql, dryRun: dry})});
    const data = await res.json();
    if(!data.ok){ errBox.innerHTML = failNote(data.error || "Could not start deployment."); return; }
    errBox.innerHTML = "";
    hideDeployModal();   // force-close + guaranteed backdrop removal (see below)
    startDeployPolling(data.jobId, {kind: (etlView === "ddl" ? "Create Table" : "ETL Code"), dryRun: dry, database: cfg.database});
  }catch(e){
    errBox.innerHTML = failNote("Backend not reachable. Start it with: cd server && python main.py");
  }
}
function failNote(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }

function startDeployPolling(jobId, meta){
  const card = document.getElementById("deployStatusCard");
  if(card) card.style.display = "";
  // Reset the status card so a re-deploy visibly starts fresh (not the prior result).
  const badge = document.getElementById("deployStateBadge");
  const body = document.getElementById("deployStatusBody");
  if(badge) badge.innerHTML = '<span class="badge-soft badge-gray">queued</span>';
  if(body) body.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-1"></span> Starting deployment…</div>';

  if(deployPoll){ clearInterval(deployPoll); deployPoll = null; }
  deployPoll = "starting";   // truthy sentinel so the button disables immediately
  updateDeployBtn();         // disable Deploy while a job runs

  // Stream the deployment process into the AI Processing Console.
  etlConsoleShow(); etlLogReset();
  deployLogShown = 0; deployFixesShown = false;
  etlConsoleAppend("Deploying to " + ((meta && meta.database) ? meta.database : "SQL Server")
    + ((meta && meta.dryRun) ? " (dry run)" : "") + "…", "info");

  const stopPolling = () => { if(deployPoll){ clearInterval(deployPoll); } deployPoll = null; updateDeployBtn(); };

  const tick = async () => {
    let data;
    try{
      const res = await fetch("/api/deploy/status/" + encodeURIComponent(jobId));
      data = await res.json();
    }catch(e){ return; /* network blip — keep polling */ }

    if(!data || !data.ok){ stopPolling(); return; }   // unknown/expired job — release the button
    const job = data.job || {};
    try{ mirrorDeployLog(job); }catch(e){}   // stream new log lines into the AI console
    const terminal = (job.state === "succeeded" || job.state === "failed" || job.state === "needs_review");

    // Stop the poll + RE-ENABLE the Deploy button BEFORE rendering, so a render
    // error can never strand the button in a disabled state (the bug that made
    // "deploy again" impossible). Rendering/history are best-effort after that.
    if(terminal) stopPolling();
    try{ renderDeployStatus(job); }catch(e){ /* non-fatal display error */ }

    if(terminal){
      try{ addDeployHistory(job, meta); }catch(e){}
      const fixCount = (job.fixes || []).length;
      // Console footer: summarize any AI fixes below the process log.
      if(fixCount && !deployFixesShown){
        etlConsoleAppend("AI fixes applied (" + fixCount + ")", "done");
        (job.fixes || []).forEach(fx => {
          const num = (fx.error && fx.error.number) ? ("SQL " + fx.error.number + ": ") : "";
          etlConsoleAppend("• batch " + fx.batchIndex + " — " + num + ((fx.error && fx.error.message) || "corrected"), "info");
        });
        deployFixesShown = true;
      }
      if(job.state === "succeeded"){
        showNotification((job.dryRun ? "Dry run OK" : "Deployed") + " to " + (job.database || "") + ".", "success", 7000);
      } else if(job.state === "needs_review"){
        // AI corrected the SQL but did NOT deploy it: load it into the editor for review.
        if(job.finalSql){ try{ loadFixedSqlIntoEditor(job.finalSql, fixCount); }catch(e){} }
      } else {
        showNotification("Deployment failed: " + ((job.error && job.error.message) || "see details below") + " (target unchanged).", "danger", 9000);
      }
    }
  };
  deployPoll = setInterval(tick, 2000);
  tick();
}

function renderDeployStatus(job){
  const badge = document.getElementById("deployStateBadge");
  const body = document.getElementById("deployStatusBody");
  const cls = {queued:"badge-gray", running:"badge-medium", fixing_error:"badge-medium", needs_review:"badge-medium", succeeded:"badge-high", failed:"badge-low"};
  if(badge) badge.innerHTML = '<span class="badge-soft ' + (cls[job.state] || "badge-gray") + '">' + escapeHtml((job.state || "").replace(/_/g, " ")) + '</span>';

  let html = '<div class="text-xs text-muted-2 mb-2">Target: <span class="mono">' + escapeHtml(job.server) + ' / ' + escapeHtml(job.database) +
    '</span> &middot; ' + job.totalBatches + ' batch(es)' + (job.dryRun ? ' &middot; dry run' : '') + '</div>';

  // Manual-gate banner: the AI corrected the SQL but did NOT deploy it.
  if(job.state === "needs_review"){
    const n = (job.fixes || []).length;
    html += '<div class="hint-note mb-2" style="background:var(--primary-soft);color:var(--primary-dark);border-color:var(--primary);">' +
      '<i class="bi bi-pencil-square"></i> AI corrected ' + n + ' issue(s) and loaded the updated query into the editor above. ' +
      '<strong>Nothing was deployed.</strong> Review the highlighted changes below, then click ' +
      '<strong>Deploy to SQL Server</strong> again to deploy the corrected script.</div>';
  }
  html += '<div class="deploy-log">' +
    (job.log || []).map(l => '<div class="deploy-log-line">' + escapeHtml(l.message) + '</div>').join("") + '</div>';

  if((job.fixes || []).length){
    html += '<div class="deploy-fixes"><div class="deploy-fixes-title">AI fixes applied (' + job.fixes.length + ')</div>';
    job.fixes.forEach(fx => {
      const num = (fx.error && fx.error.number) ? (' &middot; SQL ' + fx.error.number) : '';
      html += '<details class="deploy-fix" open><summary>Attempt ' + fx.attempt + ' &middot; batch ' + fx.batchIndex + num +
        ' &mdash; ' + escapeHtml((fx.error && fx.error.message) || '') + '</summary>' +
        lineDiffHtml(fx.before, fx.after) +
        '</details>';
    });
    html += '</div>';
  }
  if(job.state === "failed" && job.error){
    html += '<div class="hint-note mt-2" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;">' +
      '<i class="bi bi-x-circle"></i> ' + (job.error.number ? ('SQL ' + job.error.number + ': ') : '') + escapeHtml(job.error.message || 'Failed') + '</div>';
  }
  if(body) body.innerHTML = html;
}

// Load the AI-corrected full script into the editable output box (active buffer),
// select it so the change is obvious, and show a clear "we changed it" banner.
function loadFixedSqlIntoEditor(finalSql, fixCount){
  if(etlView === "ddl") ddlLastSql = finalSql; else etlLastSql = finalSql;
  const out = document.getElementById("etlOutput");
  if(out){ out.value = finalSql; out.focus(); try{ out.setSelectionRange(0, 0); }catch(e){} }
  updateOutputButtons();
  showNotification("AI corrected " + fixCount + " issue(s) and loaded the updated query into the editor above. "
    + "Nothing was deployed — review the highlighted changes below, then click Deploy to SQL Server again.", "primary", 10000);
}

// Colored, line-by-line diff (LCS) of a batch before/after an AI fix.
// removed lines = red, added = green, unchanged = muted. Falls back to plain
// before/after for very large batches (keeps the O(m*n) table bounded).
function lineDiffHtml(before, after){
  const a = String(before || "").split("\n"), b = String(after || "").split("\n");
  const m = a.length, n = b.length;
  if(m * n > 250000){
    return '<div class="deploy-diff">' +
      '<pre class="deploy-diff-before">' + escapeHtml(before) + '</pre>' +
      '<pre class="deploy-diff-after">' + escapeHtml(after) + '</pre></div>';
  }
  const dp = Array.from({length:m+1}, () => new Array(n+1).fill(0));
  for(let i=m-1;i>=0;i--) for(let j=n-1;j>=0;j--)
    dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const rows = []; let i=0, j=0;
  while(i<m && j<n){
    if(a[i]===b[j]){ rows.push(["eq", a[i]]); i++; j++; }
    else if(dp[i+1][j] >= dp[i][j+1]){ rows.push(["del", a[i]]); i++; }
    else { rows.push(["add", b[j]]); j++; }
  }
  while(i<m) rows.push(["del", a[i++]]);
  while(j<n) rows.push(["add", b[j++]]);
  return '<div class="diff-lines">' + rows.map(r =>
    '<div class="diff-line diff-' + r[0] + '">' +
    (r[0]==="add" ? "+ " : r[0]==="del" ? "- " : "  ") + escapeHtml(r[1]) +
    '</div>').join("") + '</div>';
}

/* ---- deployment history (localStorage; mirrors Mapping History) ---- */
function addDeployHistory(job, meta){
  const list = lsGet(LS_DEPLOY_HISTORY, []) || [];
  list.unshift({
    at: new Date().toISOString(), server: job.server, database: job.database,
    type: (meta && meta.kind) || "", batches: job.totalBatches, result: job.state,
    attempts: job.attempts, fixes: (job.fixes || []).length, dryRun: !!job.dryRun
  });
  lsSet(LS_DEPLOY_HISTORY, list.slice(0, 50));
  renderDeployHistory();
}
function renderDeployHistory(){
  const list = lsGet(LS_DEPLOY_HISTORY, []) || [];
  const card = document.getElementById("deployHistoryCard");
  const body = document.getElementById("deployHistoryBody");
  if(!body) return;
  if(!list.length){ if(card) card.style.display = "none"; return; }
  if(card) card.style.display = "";
  body.innerHTML = list.map(h =>
    '<tr>' +
      '<td class="text-xs">' + escapeHtml(new Date(h.at).toLocaleString()) + '</td>' +
      '<td class="mono text-xs">' + escapeHtml((h.server || "") + " / " + (h.database || "")) + '</td>' +
      '<td>' + escapeHtml(h.type || "") + (h.dryRun ? ' <span class="badge-soft badge-gray">dry</span>' : '') + '</td>' +
      '<td>' + (h.batches || 0) + '</td>' +
      '<td>' + (h.result === "succeeded" ? '<span class="badge-soft badge-high">succeeded</span>'
                 : h.result === "needs_review" ? '<span class="badge-soft badge-medium">needs review</span>'
                 : '<span class="badge-soft badge-low">failed</span>') + '</td>' +
      '<td>' + (h.attempts || 0) + '</td>' +
      '<td>' + (h.fixes || 0) + '</td>' +
    '</tr>'
  ).join("");
}
async function clearDeployHistory(){
  const ok = await confirmDialog("Clear the deployment history on this browser?", "Clear History");
  if(!ok) return;
  lsSet(LS_DEPLOY_HISTORY, []);
  renderDeployHistory();
  showNotification("Deployment history cleared.", "primary", 1200);
}

/* ---- DB name used in ETL stored-proc names (INSERT_<db>_<Table>) ----
   Derived from the active target connection's database; deploy targets are
   chosen separately in the Deploy dialog. Falls back to CommonStage. */
function currentEtlDb(){
  try{
    if(typeof getActiveTargetId === "function"){
      const id = getActiveTargetId();
      const c = id ? getTargetConnection(id) : null;
      const name = c && (c.database || c.db);
      if(name) return String(name).trim().replace(/[^A-Za-z0-9_]/g, "") || "CommonStage";
    }
  }catch(e){ /* fall through */ }
  return "CommonStage";
}

function setText(id, val){
  const el = document.getElementById(id);
  if(el) el.textContent = (val != null ? Number(val).toLocaleString() : "0");
}
