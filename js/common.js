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
  {title:"Deliver", items:[
    {label:"Mapping History", icon:"bi-clock-history", href:"mapping-history.html"},
    {label:"Export", icon:"bi-download", href:"export.html"},
    {label:"Settings", icon:"bi-gear", href:"settings.html"}
  ]}
];

const WORKFLOW_STEPS = [
  "Project Creation","Source Configuration","Source Connection","File Upload",
  "Metadata Discovery","Source Profiling","Target Configuration","Target Metadata",
  "AI Mapping Generation","Mapping Review","Prompt Refinement","Validation",
  "Approval","Export"
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

function lsGet(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}
function lsSet(key, value){
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

function getMappingOverrides(){ return lsGet(LS_KEYS.overrides, {}); }
function saveMappingOverride(id, changes){
  const all = getMappingOverrides();
  all[id] = Object.assign({}, all[id] || {}, changes);
  lsSet(LS_KEYS.overrides, all);
}
function clearMappingOverrides(){ localStorage.removeItem(LS_KEYS.overrides); }

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

/* ---- Full application reset: clear ALL app data back to defaults ---- */
async function resetApplication(){
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Reset the entire application? This permanently clears ALL data — source & target connections, uploaded schema, generated mappings, join conditions, validation results, history, settings and preferences. This cannot be undone.", "Reset Everything")
    : window.confirm("Reset the entire application? This clears ALL data and cannot be undone.");
  if(!ok) return;
  // Remove every app key (prefix "aims_") so nothing is missed as new keys are added.
  try{
    const keys = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.indexOf("aims_") === 0) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    // Mark the mapping document as explicitly EMPTY (not missing) so the workspace,
    // dashboard, history and validation don't fall back to the bundled sample data.
    localStorage.setItem("aims_ai_mappings", "[]");
  }catch(e){ /* ignore */ }
  if(typeof showNotification === "function") showNotification("Application reset. Reloading…", "primary", 1500);
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
function initials(name){
  return (name || "").trim().split(/\s+/).map(w => w[0]).slice(0,2).join("").toUpperCase() || "U";
}
function getCurrentUser(){
  // Prefer the profile saved on the Settings page; fall back to the default.
  const s = getSettings();
  const name = (s && s.userName && s.userName.trim()) ? s.userName.trim() : CURRENT_USER.name;
  const role = (s && s.userRole && s.userRole.trim()) ? s.userRole.trim() : CURRENT_USER.role;
  return { name: name, role: role, initials: initials(name) };
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

async function initShell(activeHref){
  applyTheme(getTheme());   // ensure saved theme is active on every page
  const sidebarHTML =
    '<div class="sidebar-brand">' +
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
  const sidebarEl = document.getElementById("sidebar-container");
  if(sidebarEl){ sidebarEl.className = "sidebar"; sidebarEl.innerHTML = sidebarHTML; }

  await loadProject();   // seed the cached project (used by other pages)
  const user = getCurrentUser();
  const headerHTML =
    '<div class="topbar-left">' +
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
      '<button class="icon-btn" id="themeToggleBtn" title="Toggle dark / light theme"><i class="bi ' + (getTheme()==="dark" ? "bi-sun" : "bi-moon-stars") + '"></i></button>' +
      '<button class="icon-btn" id="resetAppBtn" title="Reset application (clear all data)"><i class="bi bi-arrow-counterclockwise"></i></button>' +
      '<div class="icon-btn" id="notifBtn"><i class="bi bi-bell"></i><span class="badge-dot"></span></div>' +
      '<div class="user-chip">' +
        '<div class="user-avatar">' + user.initials + '</div>' +
        '<div class="user-meta d-none d-md-block">' +
          '<div class="user-name">' + escapeHtml(user.name) + '</div>' +
          '<div class="user-role">' + escapeHtml(user.role) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  const headerEl = document.getElementById("header-container");
  if(headerEl){ headerEl.className = "topbar"; headerEl.innerHTML = headerHTML; }

  wireShellEvents();
  applySidebarCollapsedState();
}

function wireShellEvents(){
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
