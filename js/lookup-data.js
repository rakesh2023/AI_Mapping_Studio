/* =========================================================================
   lookup-data.js  (Mapping ▸ Lookup Mapping page)
   Manage source lookup / typelist data + its target binding and expected
   mapping. Upload a document (Excel/CSV parsed directly; PDF/Word/unstructured
   read by the AI), or derive sets from target columns marked List Value = Yes.
   Source (table.column) and Expected mapping are editable inline.
   Stored via /api/lookups/*; the AI turns the expected value into a reviewable
   source-code → target-code mapping later.
   ========================================================================= */

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("lookup-mapping.html");
  loadLookupSets();

  const addLk = document.getElementById("addLookupBtn");
  const lkFile = document.getElementById("lkFile");
  if(addLk && lkFile) addLk.addEventListener("click", () => lkFile.click());
  if(lkFile) lkFile.addEventListener("change", () => {
    const f = lkFile.files && lkFile.files[0];
    lkFile.value = "";
    if(!f) return;
    // A Guidewire dictionary (zip / html) asks which product to import first.
    if(/\.(zip|html?)$/i.test(f.name)) openLookupProductModal(f);
    else uploadLookupDoc(f);
  });
  const clearLk = document.getElementById("clearLookupsBtn");
  if(clearLk) clearLk.addEventListener("click", clearAllLookups);
  const syncBtn = document.getElementById("syncToMappingBtn");
  if(syncBtn) syncBtn.addEventListener("click", syncLookupsToMappings);
  const lkSearch = document.getElementById("lkSearch");
  if(lkSearch) lkSearch.addEventListener("input", applyLookupFilters);
  const lkStatus = document.getElementById("lkStatusFilter");
  if(lkStatus) lkStatus.addEventListener("change", applyLookupFilters);
  const lkClear = document.getElementById("lkClearFilter");
  if(lkClear) lkClear.addEventListener("click", clearLookupFilters);
  const lkTableSearch = document.getElementById("lkTableSearch");
  if(lkTableSearch) lkTableSearch.addEventListener("input", () => {
    _tableFilter = (lkTableSearch.value || "").toLowerCase().trim();
    renderLookupTableList();
  });
  const lkHide = document.getElementById("lkHidePanelBtn");
  if(lkHide) lkHide.addEventListener("click", () => toggleLookupPanel(false));
  const lkShow = document.getElementById("lkShowPanelBtn");
  if(lkShow) lkShow.addEventListener("click", () => toggleLookupPanel(true));
});

// Left-panel state: active target table (null = all) + the table-search filter.
let _activeTable = null;      // lowercased table key, or null for "all tables"
let _tableFilter = "";

function toggleLookupPanel(show){
  const panel = document.getElementById("lkTablePanelCol");
  const grid = document.getElementById("lkGridCol");
  const showBtn = document.getElementById("lkShowPanelBtn");
  if(!panel || !grid) return;
  panel.style.display = show ? "" : "none";
  grid.className = show ? "col-lg-9" : "col-12";
  if(showBtn) showBtn.style.display = show ? "none" : "";
}

/* Reset the search box + status filter to defaults. */
function clearLookupFilters(){
  const searchEl = document.getElementById("lkSearch");
  const statusEl = document.getElementById("lkStatusFilter");
  if(searchEl) searchEl.value = "";
  if(statusEl) statusEl.value = "all";
  applyLookupFilters();
}

// All lookup sets loaded for the active client (search/filter run client-side over this).
let _allLookupSets = [];

/* ---- small note helpers ---- */
function okNote(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function failNote(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }

async function loadLookupSets(){
  const layout = document.getElementById("lookupLayout");
  const disabled = document.getElementById("lookupDisabledCard");
  const list = document.getElementById("lookupList");
  if(!layout || !list) return;
  try{
    const res = await fetch("/api/lookups", {headers:{Accept:"application/json"}});
    if(res.status === 404){ layout.style.display = "none"; if(disabled) disabled.style.display = ""; return; }  // feature disabled
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){
      layout.style.display = "";
      list.innerHTML = '<div class="text-xs text-danger">' + escapeHtml(j.error || "Could not load lookup sets.") + '</div>';
      return;
    }
    layout.style.display = "";
    if(disabled) disabled.style.display = "none";
    _allLookupSets = j.sets || [];
    // Drop the active-table selection if that table no longer has any sets.
    if(_activeTable && !_allLookupSets.some(s => _tableKey(s) === _activeTable)) _activeTable = null;
    renderLookupTableList();
    applyLookupFilters();
  }catch(e){ layout.style.display = ""; list.innerHTML = '<div class="text-xs text-muted-2">Cannot reach the server.</div>'; }
}

