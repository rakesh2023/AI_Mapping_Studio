/* =========================================================================
   source-data-filter.js — Source Data › Source Data Filter.
   Prepares filtered legacy→prestage extraction SQL. The user picks a source
   (its tables/columns were AI-extracted from a DDL/PDF/dictionary, or read
   live from SQL Server), a main table + key column, a target dialect, and a
   population (specific key values OR a plain-English condition + optional cap).
   AI infers the join relationships + the condition predicate; the server
   assembles one read-only SELECT per table, all filtered to the same
   population. Endpoint:  POST /api/ai/source-filter-sql
   ========================================================================= */

let sdfSchema = null;      // normalized {tables:[{name, columns:[{name,dataType,pk,fk}]}]}
let sdfConn = null;        // the selected source connection object
let sdfMode = "keys";      // "keys" | "condition"
let sdfQueries = [];       // last generated [{table, sql, joinSql, note}]
let sdfAbort = null;       // AbortController for the in-flight request

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("source-data-filter.html");
  wireSdf();
  populateSources();
  loadVersions({renderLatest: true});   // show the last saved version's queries (if any)
});

function wireSdf(){
  document.getElementById("sdfSource").addEventListener("change", onSourceChange);
  document.getElementById("sdfTable").addEventListener("change", onTableChange);
  document.getElementById("sdfKey").addEventListener("change", refreshGenerateState);
  document.getElementById("sdfGenerateBtn").addEventListener("click", generateSdf);
  document.getElementById("sdfCancelBtn").addEventListener("click", () => { if(sdfAbort) sdfAbort.abort(); });
  document.getElementById("sdfCopyAllBtn").addEventListener("click", copyAllSdf);
  document.getElementById("sdfDownloadBtn").addEventListener("click", downloadSdf);
  document.querySelectorAll(".sdf-modebtn").forEach(b =>
    b.addEventListener("click", () => setSdfMode(b.getAttribute("data-mode"))));
  document.getElementById("sdfConsoleHdr").addEventListener("click", () => toggleSdfConsole());
  // Fullscreen editor: live-sync edits back to the source card + copy.
  const exArea = document.getElementById("sdfExpandArea");
  if(exArea) exArea.addEventListener("input", () => {
    if(_sdfExpandIdx === null) return;
    const src = document.getElementById("sdfSql_" + _sdfExpandIdx);
    if(src) src.value = exArea.value;
  });
  const exCopy = document.getElementById("sdfExpandCopyBtn");
  if(exCopy) exCopy.addEventListener("click", () => { if(exArea && exArea.value) copyText(exArea.value, "Query copied."); });
  const saveV = document.getElementById("sdfSaveVersionBtn");
  if(saveV) saveV.addEventListener("click", saveSdfVersion);
  const vsel = document.getElementById("sdfVersionSelect");
  if(vsel) vsel.addEventListener("change", () => { if(vsel.value) renderVersion(vsel.value); });
  const vdel = document.getElementById("sdfDeleteVersionBtn");
  if(vdel) vdel.addEventListener("click", deleteSelectedVersion);
  document.getElementById("sdfUseControl").addEventListener("change", updateControlUi);
  updateControlUi();
}

/* Control table on → show the control-table name + load fields. The Population inputs stay
   visible: the key values / condition entered there seed the control table's INSERTs. */
function updateControlUi(){
  const on = document.getElementById("sdfUseControl").checked;
  const show = el => { const e = document.getElementById(el); if(e) e.style.display = ""; };
  const hide = el => { const e = document.getElementById(el); if(e) e.style.display = "none"; };
  (on ? show : hide)("sdfControlNameWrap");
  (on ? show : hide)("sdfControlHint");
  if(on) applyDefaultControlName();
}

// Suggest CTL_<MAIN>_KEYS for the control table name (only when the field is empty).
function applyDefaultControlName(){
  const inp = document.getElementById("sdfControlName");
  const table = document.getElementById("sdfTable").value;
  if(inp && !inp.value.trim() && table){
    inp.value = "CTL_" + table.replace(/[^A-Za-z0-9_]/g, "") + "_KEYS";
  }
}

