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
  renderTableList();
  wireControls();
});

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

  const gen = document.getElementById("generateEtlBtn");
  if(gen) gen.addEventListener("click", (e) => { e.preventDefault(); generateEtl(); });
  const copyBtn = document.getElementById("copyEtlBtn");
  if(copyBtn) copyBtn.addEventListener("click", (e) => { e.preventDefault(); copyEtl(); });
  const dl = document.getElementById("downloadEtlBtn");
  if(dl) dl.addEventListener("click", (e) => { e.preventDefault(); downloadEtl(); });

  updateGenerateBtn();
}

function updateGenerateBtn(){
  const gen = document.getElementById("generateEtlBtn");
  const n = etlSelected.size;
  if(gen){
    gen.disabled = n === 0;
    gen.innerHTML = '<i class="bi bi-magic me-1"></i> Generate ETL Code' + (n ? (' (' + n + ')') : '');
  }
}

/* ---- SQL generation (deterministic template fill) ---- */
let etlLastSql = "";

function generateEtl(){
  const selected = etlGroups.filter(g => etlSelected.has(g.name));
  if(!selected.length){ showNotification("Select at least one target table.", "warning"); return; }
  const db = currentEtlDb();
  const scripts = selected.map(g => buildProc(g, db));
  etlLastSql = scripts.join("\n\nGO\n\n\n");

  const out = document.getElementById("etlOutput");
  if(out) out.innerHTML = '<code>' + escapeHtml(etlLastSql) + '</code>';
  const info = document.getElementById("etlOutInfo");
  if(info) info.textContent = selected.length + " procedure(s)";
  ["copyEtlBtn","downloadEtlBtn"].forEach(id => { const b = document.getElementById(id); if(b) b.disabled = false; });
  showNotification("Generated SQL for " + selected.length + " table(s).", "success");
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

function copyEtl(){
  if(!etlLastSql) return;
  navigator.clipboard.writeText(etlLastSql)
    .then(() => showNotification("SQL copied to clipboard.", "success"))
    .catch(() => showNotification("Could not copy to clipboard.", "danger"));
}

function downloadEtl(){
  if(!etlLastSql) return;
  const blob = new Blob([etlLastSql], {type:"text/sql"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "etl_" + currentEtlDb() + "_procedures.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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
    if(etlLastSql) generateEtl();   // refresh output if already generated
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
