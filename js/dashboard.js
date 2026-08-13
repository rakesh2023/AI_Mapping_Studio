/* =========================================================================
   dashboard.js - populates the Dashboard page with KPIs and summaries.
   Future API: GET /api/dashboard/summary
   ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("dashboard.html");

  const project = await loadProject();
  // Prefer the REAL AI-generated mappings (same source as the Mapping Workspace);
  // fall back to the bundled sample only when nothing has been generated yet.
  // Use the generated document if it exists (empty array = cleared, not "use sample").
  const aiRows = lsGet("aims_ai_mappings", null);
  const rawMappings = (aiRows !== null) ? aiRows : (await fetchJSON("mappings.json") || []);

  const mappings = applyOverrides(rawMappings || []);
  // Reflect REAL progress (was hardcoded to 9) from stored project state.
  renderWorkflowStepper("workflowStepper", computeWorkflowIndex(mappings));
  // Derive validation issues from the REAL mappings (same rules as the Validation page)
  // instead of a static file, so the summary reflects the current document.
  const validation = deriveValidationIssues(mappings);
  const stats = computeStats(mappings, validation);

  renderKPIs(stats, mappings);
  renderProgressBars(stats);
  renderRecentActivity();
  renderByType(mappings);
  renderByStatus(mappings);
  renderLowConfidence(mappings);
  renderValidationSummary(validation, mappings);
});

/* Compute how far the migration workflow has really progressed, from stored
   state (was previously hardcoded to 9, which always showed 9 green steps).
   A step is only "done" when there's a genuine signal for it (or a LATER step's
   signal is present — a linear pipeline, so we fill gaps up to the furthest
   milestone reached). Returns the index of the first not-yet-done step. */
function computeWorkflowIndex(mappings){
  const filled = (v) => Array.isArray(v) ? v.length > 0 : !!v;
  const rows = Array.isArray(mappings) ? mappings : [];
  const hasMappings = rows.length > 0;
  const reviewed = rows.some(m => (m.reviewStatus || "").trim() !== "");
  const allApproved = hasMappings && rows.every(m => (m.reviewStatus || "").indexOf("Approved") === 0);

  // WORKFLOW_STEPS indices (see common.js) -> best available signal.
  const signal = {
    0: filled(lsGet("aims_current_project", null)),      // Project Creation
    1: filled(lsGet("aims_db_connections", [])),          // Source Configuration
    2: filled(lsGet("aims_db_connections", [])),          // Source Connection
    4: filled(lsGet("aims_db_connections", [])),          // Metadata Discovery
    6: filled(lsGet("aims_target_connections", [])),      // Target Configuration
    7: filled(lsGet("aims_active_target", null)),         // Target Metadata
    8: hasMappings,                                        // AI Mapping Generation
    9: reviewed,                                           // Mapping Review
    12: filled(lsGet("aims_deploy_history", [])),          // ETL Code Generation (deployed)
    13: allApproved,                                       // Approval
  };
  let maxDone = -1;
  Object.keys(signal).forEach(k => { if(signal[k]) maxDone = Math.max(maxDone, Number(k)); });
  return maxDone + 1;   // first step without a completion signal is "active"
}

/* Derive validation issues from the current mappings using the same rules as the
   Validation page, so the dashboard summary is dynamic (Critical/Error/Warning/Info). */
function deriveValidationIssues(mappings){
  const s = getSettings();
  const medium = s.mediumConfidence || 70;
  const issues = [];
  (mappings || []).forEach(m => {
    if(m.mappingType === "Not Mapped"){
      issues.push({severity:"Critical"});   // mandatory field with no mapping
      return;
    }
    if(m.mappingType === "Direct" && m.sourceDataType && m.targetDataType &&
       String(m.sourceDataType).split(" ")[0].toLowerCase() !== String(m.targetDataType).split(" ")[0].toLowerCase()){
      issues.push({severity:"Error"});       // incompatible direct type
    }
    if(m.sourceLength && m.targetLength && m.sourceLength > m.targetLength){
      issues.push({severity:"Warning"});      // truncation risk
    }
    if(m.mappingType === "Lookup" && (!m.lookupTable || m.lookupTable === "-")){
      issues.push({severity:"Error"});        // lookup missing table
    }
    if(["Derived","Conditional","Calculation"].indexOf(m.mappingType) !== -1 && (!m.businessRule || m.businessRule === "-")){
      issues.push({severity:"Warning"});
    }
    if(!m.nullHandling || m.nullHandling === "-"){
      issues.push({severity:"Warning"});
    }
    if((m.confidence||0) < medium){
      issues.push({severity:"Warning"});
    }
  });
  return issues;
}