/* ---------- source picker ---------- */
function isFsSource(conn){ return ((conn && conn.type) || "").toLowerCase() === "file system"; }

function populateSources(){
  const sel = document.getElementById("sdfSource");
  const conns = getDbConnections();
  if(!conns.length){
    sel.innerHTML = '<option value="">No sources — add one on Source Systems</option>';
    sel.disabled = true;
    document.getElementById("sdfSchemaInfo").innerHTML =
      '<i class="bi bi-exclamation-triangle text-warning me-1"></i> No source configured yet. Add one on <a href="source-systems.html">Source Systems</a>.';
    return;
  }
  sel.innerHTML = '<option value="">Select a source…</option>' + conns.map(c =>
    '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name || c.id) +
    ' (' + escapeHtml(c.type || "?") + ')</option>').join("");
}

async function onSourceChange(){
  resetResult();
  sdfSchema = null; sdfConn = null;
  const id = document.getElementById("sdfSource").value;
  const tableSel = document.getElementById("sdfTable");
  const keySel = document.getElementById("sdfKey");
  tableSel.innerHTML = '<option value="">—</option>'; tableSel.disabled = true;
  keySel.innerHTML = '<option value="">—</option>'; keySel.disabled = true;
  const info = document.getElementById("sdfSchemaInfo");
  refreshGenerateState();
  if(!id){ info.textContent = ""; return; }

  sdfConn = getDbConnection(id);
  if(!sdfConn){ info.textContent = ""; return; }
  info.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Reading schema for ' + escapeHtml(sdfConn.name || id) + '…';

  try{
    sdfSchema = await loadSourceSchema(sdfConn);
  }catch(e){ sdfSchema = null; }

  const tables = (sdfSchema && sdfSchema.tables) || [];
  if(!tables.length){
    info.innerHTML = '<i class="bi bi-exclamation-triangle text-warning me-1"></i> This source has no extracted tables. ' +
      (isFsSource(sdfConn) ? 'Re-extract it on <a href="source-systems.html">Source Systems</a>.' : 'Could not read its metadata.');
    return;
  }
  info.innerHTML = '<i class="bi bi-hdd-network text-primary me-1"></i> <b>' + tables.length + '</b> tables loaded from ' +
    escapeHtml(sdfConn.name || id) + (isFsSource(sdfConn) ? ' (file-extracted schema).' : ' (live metadata).');
  tableSel.innerHTML = '<option value="">Select a table…</option>' +
    tables.map(t => '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</option>').join("");
  tableSel.disabled = false;
}

/* Load + normalize a source's schema. File System → connection.tables; SQL Server → live metadata. */
async function loadSourceSchema(conn){
  if(isFsSource(conn)){
    return {tables: (conn.tables || []).map(t => ({name: t.name, columns: t.columns || []}))};
  }
  // SQL Server: read live metadata (needs a password for non-trusted connections).
  const cfg = {
    driver: conn.driver || "ODBC Driver 17 for SQL Server",
    server: conn.server || conn.host || "",
    database: conn.database || conn.db || "",
    schema: conn.schema || null,
    trusted: !!conn.trusted,
    username: conn.username || "",
    password: ""
  };
  if(!cfg.server || !cfg.database){
    showNotification("'" + (conn.name || "source") + "' has no server/database. Edit it on Source Systems.", "warning");
    return {tables: []};
  }
  const pw = await ensureConnPassword(conn);
  if(pw === null) return {tables: []};   // cancelled
  cfg.password = pw;
  const res = await fetch("/api/db/metadata", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(cfg)});
  const data = await res.json().catch(() => ({}));
  if(!data.ok){
    showNotification("Could not read metadata: " + (data.error || ""), "danger");
    return {tables: []};
  }
  return {tables: (data.tables || []).map(t => ({name: t.name, columns: t.columns || []}))};
}