/* The target-table a lookup set belongs to (lowercased key; "" -> no target table). */
function _tableKey(s){ return (s.targetTable || "").trim().toLowerCase(); }
function _tableLabel(s){ return (s.targetTable || "").trim() || "(no target table)"; }

/* Left panel: one card per distinct target table, with lookup counts, + an "All tables" row. */
function renderLookupTableList(){
  const el = document.getElementById("lkTableList");
  if(!el) return;
  // Group loaded sets by target table.
  const groups = {};   // key -> {label, total, missing}
  const orderKeys = [];
  _allLookupSets.forEach(s => {
    const k = _tableKey(s);
    if(!(k in groups)){ groups[k] = {key: k, label: _tableLabel(s), total: 0, missing: 0}; orderKeys.push(k); }
    groups[k].total++;
    if(!(s.targetValuesSpec || "").trim()) groups[k].missing++;
  });
  orderKeys.sort((a, b) => groups[a].label.localeCompare(groups[b].label));

  let visible = orderKeys.map(k => groups[k]);
  if(_tableFilter) visible = visible.filter(g => g.label.toLowerCase().indexOf(_tableFilter) !== -1);

  const totalSets = _allLookupSets.length;
  const totalMissing = _allLookupSets.filter(s => !(s.targetValuesSpec || "").trim()).length;

  const allItem =
    '<div class="tl-item ' + (_activeTable === null ? "active" : "") + '" data-lk-table="__all__">' +
      '<div class="tl-name"><i class="bi bi-collection"></i> All tables</div>' +
      '<div class="tl-stats">' +
        '<span class="tl-badge badge-gray">' + totalSets + ' lookup' + (totalSets === 1 ? "" : "s") + '</span>' +
        (totalMissing ? '<span class="tl-badge badge-low">' + totalMissing + ' missing</span>' : '') +
      '</div>' +
    '</div>';

  const items = visible.map(g =>
    '<div class="tl-item ' + (_activeTable === g.key ? "active" : "") + '" data-lk-table="' + escapeHtml(g.key) + '">' +
      '<div class="tl-name"><i class="bi bi-diagram-2"></i> ' + escapeHtml(g.label) + '</div>' +
      '<div class="tl-stats">' +
        '<span class="tl-badge badge-gray">' + g.total + ' lookup' + (g.total === 1 ? "" : "s") + '</span>' +
        (g.missing ? '<span class="tl-badge badge-low">' + g.missing + ' missing</span>' : '') +
      '</div>' +
    '</div>').join("");

  if(!totalSets){ el.innerHTML = '<div class="text-xs text-muted-2">No lookup data yet.</div>'; return; }
  el.innerHTML = allItem + (visible.length ? items : '<div class="text-xs text-muted-2 mt-1">No tables match.</div>');
  el.querySelectorAll("[data-lk-table]").forEach(it => it.addEventListener("click", () => {
    const k = it.dataset.lkTable;
    selectLookupTable(k === "__all__" ? null : k);
  }));
}

function selectLookupTable(key){
  _activeTable = key;
  const g = _allLookupSets.find(s => _tableKey(s) === key);
  const label = document.getElementById("lkScopeLabel");
  if(label) label.textContent = key === null ? "— all target tables" : "— " + (g ? _tableLabel(g) : key);
  renderLookupTableList();
  applyLookupFilters();
}