/* Build live stats: SOURCE from saved connections, TARGET from uploaded schema. */
function computeStats(mappings, validation){
  // ----- SOURCE (from configured source-system connections) -----
  const conns = (typeof getDbConnections === "function") ? getDbConnections() : [];
  const connected = conns.filter(c => c.status === "Connected");
  const sourceSystems = conns.length;
  const sourceTables = conns.reduce((a,c) => a + (Number(c.tableCount) || 0), 0);
  const sourceColumns = conns.reduce((a,c) => a + (Number(c.columnCount) || 0), 0);

  // ----- TARGET (from uploaded Target Schema File) -----
  const schema = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  const targetTables = schema ? (schema.tableCount || (schema.entities||[]).length) : 0;
  const targetColumns = schema ? (schema.columnCount || (schema.entities||[]).reduce((a,e)=>a+(e.fields||[]).length,0)) : 0;

  // ----- MAPPINGS (from current mapping set) -----
  const total = mappings.length;
  const mapped = mappings.filter(m => m.mappingType !== "Not Mapped").length;
  const unmapped = mappings.filter(m => m.mappingType === "Not Mapped").length;
  const approved = mappings.filter(m => (m.reviewStatus||"").indexOf("Approved") === 0).length;
  const needsReview = mappings.filter(m => m.reviewStatus === "Needs Review" || m.reviewStatus === "In Review").length;
  const avgConf = total ? Math.round(mappings.reduce((a,m)=>a+(m.confidence||0),0) / total) : 0;
  const completionPct = total ? Math.round(mapped / total * 100) : 0;

  // Validation errors: count Critical + Error issues derived live from the mappings.
  const validationErrors = (validation||[]).filter(r => r.severity === "Critical" || r.severity === "Error").length;

  return {
    sourceSystems, sourceTables, sourceColumns, connectedCount: connected.length,
    targetTables, targetColumns, hasSchema: !!schema,
    totalMappingRows: total, mappedFields: mapped, unmappedFields: unmapped,
    approvedMappings: approved, needsReview,
    validationErrors: validationErrors,
    completionPct, avgConfidencePct: avgConf
  };
}

function renderKPIs(stats, mappings){
  const srcSub = stats.connectedCount + " connected";
  const tgtSub = stats.hasSchema ? "from schema file" : "no schema uploaded";
  const cards = [
    {label:"Source Systems", value: stats.sourceSystems, icon:"bi-hdd-network", accent:"blue", sub: srcSub},
    {label:"Source Tables", value: stats.sourceTables, icon:"bi-table", accent:"blue", sub:"live"},
    {label:"Source Columns", value: stats.sourceColumns, icon:"bi-list-columns", accent:"blue", sub:"live"},
    {label:"Staging Area Tables", value: stats.targetTables, icon:"bi-diagram-2", accent:"green", sub: tgtSub},
    {label:"Staging Area Columns", value: stats.targetColumns, icon:"bi-list-columns-reverse", accent:"green", sub: tgtSub},
    {label:"Total Mapping Rows", value: stats.totalMappingRows, icon:"bi-arrow-left-right", accent:"blue"},
    {label:"Mapped Fields", value: stats.mappedFields, icon:"bi-check2-square", accent:"green"},
    {label:"Unmapped Fields", value: stats.unmappedFields, icon:"bi-exclamation-square", accent:"amber"},
    {label:"Approved Mappings", value: stats.approvedMappings, icon:"bi-patch-check", accent:"green"},
    {label:"Needs Review", value: stats.needsReview, icon:"bi-hourglass-split", accent:"amber"},
    {label:"Validation Errors", value: stats.validationErrors, icon:"bi-bug", accent:"red"},
    {label:"Mapping Completion %", value: stats.completionPct + "%", icon:"bi-speedometer", accent:"green"},
    {label:"Average AI Confidence %", value: stats.avgConfidencePct + "%", icon:"bi-cpu", accent:"blue"}
  ];
  document.getElementById("kpiGrid").innerHTML = cards.map(c =>
    '<div class="kpi-card accent-' + c.accent + '">' +
      '<div class="d-flex justify-content-between align-items-start">' +
        '<div><div class="kpi-label">' + c.label + '</div>' +
        '<div class="kpi-value">' + c.value + '</div>' +
        (c.sub ? '<div class="text-muted-2" style="font-size:.66rem;">' + c.sub + '</div>' : '') + '</div>' +
        '<i class="bi ' + c.icon + '" style="font-size:1.3rem;color:#c7d2e0;"></i>' +
      '</div></div>'
  ).join("");
}

function renderProgressBars(stats){
  const tot = stats.totalMappingRows || 1;
  const rows = [
    {label:"Overall Mapping Completion", pct: stats.completionPct, color:"var(--primary)"},
    {label:"Fields Approved", pct: Math.round(stats.approvedMappings/tot*100), color:"var(--success)"},
    {label:"Fields Needing Review", pct: Math.round(stats.needsReview/tot*100), color:"var(--warning)"},
    {label:"Average AI Confidence", pct: stats.avgConfidencePct, color:"#7c3aed"}
  ];
  document.getElementById("progressBars").innerHTML = rows.map(r =>
    '<div class="mb-3">' +
      '<div class="d-flex justify-content-between text-xs mb-1"><span>' + r.label + '</span><span>' + r.pct + '%</span></div>' +
      '<div style="height:8px;background:#eef1f5;border-radius:6px;overflow:hidden;">' +
        '<div style="height:100%;width:' + r.pct + '%;background:' + r.color + ';"></div>' +
      '</div></div>'
  ).join("");
}