function onTableChange(){
  resetResult();
  const keySel = document.getElementById("sdfKey");
  const tname = document.getElementById("sdfTable").value;
  const tbl = ((sdfSchema && sdfSchema.tables) || []).find(t => t.name === tname);
  const cols = (tbl && tbl.columns) || [];
  if(!cols.length){ keySel.innerHTML = '<option value="">—</option>'; keySel.disabled = true; refreshGenerateState(); return; }
  keySel.innerHTML = cols.map(c => '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) +
    (c.pk ? " (PK)" : c.fk ? " (FK)" : "") + '</option>').join("");
  keySel.disabled = false;
  keySel.value = guessKeyColumn(cols);
  // refresh the suggested control-table name for the newly chosen main table
  const cn = document.getElementById("sdfControlName");
  if(cn) cn.value = "";
  if(document.getElementById("sdfUseControl").checked) applyDefaultControlName();
  refreshGenerateState();
}

// Prefer a PK, else a *number/*no/*id column, else the first column.
function guessKeyColumn(cols){
  const pk = cols.find(c => c.pk);
  if(pk) return pk.name;
  const byName = cols.find(c => /(number|^no$|no$|id)$/i.test(c.name || ""));
  return (byName || cols[0]).name;
}

function setSdfMode(mode){
  sdfMode = (mode === "condition") ? "condition" : "keys";
  document.querySelectorAll(".sdf-modebtn").forEach(b =>
    b.classList.toggle("active", b.getAttribute("data-mode") === sdfMode));
  document.getElementById("sdfKeysWrap").style.display = sdfMode === "keys" ? "" : "none";
  document.getElementById("sdfCondWrap").style.display = sdfMode === "condition" ? "" : "none";
}

function refreshGenerateState(){
  const ok = !!(document.getElementById("sdfSource").value &&
                document.getElementById("sdfTable").value &&
                document.getElementById("sdfKey").value);
  document.getElementById("sdfGenerateBtn").disabled = !ok;
}

function resetResult(){
  sdfQueries = [];
  const r = document.getElementById("sdfResult"); if(r) r.style.display = "none";
  const q = document.getElementById("sdfQueries"); if(q) q.innerHTML = "";
  const u = document.getElementById("sdfUnrelated"); if(u) u.innerHTML = "";
}

/* ---------- AI Processing Console ---------- */
function sdfLog(text, kind){
  const el = document.getElementById("sdfConsole");
  if(!el) return null;
  const line = document.createElement("div");
  line.className = "log-line" + (kind === "done" ? " done" : kind === "error" ? " error" : "");
  const icon = kind === "done" ? "bi-check-circle-fill" : kind === "error" ? "bi-x-circle-fill"
             : kind === "run" ? "bi-arrow-repeat" : "bi-info-circle";
  line.innerHTML = '<i class="bi ' + icon + '"></i> ' + escapeHtml(text);
  el.appendChild(line); el.scrollTop = el.scrollHeight;
  return line;
}
function sdfDone(line, text){
  if(!line) return;
  line.className = "log-line done";
  line.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(text);
}
function toggleSdfConsole(force){
  const log = document.getElementById("sdfConsole");
  const chev = document.getElementById("sdfConsoleChev");
  if(!log) return;
  const collapse = (typeof force === "boolean") ? force : (log.style.display !== "none");
  log.style.display = collapse ? "none" : "";
  if(chev) chev.className = "bi ms-auto " + (collapse ? "bi-chevron-down" : "bi-chevron-up");
}
function setSdfConsoleStatus(html){
  const s = document.getElementById("sdfConsoleStatus");
  if(s) s.innerHTML = html || "";
}

/* ---------- generate ---------- */
function parseKeyValues(raw){
  return (raw || "").split(/[\n,]/).map(s => s.trim()).filter(s => s !== "");
}

