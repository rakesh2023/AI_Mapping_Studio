/* =========================================================================
   common.js
   Shared shell, notification, storage and utility helpers used across all
   pages of AI Mapping Studio.
   ========================================================================= */

const DATA_BASE = "../data/";

const SIDEBAR_SECTIONS = [
  {title:"", items:[
    {label:"Dashboard", icon:"bi-speedometer2", href:"dashboard.html"}
  ]},
  {title:"Setup", items:[
    {label:"Project Setup", icon:"bi-kanban", href:"project-setup.html"},
    {label:"Source Systems", icon:"bi-database", href:"source-systems.html"},
    {label:"Target System", icon:"bi-hdd-network", href:"target-system.html"}
  ]},
  {title:"Discover", items:[
    {label:"Metadata Explorer", icon:"bi-diagram-3", href:"metadata-explorer.html"},
    {label:"Data Profiling", icon:"bi-bar-chart-line", href:"data-profiling.html"}
  ]},
  {title:"Mapping", items:[
    {label:"AI Mapping Generator", icon:"bi-stars", href:"ai-mapping-generator.html"},
    {label:"Mapping Workspace", icon:"bi-grid-3x3-gap", href:"mapping-workspace.html"},
    {label:"Validation", icon:"bi-shield-check", href:"validation.html"}
  ]},
  {title:"Build", items:[
    {label:"ETL Code (SQL)", icon:"bi-file-earmark-code", href:"etl-code.html"}
  ]},
  {title:"Deliver", items:[
    {label:"Mapping History", icon:"bi-clock-history", href:"mapping-history.html"},
    {label:"Export", icon:"bi-download", href:"export.html"},
    {label:"Settings", icon:"bi-gear", href:"settings.html"}
  ]},
  {title:"Reports", items:[
    {label:"AI Usage Report", icon:"bi-graph-up", href:"ai-usage-report.html"}
  ]},
  {title:"Help", items:[
    {label:"Introduction", icon:"bi-info-circle", href:"introduction.html"}
  ]}
];

const WORKFLOW_STEPS = [
  "Project Creation","Source Configuration","Source Connection","File Upload",
  "Metadata Discovery","Source Profiling","Target Configuration","Target Metadata",
  "AI Mapping Generation","Mapping Review","Prompt Refinement","Validation",
  "ETL Code Generation","Approval","Export"
];