/* Apply the search box + status filter over the loaded sets (client-side). */
function applyLookupFilters(){
  const total = _allLookupSets.length;
  const toolbar = document.getElementById("lookupToolbar");
  const clearBtn = document.getElementById("clearLookupsBtn");
  const syncBtn = document.getElementById("syncToMappingBtn");
  if(toolbar) toolbar.style.display = total ? "" : "none";
  if(clearBtn) clearBtn.style.display = total ? "" : "none";
  if(syncBtn) syncBtn.style.display = total ? "" : "none";

  const searchEl = document.getElementById("lkSearch");
  const statusEl = document.getElementById("lkStatusFilter");
  const q = (searchEl && searchEl.value ? searchEl.value : "").trim().toLowerCase();
  const status = statusEl && statusEl.value ? statusEl.value : "all";

  const clearBtnF = document.getElementById("lkClearFilter");
  if(clearBtnF) clearBtnF.style.display = (q || status !== "all") ? "" : "none";

  // Scope to the selected target table first (the left-panel "one entity at a time").
  let rows = (_activeTable === null) ? _allLookupSets : _allLookupSets.filter(s => _tableKey(s) === _activeTable);
  const scopeTotal = rows.length;
  if(status === "has") rows = rows.filter(s => (s.targetValuesSpec || "").trim());
  else if(status === "missing") rows = rows.filter(s => !(s.targetValuesSpec || "").trim());
  if(q){
    rows = rows.filter(s => [s.lookupName, s.sourceTable, s.sourceColumn, s.targetTable, s.targetColumn, s.targetValuesSpec]
      .map(x => (x || "").toString().toLowerCase()).join(" ").includes(q));
  }

  const countEl = document.getElementById("lkCount");
  if(countEl) countEl.textContent = (rows.length === scopeTotal)
    ? (scopeTotal + " lookup set" + (scopeTotal === 1 ? "" : "s") + (_activeTable === null ? "" : " in this table"))
    : (rows.length + " of " + scopeTotal + " shown");
  renderLookupSets(rows, scopeTotal);
}

