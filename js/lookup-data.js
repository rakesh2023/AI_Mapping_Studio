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
    // Auto-create / backfill a lookup set for every List column of a MAPPED target
    // table (source pulled from the generated mappings). Re-fetch if anything changed.
    const added = await ensureListColumnSets(_allLookupSets);
    if(added){
      const r2 = await fetch("/api/lookups", {headers:{Accept:"application/json"}});
      const j2 = await r2.json().catch(() => ({}));
      if(j2 && j2.ok) _allLookupSets = j2.sets || [];
    }
    // Build the dictionary indexes (target Type Key + imported typelist code lists)
    // used to auto-fill the "Expected Type list value" reference column.
    await buildDictIndexes();
    // Change 1: show only tables for which mappings were generated.
    _allLookupSets = filterToMappedTables(_allLookupSets);
    // Drop the active-table selection if that table no longer has any sets.
    if(_activeTable && !_allLookupSets.some(s => _tableKey(s) === _activeTable)) _activeTable = null;
    renderLookupTableList();
    applyLookupFilters();
  }catch(e){ layout.style.display = ""; list.innerHTML = '<div class="text-xs text-muted-2">Cannot reach the server.</div>'; }
}

/* Dictionary indexes for the reference column + Generate:
   _fieldTypeKeyIdx : "<entityOrTable>::<column>" -> target column's Guidewire Type Key
   _typelistIndex   : normalized typelist base name -> [{code, description}] (from the
                      imported Guidewire dictionary, via /api/lookups/snapshot). */
let _typelistIndex = {};
let _typelistNameByBase = {};
let _fieldTypeKeyIdx = {};

async function buildDictIndexes(){
  _fieldTypeKeyIdx = {};
  const meta = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  if(meta && meta.entities) meta.entities.forEach(e => {
    (e.fields || []).forEach(f => {
      const col = (f.name || "").toLowerCase();
      [(e.name || "").toLowerCase(), (e.table || "").toLowerCase()].forEach(t => {
        if(t) _fieldTypeKeyIdx[t + "::" + col] = (f.typeKey || "");
      });
    });
  });
  _typelistIndex = {};
  _typelistNameByBase = {};
  try{
    const r = await fetch("/api/lookups/snapshot", {headers:{Accept:"application/json"}});
    const j = await r.json().catch(() => ({}));
    if(j && j.ok) (j.sets || []).forEach(x => {
      if((x.values || []).length){
        const base = _typelistBaseName(x.lookupName);
        _typelistIndex[base] = x.values;
        _typelistNameByBase[base] = x.lookupName;   // e.g. "cctl_checkstatus"
      }
    });
  }catch(e){ /* leave empty — Expected column will show "no typelist" */ }
}

/* The target column's Guidewire Type Key (from the schema), or "" if none set. */
function _targetTypeKey(s){
  const col = (s.targetColumn || "").toLowerCase();
  return _fieldTypeKeyIdx[_tableKey(s) + "::" + col] ||
         _fieldTypeKeyIdx[(s.targetTable || "").toLowerCase() + "::" + col] || "";
}

/* The Guidewire typelist code list for a lookup set's target column, resolved via its
   Type Key (falls back to the column name). [] when the dictionary has no match. */
function _expectedValues(s){
  const base = _typelistBaseName(_targetTypeKey(s) || s.targetColumn);
  return _typelistIndex[base] || [];
}

/* What the "Lookup" column shows: the actual Guidewire typelist name being mapped to.
   Prefer the imported typelist's physical name (cctl_checkstatus), else the column's
   Type Key (CheckStatus), else fall back to the target column. */
function _lookupDisplayName(s){
  const tk = _targetTypeKey(s);
  const base = _typelistBaseName(tk || s.targetColumn);
  return _typelistNameByBase[base] || tk || s.targetColumn || s.lookupName || "—";
}

/* The LookupName value written into the generated ETL (JOIN filter + LookupData seed
   rows). The Guidewire typelist name so it matches typelist-seeded LookupData across
   products: the imported typelist's physical name (cctl_addresstype) when known, else
   the column's Type Key without the "typekey." qualifier, else a safe fallback. */
function _gwLookupName(s){
  const tk = _targetTypeKey(s);
  const base = _typelistBaseName(tk || s.targetColumn);
  if(_typelistNameByBase[base]) return _typelistNameByBase[base];
  if(tk) return tk.replace(/^typekey\./i, "");
  return s.targetColumn || s.lookupName || "";
}

