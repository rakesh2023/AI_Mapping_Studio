/* =========================================================================
   profiling.js - Data Profiling page (dynamic)
   Flow: pick a source system -> pick a table -> Run Profiling.
   Sources profile live against the backend (/api/db/profile).
   ========================================================================= */

let activeSource = null;       // {kind:'live', conn:{...}}
let liveTables = [];           // [{name, schema}] for the active live source
let activeSchema = "dbo";

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("data-profiling.html");

  document.getElementById("sourceSelect").addEventListener("change", onSourceChange);
  document.getElementById("runProfileBtn").addEventListener("click", runProfiling);

  buildSourceOptions();
  await onSourceChange();   // load tables for the first source
});

/* ---------- source dropdown ---------- */
function buildSourceOptions(){
  const sel = document.getElementById("sourceSelect");
  const conns = (typeof getDbConnections === "function") ? getDbConnections() : [];
  // Data profiling runs live SQL against the source, so File System (file-based)
  // sources are not eligible — exclude them from the list.
  const dbConns = conns.filter(c => (c.type || "").toLowerCase() !== "file system");
  let html = dbConns.map(c => '<option value="live:' + c.id + '">' + escapeHtml(c.name) + ' (' + escapeHtml(c.type || "SQL Server") + ')</option>').join("");
  if(!html) html = '<option value="">No database source — profiling needs a live SQL source</option>';
  sel.innerHTML = html;
  // prefer a Connected live source first, else first option
  const connected = dbConns.find(c => c.status === "Connected");
  if(connected) sel.value = "live:" + connected.id;
}

async function onSourceChange(){
  const val = document.getElementById("sourceSelect").value;
  const tableSel = document.getElementById("tableSelect");
  document.getElementById("profileCards").innerHTML = "";
  document.getElementById("profileSummary").innerHTML = "";

  if(val && val.indexOf("live:") === 0){
    const id = val.slice(5);
    const conn = getDbConnection(id);
    // File System sources can't be profiled (no live database to query).
    if(conn && (conn.type || "").toLowerCase() === "file system"){
      activeSource = null;
      tableSel.innerHTML = '<option value="">Not available for file sources</option>';
      setConsole("'" + conn.name + "' is a File System connection — data profiling runs live SQL and isn't available for file sources. Explore it on the Metadata Explorer instead.", true);
      showNotification("Data profiling isn't available for File System sources.", "warning");
      return;
    }
    activeSource = {kind:"live", conn};
    tableSel.innerHTML = '<option value="">Loading tables...</option>';
    await loadLiveTables(conn);
    return;
  }

  activeSource = null;
  tableSel.innerHTML = '<option value="">No source</option>';
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

async function loadLiveTables(conn){
  const tableSel = document.getElementById("tableSelect");
  try{
    const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(connToConfig(conn))});
    const data = await res.json();
    if(!data.ok || !data.tables.length){
      liveTables = [];
      tableSel.innerHTML = '<option value="">' + (data.ok ? "No tables found" : "Connection failed") + '</option>';
      if(!data.ok) showNotification("Could not read tables: " + (data.error||""), "danger");
      return;
    }
    activeSchema = data.schema || "dbo";
    liveTables = data.tables.map(t => ({name:t.name, schema:t.schema || activeSchema}));
    tableSel.innerHTML = liveTables.map(t => '<option>' + escapeHtml(t.name) + '</option>').join("");
  }catch(err){
    liveTables = [];
    tableSel.innerHTML = '<option value="">Backend not reachable</option>';
    showNotification("Backend not reachable. Start it with python server/app.py.", "danger");
  }
}

/* ---------- run profiling ---------- */
function setConsole(text, show){
  const el = document.getElementById("profileConsole");
  if(!el) return;
  el.style.display = show === false ? "none" : "";
  el.textContent = text;
}