function renderLookupSets(sets, total){
  const list = document.getElementById("lookupList");
  if(total === undefined) total = sets.length;
  if(!sets.length){
    list.innerHTML = total
      ? '<div class="text-xs text-muted-2">No lookup sets match your search / filter.</div>'
      : '<div class="text-xs text-muted-2">No lookup data yet. Upload a document (or a Guidewire dictionary .zip) to capture typelist codes and their target binding.</div>';
    return;
  }
  const dash = '<span class="text-muted-2">—</span>';
  const snippet = (t) => {
    const s = (t || "").replace(/\s*\n\s*/g, " · ").trim();
    return s ? escapeHtml(s.length > 90 ? s.slice(0, 90) + "…" : s) : dash;
  };
  list.innerHTML =
    '<div class="table-responsive-el"><table class="grid-table"><thead><tr>' +
      '<th style="min-width:150px;">Lookup</th>' +
      '<th style="min-width:180px;">Source</th>' +
      '<th style="min-width:150px;">Target</th>' +
      '<th style="min-width:300px;">Expected mapping</th>' +
      '<th style="width:1%;"></th></tr></thead><tbody>' +
    sets.map(s => {
      const src = s.sourceColumn ? ((s.sourceTable ? s.sourceTable + "." : "") + s.sourceColumn) : "";
      const tgt = s.targetColumn ? ((s.targetTable ? s.targetTable + "." : "") + s.targetColumn) : "";
      return '<tr>' +
        '<td class="mono">' + escapeHtml(s.lookupName) + '</td>' +
        '<td class="mono">' + (src ? escapeHtml(src) : dash) + '</td>' +
        '<td class="mono">' + (tgt ? escapeHtml(tgt) : dash) + '</td>' +
        '<td class="wrap" style="max-width:420px;">' + snippet(s.targetValuesSpec) + '</td>' +
        '<td class="text-end" style="white-space:nowrap;">' +
          '<button class="btn btn-sm btn-outline-soft me-1" data-lk-edit="' + s.id + '" title="Edit"><i class="bi bi-pencil"></i></button>' +
          '<button class="btn btn-sm btn-outline-danger" data-lk-del="' + s.id + '" data-lk-name="' + escapeHtml(s.lookupName) + '" title="Delete"><i class="bi bi-trash"></i></button>' +
        '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table></div>';
  list.querySelectorAll("[data-lk-edit]").forEach(b => b.addEventListener("click", () => openLookupEditModal(b.dataset.lkEdit)));
  list.querySelectorAll("[data-lk-del]").forEach(b => b.addEventListener("click", () => deleteLookupSet(b.dataset.lkDel, b.dataset.lkName)));
}

/* ---- Edit lookup mapping in a modal (Source table.column + Expected mapping) ---- */
let _editingLookupId = null;

function injectLookupEditModal(){
  if(document.getElementById("lookupEditModal")) return;
  const html =
    '<div class="modal fade" id="lookupEditModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered">' +
    '<div class="modal-content"><div class="modal-header">' +
      '<h5 class="modal-title"><i class="bi bi-pencil-square me-1"></i> Edit lookup mapping</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
    '<div class="modal-body">' +
      '<div class="hint-note mb-2" id="leErr" style="display:none;background:var(--danger-bg);color:var(--danger);border-color:#f3c9c6;"></div>' +
      '<div class="kv-list mb-3">' +
        '<span class="k">Lookup</span><span class="mono" id="leName">—</span>' +
        '<span class="k">Target</span><span class="mono" id="leTarget">—</span>' +
      '</div>' +
      '<div class="form-group"><label>Source <span class="text-xs text-muted-2">(table.column)</span></label>' +
        '<input type="text" class="form-control mono" id="leSource" placeholder="source_table.source_column"></div>' +
      '<div class="form-group"><label>Expected mapping <span class="text-xs text-muted-2">(free text)</span></label>' +
        '<textarea class="form-control" id="leSpec" rows="6" style="resize:vertical;white-space:pre-wrap;" placeholder="e.g. 1 then open, 2 then closed"></textarea>' +
        '<div class="text-xs text-muted-2 mt-1">One value per line or comma-separated, e.g. <span class="mono">1 then open</span>, <span class="mono">2 then closed</span>.</div></div>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="leSave"><i class="bi bi-check2 me-1"></i> Save</button>' +
    '</div></div></div></div>';
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("leSave").addEventListener("click", saveLookupEditModal);
}

function _leErr(msg){ const e = document.getElementById("leErr"); if(!e) return; if(msg){ e.textContent = msg; e.style.display = ""; } else { e.style.display = "none"; } }

function openLookupEditModal(id){
  injectLookupEditModal();
  const s = (_allLookupSets || []).find(x => String(x.id) === String(id));
  if(!s){ showNotification("Lookup set not found — reload the page.", "warning"); return; }
  _editingLookupId = s.id;
  _leErr(null);
  document.getElementById("leName").textContent = s.lookupName || "—";
  document.getElementById("leTarget").textContent =
    s.targetColumn ? ((s.targetTable ? s.targetTable + "." : "") + s.targetColumn) : "—";
  document.getElementById("leSource").value = (s.sourceTable ? s.sourceTable + "." : "") + (s.sourceColumn || "");
  document.getElementById("leSpec").value = s.targetValuesSpec || "";
  if(typeof bootstrap !== "undefined"){ new bootstrap.Modal(document.getElementById("lookupEditModal")).show(); }
}

async function saveLookupEditModal(){
  const id = _editingLookupId;
  if(!id) return;
  _leErr(null);
  const raw = (document.getElementById("leSource").value || "").trim();
  const spec = document.getElementById("leSpec").value;
  const dot = raw.lastIndexOf(".");
  const sourceTable = dot > 0 ? raw.slice(0, dot).trim() : "";
  const sourceColumn = dot > 0 ? raw.slice(dot + 1).trim() : raw;
  const btn = document.getElementById("leSave");
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving…'; }
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id), {
      method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sourceTable, sourceColumn, targetValuesSpec: spec })});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ _leErr((j && j.error) || "Save failed."); return; }
    const m = bootstrap.Modal.getInstance(document.getElementById("lookupEditModal")); if(m) m.hide();
    showNotification("Lookup updated.", "primary", 1500);
    loadLookupSets();
  }catch(e){ _leErr("Cannot reach the server."); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2 me-1"></i> Save'; } }
}

/* ---- Guidewire dictionary: ask the product, then import only its typelists ---- */
let _pendingLookupFile = null;

