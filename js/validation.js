/* =========================================================================
   validation.js - Mapping Validation Rules Engine (client-side simulation)
   Future API:
     POST /api/validation/run
     GET  /api/validation/issues
   ========================================================================= */

const VALIDATION_RULES = [
  {id:"VR-01", name:"Mandatory Target Field Coverage", description:"Every target field selected for the project must have an active mapping.", severity:"Failed"},
  {id:"VR-02", name:"Data Type Compatibility", description:"Direct mappings require source and target data types to be compatible.", severity:"Failed"},
  {id:"VR-03", name:"Length Constraint Check", description:"Target field length must accommodate the maximum source field length.", severity:"Warning"},
  {id:"VR-04", name:"Lookup Table Reference", description:"Lookup-type mappings must reference a valid lookup table.", severity:"Failed"},
  {id:"VR-05", name:"Business Rule Completeness", description:"Derived, Conditional and Calculation mappings must define a business rule.", severity:"Warning"},
  {id:"VR-06", name:"Null Handling Defined", description:"Active mappings should specify how null or blank source values are handled.", severity:"Warning"},
  {id:"VR-07", name:"Low AI Confidence Review", description:"Mappings below the medium confidence threshold must be reviewed by a human.", severity:"Warning"}
];

let vState = { issues: [], filters:{severity:"", rule:""}, page:1, pageSize:25 };

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("validation.html");
  await runEvaluation(false);
  buildFilterBar();
  document.getElementById("runValidationBtn").addEventListener("click", () => runEvaluation(true));
  document.getElementById("clearValidationBtn").addEventListener("click", clearValidation);
});

// Clear the current validation results: empty the issues list + stats, and remove the
// validationStatus that the engine wrote onto each mapping override (keeps user edits).
async function clearValidation(){
  if(!vState.issues.length){
    // still allow clearing stored statuses even if the on-screen list is empty
  }
  const ok = await confirmDialog("Clear all validation results? This removes the current issues and resets each mapping's validation status. Your mapping edits are kept.", "Clear Validation");
  if(!ok) return;

  // strip only the validationStatus key from each override
  if(typeof getMappingOverrides === "function"){
    const ov = getMappingOverrides();
    let changed = false;
    Object.keys(ov).forEach(id => {
      if(ov[id] && ov[id].validationStatus !== undefined){ delete ov[id].validationStatus; changed = true; }
      if(ov[id] && Object.keys(ov[id]).length === 0) delete ov[id];
    });
    if(changed) lsSet(LS_KEYS.overrides, ov);
  }

  vState.issues = [];
  vState.page = 1;
  document.getElementById("statPassed").textContent = 0;
  document.getElementById("statWarning").textContent = 0;
  document.getElementById("statFailed").textContent = 0;
  document.getElementById("statTotal").textContent = 0;
  renderRulesSummary([]);
  renderIssues();
  showNotification("Validation results cleared.", "primary");
}

function evaluateMapping(m){
  const issues = [];
  const settings = getSettings();

  if(m.mappingType === "Not Mapped"){
    issues.push({ruleId:"VR-01", severity:"Failed", message:"Target field '" + m.targetColumn + "' in " + m.targetEntity + " has no active mapping."});
    return issues;
  }
  if(m.mappingType === "Direct" && m.sourceDataType && m.targetDataType &&
     m.sourceDataType.split(" ")[0].toLowerCase() !== m.targetDataType.split(" ")[0].toLowerCase()){
    issues.push({ruleId:"VR-02", severity:"Failed", message:"Direct mapping between incompatible types (" + m.sourceDataType + " -> " + m.targetDataType + "). Add a Data Type Conversion rule."});
  }
  if(m.sourceLength && m.targetLength && m.sourceLength > m.targetLength){
    issues.push({ruleId:"VR-03", severity:"Warning", message:"Source length (" + m.sourceLength + ") exceeds target length (" + m.targetLength + "). Data truncation risk."});
  }
  if(m.mappingType === "Lookup" && (!m.lookupTable || m.lookupTable === "-")){
    issues.push({ruleId:"VR-04", severity:"Failed", message:"Lookup mapping is missing a lookup table reference."});
  }
  if(["Derived","Conditional","Calculation"].indexOf(m.mappingType) !== -1 && (!m.businessRule || m.businessRule === "-")){
    issues.push({ruleId:"VR-05", severity:"Warning", message:"Mapping type '" + m.mappingType + "' requires a documented business rule."});
  }
  if(!m.nullHandling || m.nullHandling === "-"){
    issues.push({ruleId:"VR-06", severity:"Warning", message:"Null handling strategy not defined for this mapping."});
  }
  if(m.confidence < settings.mediumConfidence){
    issues.push({ruleId:"VR-07", severity:"Warning", message:"AI confidence (" + m.confidence + "%) is below the medium threshold (" + settings.mediumConfidence + "%)."});
  }
  return issues;
}