async function runProfiling(){
  const table = document.getElementById("tableSelect").value;
  if(!activeSource || !table){ showNotification("Select a source and table first.", "warning"); return; }

  // live profiling
  const conn = activeSource.conn;
  const schema = (liveTables.find(t => t.name === table) || {}).schema || activeSchema;
  const btn = document.getElementById("runProfileBtn");
  btn.disabled = true;
  setConsole("Profiling " + schema + "." + table + " on " + (conn.name || conn.server) + " ...");
  document.getElementById("profileCards").innerHTML = "";
  document.getElementById("profileSummary").innerHTML = "";
  try{
    const cfg = Object.assign(connToConfig(conn), {schema, table, topN:6});
    const res = await fetch("/api/db/profile", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
    const data = await res.json();
    if(!data.ok){ setConsole("Profiling failed: " + (data.error||"")); showNotification("Profiling failed: " + (data.error||""), "danger"); btn.disabled=false; return; }
    setConsole("Profiled " + data.columns.length + " columns across " + data.rowCount.toLocaleString() + " rows.", true);
    renderLiveProfile(data);
    showNotification("Profiling complete for " + table + " (" + data.rowCount.toLocaleString() + " rows).", "success");
  }catch(err){
    setConsole("Backend not reachable. Start it with python server/app.py.");
    showNotification("Backend not reachable.", "danger");
  }finally{
    btn.disabled = false;
  }
}

/* ---------- render: live ---------- */
function renderLiveProfile(data){
  document.getElementById("profileSummary").innerHTML =
    '<span class="badge-soft badge-high"><i class="bi bi-table"></i> ' + escapeHtml(data.schema) + '.' + escapeHtml(data.table) + '</span> ' +
    '<span class="badge-soft badge-gray">' + data.rowCount.toLocaleString() + ' rows</span> ' +
    '<span class="badge-soft badge-gray">' + data.columns.length + ' columns</span>';
  const wrap = document.getElementById("profileCards");
  wrap.innerHTML = data.columns.map(c => buildLiveCard(data, c)).join("");
}

function buildLiveCard(data, c){
  const topValuesHTML = (c.topValues || []).map(v =>
    '<div class="prof-bar-row"><span class="pbr-val">' + escapeHtml(String(v.value)) + '</span>' +
      '<span class="pbr-pct">' + v.pct + '% &middot; ' + v.count.toLocaleString() + '</span></div>' +
    '<div class="prof-bar"><span style="width:' + v.pct + '%"></span></div>'
  ).join("");

  const np = c.nullPct || 0;
  const nullCls = np === 0 ? "ok" : (np < 20 ? "warn" : "bad");
  const nullPill = '<span class="prof-null-pill ' + nullCls + '">' + np + '% null</span>';
  const distinctPct = data.rowCount ? Math.round((Number(c.distinctCount||0) / data.rowCount) * 100) : 0;
  const uniqueTag = (data.rowCount && Number(c.distinctCount||0) === data.rowCount) ? ' <span class="badge-soft badge-blue" style="font-size:.6rem;padding:1px 6px;">unique</span>' : '';

  return (
    '<div class="col-lg-6 col-xl-4"><div class="card-el prof-card">' +
      '<div class="prof-head">' +
        '<div><div class="prof-name">' + escapeHtml(c.name) + '</div>' +
        '<div class="prof-sub">' + escapeHtml(data.table) + ' &middot; ' + escapeHtml(c.dataType) + (c.length ? "(" + c.length + ")" : "") + '</div></div>' +
        nullPill +
      '</div>' +
      '<div class="prof-stats">' +
        '<div class="prof-stat"><span class="ps-label">Rows</span><span class="ps-value">' + data.rowCount.toLocaleString() + '</span></div>' +
        '<div class="prof-stat"><span class="ps-label">Distinct</span><span class="ps-value">' + Number(c.distinctCount||0).toLocaleString() + ' <span class="text-muted-2" style="font-size:.7rem;font-weight:500;">(' + distinctPct + '%)</span>' + uniqueTag + '</span></div>' +
        '<div class="prof-stat"><span class="ps-label">Null Count</span><span class="ps-value">' + Number(c.nullCount||0).toLocaleString() + '</span></div>' +
        '<div class="prof-stat"><span class="ps-label">Sample</span><span class="ps-value mono">' + escapeHtml(c.sample ?? "-") + '</span></div>' +
        '<div class="prof-stat full"><span class="ps-label">Min / Max</span><span class="ps-value mono">' + escapeHtml(c.min ?? "-") + '  →  ' + escapeHtml(c.max ?? "-") + '</span></div>' +
      '</div>' +
      ((c.topValues || []).length ? '<div class="prof-topvals"><div class="ptv-title">Top Values</div>' + topValuesHTML + '</div>' : '') +
    '</div></div>'
  );
}