function injectLookupProductModal(){
  if(document.getElementById("lkProductModal")) return;
  const html =
    '<div class="modal fade" id="lkProductModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered">' +
    '<div class="modal-content"><div class="modal-header">' +
      '<h5 class="modal-title"><i class="bi bi-box-seam me-1"></i> Import Guidewire dictionary</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
    '<div class="modal-body">' +
      '<p class="text-xs text-muted-2 mb-2">Which product is this dictionary? Only that product’s <b>typelists</b> (code lists) will be imported as lookup sets.</p>' +
      '<div class="form-group"><label>Product</label>' +
        '<select class="form-select" id="lkProduct">' +
          '<option value="claim">ClaimCenter — cctl_* typelists</option>' +
          '<option value="policy">PolicyCenter — pctl_* typelists</option>' +
          '<option value="billing">BillingCenter — bctl_* typelists</option>' +
        '</select></div>' +
      '<div class="text-xs text-muted-2" id="lkProductFile"></div>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="lkProductImport"><i class="bi bi-upload me-1"></i> Import</button>' +
    '</div></div></div></div>';
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("lkProductImport").addEventListener("click", () => {
    const product = (document.getElementById("lkProduct") || {}).value || "claim";
    const m = bootstrap.Modal.getInstance(document.getElementById("lkProductModal")); if(m) m.hide();
    if(_pendingLookupFile){ uploadLookupDoc(_pendingLookupFile, product); _pendingLookupFile = null; }
  });
}

function openLookupProductModal(file){
  injectLookupProductModal();
  _pendingLookupFile = file;
  const fn = document.getElementById("lkProductFile");
  if(fn) fn.textContent = "File: " + file.name;
  if(typeof bootstrap !== "undefined"){ new bootstrap.Modal(document.getElementById("lkProductModal")).show(); }
}

async function uploadLookupDoc(file, product){
  const box = document.getElementById("lkUploadResult");
  if(box) box.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span>Parsing ' + escapeHtml(file.name) + '…</div>';
  const fd = new FormData(); fd.append("file", file);
  if(product) fd.append("product", product);
  try{
    const res = await fetch("/api/lookups/upload", {method:"POST", body: fd});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ if(box) box.innerHTML = failNote((j && j.error) || "Upload failed."); return; }
    if(box) box.innerHTML = okNote("Imported " + j.created + " lookup set" + (j.created === 1 ? "" : "s") +
      " (" + j.totalValues + " values" + (j.skippedRows ? ", " + j.skippedRows + " row(s) skipped" : "") + ").");
    loadLookupSets();
  }catch(e){ if(box) box.innerHTML = failNote("Cannot reach the server."); }
}

/* No-upload path: derive lookup sets from every target column marked List Value = Yes,
   pulling the mapped source column from the generated field mappings when available. */
async function deriveLookupsFromListColumns(){
  const box = document.getElementById("lkUploadResult");
  const meta = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  if(!meta || !meta.entities || !meta.entities.length){
    showNotification("No active target schema. Load & activate a target first.", "warning"); return;
  }
  // Index generated field mappings by target entity::column to find the source column.
  const mappings = lsGet("aims_ai_mappings", []) || [];
  const mapIdx = {};
  mappings.forEach(m => { mapIdx[(m.targetEntity || "").toLowerCase() + "::" + (m.targetColumn || "").toLowerCase()] = m; });

  const candidates = [];
  meta.entities.forEach(e => {
    (e.fields || []).forEach(f => {
      if(f.isListTable || e.isListTable){
        const m = mapIdx[(e.name || "").toLowerCase() + "::" + (f.name || "").toLowerCase()];
        const sc = (m && m.sourceColumn && m.sourceColumn !== "(no source equivalent)") ? m.sourceColumn : "";
        const tt = e.table || e.name || "";
        candidates.push({ lookupName: (tt ? tt + "_" : "") + f.name, sourceTable: (m && m.sourceTable) || "",
                          sourceColumn: sc, targetTable: tt, targetColumn: f.name });
      }
    });
  });
  if(!candidates.length){
    showNotification("No target columns are marked List Value = Yes. Mark them on the Target System page first.", "warning");
    return;
  }

  // Skip lookups that already exist (don't clobber uploaded ones).
  let existing = new Set();
  try{
    const r = await fetch("/api/lookups", {headers:{Accept:"application/json"}});
    if(r.status === 404){ if(box) box.innerHTML = failNote("Lookup mapping is disabled."); return; }
    const j = await r.json().catch(() => ({}));
    if(j && j.ok) existing = new Set((j.sets || []).map(s => (s.lookupName || "").toLowerCase()));
  }catch(e){ if(box) box.innerHTML = failNote("Cannot reach the server."); return; }

  const todo = candidates.filter(c => !existing.has((c.lookupName || "").toLowerCase()));
  if(box) box.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span>Creating ' + todo.length + ' lookup set(s) from List-Table columns…</div>';
  let created = 0;
  for(const c of todo){
    try{
      const res = await fetch("/api/lookups", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ lookupName: c.lookupName, sourceTable: c.sourceTable, sourceColumn: c.sourceColumn,
                               targetTable: c.targetTable, targetColumn: c.targetColumn, values: [] })});
      const j = await res.json().catch(() => ({}));
      if(res.ok && j.ok) created++;
    }catch(e){ /* skip this one */ }
  }
  if(box) box.innerHTML = okNote("Added " + created + " lookup set(s) from List-Table columns" +
    (todo.length < candidates.length ? " (" + (candidates.length - todo.length) + " already existed)" : "") +
    ". Upload a document or use AI to fill the expected mapping.");
  loadLookupSets();
}