/* Change 1: keep only sets whose target table has at least one generated mapping.
   When no mappings exist yet, fall back to showing everything. */
function filterToMappedTables(sets){
  const mappings = lsGet("aims_ai_mappings", null);
  if(!mappings || !mappings.length) return sets;
  const meta = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  const byName = {};
  if(meta && meta.entities) meta.entities.forEach(e => { byName[(e.name || "").toLowerCase()] = e; });
  const keys = new Set();
  mappings.forEach(m => {
    const en = (m.targetEntity || "").toLowerCase().trim();
    if(!en) return;
    keys.add(en);
    const e = byName[en];
    if(e && e.table) keys.add((e.table || "").toLowerCase().trim());
  });
  return sets.filter(s => keys.has(_tableKey(s)));
}

/* Auto-populate: ensure a lookup set exists for every List/typelist column of a target
   table that HAS generated mappings, bound to its source column (table.column) from
   those mappings. Also backfills the source on an existing set when it's still blank.
   Idempotent; never clobbers uploaded sets. Returns the number of rows created/updated. */
async function ensureListColumnSets(existing){
  const meta = (typeof getTargetSchema === "function") ? getTargetSchema() : null;
  if(!meta || !meta.entities || !meta.entities.length) return 0;

  // Change 1: only tables that have at least one generated mapping.
  const mappings = lsGet("aims_ai_mappings", null);
  if(!mappings || !mappings.length) return 0;

  // Index generated field mappings by target entity::column to find the source column.
  const mapIdx = {};
  const mappedEntities = new Set();
  mappings.forEach(m => {
    const en = (m.targetEntity || "").toLowerCase().trim();
    if(en) mappedEntities.add(en);
    mapIdx[en + "::" + (m.targetColumn || "").toLowerCase()] = m;
  });

  const have = {};
  (existing || []).forEach(s => { have[(s.lookupName || "").toLowerCase()] = s; });

  const creates = [], updates = [];
  meta.entities.forEach(e => {
    const en = (e.name || "").toLowerCase().trim();
    if(!mappedEntities.has(en)) return;   // skip tables with no generated mappings
    (e.fields || []).forEach(f => {
      if(!(f.isListTable || e.isListTable || (f.typeKey || "").trim())) return;
      const tt = e.table || e.name || "";
      const lookupName = (tt ? tt + "_" : "") + f.name;
      const m = mapIdx[en + "::" + (f.name || "").toLowerCase()];
      const sc = (m && m.sourceColumn && m.sourceColumn !== "(no source equivalent)") ? m.sourceColumn : "";
      const st = (m && m.sourceTable) || "";
      const ex = have[lookupName.toLowerCase()];
      if(!ex){
        creates.push({ lookupName, sourceTable: st, sourceColumn: sc, targetTable: tt, targetColumn: f.name });
        have[lookupName.toLowerCase()] = { id: -1 };   // guard against dup column names in the pass
      } else if(sc && !((ex.sourceColumn || "").trim())){
        updates.push({ id: ex.id, sourceTable: st, sourceColumn: sc });   // Change 2: backfill blank source
      }
    });
  });
  if(!creates.length && !updates.length) return 0;

  let touched = 0;
  for(const c of creates){
    try{
      const res = await fetch("/api/lookups", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ lookupName: c.lookupName, sourceTable: c.sourceTable, sourceColumn: c.sourceColumn,
                               targetTable: c.targetTable, targetColumn: c.targetColumn, values: [] })});
      const j = await res.json().catch(() => ({}));
      if(res.ok && j.ok) touched++;
    }catch(e){ /* skip this one */ }
  }
  for(const u of updates){
    try{
      const res = await fetch("/api/lookups/" + encodeURIComponent(u.id), {method:"PUT",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ sourceTable: u.sourceTable, sourceColumn: u.sourceColumn })});
      const j = await res.json().catch(() => ({}));
      if(res.ok && j.ok) touched++;
    }catch(e){ /* skip this one */ }
  }
  return touched;
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

  if(!totalSets){ el.innerHTML = '<div class="text-xs text-muted-2">No mapped tables with list columns yet.</div>'; return; }
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
      : '<div class="text-xs text-muted-2">No list columns to map yet. They appear here automatically once (1) you have generated mappings (AI Mapping Generator) and (2) the target list / typelist columns are identified — set their <b>Type Key</b> on <b>Target System</b> (via <b>AI fill</b>, which reads the <b>Product Data Dictionary</b> / <b>Product Schema</b>).</div>';
    return;
  }
  const dash = '<span class="text-muted-2">—</span>';
  const snippet = (t) => {
    const s = (t || "").replace(/\s*\n\s*/g, " · ").trim();
    return s ? escapeHtml(s.length > 90 ? s.slice(0, 90) + "…" : s) : dash;
  };
  list.innerHTML =
    '<div class="table-responsive-el"><table class="grid-table sticky-first"><thead><tr>' +
      '<th style="min-width:150px;">Lookup Name</th>' +
      '<th style="min-width:170px;">Source</th>' +
      '<th style="min-width:150px;">Target</th>' +
      '<th style="min-width:220px;">Legacy value</th>' +
      '<th style="min-width:240px;">Expected GW Values</th>' +
      '<th style="min-width:230px;">Generated Mapping (Legacy---&gt;GW)</th>' +
      '<th style="width:1%;"></th></tr></thead><tbody>' +
    sets.map(s => {
      const src = s.sourceColumn ? ((s.sourceTable ? s.sourceTable + "." : "") + s.sourceColumn) : "";
      const tgt = s.targetColumn ? ((s.targetTable ? s.targetTable + "." : "") + s.targetColumn) : "";
      const noTgt = !(s.targetColumn || "").trim();
      const exp = _expectedValues(s);
      const expHtml = exp.length
        ? '<div class="mono text-xs" style="max-height:96px;overflow:auto;line-height:1.5;">' +
            exp.map(v => escapeHtml(v.code + (v.description ? " — " + v.description : ""))).join("<br>") +
          '</div><div class="text-xs text-muted-2 mt-1">' + exp.length + ' value' + (exp.length === 1 ? "" : "s") + ' from dictionary</div>'
        : '<span class="text-xs text-muted-2">No typelist in the dictionary for this column.</span>';
      const genMapHtml = (s.targetValuesSpec || "").trim()
        ? '<div class="mono text-xs" style="max-height:96px;overflow:auto;line-height:1.5;white-space:pre-wrap;">' +
            escapeHtml(s.targetValuesSpec) + '</div>'
        : '<span class="text-xs text-muted-2">Not generated yet.</span>';
      return '<tr>' +
        '<td class="mono">' + escapeHtml(_lookupDisplayName(s)) + '</td>' +
        '<td class="mono">' + (src ? escapeHtml(src) : dash) + '</td>' +
        '<td class="mono">' + (tgt ? escapeHtml(tgt) : dash) + '</td>' +
        '<td><textarea class="form-control form-control-sm mono" rows="2" data-lk-legacy="' + s.id + '" ' +
          'style="resize:vertical;min-width:220px;" placeholder="e.g. 1 Open, 2 Closed">' +
          escapeHtml(s.legacyValuesSpec || "") + '</textarea></td>' +
        '<td class="wrap" style="max-width:360px;">' + expHtml + '</td>' +
        '<td class="wrap" style="max-width:320px;">' + genMapHtml + '</td>' +
        '<td class="text-end" style="white-space:nowrap;">' +
          '<button class="btn btn-sm btn-primary me-1" data-lk-gen="' + s.id + '" title="Map the Legacy values → this target typelist"' +
            (noTgt ? ' disabled' : '') + '><i class="bi bi-stars me-1"></i>Generate</button>' +
          '<button class="btn btn-sm btn-outline-soft me-1" data-lk-edit="' + s.id + '" title="Edit"><i class="bi bi-pencil"></i></button>' +
          '<button class="btn btn-sm btn-outline-danger" data-lk-del="' + s.id + '" data-lk-name="' + escapeHtml(_lookupDisplayName(s)) + '" title="Delete"><i class="bi bi-trash"></i></button>' +
        '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table></div>';
  list.querySelectorAll("[data-lk-edit]").forEach(b => b.addEventListener("click", () => openLookupEditModal(b.dataset.lkEdit)));
  list.querySelectorAll("[data-lk-del]").forEach(b => b.addEventListener("click", () => deleteLookupSet(b.dataset.lkDel, b.dataset.lkName)));
  list.querySelectorAll("[data-lk-gen]").forEach(b => b.addEventListener("click", () => generateValueMapping(b.dataset.lkGen, b)));
  list.querySelectorAll("[data-lk-legacy]").forEach(t => t.addEventListener("change", () => saveLegacyValues(t.dataset.lkLegacy, t.value)));
}

/* Persist the inline Legacy value box (fire-and-forget; toast only on failure). */
async function saveLegacyValues(id, value){
  const s = (_allLookupSets || []).find(x => String(x.id) === String(id));
  if(s) s.legacyValuesSpec = value;   // keep local copy in sync for Generate
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id), {
      method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ legacyValuesSpec: value })});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok) showNotification((j && j.error) || "Could not save legacy values.", "warning", 2500);
  }catch(e){ showNotification("Cannot reach the server — legacy values not saved.", "warning", 2500); }
}