function renderRecentActivity(){
  const history = getAllHistoryFlat().slice(0, 6);
  const staticSeed = [
    {mappingId:"MAP-004", action:"Regenerated with new instructions", date:new Date(Date.now()-3600e3*3).toISOString(), by:"AI Engine"},
    {mappingId:"MAP-003", action:"Approved after SME confirmation", date:new Date(Date.now()-3600e3*7).toISOString(), by:currentUserName()},
    {mappingId:"MAP-018", action:"Flagged Needs Review - derived rule edge case", date:new Date(Date.now()-3600e3*20).toISOString(), by:"AI Engine"}
  ];
  const items = history.length ? history : staticSeed;
  document.getElementById("recentActivity").innerHTML = items.map(h =>
    '<div class="d-flex justify-content-between align-items-start py-2" style="border-bottom:1px solid #eef1f5;">' +
      '<div><div style="font-weight:600;">' + h.mappingId + '</div>' +
      '<div class="text-muted-2">' + (h.action || h.changeType || "Updated") + '</div></div>' +
      '<div class="text-end"><div class="text-muted-2">' + (h.by || h.user || "System") + '</div>' +
      '<div class="text-muted-2">' + timeAgo(h.date) + '</div></div></div>'
  ).join("");
}

function renderByType(mappings){
  const counts = {};
  mappings.forEach(m => counts[m.mappingType] = (counts[m.mappingType]||0) + 1);
  const total = mappings.length;
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  document.getElementById("byType").innerHTML = entries.map(([type,count]) =>
    '<div class="mb-2">' +
      '<div class="d-flex justify-content-between text-xs mb-1"><span>' + type + '</span><span>' + count + '</span></div>' +
      '<div style="height:6px;background:#eef1f5;border-radius:4px;">' +
        '<div style="height:100%;width:' + Math.round(count/total*100) + '%;background:var(--primary);border-radius:4px;"></div>' +
      '</div></div>'
  ).join("");
}

function renderByStatus(mappings){
  const counts = {};
  mappings.forEach(m => counts[m.reviewStatus] = (counts[m.reviewStatus]||0) + 1);
  document.getElementById("byStatus").innerHTML = Object.entries(counts).map(([status,count]) =>
    '<div class="d-flex justify-content-between align-items-center mb-2">' +
      statusBadge(status) + '<span class="fw-bold">' + count + '</span></div>'
  ).join("");
}

function renderLowConfidence(mappings){
  const low = mappings.filter(m => m.mappingType !== "Not Mapped" && confidenceLevel(m.confidence) === "low");
  const el = document.getElementById("lowConfList");
  if(!low.length){ el.innerHTML = '<p class="text-muted-2 text-xs">No low-confidence mappings in current scope.</p>'; return; }
  el.innerHTML = low.map(m =>
    '<a href="mapping-workspace.html?search=' + m.id + '" class="d-flex justify-content-between align-items-center py-2 text-decoration-none" style="border-bottom:1px solid #eef1f5;color:inherit;">' +
      '<div><div style="font-weight:600;font-size:.82rem;">' + (m.sourceColumn || "-") + ' <i class="bi bi-arrow-right text-muted-2"></i> ' + m.targetColumn + '</div>' +
      '<div class="text-muted-2 text-xs">' + m.id + ' - ' + m.targetEntity + '</div></div>' +
      confidenceBadge(m.confidence) + '</a>'
  ).join("");
}

function renderValidationSummary(results, mappings){
  const sevCounts = {Critical:0, Error:0, Warning:0, Information:0};
  (results||[]).forEach(r => sevCounts[r.severity] = (sevCounts[r.severity]||0)+1);
  // "Passed Checks" = mappings that produced NO issues (clean per the same rules).
  const passed = (mappings||[]).filter(m => deriveValidationIssues([m]).length === 0).length;
  const cards = [
    {label:"Critical Errors", value:sevCounts.Critical, accent:"red"},
    {label:"Errors", value:sevCounts.Error, accent:"red"},
    {label:"Warnings", value:sevCounts.Warning, accent:"amber"},
    {label:"Recommendations", value:sevCounts.Information, accent:"blue"},
    {label:"Passed Checks", value:passed, accent:"green"}
  ];
  document.getElementById("validationSummary").innerHTML = cards.map(c =>
    '<div class="col"><div class="kpi-card accent-' + c.accent + '">' +
      '<div class="kpi-label">' + c.label + '</div><div class="kpi-value">' + c.value + '</div></div></div>'
  ).join("") + '<div class="col-12 mt-2"><a href="validation.html" class="btn btn-sm btn-outline-soft">Open Validation Engine <i class="bi bi-arrow-right"></i></a></div>';
}