async function clearAllLookups(){
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Delete ALL lookup sets for this client? This removes every set along with its values and value mappings. This cannot be undone.", "Clear all")
    : window.confirm("Delete ALL lookup sets? This cannot be undone.");
  if(!ok) return;
  try{
    const res = await fetch("/api/lookups", {method:"DELETE"});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Clear all failed.", "danger"); return; }
    showNotification("Cleared " + (j.removed || 0) + " lookup set" + (j.removed === 1 ? "" : "s") + ".", "primary", 1800);
    loadLookupSets();
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}

/* =========================================================================
   Sync lookup mappings → AI-generated field mappings.
   For every lookup set that binds to a target column, update ONLY the matching
   generated mapping row(s) — mapping type, transformation rule, business rule
   (+ the Lookup Table). Columns without a lookup set are left untouched, and no
   new mapping rows are created.
   ========================================================================= */

/* Parse a free-text expected-value spec into {code,target} pairs.
   Handles "1 then open", "A- then active", "H-Home", "P = Person" etc. */
function parseSpecPairs(spec){
  const out = [];
  if(!spec) return out;
  spec.split(/[\n,;]+/).forEach(seg => {
    const t = seg.trim();
    if(!t) return;
    const m = /^(.+?)\s+then\s+(.+)$/i.exec(t) || /^(.+?)\s*[-=:>]+\s*(.+)$/.exec(t);
    if(m){
      const code = m[1].replace(/[^0-9A-Za-z_]+$/, "").trim();   // drop trailing punctuation e.g. "A-"
      const target = m[2].trim();
      if(code && target) out.push({code: code, target: target});
    }
  });
  return out;
}

/* Overwrite a generated mapping row's lookup-related fields from a lookup set. */
function applyLookupToMapping(m, s){
  const spec = (s.targetValuesSpec || "").trim();
  const pairs = parseSpecPairs(spec);
  const srcRef = (s.sourceTable ? s.sourceTable + "." : "") +
    (s.sourceColumn || (m.sourceColumn && m.sourceColumn !== "(no source equivalent)" ? m.sourceColumn : "source"));
  const tgtRef = (s.targetTable ? s.targetTable + "." : "") + (s.targetColumn || m.targetColumn || "");

  m.mappingType = "Lookup";
  // Lookup Table in the "Name: code-target, code-target" shape the workspace/ETL parse.
  m.lookupTable = s.lookupName + (pairs.length ? (": " + pairs.map(p => p.code + "-" + p.target).join(", ")) : "");
  m.transformationRule = pairs.length
    ? ("LOOKUP(" + srcRef + "): " + pairs.map(p => p.code + " → " + p.target).join(", "))
    : (spec ? ("LOOKUP(" + srcRef + "): " + spec.replace(/\s*\n\s*/g, ", ")) : ("Apply lookup '" + s.lookupName + "'"));
  m.businessRule = spec
    ? ("Reference/lookup mapping " + srcRef + " → " + tgtRef + " via '" + s.lookupName + "': " + spec.replace(/\s*\n\s*/g, "; "))
    : ("Reference/lookup mapping " + srcRef + " → " + tgtRef + " via '" + s.lookupName + "'.");
  m.updatedBy = "Lookup Sync";
  m.lastUpdated = new Date().toISOString();
}

async function syncLookupsToMappings(){
  const sets = (_allLookupSets || []).filter(s => (s.targetColumn || "").trim());
  if(!sets.length){ showNotification("No lookup sets with a target column to sync.", "warning"); return; }

  const mappings = lsGet("aims_ai_mappings", null);
  if(mappings === null){
    showNotification("No AI mappings yet — generate them first in AI Mapping Generator.", "warning"); return;
  }
  if(!mappings.length){ showNotification("There are no generated mappings to update.", "warning"); return; }

  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog("Apply " + sets.length + " lookup set(s) to the AI-generated mappings? This updates the " +
        "Mapping Type, Transformation Rule and Business Rule for the matching target columns only — no other columns " +
        "are changed and no new rows are added. The lookup sync takes priority: it overrides any manual edits to " +
        "those fields for the matched columns.", "Sync to AI Mapping")
    : window.confirm("Apply lookup mappings to the generated mappings?");
  if(!ok) return;

  // Sync must WIN over any prior manual edits. The workspace applies per-row entries in
  // aims_mapping_overrides on top of the base row, so for a synced row we also overwrite
  // the synced fields in its existing override (leaving the user's other edits intact).
  const overrides = (typeof getMappingOverrides === "function") ? getMappingOverrides() : {};
  const SYNC_FIELDS = ["mappingType", "lookupTable", "transformationRule", "businessRule", "updatedBy", "lastUpdated"];
  let overridesTouched = false;

  let updated = 0;
  const unmatched = [];
  sets.forEach(s => {
    const col = (s.targetColumn || "").trim().toLowerCase();
    const tbl = (s.targetTable || "").trim().toLowerCase();
    const matches = mappings.filter(m => (m.targetColumn || "").trim().toLowerCase() === col &&
      (!tbl || (m.targetTable || "").trim().toLowerCase() === tbl || (m.targetEntity || "").trim().toLowerCase() === tbl));
    if(!matches.length){ unmatched.push(s.lookupName); return; }
    matches.forEach(m => {
      applyLookupToMapping(m, s);
      updated++;
      if(overrides && overrides[m.id]){   // an existing manual edit — force the synced values on top
        SYNC_FIELDS.forEach(k => { overrides[m.id][k] = m[k]; });
        overridesTouched = true;
      }
    });
  });

  if(!updated){
    showNotification("No generated columns matched the lookup sets — nothing changed. " +
      "Check that the target table/column names match your generated mappings.", "warning", 5000);
    return;
  }
  try{
    lsSet("aims_ai_mappings", mappings);
    if(overridesTouched && typeof LS_KEYS !== "undefined") lsSet(LS_KEYS.overrides, overrides);
  }
  catch(e){ showNotification(e.message || "Could not save the updated mappings.", "danger", 6000); return; }

  const box = document.getElementById("lkUploadResult");
  const msg = "Synced " + updated + " mapping row(s) from " + (sets.length - unmatched.length) + " lookup set(s)" +
    (unmatched.length ? "; " + unmatched.length + " set(s) had no matching generated column" : "") +
    ". Open the Mapping Workspace to review.";
  if(box) box.innerHTML = okNote(msg);
  showNotification("Synced " + updated + " mapping row(s) to the AI mappings.", "success", 3200);
}

async function deleteLookupSet(id, name){
  const ok = (typeof confirmDialog === "function")
    ? await confirmDialog('Delete lookup set "' + escapeHtml(name || "") + '"? This removes its values and any value mappings.', "Delete")
    : window.confirm("Delete this lookup set?");
  if(!ok) return;
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id), {method:"DELETE"});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Delete failed.", "danger"); return; }
    showNotification("Lookup set deleted.", "primary", 1500);
    loadLookupSets();
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
}