/* Normalize a typelist / Type-Key name for matching: lowercase, drop Guidewire's
   qualified prefix (typekey./typelist.), then the cctl_/pctl_/bctl_/cc/pc/bc table
   prefix, strip non-alphanumerics. So "typekey.AddressType" and "cctl_addresstype"
   both reduce to "addresstype". */
function _typelistBaseName(v){
  let s = (v || "").toString().toLowerCase().trim();
  s = s.replace(/^(typekey|typelist)[._]?/, "");     // typekey.AddressType -> addresstype
  s = s.replace(/^(cctl|pctl|bctl|cc|pc|bc)_?/, "");
  return s.replace(/[^a-z0-9]/g, "");
}

/* Inline Generate: map this set's Legacy values → its target Guidewire typelist codes. */
async function generateValueMapping(id, btn){
  const s = (_allLookupSets || []).find(x => String(x.id) === String(id));
  if(!s){ showNotification("Lookup set not found — reload the page.", "warning"); return; }
  // Prefer the (possibly-unsaved) textarea value.
  const box = document.querySelector('[data-lk-legacy="' + id + '"]');
  const legacyValues = ((box ? box.value : s.legacyValuesSpec) || "").trim();
  if(!legacyValues){ showNotification("Enter the legacy values first.", "warning"); return; }
  if(!(s.targetColumn || "").trim()){ showNotification("This lookup has no target column to map to.", "warning"); return; }

  // Target codes come from the dictionary index already built for the Expected column.
  const targetCodes = _expectedValues(s).map(v => ({ code: v.code, name: v.description || "" }));
  if(!targetCodes.length){
    showNotification("No Guidewire typelist codes found for '" + (s.targetColumn || s.lookupName) +
      "'. Import its typelist on Product Data Dictionary and set the column's Type Key (Target → AI fill).", "warning", 6000);
    return;
  }

  const html = btn ? btn.innerHTML : "";
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Generating…'; }
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id) + "/generate-values", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ legacyValues, targetCodes })});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ showNotification((j && j.error) || "Generate failed.", "danger", 5000); return; }
    showNotification("Mapped " + (j.mapped || 0) + " of " + (j.saved || 0) + " value(s).", "success", 3000);
    loadLookupSets();
  }catch(e){ showNotification("Cannot reach the server.", "danger"); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = html; } }
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
      '<div class="form-group"><label>Source detail <span class="text-xs text-muted-2">(table.column)</span></label>' +
        '<input type="text" class="form-control mono" id="leSource" placeholder="source_table.source_column"></div>' +
      '<div class="form-group"><label>Legacy value <span class="text-xs text-muted-2">(source system, free text)</span></label>' +
        '<textarea class="form-control mono" id="leLegacy" rows="4" style="resize:vertical;" placeholder="e.g. 1 Open, 2 Closed"></textarea></div>' +
      '<div class="form-group"><label>Generated Mapping <span class="text-xs text-muted-2">(legacy ---&gt; GW value)</span></label>' +
        '<textarea class="form-control mono" id="leSpec" rows="6" style="resize:vertical;white-space:pre-wrap;" placeholder="1 ---&gt; home"></textarea>' +
        '<div class="text-xs text-muted-2 mt-1">One per line, e.g. <span class="mono">1 ---&gt; home</span>. Click <b>Generate</b> on the row to fill this with AI, then adjust here if needed.</div></div>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button type="button" class="btn btn-outline-primary btn-sm me-auto" id="leGenerate" title="Map the Legacy values above → this target typelist"><i class="bi bi-stars me-1"></i> Generate</button>' +
      '<button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="leSave"><i class="bi bi-check2 me-1"></i> Save</button>' +
    '</div></div></div></div>';
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("leSave").addEventListener("click", saveLookupEditModal);
  document.getElementById("leGenerate").addEventListener("click", generateInEditModal);
}