async function generateSdf(){
  const table = document.getElementById("sdfTable").value;
  const key = document.getElementById("sdfKey").value;
  const dialect = document.getElementById("sdfDialect").value;
  if(!sdfSchema || !table || !key){ showNotification("Pick a source, main table and key column.", "warning"); return; }

  const useControl = document.getElementById("sdfUseControl").checked;
  const body = {
    sourceName: (sdfConn && sdfConn.name) || "",
    schema: sdfSchema,
    mainTable: table,
    keyColumn: key,
    dialect: dialect,
    mode: sdfMode,
    useControlTable: useControl,
    controlTable: (document.getElementById("sdfControlName").value || "").trim(),
    loadName: (document.getElementById("sdfLoadName").value || "").trim()
  };
  // The Population (key values / condition) is used either way: without a control table it filters
  // inline; WITH a control table it seeds the control table's INSERTs. It's required normally, and
  // optional when a control table is used (leave it blank to get a populate template you fill in).
  if(sdfMode === "keys"){
    const keyValues = parseKeyValues(document.getElementById("sdfKeyValues").value);
    if(!keyValues.length && !useControl){ showNotification("Paste at least one key value, or switch to a condition.", "warning"); return; }
    if(keyValues.length) body.keyValues = keyValues;
  } else {
    const condition = (document.getElementById("sdfCondition").value || "").trim();
    const rowCap = parseInt(document.getElementById("sdfRowCap").value, 10);
    if(!condition && !(rowCap > 0) && !useControl){ showNotification("Describe a condition or set a row cap.", "warning"); return; }
    if(condition) body.condition = condition;
    if(rowCap > 0) body.rowCap = rowCap;
  }

  const btn = document.getElementById("sdfGenerateBtn");
  const cancelBtn = document.getElementById("sdfCancelBtn");
  const orig = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…';
  sdfAbort = new AbortController();
  if(cancelBtn) cancelBtn.style.display = "";

  const con = document.getElementById("sdfConsoleWrap");
  if(con) con.style.display = "";
  document.getElementById("sdfConsole").innerHTML = "";
  toggleSdfConsole(false);
  setSdfConsoleStatus("");
  const nT = (sdfSchema.tables || []).length;
  sdfLog("Reading your request…", "done");
  sdfLog("Grounding on " + ((sdfConn && sdfConn.name) || "source") + " (" + nT + " tables) — anchored on " + table + "." + key + ".", "done");
  sdfLog((sdfMode === "keys" ? "Population: specific key values" : "Population: condition") +
        (useControl ? " → seeds the control table INSERTs; extracts INNER JOIN it." : "."), "done");
  const running = sdfLog("Inferring join relationships with AI…", "run");

  try{
    const res = await fetch("/api/ai/source-filter-sql", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(body), signal: sdfAbort.signal});
    // Read the body defensively: on a 500/proxy error it may be HTML, not JSON.
    const rawText = await res.text();
    let j = {};
    try{ j = rawText ? JSON.parse(rawText) : {}; }catch(_){ j = {}; }
    if(!res.ok || !j.ok){
      const msg = (j && j.error) ||
        (res.ok ? "Could not generate SQL." : ("Server error (HTTP " + res.status + "). " +
          (rawText ? rawText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : "")));
      if(running){ running.className = "log-line error"; running.innerHTML = '<i class="bi bi-x-circle-fill"></i> Generation failed.'; }
      sdfLog(msg, "error");
      setSdfConsoleStatus('<span class="text-danger">Failed</span>');
      toggleSdfConsole(false);
      showNotification(msg, "danger", 6000);
      return;
    }
    sdfDone(running, "Join relationships inferred by AI.");
    if(j.useControlTable && j.controlTable) sdfLog("Control table: " + j.controlTable + " (Load_Name = " + (j.loadName || "LOAD_1") + ") — CREATE + populate scripts included; every extract INNER JOINs it.", "done");
    if(j.keyPredicate) sdfLog("Main-table filter: " + j.keyPredicate, "done");
    const grounded = j.grounded || [];
    if(grounded.length) sdfLog("Extracted from tables: " + grounded.join(", "), "done");
    sdfLog("Assembled " + (j.queries || []).length + " per-table extraction " +
           ((j.queries || []).length === 1 ? "query" : "queries") + ".", "done");
    sdfLog("Done.", "done");
    setSdfConsoleStatus('<span class="text-success">✓ Done</span>');
    toggleSdfConsole(true);

    sdfQueries = j.queries || [];
    // Remember the metadata for this result so a manual Save records it with the queries.
    sdfLast = {
      sourceName: body.sourceName || "", mainTable: body.mainTable || "", keyColumn: body.keyColumn || "",
      dialect: j.dialect || body.dialect || "", mode: body.mode || "",
      useControlTable: !!j.useControlTable, controlTable: j.controlTable || "", loadName: j.loadName || "",
      grounded: j.grounded || [], unrelated: j.unrelated || [], keyPredicate: j.keyPredicate || null
    };
    renderQueries(sdfQueries, j.unrelated || []);
    setSdfVersionInfoText("Not saved yet — edit if needed, then click Save version.");
    updateSdfSaveBtn();
    sdfLog("Ready. Review/edit the queries, then click Save version to store them.", "done");
    showNotification("Extraction SQL generated — review, then Save version.", "success", 2800);
  }catch(e){
    if(e && e.name === "AbortError"){
      if(running){ running.className = "log-line"; running.innerHTML = '<i class="bi bi-slash-circle"></i> Generation cancelled.'; }
      sdfLog("Cancelled by user.", "done");
      setSdfConsoleStatus('<span class="text-muted-2">Cancelled</span>');
      showNotification("Generation cancelled.", "warning", 2000);
    } else {
      if(running){ running.className = "log-line error"; running.innerHTML = '<i class="bi bi-x-circle-fill"></i> Backend not reachable.'; }
      showNotification("Backend not reachable.", "danger");
    }
  }finally{
    btn.disabled = false; btn.innerHTML = orig;
    if(cancelBtn) cancelBtn.style.display = "none";
    sdfAbort = null;
  }
}