async function runEvaluation(showLog){
  // Validate the REAL generated mapping document (same source as the Workspace).
  // An empty array means "cleared" (validate nothing); only null falls back to sample.
  const aiRows = lsGet("aims_ai_mappings", null);
  const mappings = applyOverrides(aiRows !== null ? aiRows : (await fetchJSON("mappings.json") || []));

  const runBtn = document.getElementById("runValidationBtn");
  if(showLog && runBtn){
    runBtn.classList.add("btn-running");
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Running Validation...';
  }
  const restoreBtn = () => {
    if(runBtn){
      runBtn.classList.remove("btn-running");
      runBtn.disabled = false;
      runBtn.innerHTML = '<i class="bi bi-play-fill me-1"></i> Run Validation';
    }
  };

  const doWork = () => {
    let passed=0, warning=0, failed=0;
    const allIssues = [];
    mappings.forEach(m => {
      const issues = evaluateMapping(m);
      let status = "Passed";
      if(issues.some(i => i.severity === "Failed")) status = "Failed";
      else if(issues.some(i => i.severity === "Warning")) status = "Warning";

      if(m.validationStatus !== status){
        saveMappingOverride(m.id, {validationStatus: status});
        addHistoryRecord(m.id, {changeType:"Modified", previousValue: m.validationStatus || "Passed", newValue: status, reason:"Validation re-run", user:"Validation Engine", source:"AI"});
      }
      if(status === "Passed") passed++; else if(status === "Warning") warning++; else failed++;

      issues.forEach(i => allIssues.push(Object.assign({mappingId:m.id, source: m.sourceTable + "." + (m.sourceColumn||"-"), target: m.targetEntity + "." + m.targetColumn}, i)));
    });

    document.getElementById("statPassed").textContent = passed;
    document.getElementById("statWarning").textContent = warning;
    document.getElementById("statFailed").textContent = failed;
    document.getElementById("statTotal").textContent = mappings.length;

    renderRulesSummary(allIssues);
    vState.issues = allIssues;
    vState.page = 1;
    renderIssues();

    if(showLog) showNotification("Validation run complete: " + failed + " failed, " + warning + " warnings.", failed ? "danger" : "success");
    restoreBtn();
  };

  if(showLog){
    const steps = ["Loading mapping definitions...","Checking mandatory field coverage...","Checking data type compatibility...",
      "Checking length constraints...","Checking lookup references...","Checking business rules...","Checking null handling...",
      "Checking AI confidence thresholds...","Validation run complete."];
    runProcessLog2(steps, doWork, 350);
  } else {
    doWork();
  }
}

function runProcessLog2(steps, cb, delay){
  // lightweight inline processor (no dedicated console box on this page)
  let i = 0;
  const timer = setInterval(() => {
    i++;
    if(i >= steps.length){ clearInterval(timer); cb(); }
  }, delay);
}