async function fetchJSON(fileName){
  try{
    const res = await fetch(DATA_BASE + fileName, {cache:"no-store"});
    if(!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }catch(err){
    console.error("fetchJSON failed for " + fileName, err);
    showNotification("Unable to load data file: " + fileName, "danger");
    return null;
  }
}

const LS_KEYS = {
  sidebar: "aims_sidebar_collapsed",
  project: "aims_current_project",
  overrides: "aims_mapping_overrides",
  settings: "aims_settings",
  filters: "aims_filter_prefs",
  scope: "aims_mapping_scope",
  history: "aims_mapping_history"
};

/* ---- Per-client data now lives server-side (multi-tenant), scoped by the
   logged-in user + active client. These 13 stores are routed through an in-memory
   CLIENT_STATE cache (hydrated once per page from GET /api/state) so existing
   synchronous lsGet/lsSet callers keep working unchanged; writes are debounced to
   PUT /api/state/<key>. Everything else (device/UI prefs) stays in localStorage. */
const TENANT_DOC_KEYS = ["current_project","db_connections","target_connections",
  "active_target","target_schema","ai_mappings","ai_joins","mapping_overrides",
  "mapping_history","deploy_history","exports","business_context","etl_instructions"];
const TENANT_LS = {};                                  // "aims_ai_mappings" -> "ai_mappings"
TENANT_DOC_KEYS.forEach(k => { TENANT_LS["aims_" + k] = k; });
function isTenantKey(key){ return Object.prototype.hasOwnProperty.call(TENANT_LS, key); }

let CLIENT_STATE = {};                                 // doc_key -> value
let CLIENT_STATE_READY = false;
const _pendingWrites = {};                             // doc_key -> setTimeout id

async function hydrateClientState(){
  try{
    const res = await fetch("/api/state", {headers:{"Accept":"application/json"}});
    if(res.ok){ const j = await res.json(); CLIENT_STATE = (j && j.state) ? j.state : {}; }
    else { CLIENT_STATE = {}; }
  }catch(e){ CLIENT_STATE = {}; }
  CLIENT_STATE_READY = true;
}
function clientGet(docKey, fallback){
  const v = CLIENT_STATE[docKey];
  return (v === undefined || v === null) ? fallback : v;
}
function clientSet(docKey, value){
  CLIENT_STATE[docKey] = value;
  if(_pendingWrites[docKey]) clearTimeout(_pendingWrites[docKey]);
  _pendingWrites[docKey] = setTimeout(() => _flushClientWrite(docKey), 300);
}
function clientRemove(docKey){ CLIENT_STATE[docKey] = null; clientSet(docKey, null); }
function _flushClientWrite(docKey, keepalive){
  if(_pendingWrites[docKey]){ clearTimeout(_pendingWrites[docKey]); delete _pendingWrites[docKey]; }
  const opts = {method:"PUT", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({value: CLIENT_STATE[docKey]})};
  if(keepalive) opts.keepalive = true;   // let the write survive page navigation/unload
  try{ fetch("/api/state/" + encodeURIComponent(docKey), opts).catch(()=>{}); }catch(e){}
}
function _flushAllPending(){ Object.keys(_pendingWrites).forEach(k => _flushClientWrite(k, true)); }
if(typeof window !== "undefined"){
  window.addEventListener("pagehide", _flushAllPending);
  document.addEventListener("visibilitychange", () => { if(document.visibilityState === "hidden") _flushAllPending(); });
}

function lsGet(key, fallback){
  if(isTenantKey(key)) return clientGet(TENANT_LS[key], fallback);
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}
function lsSet(key, value){
  if(isTenantKey(key)){ clientSet(TENANT_LS[key], value); return; }
  try{
    localStorage.setItem(key, JSON.stringify(value));
  }catch(e){
    // Most commonly a QuotaExceededError when a large schema/mapping set is stored.
    // Surface it instead of failing silently so callers can react.
    console.error("lsSet failed for " + key, e);
    throw new Error("Browser storage is full — could not save '" + key + "'. " +
      "The data set may be too large for localStorage (~5MB). Try a smaller target/source, or clear old data.");
  }
}
// Tenant-aware remove: server-backed keys are cleared server-side; others hit localStorage.
function lsRemove(key){
  if(isTenantKey(key)){ clientRemove(TENANT_LS[key]); return; }
  try{ localStorage.removeItem(key); }catch(e){}
}

function getMappingOverrides(){ return lsGet(LS_KEYS.overrides, {}); }
function saveMappingOverride(id, changes){
  const all = getMappingOverrides();
  all[id] = Object.assign({}, all[id] || {}, changes);
  lsSet(LS_KEYS.overrides, all);
}
function clearMappingOverrides(){ lsRemove(LS_KEYS.overrides); }

function applyOverrides(mappings){
  const overrides = getMappingOverrides();
  return mappings.map(m => overrides[m.id] ? Object.assign({}, m, overrides[m.id]) : m);
}

const DEFAULT_SETTINGS = {
  highConfidence: 90,
  mediumConfidence: 70,
  aiModel: "AIMS-Mock-LLM-v1 (simulated)",
  mappingStrategy: "Balanced",
  dateFormat: "YYYY-MM-DD",
  theme: "Enterprise Light"
};
function getSettings(){ return lsGet(LS_KEYS.settings, DEFAULT_SETTINGS); }
function saveSettings(settings){ lsSet(LS_KEYS.settings, settings); }

/* ---- Theme (dark / light), shared app-wide ---- */
function getTheme(){ return getSettings().theme === "dark" ? "dark" : "light"; }
function applyTheme(theme){
  if(document.body) document.body.classList.toggle("theme-dark", theme === "dark");
}
function setTheme(theme){
  const s = getSettings(); s.theme = theme; saveSettings(s);
  applyTheme(theme);
}
// Apply immediately so pages don't flash light before initShell runs.
if(typeof document !== "undefined"){
  if(document.body){ applyTheme(getTheme()); }
  else { document.addEventListener("DOMContentLoaded", () => applyTheme(getTheme()), {once:true}); }
}

/* ---- Reset: clear data for the LOGGED-IN USER + SELECTED CLIENT only ---- */
async function resetApplication(){
  const who = activeClientName() || "the current client";
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Reset all data for " + who + "? This permanently clears THIS client's "
        + "source & target connections, uploaded schema, generated mappings, join conditions, history "
        + "and generated outputs. Your other clients and your device preferences (theme, layout) are "
        + "NOT affected. This cannot be undone.", "Reset " + who)
    : window.confirm("Reset all data for " + who + "? This clears this client's data only and cannot be undone.");
  if(!ok) return;
  // Server-side clear is scoped to session user_id + active client_id (see /api/state DELETE),
  // so no other user or client is touched. Re-store the mapping document as explicitly EMPTY ([])
  // so the workspace/dashboard/history/validation don't fall back to the bundled sample data.
  try{
    await fetch("/api/state", {method:"DELETE"}).catch(()=>{});
    await fetch("/api/state/ai_mappings", {method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({value: []})}).catch(()=>{});
  }catch(e){ /* ignore */ }
  // Only reset THIS client's in-memory cache. Device/UI prefs in localStorage are left intact.
  CLIENT_STATE = {ai_mappings: []};
  RUNTIME_PW && Object.keys(RUNTIME_PW).forEach(k => delete RUNTIME_PW[k]);   // drop cached passwords
  if(typeof showNotification === "function") showNotification(who + " data reset. Reloading…", "primary", 1500);
  setTimeout(() => { window.location.href = "dashboard.html"; }, 700);
}

/* ---- Streamed AI file extraction with progress ----
   Streams NDJSON events from /api/ai/extract-source-stream and calls onEvent for each
   ({type:'start'|'progress'|'done'|'error', ...}). Resolves with the 'done' payload
   (or throws on error). Falls back to the non-streaming endpoint if streaming fails. */