function renderQueries(queries, unrelated){
  const wrap = document.getElementById("sdfQueries");
  const un = document.getElementById("sdfUnrelated");
  un.innerHTML = (unrelated && unrelated.length)
    ? '<div class="text-xs text-muted-2"><i class="bi bi-info-circle me-1"></i>Not related to the main table (skipped): ' +
        unrelated.map(t => '<span class="sdf-chip">' + escapeHtml(t) + '</span>').join("") + '</div>'
    : "";
  wrap.innerHTML = queries.map((q, i) =>
    '<div class="sdf-qcard">' +
      '<div class="sdf-qhead">' +
        '<span class="sdf-qname"><i class="bi bi-table me-1"></i>' + escapeHtml(q.table) +
          (q.note ? ' <span class="text-xs text-muted-2 fw-normal">— ' + escapeHtml(q.note) + '</span>' : '') + '</span>' +
        '<span class="d-flex gap-1">' +
          '<button type="button" class="btn btn-sm btn-outline-soft" data-expand="' + i + '" title="Expand (fullscreen)"><i class="bi bi-arrows-fullscreen"></i></button>' +
          '<button type="button" class="btn btn-sm btn-outline-soft" data-copy="' + i + '"><i class="bi bi-clipboard me-1"></i>Copy</button>' +
        '</span>' +
      '</div>' +
      '<textarea class="sdf-sql" id="sdfSql_' + i + '" spellcheck="false"></textarea>' +
    '</div>').join("");
  // Set textarea values (avoid HTML-escaping issues) + wire per-card Copy / Expand.
  queries.forEach((q, i) => {
    const ta = document.getElementById("sdfSql_" + i);
    if(ta) ta.value = q.sql || "";
  });
  wrap.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => {
    const ta = document.getElementById("sdfSql_" + b.getAttribute("data-copy"));
    if(ta) copyText(ta.value, "Query copied.");
  }));
  wrap.querySelectorAll("[data-expand]").forEach(b => b.addEventListener("click", () => {
    openSdfExpand(b.getAttribute("data-expand"), (queries[b.getAttribute("data-expand")] || {}).table || "");
  }));
  document.getElementById("sdfResult").style.display = "";
}

