/* =========================================================================
   export.js - Export Mapping Document
   Future API:
     POST /api/exports/generate  (returns a signed download URL / file stream)
     GET  /api/exports/history
   ========================================================================= */

const FORMAT_HINTS = {
  csv: "CSV is generated directly in your browser and downloads immediately.",
  json: "JSON is generated directly in your browser and downloads immediately.",
  xlsx: "Excel generation will be handled by the backend export service in production. This is a simulated run.",
  pdf: "PDF summary generation will be handled by the backend export service in production. This is a simulated run."
};

const EXPORT_COLUMNS = ["id","sourceSystem","sourceTable","sourceColumn","sourceDataType","targetSystem","targetEntity",
  "targetTable","targetColumn","targetDataType","mappingType","transformationRule","businessRule","defaultValue",
  "lookupTable","nullHandling","confidence","validationStatus","reviewStatus","createdBy","updatedBy","lastUpdated"];

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("export.html");
  renderExportsTable();

  document.getElementById("exportFormat").addEventListener("change", (e) => {
    document.getElementById("formatHint").textContent = FORMAT_HINTS[e.target.value];
  });
  document.getElementById("generateExportBtn").addEventListener("click", generateExport);
});

function scopeFilter(list, scope){
  switch(scope){
    case "mapped": return list.filter(m => m.mappingType !== "Not Mapped");
    case "unmapped": return list.filter(m => m.mappingType === "Not Mapped");
    case "approved": return list.filter(m => m.reviewStatus === "Approved" || m.reviewStatus === "Approved After Modification");
    case "review": return list.filter(m => m.reviewStatus === "Needs Review" || m.reviewStatus === "In Review");
    case "rejected": return list.filter(m => m.reviewStatus === "Rejected");
    default: return list;
  }
}

async function generateExport(){
  const scope = document.getElementById("exportScope").value;
  const format = document.getElementById("exportFormat").value;
  const includeHistory = document.getElementById("includeHistory").checked;
  const includeComments = document.getElementById("includeComments").checked;

  const mappings = scopeFilter(applyOverrides(await fetchJSON("mappings.json")), scope);
  const historyStore = includeHistory ? lsGet("aims_history", {}) : {};

  const steps = [
    "Validating export scope (" + scope + ")...",
    "Applying column selection...",
    "Formatting " + mappings.length + " mapping records...",
    includeHistory ? "Compiling change history..." : "Skipping change history...",
    includeComments ? "Compiling review comments..." : "Skipping review comments...",
    "Finalizing export file (" + format.toUpperCase() + ")..."
  ];

  runProcessLog("exportLog", steps, () => finalizeExport(mappings, format, scope, includeHistory, includeComments, historyStore), 400);
}

function finalizeExport(mappings, format, scope, includeHistory, includeComments, historyStore){
  const exportId = "EXP-" + Date.now();
  const filename = exportId + "." + format;
  let simulated = false;

  if(format === "csv"){
    const content = buildCSV(mappings, includeHistory, includeComments, historyStore);
    downloadTextFile(filename, content, "text/csv");
  } else if(format === "json"){
    const content = buildJSON(mappings, includeHistory, includeComments, historyStore);
    downloadTextFile(filename, content, "application/json");
  } else {
    simulated = true;
  }

  const record = {
    id: exportId, filename, format: format.toUpperCase(), scope, rowCount: mappings.length,
    generatedBy: currentUserName(), date: new Date().toISOString(), status: simulated ? "Simulated" : "Completed"
  };
  const exports = lsGet("aims_exports", []);
  exports.unshift(record);
  lsSet("aims_exports", exports);
  renderExportsTable();

  showNotification(simulated
    ? "Export simulated (" + format.toUpperCase() + "). Real " + format.toUpperCase() + " generation requires the backend export service."
    : "Export generated and downloaded: " + filename, simulated ? "warning" : "success");
}

function buildCSV(mappings, includeHistory, includeComments, historyStore){
  const headers = EXPORT_COLUMNS.slice();
  if(includeComments) headers.push("comments");
  if(includeHistory) headers.push("historyCount");
  const lines = [headers.join(",")];
  mappings.forEach(m => {
    const row = EXPORT_COLUMNS.map(c => '"' + String(m[c] ?? "").replace(/"/g,'""') + '"');
    if(includeComments) row.push('"' + ((m.comments||[]).map(c=>c.user+": "+c.text).join(" | ")).replace(/"/g,'""') + '"');
    if(includeHistory) row.push((historyStore[m.id]||[]).length);
    lines.push(row.join(","));
  });
  return lines.join("\n");
}

function buildJSON(mappings, includeHistory, includeComments, historyStore){
  const out = mappings.map(m => {
    const row = {};
    EXPORT_COLUMNS.forEach(c => row[c] = m[c]);
    if(includeComments) row.comments = m.comments || [];
    if(includeHistory) row.history = historyStore[m.id] || [];
    return row;
  });
  return JSON.stringify(out, null, 2);
}

function downloadTextFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function renderExportsTable(){
  const exports = lsGet("aims_exports", []);
  const body = document.getElementById("exportsBody");
  if(!exports.length){
    body.innerHTML = '<tr><td colspan="8"><div class="empty-state"><i class="bi bi-download"></i><h4>No exports generated yet.</h4></div></td></tr>';
    return;
  }
  body.innerHTML = exports.map(e =>
    '<tr><td class="mono">' + e.id + '</td><td>' + e.filename + '</td><td>' + e.format + '</td><td>' + e.scope + '</td>' +
    '<td>' + e.rowCount + '</td><td>' + e.generatedBy + '</td><td class="text-xs">' + formatDateTime(e.date) + '</td>' +
    '<td><span class="badge ' + (e.status==="Completed"?"bg-success":"bg-warning text-dark") + '">' + e.status + '</span></td></tr>'
  ).join("");
}
