/* =========================================================================
   ai-usage-report.js — AI Usage Report page.

   Reads the local AI usage log (server/aims_usage.db) via /api/ai-usage/*.
   Shows summary cards (Total Calls / Input / Output / Total tokens) plus a
   paginated, filterable table of individual calls. Token counts + metadata
   only — no prompt/response content, no cost figures. Plain fetch(), no libs.
   ========================================================================= */

const auPage = { limit: 100, offset: 0, total: 0 };

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("ai-usage-report.html");
  setDefaultDates();
  wireEvents();
  await refresh();
});

function isoDate(d){ return d.toISOString().slice(0, 10); }

// Default window: last 7 days (inclusive of today).
function setDefaultDates(){
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 7);
  document.getElementById("startDate").value = isoDate(start);
  document.getElementById("endDate").value = isoDate(end);
}

function currentFilters(){
  return {
    start: document.getElementById("startDate").value || "",
    end: document.getElementById("endDate").value || "",
    feature: document.getElementById("featureFilter").value || "",
  };
}

function qs(params){
  return Object.keys(params)
    .filter(k => params[k] !== "" && params[k] != null)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
}

async function refresh(){
  auPage.offset = 0;
  await Promise.all([loadSummary(), loadLogs()]);
}

async function loadSummary(){
  const f = currentFilters();
  try{
    const res = await fetch("/api/ai-usage/summary?" + qs({ start_date: f.start, end_date: f.end }));
    const data = await res.json();
    if(!data.ok){ showNotification("Could not load summary: " + (data.error || ""), "danger"); return; }
    const o = data.overall || {};
    setNum("suTotalCalls", o.total_calls);
    setNum("suInput", o.total_input_tokens);
    setNum("suOutput", o.total_output_tokens);
    setNum("suTotal", o.total_tokens);
    const failed = o.failed_calls || 0;
    document.getElementById("suFailed").textContent = failed ? (failed.toLocaleString() + " failed") : "";
    populateFeatures(data.by_feature || []);
  }catch(e){ showNotification("Backend not reachable. Start it with: cd server && python main.py", "danger"); }
}

// Fill the feature dropdown from the per-feature breakdown, keeping the current
// selection if it's still present in the new range.
function populateFeatures(byFeature){
  const sel = document.getElementById("featureFilter");
  const current = sel.value;
  const names = byFeature.map(r => r.feature_name).filter(Boolean);
  sel.innerHTML = '<option value="">All features</option>'
    + names.map(n => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join("");
  if(current && names.indexOf(current) !== -1) sel.value = current;
}

async function loadLogs(){
  const f = currentFilters();
  try{
    const res = await fetch("/api/ai-usage/logs?" + qs({
      start_date: f.start, end_date: f.end, feature: f.feature,
      limit: auPage.limit, offset: auPage.offset,
    }));
    const data = await res.json();
    if(!data.ok){ showNotification("Could not load logs: " + (data.error || ""), "danger"); return; }
    auPage.total = data.total || 0;
    renderRows(data.rows || []);
    renderPager();
  }catch(e){ showNotification("Backend not reachable.", "danger"); }
}

function renderRows(rows){
  const body = document.getElementById("usageBody");
  if(!rows.length){
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted-2 p-3">No AI calls logged for this range.</td></tr>';
    document.getElementById("logInfo").textContent = "";
    return;
  }
  body.innerHTML = rows.map(r => {
    const st = (r.status === "failed")
      ? '<span class="badge-soft badge-low" title="' + escapeHtml(r.error_message || "") + '">failed</span>'
      : '<span class="badge-soft badge-high">success</span>';
    return '<tr>'
      + '<td class="text-xs">' + escapeHtml(fmtDate(r.call_timestamp)) + '</td>'
      + '<td>' + escapeHtml(r.feature_name || "") + '</td>'
      + '<td class="text-xs mono">' + escapeHtml(r.model || "") + '</td>'
      + '<td class="text-end">' + num(r.input_tokens) + '</td>'
      + '<td class="text-end">' + num(r.output_tokens) + '</td>'
      + '<td class="text-end fw-bold">' + num(r.total_tokens) + '</td>'
      + '<td>' + st + '</td>'
      + '</tr>';
  }).join("");
  document.getElementById("logInfo").textContent = auPage.total.toLocaleString() + " call(s)";
}

function renderPager(){
  const start = auPage.total ? (auPage.offset + 1) : 0;
  const end = Math.min(auPage.offset + auPage.limit, auPage.total);
  document.getElementById("pageInfo").textContent =
    auPage.total ? ("Showing " + start + "–" + end + " of " + auPage.total.toLocaleString()) : "";
  document.getElementById("prevBtn").disabled = auPage.offset <= 0;
  document.getElementById("nextBtn").disabled = (auPage.offset + auPage.limit) >= auPage.total;
}

function wireEvents(){
  document.getElementById("applyBtn").addEventListener("click", refresh);
  document.getElementById("refreshBtn").addEventListener("click", refresh);
  document.getElementById("resetBtn").addEventListener("click", async () => {
    setDefaultDates();
    document.getElementById("featureFilter").value = "";
    await refresh();
  });
  document.getElementById("clearHistoryBtn").addEventListener("click", clearHistory);
  document.getElementById("featureFilter").addEventListener("change", async () => { auPage.offset = 0; await loadLogs(); });
  document.getElementById("prevBtn").addEventListener("click", async () => { auPage.offset = Math.max(0, auPage.offset - auPage.limit); await loadLogs(); });
  document.getElementById("nextBtn").addEventListener("click", async () => { auPage.offset += auPage.limit; await loadLogs(); });
}

// Permanently delete ALL logged rows (irreversible) after confirming.
async function clearHistory(){
  const ok = await confirmDialog(
    "Permanently delete ALL AI usage log history? Token counts for every logged call will be removed. This cannot be undone.",
    "Clear History");
  if(!ok) return;
  try{
    const res = await fetch("/api/ai-usage/logs", { method: "DELETE" });
    const data = await res.json();
    if(!data.ok){ showNotification("Could not clear history: " + (data.error || ""), "danger"); return; }
    showNotification("Cleared " + Number(data.deleted || 0).toLocaleString() + " log row(s).", "primary", 2500);
    await refresh();
  }catch(e){ showNotification("Backend not reachable.", "danger"); }
}

function num(v){ return Number(v || 0).toLocaleString(); }
function setNum(id, v){ const el = document.getElementById(id); if(el) el.textContent = Number(v || 0).toLocaleString(); }
function fmtDate(iso){ if(!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); }