/* Fullscreen editor for one query card. Edits sync live back to that card's textarea. */
let _sdfExpandIdx = null;
function openSdfExpand(idx, tableName){
  _sdfExpandIdx = idx;
  const src = document.getElementById("sdfSql_" + idx);
  const area = document.getElementById("sdfExpandArea");
  const title = document.getElementById("sdfExpandTitle");
  if(area && src) area.value = src.value || "";
  if(title) title.textContent = tableName ? ("Query — " + tableName) : "Query";
  const modalEl = document.getElementById("sdfExpandModal");
  if(modalEl && typeof bootstrap !== "undefined"){
    new bootstrap.Modal(modalEl).show();
    setTimeout(() => { if(area) area.focus(); }, 250);
  }
}

/* ---------- saved versions (SQLite-backed) ---------- */
let sdfVersions = [];   // [{id, version, mainTable, dialect, ...}] newest first
let sdfLast = null;     // metadata for the currently-displayed query set (for a manual Save)

/* Enable "Save version" whenever there are queries on screen. */
function updateSdfSaveBtn(){
  const btn = document.getElementById("sdfSaveVersionBtn");
  if(btn) btn.disabled = !(sdfQueries && sdfQueries.length);
}
function setSdfVersionInfoText(text){
  const el = document.getElementById("sdfVersionInfo");
  if(el) el.innerHTML = '<i class="bi bi-info-circle me-1"></i> ' + escapeHtml(text);
}

/* Save the current queries (with any edits) as a NEW version. Captures every query's edited SQL
   from its textarea, plus the metadata of the displayed set. */
