/* =========================================================================
   mapping-history.js - global audit trail across all mappings
   Future API:
     GET /api/mappings/history?filters=...
   ========================================================================= */

let hState = { all: [], filtered: [], filters:{changeType:"", source:"", user:"", search:""}, page:1, pageSize:50 };

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("mapping-history.html");

  // Apply the Settings "Default Grid Page Size" (only when it's one of the offered
  // options here; user can still override per page).
  const hps = document.getElementById("hPageSize");
  if(hps){
    hps.value = String(getSettings().pageSize);
    hState.pageSize = +hps.value || hState.pageSize;
  }

  await loadHistory();
  buildFilterBar();
  applyHistoryPipeline();

  document.getElementById("hPageSize").addEventListener("change", (e) => { hState.pageSize = +e.target.value; hState.page = 1; renderHistory(); });
  document.getElementById("exportHistoryBtn").addEventListener("click", exportHistoryCSV);
  document.getElementById("clearHistoryBtn").addEventListener("click", clearAllHistory);
});

async function clearAllHistory(){
  const count = hState.all.length;
  if(!count){ showNotification("There is no history to clear.", "warning"); return; }
  const ok = await confirmDialog("Clear the entire mapping history &amp; audit trail (" + count + " entries)? This cannot be undone.", "Clear History");
  if(!ok) return;
  // Clear both keys — the store writes under LS_KEYS.history while this page read
  // from a legacy 'aims_history' key; wipe both so nothing lingers.
  lsRemove("aims_mapping_history");
  lsRemove("aims_history");
  hState.all = []; hState.filtered = []; hState.page = 1;
  renderHistory();
  showNotification("Mapping history cleared.", "primary");
}

async function loadHistory(){
  // Use the active mapping set (AI-generated preferred, else the sample doc) so
  // history rows resolve their source/target fields.
  const aiRows = lsGet("aims_ai_mappings", null);
  const mappings = applyOverrides(aiRows !== null ? aiRows : []);   // no sample fallback (multi-tenant)
  const byId = {};
  mappings.forEach(m => { byId[m.id] = m; });

  // History is written by common.js under LS_KEYS.history ("aims_mapping_history").
  // Merge a legacy "aims_history" key too, in case older data lives there.
  const historyStore = Object.assign({}, lsGet("aims_history", {}), lsGet("aims_mapping_history", {}));
  const rows = [];
  Object.keys(historyStore).forEach(mid => {
    const m = byId[mid] || {};
    (historyStore[mid] || []).forEach(r => {
      // Prefer field names embedded on the record (e.g. delete entries whose mapping
      // no longer exists); otherwise resolve from the current mapping set.
      rows.push(Object.assign({
        mappingId: mid,
        sourceField: r.sourceField || ((m.sourceTable || "-") + "." + (m.sourceColumn || "-")),
        targetField: r.targetField || ((m.targetEntity || "-") + "." + (m.targetColumn || "-"))
      }, r));
    });
  });
  rows.sort((a,b) => new Date(b.date) - new Date(a.date));
  hState.all = rows;
}

function buildFilterBar(){
  const el = document.getElementById("hFilterBar");
  const users = Array.from(new Set(hState.all.map(r => r.user)));
  el.innerHTML =
    '<input type="text" id="hSearch" placeholder="Search mapping ID, reason, value..." style="width:250px;">' +
    '<select id="hChangeType"><option value="">All Change Types</option><option>Approved</option><option>Rejected</option><option>Modified</option><option>Regenerated</option></select>' +
    '<select id="hSource"><option value="">All Origins</option><option>AI</option><option>User</option></select>' +
    '<select id="hUser"><option value="">All Users</option>' + users.map(u => '<option>' + u + '</option>').join("") + '</select>' +
    '<button class="btn btn-sm btn-outline-soft" id="hClear">Clear</button>';

  el.querySelectorAll("input,select").forEach(input => input.addEventListener("input", debounce(() => {
    hState.filters.search = document.getElementById("hSearch").value;
    hState.filters.changeType = document.getElementById("hChangeType").value;
    hState.filters.source = document.getElementById("hSource").value;
    hState.filters.user = document.getElementById("hUser").value;
    hState.page = 1;
    applyHistoryPipeline();
  }, 150)));

  document.getElementById("hClear").addEventListener("click", () => {
    hState.filters = {changeType:"", source:"", user:"", search:""};
    buildFilterBar(); applyHistoryPipeline();
  });
}