/* Generate the mapping from inside the Edit modal, using the modal's Legacy value box
   and filling its Generated Mapping box (also updates the row behind the modal). */
async function generateInEditModal(){
  const id = _editingLookupId;
  if(!id) return;
  const s = (_allLookupSets || []).find(x => String(x.id) === String(id));
  if(!s){ _leErr("Lookup set not found — reload the page."); return; }
  _leErr(null);
  const legacyEl = document.getElementById("leLegacy");
  const legacy = (legacyEl ? legacyEl.value : "").trim();
  if(!legacy){ _leErr("Enter the legacy values to map first."); return; }
  const targetCodes = _expectedValues(s).map(v => ({ code: v.code, name: v.description || "" }));
  if(!targetCodes.length){
    _leErr("No Guidewire typelist codes found for '" + (s.targetColumn || s.lookupName) +
      "'. Import its typelist (Product Data Dictionary) and set the column's Type Key (Target → AI fill).");
    return;
  }
  const btn = document.getElementById("leGenerate");
  const html = btn ? btn.innerHTML : "";
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Generating…'; }
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id) + "/generate-values", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ legacyValues: legacy, targetCodes })});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ _leErr((j && j.error) || "Generate failed."); return; }
    const specEl = document.getElementById("leSpec");
    if(specEl) specEl.value = j.spec || "";
    s.legacyValuesSpec = legacy;             // keep local copy + row behind the modal in sync
    s.targetValuesSpec = j.spec || "";
    applyLookupFilters();
    showNotification("Mapped " + (j.mapped || 0) + " of " + (j.saved || 0) + " value(s).", "success", 2500);
  }catch(e){ _leErr("Cannot reach the server."); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = html; } }
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
  document.getElementById("leLegacy").value = s.legacyValuesSpec || "";
  document.getElementById("leSpec").value = s.targetValuesSpec || "";
  if(typeof bootstrap !== "undefined"){ new bootstrap.Modal(document.getElementById("lookupEditModal")).show(); }
}