async function saveSdfVersion(){
  if(!sdfQueries || !sdfQueries.length){ showNotification("Nothing to save — generate the extraction SQL first.", "warning"); return; }
  const m = sdfLast || {};
  const queries = sdfQueries.map((q, i) => {
    const ta = document.getElementById("sdfSql_" + i);
    return { table: q.table, sql: ta ? ta.value : (q.sql || ""), joinSql: q.joinSql || "", note: q.note || "" };
  });
  const payload = {
    sourceName: m.sourceName || "", mainTable: m.mainTable || "", keyColumn: m.keyColumn || "",
    dialect: m.dialect || "", mode: m.mode || "", useControlTable: !!m.useControlTable,
    controlTable: m.controlTable || "", loadName: m.loadName || "",
    grounded: m.grounded || [], unrelated: m.unrelated || [], keyPredicate: m.keyPredicate || null,
    queries: queries
  };
  const btn = document.getElementById("sdfSaveVersionBtn");
  if(btn) btn.disabled = true;
  try{
    const res = await fetch("/api/ai/source-filter/versions", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Save failed.", "danger"); return; }
    showNotification("Saved as version " + j.version + ".", "success", 2600);
    await loadVersions({selectId: j.id});
  }catch(e){ showNotification("Cannot reach the server — not saved.", "danger"); }
  finally{ updateSdfSaveBtn(); }
}

function _fmtWhen(iso){
  try{ const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(); }catch(e){ return ""; }
}
function versionOptionLabel(v){ return "v" + v.version; }

/* Fetch the version list into the dropdown. opts.renderLatest → also fetch+render the newest;
   opts.selectId → select that version id without re-fetching (used right after a generate, whose
   queries are already on screen). */
async function loadVersions(opts){
  opts = opts || {};
  const sel = document.getElementById("sdfVersionSelect");
  if(!sel) return;
  try{
    const res = await fetch("/api/ai/source-filter/versions", {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    sdfVersions = (j && j.ok) ? (j.versions || []) : [];
  }catch(e){ sdfVersions = []; }

  if(!sdfVersions.length){ sel.innerHTML = '<option value="">No saved versions yet</option>'; return; }
  sel.innerHTML = sdfVersions.map(v =>
    '<option value="' + v.id + '">' + escapeHtml(versionOptionLabel(v)) + '</option>').join("");

  if(opts.selectId){
    sel.value = String(opts.selectId);
    const v = sdfVersions.find(x => String(x.id) === String(opts.selectId));
    if(v) setVersionInfo(v, true);
  } else if(opts.renderLatest){
    sel.value = String(sdfVersions[0].id);
    renderVersion(sdfVersions[0].id);
  }
}

function setVersionInfo(v, isLatest){
  const el = document.getElementById("sdfVersionInfo");
  if(!el || !v) return;
  const parts = ["Version " + v.version + (isLatest ? " (latest)" : "")];
  if(v.sourceName) parts.push("source " + v.sourceName);
  if(v.mainTable) parts.push("anchored on " + v.mainTable + (v.keyColumn ? "." + v.keyColumn : ""));
  if(v.useControlTable && v.controlTable) parts.push("control table " + v.controlTable + (v.loadName ? " / " + v.loadName : ""));
  if(v.dialect) parts.push(v.dialect);
  const when = _fmtWhen(v.createdAt);
  if(when) parts.push("saved " + when);
  el.innerHTML = '<i class="bi bi-clock-history me-1"></i> ' + escapeHtml(parts.join(" · "));
}

/* Load a saved version by id and display all its queries. */
async function renderVersion(id){
  try{
    const res = await fetch("/api/ai/source-filter/versions/" + encodeURIComponent(id), {headers:{Accept:"application/json"}});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok || !j.version){ showNotification((j && j.error) || "Could not load that version.", "danger"); return; }
    const v = j.version;
    sdfQueries = v.queries || [];
    sdfLast = {
      sourceName: v.sourceName || "", mainTable: v.mainTable || "", keyColumn: v.keyColumn || "",
      dialect: v.dialect || "", mode: v.mode || "", useControlTable: !!v.useControlTable,
      controlTable: v.controlTable || "", loadName: v.loadName || "",
      grounded: v.grounded || [], unrelated: v.unrelated || [], keyPredicate: v.keyPredicate || null
    };
    renderQueries(sdfQueries, v.unrelated || []);
    updateSdfSaveBtn();
    const sel = document.getElementById("sdfVersionSelect");
    if(sel) sel.value = String(v.id);
    setVersionInfo(v, sdfVersions.length ? String(sdfVersions[0].id) === String(v.id) : false);
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}

/* Delete the version currently selected in the dropdown. */
async function deleteSelectedVersion(){
  const sel = document.getElementById("sdfVersionSelect");
  const id = sel && sel.value;
  if(!id){ showNotification("No version selected.", "warning"); return; }
  const v = sdfVersions.find(x => String(x.id) === String(id));
  const label = v ? ("version " + v.version) : "this version";
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Delete <b>" + escapeHtml(label) + "</b>? This removes its saved queries permanently.", "Delete version")
    : window.confirm("Delete " + label + "? This cannot be undone.");
  if(!ok) return;
  try{
    const res = await fetch("/api/ai/source-filter/versions/" + encodeURIComponent(id), {method:"DELETE"});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Delete failed.", "danger"); return; }
    showNotification("Deleted " + label + ".", "primary", 1800);
    await loadVersions({renderLatest: true});
    // Nothing left → clear the results view.
    if(!sdfVersions.length){
      sdfQueries = [];
      const r = document.getElementById("sdfResult"); if(r) r.style.display = "none";
      const q = document.getElementById("sdfQueries"); if(q) q.innerHTML = "";
      const info = document.getElementById("sdfVersionInfo"); if(info) info.innerHTML = "";
    }
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}

// Read the (possibly edited) SQL from every textarea, joined with blank lines.
function collectSql(){
  return sdfQueries.map((q, i) => {
    const ta = document.getElementById("sdfSql_" + i);
    return ta ? ta.value : q.sql;
  }).join("\n\n");
}

function copyText(text, okMsg){
  if(!text) return;
  navigator.clipboard.writeText(text)
    .then(() => showNotification(okMsg || "Copied.", "success", 1500))
    .catch(() => showNotification("Could not copy to clipboard.", "danger"));
}

function copyAllSdf(){ copyText(collectSql(), "All queries copied."); }

function downloadSdf(){
  const sql = collectSql();
  if(!sql) return;
  const blob = new Blob([sql], {type: "text/sql"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "source_extract.sql";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