function applyHistoryPipeline(){
  let list = hState.all.filter(r => {
    if(hState.filters.changeType && r.changeType !== hState.filters.changeType) return false;
    if(hState.filters.source && r.source !== hState.filters.source) return false;
    if(hState.filters.user && r.user !== hState.filters.user) return false;
    return true;
  });
  if(hState.filters.search){
    const q = hState.filters.search.toLowerCase();
    list = list.filter(r => [r.mappingId, r.reason, r.previousValue, r.newValue].some(v => (v||"").toLowerCase().indexOf(q) !== -1));
  }
  hState.filtered = list;
  renderHistory();
}

function renderHistory(){
  const start = (hState.page-1)*hState.pageSize;
  const rows = hState.filtered.slice(start, start+hState.pageSize);
  const body = document.getElementById("historyBody");

  if(!rows.length){
    body.innerHTML = '<tr><td colspan="10"><div class="empty-state"><i class="bi bi-clock-history"></i><h4>No history records match the current filters.</h4></div></td></tr>';
  } else {
    body.innerHTML = rows.map(r =>
      '<tr><td class="text-xs">' + formatDateTime(r.date) + '</td>' +
      '<td class="mono"><a href="mapping-workspace.html?search=' + r.mappingId + '">' + r.mappingId + '</a></td>' +
      '<td class="text-xs mono">' + r.sourceField + '</td><td class="text-xs mono">' + r.targetField + '</td>' +
      '<td>' + changeTypeBadge(r.changeType) + '</td>' +
      '<td class="wrap text-xs">' + escapeHtml(r.previousValue||"-") + '</td>' +
      '<td class="wrap text-xs">' + escapeHtml(r.newValue||"-") + '</td>' +
      '<td class="wrap text-xs">' + escapeHtml(r.reason||"-") + '</td>' +
      '<td>' + r.user + '</td>' +
      '<td><span class="badge ' + (r.source==="AI"?"bg-info text-dark":"bg-secondary") + '">' + r.source + '</span></td></tr>'
    ).join("");
  }

  const total = hState.filtered.length;
  document.getElementById("pgInfo").textContent = "Displaying " + (total?start+1:0) + "-" + Math.min(start+hState.pageSize, total) + " of " + total + " history records";
  const totalPages = Math.max(1, Math.ceil(total/hState.pageSize));
  const controls = document.getElementById("pgControls");
  let html = '<button ' + (hState.page===1?"disabled":"") + ' id="hPrev">Prev</button>';
  for(let p=1;p<=totalPages;p++){ if(p===1||p===totalPages||Math.abs(p-hState.page)<=1){ html += '<button class="' + (p===hState.page?"active":"") + '" data-pg="' + p + '">' + p + '</button>'; } else if(p===2||p===totalPages-1){ html += '<span>...</span>'; } }
  html += '<button ' + (hState.page===totalPages?"disabled":"") + ' id="hNext">Next</button>';
  controls.innerHTML = html;
  const prevBtn = document.getElementById("hPrev"); if(prevBtn) prevBtn.addEventListener("click", () => { hState.page--; renderHistory(); });
  const nextBtn = document.getElementById("hNext"); if(nextBtn) nextBtn.addEventListener("click", () => { hState.page++; renderHistory(); });
  controls.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => { hState.page = +b.dataset.pg; renderHistory(); }));
}

function changeTypeBadge(type){
  const map = {Approved:"bg-success", Rejected:"bg-danger", Modified:"bg-primary", Regenerated:"bg-warning text-dark"};
  return '<span class="badge ' + (map[type]||"bg-secondary") + '">' + type + '</span>';
}

function exportHistoryCSV(){
  const rows = hState.filtered;
  if(!rows.length){ showNotification("No history records to export.", "warning"); return; }
  const headers = ["Timestamp","Mapping ID","Source Field","Target Field","Change Type","Previous Value","New Value","Reason","User","Origin"];
  const lines = [headers.join(",")];
  rows.forEach(r => {
    const line = [formatDateTime(r.date), r.mappingId, r.sourceField, r.targetField, r.changeType, r.previousValue, r.newValue, r.reason, r.user, r.source]
      .map(v => '"' + String(v||"").replace(/"/g,'""') + '"').join(",");
    lines.push(line);
  });
  downloadTextFile("mapping-history-" + Date.now() + ".csv", lines.join("\n"), "text/csv");
  showNotification("History exported (" + rows.length + " records).", "success");
}

function downloadTextFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