async function streamExtractFile(file, onEvent){
  // Non-streaming extraction (reliable; no progress). Used as a fallback if streaming
  // isn't available or the stream connection drops mid-way on a very large file.
  async function nonStreaming(){
    const f = new FormData(); f.append("file", file);
    const r = await fetch("/api/ai/extract-source", {method:"POST", body:f});
    let out; try{ out = await r.json(); }catch(e){ out = {ok:false, error:"Server returned an invalid response (HTTP " + r.status + ")."}; }
    if(!out.ok) throw new Error(out.error || "Extraction failed.");
    if(onEvent) onEvent({type:"done", ...out});
    return out;
  }

  let res;
  try{
    res = await fetch("/api/ai/extract-source-stream", {method:"POST", body:(function(){const f=new FormData();f.append("file",file);return f;})()});
  }catch(e){
    // couldn't even open the stream — try the plain endpoint before giving up
    try{ return await nonStreaming(); }
    catch(e2){ throw new Error("Backend not reachable. Start it with python server/app.py."); }
  }
  if(!res.ok || !res.body){
    return await nonStreaming();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", done = null, sawServerError = null;
  try{
    while(true){
      const {value, done: rdDone} = await reader.read();
      if(rdDone) break;
      buf += decoder.decode(value, {stream:true});
      let nl;
      while((nl = buf.indexOf("\n")) !== -1){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if(!line) continue;
        let evt; try{ evt = JSON.parse(line); }catch(e){ continue; }
        if(onEvent) onEvent(evt);
        if(evt.type === "error") sawServerError = evt.error || "Extraction failed.";
        if(evt.type === "done") done = evt;
      }
    }
  }catch(streamErr){
    // Connection dropped mid-stream (e.g. proxy/idle timeout on a big file).
    // Fall back to the non-streaming endpoint rather than failing.
    if(!done){
      try{ return await nonStreaming(); }
      catch(e2){ throw new Error("Extraction connection dropped and the fallback also failed: " + (e2.message || e2)); }
    }
  }
  if(sawServerError && !done) throw new Error(sawServerError);
  if(!done){
    // Stream ended without a result — try the reliable endpoint once.
    return await nonStreaming();
  }
  return done;
}

/* Progress-bar markup for AI file extraction (shared by Source + Target pages). */
function renderExtractProgress(done, total, tables, columns, label, unit){
  const pct = total ? Math.round(done / total * 100) : 0;
  const counts = (tables || columns)
    ? ('<span class="badge-soft badge-high">' + tables + ' tables</span> <span class="badge-soft badge-gray">' + columns + ' columns</span>')
    : '';
  return '<div class="extract-progress">' +
    '<div class="d-flex justify-content-between align-items-center text-xs mb-1">' +
      '<span><span class="spinner-border spinner-border-sm me-2"></span>' +
        (total ? ('Processing ' + done + ' of ' + total + ' ' + (unit || 'parts')) : escapeHtml(label || 'Working…')) + '</span>' +
      '<span>' + pct + '%</span>' +
    '</div>' +
    '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
    (counts ? '<div class="mt-1">' + counts + '</div>' : '') +
    (label && total ? '<div class="text-muted-2 text-xs mt-1 mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(label) + '</div>' : '') +
  '</div>';
}

/* Shared source-database connections (used by Source Systems + Metadata Explorer) */
const LS_DB_CONNECTIONS = "aims_db_connections";
function getDbConnections(){ return lsGet(LS_DB_CONNECTIONS, []); }
function saveDbConnections(list){ lsSet(LS_DB_CONNECTIONS, list); }
function getDbConnection(id){ return getDbConnections().find(c => c.id === id) || null; }
function upsertDbConnection(conn){
  const list = getDbConnections();
  const i = list.findIndex(c => c.id === conn.id);
  if(i !== -1) list[i] = conn; else list.push(conn);
  saveDbConnections(list);
  return conn;
}
function deleteDbConnection(id){ saveDbConnections(getDbConnections().filter(c => c.id !== id)); }

const CURRENT_USER = { name: "Rakesh Sinha", role: "Migration Lead" };
// Populated by initShell() from GET /api/auth/me: {user, clients[], activeClientId}.
let AUTH = null;
function initials(name){
  return (name || "").trim().split(/\s+/).map(w => w[0]).slice(0,2).join("").toUpperCase() || "U";
}
function getCurrentUser(){
  // Prefer the authenticated account; fall back to the Settings profile, then the default.
  if(AUTH && AUTH.user){
    const name = (AUTH.user.name && AUTH.user.name.trim()) || AUTH.user.email || CURRENT_USER.name;
    const role = (AUTH.user.role && AUTH.user.role.trim()) || CURRENT_USER.role;
    return { name: name, role: role, email: AUTH.user.email || "", initials: initials(name) };
  }
  const s = getSettings();
  const name = (s && s.userName && s.userName.trim()) ? s.userName.trim() : CURRENT_USER.name;
  const role = (s && s.userRole && s.userRole.trim()) ? s.userRole.trim() : CURRENT_USER.role;
  return { name: name, role: role, email: "", initials: initials(name) };
}
function activeClientName(){
  if(AUTH && AUTH.clients){ const c = AUTH.clients.find(x => x.id === AUTH.activeClientId); if(c) return c.name; }
  return "";
}
function currentUserName(){ return getCurrentUser().name; }

function getHistory(){ return lsGet(LS_KEYS.history, {}); }
function addHistoryRecord(mappingId, record){
  const all = getHistory();
  if(!all[mappingId]) all[mappingId] = [];
  record.date = new Date().toISOString();
  all[mappingId].unshift(record);
  lsSet(LS_KEYS.history, all);
}
function getHistoryFor(mappingId){
  const all = getHistory();
  return all[mappingId] || [];
}
function removeHistoryFor(mappingId){
  const all = getHistory();
  if(all[mappingId]){ delete all[mappingId]; lsSet(LS_KEYS.history, all); }
}
function getAllHistoryFlat(){
  const all = getHistory();
  let out = [];
  Object.keys(all).forEach(id => {
    all[id].forEach(rec => out.push(Object.assign({mappingId:id}, rec)));
  });
  out.sort((a,b) => new Date(b.date) - new Date(a.date));
  return out;
}

function showNotification(message, type = "primary", timeout = 3800){
  let stack = document.getElementById("toast-stack");
  if(!stack){
    stack = document.createElement("div");
    stack.id = "toast-stack";
    document.body.appendChild(stack);
  }
  const item = document.createElement("div");
  item.className = "toast-item " + (type === "primary" ? "" : type);
  const icons = {success:"bi-check-circle-fill", danger:"bi-x-circle-fill", warning:"bi-exclamation-triangle-fill", primary:"bi-info-circle-fill"};
  item.innerHTML = '<i class="bi ' + (icons[type] || icons.primary) + ' me-2"></i>' + message;
  stack.appendChild(item);
  setTimeout(() => { item.style.opacity = "0"; item.style.transition="opacity .3s"; setTimeout(()=>item.remove(), 300); }, timeout);
}

function confirmDialog(message, confirmLabel = "Confirm"){
  return new Promise(resolve => {
    const id = "confirmModal_" + Date.now();
    const wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="modal fade" id="' + id + '" tabindex="-1">' +
      '<div class="modal-dialog modal-dialog-centered">' +
      '<div class="modal-content">' +
      '<div class="modal-header"><h5 class="modal-title">Please confirm</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
      '<div class="modal-body">' + message + '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn btn-outline-soft" data-bs-dismiss="modal">Cancel</button>' +
      '<button class="btn btn-primary" id="' + id + '_ok">' + confirmLabel + '</button>' +
      '</div></div></div></div>';
    document.body.appendChild(wrap);
    const modalEl = wrap.querySelector(".modal");
    const modal = new bootstrap.Modal(modalEl);
    modalEl.querySelector("#" + id + "_ok").addEventListener("click", () => {
      modal.hide();
      resolve(true);
    });
    modalEl.addEventListener("hidden.bs.modal", () => { wrap.remove(); resolve(false); });
    modal.show();
  });
}

function formatDate(iso){
  if(!iso) return "—";
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", {year:"numeric", month:"short", day:"2-digit"});
}
function formatDateTime(iso){
  if(!iso) return "—";
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleString("en-US", {year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"});
}
function timeAgo(iso){
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if(diff < 60) return "just now";
  if(diff < 3600) return Math.floor(diff/60) + "m ago";
  if(diff < 86400) return Math.floor(diff/3600) + "h ago";
  return Math.floor(diff/86400) + "d ago";
}

function confidenceLevel(score){
  const s = getSettings();
  if(score >= s.highConfidence) return "high";
  if(score >= s.mediumConfidence) return "medium";
  return "low";
}
function confidenceBadge(score){
  const level = confidenceLevel(score);
  const labels = {high:"High Confidence", medium:"Medium Confidence", low:"Low Confidence"};
  return '<span class="badge-soft badge-' + level + '">' + score + '% · ' + labels[level] + '</span>';
}
function confidenceBar(score){
  const level = confidenceLevel(score);
  const colors = {high:"var(--success)", medium:"var(--warning)", low:"var(--danger)"};
  return '<div class="confidence-cell">' +
      '<div class="confidence-bar"><span style="width:' + score + '%;background:' + colors[level] + '"></span></div>' +
      '<span class="text-xs">' + score + '%</span></div>';
}
function statusBadgeClass(status){
  const map = {
    "Approved":"status-approved", "Approved After Modification":"status-approved",
    "Needs Review":"status-review", "In Review":"status-inreview",
    "Rejected":"status-rejected", "AI Generated":"status-aigenerated",
    "Modified by User":"status-modified"
  };
  return map[status] || "badge-gray";
}
function statusBadge(status){
  return '<span class="badge-status ' + statusBadgeClass(status) + '">' + status + '</span>';
}
function severityBadge(sev){
  const map = {Critical:"badge-low", Error:"badge-low", Warning:"badge-medium", Information:"badge-blue"};
  return '<span class="badge-soft ' + (map[sev] || 'badge-gray') + '"><i class="bi bi-exclamation-circle"></i> ' + sev + '</span>';
}

async function loadProject(){
  const cached = lsGet(LS_KEYS.project, null);
  if(cached) return cached;
  const data = await fetchJSON("projects.json");
  if(!data) return null;
  const proj = data.projects.find(p => p.id === data.currentProjectId) || data.projects[0];
  lsSet(LS_KEYS.project, proj);
  return proj;
}
function setCurrentProject(project){ lsSet(LS_KEYS.project, project); }

function buildSidebarHTML(activeHref){
  return '<div class="sidebar-brand">' +
      '<div class="brand-icon">' +
        '<img class="brand-mark mark-light" src="../assets/images/pwc-mark-dark.svg" alt="PwC">' +
        '<img class="brand-mark mark-dark" src="../assets/images/pwc-mark.svg" alt="PwC">' +
      '</div>' +
      '<div class="brand-text"><b>PwC</b><span>AI Mapping Studio</span></div>' +
    '</div>' +
    '<nav class="sidebar-nav">' +
      SIDEBAR_SECTIONS.map(section =>
        (section.title ? '<div class="nav-section-title">' + section.title + '</div>' : '') +
        section.items.map(item =>
          '<div class="nav-item">' +
            '<a class="nav-link ' + (item.href === activeHref ? "active" : "") + '" href="' + item.href + '" title="' + item.label + '">' +
              '<i class="bi ' + item.icon + '"></i><span>' + item.label + '</span>' +
            '</a>' +
          '</div>').join("")
      ).join("") +
    '</nav>' +
    '<div class="sidebar-footer">' +
      '<button class="sidebar-toggle-btn" id="sidebarToggleBtn"><i class="bi bi-layout-sidebar-inset"></i><span id="sidebarToggleLabel">Collapse</span></button>' +
    '</div>';
}

function buildHeaderHTML(){
  const user = getCurrentUser();
  return '<div class="topbar-left">' +
      '<button class="icon-btn d-lg-none" id="mobileNavToggle"><i class="bi bi-list"></i></button>' +
      '<img class="topbar-logo logo-light" src="../assets/images/pwc-logo-dark.svg" alt="PwC">' +
      '<img class="topbar-logo logo-dark" src="../assets/images/pwc-logo.svg" alt="PwC">' +
      '<div class="app-title">AI Mapping Studio<small>Intelligent Source-to-Target Mapping</small></div>' +
    '</div>' +
    '<div class="global-search">' +
      '<i class="bi bi-search"></i>' +
      '<input type="text" id="globalSearchInput" class="form-control" placeholder="Search mappings, tables, rules…">' +
    '</div>' +
    '<div class="topbar-meta">' +
      '<span class="meta-chip ai-ready"><span class="dot"></span> AI Ready</span>' +
      buildClientSwitcherHTML() +
      '<button class="icon-btn" id="themeToggleBtn" title="Toggle dark / light theme"><i class="bi ' + (getTheme()==="dark" ? "bi-sun" : "bi-moon-stars") + '"></i></button>' +
      '<button class="icon-btn" id="resetAppBtn" title="Reset application (clear all data)"><i class="bi bi-arrow-counterclockwise"></i></button>' +
      '<div class="icon-btn" id="notifBtn"><i class="bi bi-bell"></i><span class="badge-dot"></span></div>' +
      '<div class="user-wrap">' +
        '<div class="user-chip" id="userChip" role="button" tabindex="0">' +
          '<div class="user-avatar">' + user.initials + '</div>' +
          '<div class="user-meta d-none d-md-block">' +
            '<div class="user-name">' + escapeHtml(user.name) + '</div>' +
            '<div class="user-role">' + escapeHtml(user.role) + '</div>' +
          '</div>' +
          '<i class="bi bi-chevron-down user-caret"></i>' +
        '</div>' +
        '<div class="user-menu" id="userMenu" style="display:none;">' +
          '<div class="user-menu-head"><div class="user-name">' + escapeHtml(user.name) + '</div>' +
            '<div class="user-email">' + escapeHtml(user.email || "") + '</div></div>' +
          '<button type="button" class="user-menu-item" id="logoutBtn"><i class="bi bi-box-arrow-right me-1"></i> Log out</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

// Header client switcher (only when authenticated with at least one client).
function buildClientSwitcherHTML(){
  if(!AUTH || !AUTH.clients || !AUTH.clients.length) return "";
  const opts = AUTH.clients.map(c =>
    '<option value="' + c.id + '"' + (c.id === AUTH.activeClientId ? " selected" : "") + '>' +
    escapeHtml(c.name) + '</option>').join("");
  return '<div class="client-switch" title="Active client">' +
    '<i class="bi bi-building"></i>' +
    '<select id="clientSwitcher" aria-label="Active client">' + opts +
      '<option disabled>──────────</option>' +
      '<option value="__new__">+ New client…</option>' +
      '<option value="__manage__">⚙ Manage clients…</option>' +
    '</select>' +
  '</div>';
}

/* ---- Client management modal (create / edit / switch) ---- */
function injectClientModal(){
  if(document.getElementById("clientModal")) return;
  const html =
    '<div class="modal fade" id="clientModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered">' +
    '<div class="modal-content"><div class="modal-header">' +
      '<h5 class="modal-title"><i class="bi bi-building me-1"></i> Clients</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
    '<div class="modal-body">' +
      '<div class="hint-note mb-2" id="cmErr" style="display:none;background:var(--danger-bg);color:var(--danger);border-color:#f3c9c6;"></div>' +
      '<div class="section-title mb-1"><i class="bi bi-list-ul"></i> Your clients</div>' +
      '<div id="cmList" class="mb-3"></div><hr>' +
      '<div class="section-title mb-2" id="cmFormTitle"><i class="bi bi-plus-lg"></i> New client</div>' +
      '<input type="hidden" id="cmEditId">' +
      '<div class="form-group"><label>Name <span class="text-danger">*</span></label><input class="form-control" id="cmName" autocomplete="off"></div>' +
      '<div class="form-group"><label>Industry</label><input class="form-control" id="cmIndustry" autocomplete="off"></div>' +
      '<div class="d-flex gap-2 mt-2">' +
        '<button type="button" class="btn btn-primary btn-sm" id="cmSave"><i class="bi bi-check2 me-1"></i> Create client</button>' +
        '<button type="button" class="btn btn-outline-soft btn-sm" id="cmCancelEdit" style="display:none;">Cancel edit</button>' +
      '</div>' +
    '</div></div></div></div>';
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("cmSave").addEventListener("click", saveClientFromModal);
  document.getElementById("cmCancelEdit").addEventListener("click", () => setClientForm(null));
}
function _cmErr(msg){ const e = document.getElementById("cmErr"); if(!e) return; if(msg){ e.textContent = msg; e.style.display = ""; } else { e.style.display = "none"; } }
function setClientForm(client){
  document.getElementById("cmEditId").value = client ? client.id : "";
  document.getElementById("cmName").value = client ? client.name : "";
  document.getElementById("cmIndustry").value = client ? (client.industry || "") : "";
  document.getElementById("cmFormTitle").innerHTML = client
    ? '<i class="bi bi-pencil"></i> Edit client'
    : '<i class="bi bi-plus-lg"></i> New client';
  document.getElementById("cmSave").innerHTML = client
    ? '<i class="bi bi-check2 me-1"></i> Save changes'
    : '<i class="bi bi-check2 me-1"></i> Create client';
  document.getElementById("cmCancelEdit").style.display = client ? "" : "none";
  _cmErr(null);
}
async function renderClientModalList(){
  const el = document.getElementById("cmList");
  let clients = AUTH ? AUTH.clients : [];
  try{
    const res = await fetch("/api/clients", {headers:{"Accept":"application/json"}});
    if(res.ok){ const j = await res.json(); if(j.ok){ clients = j.clients; if(AUTH){ AUTH.clients = j.clients; AUTH.activeClientId = j.activeClientId; } } }
  }catch(e){ /* use cached */ }
  if(!clients.length){ el.innerHTML = '<div class="text-xs text-muted-2">No clients yet.</div>'; return; }
  el.innerHTML = clients.map(c => {
    const active = c.id === (AUTH && AUTH.activeClientId);
    return '<div class="d-flex align-items-center justify-content-between" style="padding:6px 0;border-bottom:1px solid var(--border);">' +
      '<div><div style="font-weight:600;">' + escapeHtml(c.name) +
        (active ? ' <span class="badge-soft badge-high">active</span>' : '') + '</div>' +
        '<div class="text-xs text-muted-2">' + escapeHtml(c.industry || "—") + '</div></div>' +
      '<div class="d-flex gap-2">' +
        (active ? '' : '<button type="button" class="btn btn-sm btn-outline-soft cm-switch" data-id="' + c.id + '">Switch</button>') +
        '<button type="button" class="btn btn-sm btn-outline-soft cm-edit" data-id="' + c.id + '">Edit</button>' +
      '</div></div>';
  }).join("");
  el.querySelectorAll(".cm-switch").forEach(b => b.addEventListener("click", async () => {
    try{
      const res = await fetch("/api/auth/select-client", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({clientId: Number(b.dataset.id)})});
      if(res.ok){ window.location.reload(); } else { _cmErr("Could not switch client."); }
    }catch(e){ _cmErr("Could not switch client."); }
  }));
  el.querySelectorAll(".cm-edit").forEach(b => b.addEventListener("click", () => {
    const c = (AUTH.clients || []).find(x => x.id === Number(b.dataset.id));
    if(c) setClientForm(c);
  }));
}
async function saveClientFromModal(){
  _cmErr(null);
  const id = document.getElementById("cmEditId").value;
  const name = document.getElementById("cmName").value.trim();
  const industry = document.getElementById("cmIndustry").value.trim();
  if(!name){ _cmErr("Client name is required."); return; }
  const btn = document.getElementById("cmSave"); btn.disabled = true;
  try{
    const url = id ? ("/api/clients/" + encodeURIComponent(id)) : "/api/clients";
    const method = id ? "PUT" : "POST";
    const res = await fetch(url, {method: method, headers:{"Content-Type":"application/json"}, body: JSON.stringify({name, industry, config:{}})});
    const j = await res.json().catch(()=>({}));
    if(!res.ok || !j.ok){ _cmErr(j.error || "Could not save the client."); return; }
    // Create -> it becomes the active client (server side) -> reload into its context.
    // Edit -> reload so the renamed client shows everywhere.
    window.location.reload();
  }catch(e){ _cmErr("Cannot reach the server."); }
  finally{ btn.disabled = false; }
}
function openClientModal(mode){
  injectClientModal();
  setClientForm(null);
  renderClientModalList();
  if(typeof bootstrap !== "undefined"){ new bootstrap.Modal(document.getElementById("clientModal")).show(); }
}

/* ---- DB connection passwords are NOT persisted (server-side or local). They're
   kept only in memory for this page session and prompted for when connecting. ---- */
const RUNTIME_PW = {};                              // connId -> password (session only)
function rememberConnPassword(id, pw){ if(id && pw) RUNTIME_PW[id] = pw; }
function ensureConnPassword(conn){
  return new Promise((resolve) => {
    if(!conn) return resolve("");
    if(conn.trusted) return resolve("");                 // Windows auth — no password
    if(conn.password) return resolve(conn.password);     // fresh from a form / legacy
    if(conn.id && RUNTIME_PW[conn.id] != null) return resolve(RUNTIME_PW[conn.id]);
    promptPassword(conn.name || "this connection").then(pw => {
      if(pw == null) return resolve(null);               // user cancelled
      rememberConnPassword(conn.id, pw);
      resolve(pw);
    });
  });
}
function promptPassword(name){
  return new Promise((resolve) => {
    let m = document.getElementById("pwPromptModal");
    if(!m){
      document.body.insertAdjacentHTML("beforeend",
        '<div class="modal fade" id="pwPromptModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">' +
        '<div class="modal-header"><h5 class="modal-title"><i class="bi bi-key me-1"></i> Enter password</h5>' +
        '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
        '<div class="modal-body"><div class="text-xs text-muted-2 mb-2" id="pwPromptMsg"></div>' +
        '<input type="password" class="form-control" id="pwPromptInput" autocomplete="off"></div>' +
        '<div class="modal-footer"><button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Cancel</button>' +
        '<button type="button" class="btn btn-primary btn-sm" id="pwPromptOk">Connect</button></div>' +
        '</div></div></div>');
      m = document.getElementById("pwPromptModal");
    }
    const input = document.getElementById("pwPromptInput");
    document.getElementById("pwPromptMsg").textContent =
      "Password for " + name + " — used only for this connection and never stored.";
    input.value = "";
    const modal = new bootstrap.Modal(m);
    let done = false;
    const finish = (val) => { if(done) return; done = true; resolve(val); };
    document.getElementById("pwPromptOk").onclick = () => { finish(input.value); modal.hide(); };
    input.onkeydown = (e) => { if(e.key === "Enter"){ finish(input.value); modal.hide(); } };
    m.addEventListener("hidden.bs.modal", () => finish(null), {once:true});
    modal.show();
    setTimeout(() => input.focus(), 200);
  });
}

/* ---- One-time import of pre-sign-in browser data into the active client ---- */
async function maybeOfferLegacyImport(){
  if(!AUTH || !AUTH.activeClientId) return;
  const flag = "aims_import_done_" + AUTH.activeClientId;
  if(localStorage.getItem(flag)) return;
  // Find legacy tenant data still sitting in this browser's localStorage.
  const found = TENANT_DOC_KEYS.filter(k => localStorage.getItem("aims_" + k) != null);
  if(!found.length){ return; }
  const main = document.querySelector(".content-area");
  if(!main) return;
  const bar = document.createElement("div");
  bar.className = "hint-note mb-3";
  bar.style.cssText = "background:var(--primary-soft);color:var(--primary-dark);border-color:var(--primary);";
  bar.innerHTML = '<i class="bi bi-box-arrow-in-down me-1"></i> We found data saved in this browser from before sign-in (' +
    found.length + ' item' + (found.length===1?'':'s') + '). Import it into <strong>' + escapeHtml(activeClientName()) + '</strong>? ' +
    '<button type="button" class="btn btn-sm btn-primary ms-2" id="legacyImportBtn">Import</button> ' +
    '<button type="button" class="btn btn-sm btn-outline-soft" id="legacyDismissBtn">Dismiss</button>';
  main.insertBefore(bar, main.firstChild);
  document.getElementById("legacyDismissBtn").addEventListener("click", () => { localStorage.setItem(flag, "1"); bar.remove(); });
  document.getElementById("legacyImportBtn").addEventListener("click", async () => {
    bar.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Importing…';
    for(const k of found){
      let val; try{ val = JSON.parse(localStorage.getItem("aims_" + k)); }catch(e){ continue; }
      try{ await fetch("/api/state/" + encodeURIComponent(k), {method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify({value: val})}); }catch(e){}
    }
    localStorage.setItem(flag, "1");
    showNotification("Imported your previous data into " + activeClientName() + ". Reloading…", "success", 1500);
    setTimeout(() => window.location.reload(), 800);
  });
}

async function fetchAuth(){
  try{
    const res = await fetch("/api/auth/me", {headers:{"Accept":"application/json"}});
    if(res.status === 401) return null;
    const j = await res.json();
    return (j && j.ok) ? j : null;
  }catch(e){ return null; }
}

async function initShell(activeHref){
  applyTheme(getTheme());   // ensure saved theme is active on every page

  // Auth gate: every app page needs a logged-in session + an active client.
  // (The backend also enforces this via a before_request guard; this keeps the
  // header in sync and handles a session that expired after the page loaded.)
  AUTH = await fetchAuth();
  if(!AUTH){ window.location.href = "/login"; return; }
  if(!AUTH.activeClientId){ window.location.href = "/onboarding"; return; }

  // Load this client's server-side data into the in-memory cache BEFORE any page
  // controller reads it (controllers await initShell, so the cache is ready in time).
  await hydrateClientState();

  const sidebarEl = document.getElementById("sidebar-container");
  if(sidebarEl){ sidebarEl.className = "sidebar"; sidebarEl.innerHTML = buildSidebarHTML(activeHref); }

  await loadProject();   // seed the cached project (used by other pages)
  const headerEl = document.getElementById("header-container");
  if(headerEl){ headerEl.className = "topbar"; headerEl.innerHTML = buildHeaderHTML(); }

  wireShellEvents();
  applySidebarCollapsedState();
  injectClientModal();
  maybeOfferLegacyImport();
}

function wireShellEvents(){
  // Clicking the nav link for the page you're already on would reload the whole
  // page (losing in-page state like a generated SQL script). Make it a no-op.
  document.querySelectorAll(".sidebar-nav .nav-link.active").forEach(a => {
    a.addEventListener("click", (e) => e.preventDefault());
  });

  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if(toggleBtn){
    toggleBtn.addEventListener("click", () => {
      const collapsed = !document.body.classList.contains("sidebar-collapsed");
      document.body.classList.toggle("sidebar-collapsed", collapsed);
      lsSet(LS_KEYS.sidebar, collapsed);
      document.getElementById("sidebarToggleLabel").textContent = collapsed ? "Expand" : "Collapse";
    });
  }
  const mobileToggle = document.getElementById("mobileNavToggle");
  if(mobileToggle){
    mobileToggle.addEventListener("click", () => document.body.classList.toggle("sidebar-collapsed"));
  }
  const searchInput = document.getElementById("globalSearchInput");
  if(searchInput){
    searchInput.addEventListener("keydown", e => {
      if(e.key === "Enter" && searchInput.value.trim()){
        window.location.href = "mapping-workspace.html?search=" + encodeURIComponent(searchInput.value.trim());
      }
    });
  }
  const notifBtn = document.getElementById("notifBtn");
  if(notifBtn){
    notifBtn.addEventListener("click", () => showNotification("3 mappings were flagged Needs Review after the latest AI generation run.", "warning"));
  }
  const resetBtn = document.getElementById("resetAppBtn");
  if(resetBtn){
    resetBtn.addEventListener("click", resetApplication);
  }

  // Client switcher: switch the active client (reload its context), or open the
  // manage/new modal for the special entries.
  const clientSwitcher = document.getElementById("clientSwitcher");
  if(clientSwitcher){
    clientSwitcher.addEventListener("change", async () => {
      const val = clientSwitcher.value;
      if(val === "__new__" || val === "__manage__"){
        clientSwitcher.value = String(AUTH.activeClientId || "");   // don't leave the action selected
        openClientModal(val === "__new__" ? "new" : "manage");
        return;
      }
      const cid = Number(val);
      try{
        const res = await fetch("/api/auth/select-client", {method:"POST",
          headers:{"Content-Type":"application/json"}, body: JSON.stringify({clientId: cid})});
        const j = await res.json().catch(()=>({}));
        if(res.ok && j.ok){ window.location.reload(); }
        else { showNotification((j && j.error) || "Could not switch client.", "danger"); }
      }catch(e){ showNotification("Could not switch client.", "danger"); }
    });
  }

  // User menu (name/email + Log out).
  const userChip = document.getElementById("userChip");
  const userMenu = document.getElementById("userMenu");
  if(userChip && userMenu){
    userChip.addEventListener("click", (e) => { e.stopPropagation(); userMenu.style.display = (userMenu.style.display === "none" ? "" : "none"); });
    document.addEventListener("click", () => { userMenu.style.display = "none"; });
  }
  const logoutBtn = document.getElementById("logoutBtn");
  if(logoutBtn){
    logoutBtn.addEventListener("click", async () => {
      try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
      window.location.href = "/login";
    });
  }
  const themeBtn = document.getElementById("themeToggleBtn");
  if(themeBtn){
    themeBtn.addEventListener("click", () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      setTheme(next);   // persists + applies
      const icon = themeBtn.querySelector("i");
      if(icon) icon.className = "bi " + (next === "dark" ? "bi-sun" : "bi-moon-stars");
    });
  }
}
function applySidebarCollapsedState(){
  const collapsed = lsGet(LS_KEYS.sidebar, false);
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const label = document.getElementById("sidebarToggleLabel");
  if(label) label.textContent = collapsed ? "Expand" : "Collapse";
}

function renderWorkflowStepper(containerId, activeIndex){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '<div class="workflow-stepper">' +
    WORKFLOW_STEPS.map((label, i) =>
      '<div class="step ' + (i < activeIndex ? "done" : i === activeIndex ? "active" : "") + '">' +
        '<div class="circle">' + (i < activeIndex ? '<i class="bi bi-check-lg"></i>' : i + 1) + '</div>' +
        '<div class="label">' + label + '</div>' +
      '</div>').join("") +
  '</div>';
}

function runProcessLog(containerId, steps, onDone, stepDelay = 650){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = "";
  let i = 0;
  function next(){
    if(i > 0){
      const prevLine = el.children[i - 1];
      if(prevLine){ prevLine.classList.add("done"); prevLine.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + prevLine.textContent.trim(); }
    }
    if(i >= steps.length){
      if(onDone) onDone();
      return;
    }
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = '<span class="spin"><i class="bi bi-arrow-repeat"></i></span> ' + steps[i];
    el.appendChild(line);
    requestAnimationFrame(() => line.style.opacity = "1");
    i++;
    setTimeout(next, stepDelay);
  }
  next();
}

function debounce(fn, wait = 250){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
function uid(prefix = "ID"){
  return prefix + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}
function escapeHtml(str){
  if(str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