async function saveLookupEditModal(){
  const id = _editingLookupId;
  if(!id) return;
  _leErr(null);
  const raw = (document.getElementById("leSource").value || "").trim();
  const legacy = document.getElementById("leLegacy").value;
  const spec = document.getElementById("leSpec").value;
  const dot = raw.lastIndexOf(".");
  const sourceTable = dot > 0 ? raw.slice(0, dot).trim() : "";
  const sourceColumn = dot > 0 ? raw.slice(dot + 1).trim() : raw;
  const btn = document.getElementById("leSave");
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving…'; }
  try{
    const res = await fetch("/api/lookups/" + encodeURIComponent(id), {
      method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ sourceTable, sourceColumn, legacyValuesSpec: legacy, targetValuesSpec: spec })});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ _leErr((j && j.error) || "Save failed."); return; }
    const m = bootstrap.Modal.getInstance(document.getElementById("lookupEditModal")); if(m) m.hide();
    showNotification("Lookup updated.", "primary", 1500);
    loadLookupSets();
  }catch(e){ _leErr("Cannot reach the server."); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2 me-1"></i> Save'; } }
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

  // The LookupName used in the ETL JOIN filter + LookupData seed = the Guidewire
  // typelist name (so it matches typelist-seeded LookupData across products).
  const lkName = _gwLookupName(s) || s.lookupName;

  m.mappingType = "Lookup";
  // Lookup Table in the "Name: code-target, code-target" shape the workspace/ETL parse.
  m.lookupTable = lkName + (pairs.length ? (": " + pairs.map(p => p.code + "-" + p.target).join(", ")) : "");
  m.transformationRule = pairs.length
    ? ("LOOKUP(" + srcRef + "): " + pairs.map(p => p.code + " → " + p.target).join(", "))
    : (spec ? ("LOOKUP(" + srcRef + "): " + spec.replace(/\s*\n\s*/g, ", ")) : ("Apply lookup '" + lkName + "'"));
  m.businessRule = spec
    ? ("Reference/lookup mapping " + srcRef + " → " + tgtRef + " via '" + lkName + "': " + spec.replace(/\s*\n\s*/g, "; "))
    : ("Reference/lookup mapping " + srcRef + " → " + tgtRef + " via '" + lkName + "'.");
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