function renderRulesSummary(allIssues){
  const body = document.getElementById("rulesBody");
  body.innerHTML = VALIDATION_RULES.map(r => {
    const count = allIssues.filter(i => i.ruleId === r.id).length;
    return '<tr><td class="mono">' + r.id + '</td><td>' + r.name + '</td><td class="wrap text-xs">' + r.description + '</td>' +
      '<td>' + severityBadge(r.severity) + '</td><td>' + count + '</td></tr>';
  }).join("");
}

function severityBadge(sev){
  if(sev === "Failed") return '<span class="badge bg-danger">Failed</span>';
  if(sev === "Warning") return '<span class="badge bg-warning text-dark">Warning</span>';
  return '<span class="badge bg-success">Passed</span>';
}

function buildFilterBar(){
  const el = document.getElementById("filterBar");
  el.innerHTML =
    '<select id="filterSeverity"><option value="">All Severities</option><option>Failed</option><option>Warning</option></select>' +
    '<select id="filterRule"><option value="">All Rules</option>' + VALIDATION_RULES.map(r => '<option value="' + r.id + '">' + r.id + ' - ' + r.name + '</option>').join("") + '</select>' +
    '<button class="btn btn-sm btn-outline-soft" id="clearVFilters">Clear</button>';
  el.querySelectorAll("select").forEach(s => s.addEventListener("change", () => {
    vState.filters.severity = document.getElementById("filterSeverity").value;
    vState.filters.rule = document.getElementById("filterRule").value;
    vState.page = 1;
    renderIssues();
  }));
  document.getElementById("clearVFilters").addEventListener("click", () => {
    vState.filters = {severity:"", rule:""}; buildFilterBar(); renderIssues();
  });
}

function filteredIssues(){
  return vState.issues.filter(i => {
    if(vState.filters.severity && i.severity !== vState.filters.severity) return false;
    if(vState.filters.rule && i.ruleId !== vState.filters.rule) return false;
    return true;
  });
}

function renderIssues(){
  const list = filteredIssues();
  const start = (vState.page-1)*vState.pageSize;
  const rows = list.slice(start, start+vState.pageSize);
  const body = document.getElementById("issuesBody");

  if(!rows.length){
    body.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i class="bi bi-check-circle"></i><h4>No validation issues match the current filters.</h4></div></td></tr>';
  } else {
    body.innerHTML = rows.map(i => {
      const rule = VALIDATION_RULES.find(r => r.id === i.ruleId);
      return '<tr><td class="mono">' + i.mappingId + '</td><td class="text-xs">' + i.source + ' &gt; ' + i.target + '</td>' +
        '<td class="text-xs">' + i.ruleId + ' - ' + rule.name + '</td><td>' + severityBadge(i.severity) + '</td>' +
        '<td class="wrap text-xs">' + escapeHtml(i.message) + '</td>' +
        '<td><a class="btn btn-sm btn-outline-soft" href="mapping-workspace.html?search=' + i.mappingId + '">Open</a></td></tr>';
    }).join("");
  }

  const total = list.length;
  document.getElementById("pgInfo").textContent = "Displaying " + (total ? start+1 : 0) + "-" + Math.min(start+vState.pageSize, total) + " of " + total + " issues";
  const totalPages = Math.max(1, Math.ceil(total / vState.pageSize));
  const controls = document.getElementById("pgControls");
  let html = '<button ' + (vState.page===1?"disabled":"") + ' id="vPrev">Prev</button>';
  for(let p=1;p<=totalPages;p++){ html += '<button class="' + (p===vState.page?"active":"") + '" data-pg="' + p + '">' + p + '</button>'; }
  html += '<button ' + (vState.page===totalPages?"disabled":"") + ' id="vNext">Next</button>';
  controls.innerHTML = html;
  const prevBtn = document.getElementById("vPrev"); if(prevBtn) prevBtn.addEventListener("click", () => { vState.page--; renderIssues(); });
  const nextBtn = document.getElementById("vNext"); if(nextBtn) nextBtn.addEventListener("click", () => { vState.page++; renderIssues(); });
  controls.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => { vState.page = +b.dataset.pg; renderIssues(); }));
}
