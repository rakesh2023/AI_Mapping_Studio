/* =========================================================================
   lookup-data-system.js  (Setup ▸ Lookup Data System)
   Upload a Guidewire HTML dictionary (zip) — pick the product, its typelists
   import as lookup sets — then browse it like the Metadata Explorer: a table
   tree on the left, and the selected table's typecode VALUES in a grid on the
   right. "Changes since last import" are highlighted (mirrors Target System):
   added / removed / changed / renamed typelists & typecodes, with a diff panel
   and NEW/CHANGED/REMOVED badges. Self-contained (doesn't touch AI Lookup
   Mapping). Baseline snapshot is kept per-client in the tenant doc
   aims_lookup_baseline; "Dismiss" re-baselines to the current state.
   ========================================================================= */

let _ldsSnap = {at: null, sets: []};   // current snapshot (sets WITH values)
let _ldsValues = {};                   // id -> values[] (from the snapshot)
let _ldsDiff = null;                   // computed diff vs baseline, or null
let _ldsActiveId = null;
let _ldsPendingFile = null;

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("lookup-data-system.html");
  loadLds();

  const btn = document.getElementById("ldsUploadBtn");
  const file = document.getElementById("ldsFile");
  if(btn && file) btn.addEventListener("click", () => file.click());
  if(file) file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    if(!f) return;
    if(/\.(zip|html?)$/i.test(f.name)) openLdsProductModal(f);
    else uploadLds(f);
  });
  const tsearch = document.getElementById("ldsTreeSearch");
  if(tsearch) tsearch.addEventListener("input", renderLdsTree);
  const csearch = document.getElementById("ldsCodeSearch");
  if(csearch) csearch.addEventListener("input", renderLdsCodes);
});

function ldsOk(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function ldsFail(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }

async function loadLds(){
  const layout = document.getElementById("ldsLayout");
  const disabled = document.getElementById("ldsDisabledCard");
  const loading = document.getElementById("ldsLoading");
  const tree = document.getElementById("ldsTree");
  if(!layout || !tree) return;
  const hideLoading = () => { if(loading) loading.style.display = "none"; };
  try{
    const res = await fetch("/api/lookups/snapshot", {headers:{Accept:"application/json"}});
    hideLoading();
    if(res.status === 404){ layout.style.display = "none"; if(disabled) disabled.style.display = ""; return; }
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){
      layout.style.display = "";
      tree.innerHTML = '<li class="text-xs text-danger">' + escapeHtml(j.error || "Could not load lookup data.") + '</li>';
      return;
    }
    layout.style.display = "";
    if(disabled) disabled.style.display = "none";
    // Show only REAL typelist tables — ones that actually carry typecodes. This hides the
    // empty cs_TABLE_COLUMN placeholder sets (0 codes) so only genuine typelists appear.
    const realTypelist = (s) => ((s.values && s.values.length > 0) || (s.valueCount || 0) > 0);
    _ldsSnap = {at: j.at || null, sets: (j.sets || []).filter(realTypelist)};
    _ldsValues = {};
    _ldsSnap.sets.forEach(s => { _ldsValues[s.id] = s.values || []; });

    // Diff vs the stored baseline. First time (no baseline) -> set it silently.
    const baseline = lsGet("aims_lookup_baseline", null);
    if(!baseline){ lsSet("aims_lookup_baseline", _slimSnap(_ldsSnap)); _ldsDiff = null; }
    else _ldsDiff = computeLookupDiff(baseline, _ldsSnap);

    renderLdsDiffPanel();
    renderLdsTree();
    // Keep the current selection if it still exists.
    if(_ldsActiveId && _ldsSnap.sets.some(s => String(s.id) === String(_ldsActiveId))) selectLdsTable(_ldsActiveId);
    else { _ldsActiveId = null; resetLdsGrid(); }
  }catch(e){ hideLoading(); layout.style.display = ""; tree.innerHTML = '<li class="text-xs text-muted-2">Cannot reach the server.</li>'; }
}

/* ---------------- diff engine (typelist = table, typecode = column) ---------------- */
function _slimSnap(snap){
  const tables = {};
  (snap.sets || []).forEach(s => {
    const codes = {};
    (s.values || []).forEach(v => { if(v && v.code) codes[String(v.code).toLowerCase()] = {code: v.code, description: v.description || ""}; });
    tables[String(s.lookupName || "").toLowerCase()] = {name: s.lookupName || "", codes: codes};
  });
  return {at: snap.at || null, tables: tables};
}

function computeLookupDiff(baseline, currSnap){
  const diff = {
    tablesAdded: [], tablesRemoved: [], codesAdded: [], codesRemoved: [], codesChanged: [], codesRenamed: [],
    tableStatus: {}, codeStatus: {}, removedByTable: {},
    counts: {tablesAdded:0, tablesRemoved:0, codesAdded:0, codesRemoved:0, codesChanged:0, codesRenamed:0},
    hasChanges: false, at: (baseline && baseline.at) || null
  };
  if(!baseline || !baseline.tables) return diff;
  const prev = baseline.tables;
  const curr = _slimSnap(currSnap).tables;
  const norm = (v) => (v == null ? "" : String(v).trim().toLowerCase());

  Object.keys(curr).forEach(tl => {
    if(!prev[tl]){
      diff.tablesAdded.push(curr[tl].name);
      diff.tableStatus[tl] = "added";
      Object.keys(curr[tl].codes).forEach(cl => { diff.codeStatus[tl + "::" + cl] = "added"; });
    }
  });
  Object.keys(prev).forEach(tl => {
    if(!curr[tl]){
      const codes = Object.keys(prev[tl].codes).map(cl => prev[tl].codes[cl]);
      diff.tablesRemoved.push({name: prev[tl].name, codes: codes});
      diff.tableStatus[tl] = "removed";
      diff.removedByTable[tl] = codes;
    }
  });
  Object.keys(curr).forEach(tl => {
    if(!prev[tl]) return;
    const pc = prev[tl].codes, cc = curr[tl].codes, tname = curr[tl].name;
    let changedHere = false;
    const addedCl = [], removedCl = [];
    Object.keys(cc).forEach(cl => {
      if(!pc[cl]) addedCl.push(cl);
      else if(norm(pc[cl].description) !== norm(cc[cl].description)){
        diff.codesChanged.push({table: tname, code: cc[cl].code, from: pc[cl].description, to: cc[cl].description});
        diff.codeStatus[tl + "::" + cl] = "changed"; changedHere = true;
      }
    });
    Object.keys(pc).forEach(cl => { if(!cc[cl]) removedCl.push(cl); });

    // Rename: a removed + an added code sharing the same non-empty description, unique on both sides.
    const remBySig = {}, addBySig = {};
    removedCl.forEach(cl => { const k = norm(pc[cl].description); if(k){ (remBySig[k] = remBySig[k] || []).push(cl); } });
    addedCl.forEach(cl => { const k = norm(cc[cl].description); if(k){ (addBySig[k] = addBySig[k] || []).push(cl); } });
    const renRem = {}, renAdd = {};
    Object.keys(remBySig).forEach(k => {
      if(remBySig[k].length === 1 && addBySig[k] && addBySig[k].length === 1){
        const oldCl = remBySig[k][0], newCl = addBySig[k][0];
        renRem[oldCl] = true; renAdd[newCl] = true;
        diff.codesRenamed.push({table: tname, from: pc[oldCl].code, to: cc[newCl].code});
        diff.codeStatus[tl + "::" + newCl] = "renamed";
        diff.removedByTable[tl] = diff.removedByTable[tl] || [];
        diff.removedByTable[tl].push(Object.assign({}, pc[oldCl], {_renamedTo: cc[newCl].code}));
        changedHere = true;
      }
    });
    addedCl.forEach(cl => {
      if(renAdd[cl]) return;
      diff.codesAdded.push({table: tname, code: cc[cl].code});
      diff.codeStatus[tl + "::" + cl] = "added"; changedHere = true;
    });
    const removedPlain = [];
    removedCl.forEach(cl => {
      if(renRem[cl]) return;
      diff.codesRemoved.push({table: tname, code: pc[cl]}); removedPlain.push(pc[cl]); changedHere = true;
    });
    if(removedPlain.length) diff.removedByTable[tl] = (diff.removedByTable[tl] || []).concat(removedPlain);
    if(changedHere && diff.tableStatus[tl] !== "added") diff.tableStatus[tl] = "changed";
  });

  const c = diff.counts;
  c.tablesAdded = diff.tablesAdded.length; c.tablesRemoved = diff.tablesRemoved.length;
  c.codesAdded = diff.codesAdded.length; c.codesRemoved = diff.codesRemoved.length;
  c.codesChanged = diff.codesChanged.length; c.codesRenamed = diff.codesRenamed.length;
  diff.hasChanges = Object.values(c).some(n => n > 0);
  return diff;
}

function renderLdsDiffPanel(){
  const panel = document.getElementById("ldsDiffPanel");
  if(!panel) return;
  const d = _ldsDiff;
  if(!d || !d.hasChanges){ panel.style.display = "none"; panel.innerHTML = ""; return; }
  const c = d.counts, chips = [];
  if(c.tablesAdded)   chips.push('<span class="badge-soft badge-high">+' + c.tablesAdded + ' table' + (c.tablesAdded>1?"s":"") + '</span>');
  if(c.tablesRemoved) chips.push('<span class="badge-soft badge-low">-' + c.tablesRemoved + ' table' + (c.tablesRemoved>1?"s":"") + '</span>');
  if(c.codesAdded)    chips.push('<span class="badge-soft badge-high">+' + c.codesAdded + ' code' + (c.codesAdded>1?"s":"") + '</span>');
  if(c.codesRenamed)  chips.push('<span class="badge-soft badge-medium">⇄ ' + c.codesRenamed + ' renamed</span>');
  if(c.codesChanged)  chips.push('<span class="badge-soft badge-medium">~' + c.codesChanged + ' changed</span>');
  if(c.codesRemoved)  chips.push('<span class="badge-soft badge-low">-' + c.codesRemoved + ' code' + (c.codesRemoved>1?"s":"") + '</span>');
  const when = d.at ? '<span class="text-xs text-muted-2 ms-2">since ' + escapeHtml(formatDateTime(d.at)) + '</span>' : '';
  const sec = [];
  if(d.tablesAdded.length)   sec.push(_ldsSec("New tables", "badge-high", d.tablesAdded.map(escapeHtml)));
  if(d.tablesRemoved.length) sec.push(_ldsSec("Removed tables", "badge-low", d.tablesRemoved.map(t => escapeHtml(t.name))));
  if(d.codesAdded.length)    sec.push(_ldsSec("New codes", "badge-high", d.codesAdded.map(x => escapeHtml(x.table + "." + x.code))));
  if(d.codesRenamed.length)  sec.push(_ldsSec("Renamed codes", "badge-medium", d.codesRenamed.map(x => escapeHtml(x.table + "." + x.from) + ' <span class="text-muted-2">→ ' + escapeHtml(x.to) + '</span>')));
  if(d.codesChanged.length)  sec.push(_ldsSec("Changed descriptions", "badge-medium", d.codesChanged.map(x => escapeHtml(x.table + "." + x.code))));
  if(d.codesRemoved.length)  sec.push(_ldsSec("Removed codes", "badge-low", d.codesRemoved.map(x => escapeHtml(x.table + "." + x.code.code))));
  panel.style.display = "";
  panel.innerHTML =
    '<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">' +
      '<div class="section-title mb-0"><i class="bi bi-clock-history"></i> Changes since last import ' + when + '</div>' +
      '<div class="d-flex align-items-center gap-2 flex-wrap">' + chips.join(" ") +
        '<button type="button" class="btn btn-sm btn-outline-soft" id="ldsDismissBtn" title="Clear the change highlights"><i class="bi bi-check2 me-1"></i> Dismiss</button>' +
      '</div>' +
    '</div>' +
    '<div class="diff-details mt-2">' + sec.join("") + '</div>';
  const db = document.getElementById("ldsDismissBtn");
  if(db) db.addEventListener("click", dismissLdsDiff);
}

function _ldsSec(title, badge, items){
  return '<div class="diff-sec"><span class="badge-soft ' + badge + ' diff-sec-label">' + title + ' (' + items.length + ')</span>' +
    '<ul class="diff-list">' + items.map(i => '<li class="mono">' + i + '</li>').join("") + '</ul></div>';
}

function dismissLdsDiff(){
  lsSet("aims_lookup_baseline", _slimSnap(_ldsSnap));
  _ldsDiff = null;
  renderLdsDiffPanel();
  renderLdsTree();
  if(_ldsActiveId) selectLdsTable(_ldsActiveId);
  showNotification("Change highlights cleared.", "primary", 1400);
}

/* ---------------- tree + grid ---------------- */
function renderLdsTree(){
  const tree = document.getElementById("ldsTree");
  const title = document.getElementById("ldsTreeTitle");
  const total = _ldsSnap.sets.length;
  if(title) title.innerHTML = '<i class="bi bi-diagram-3"></i> Lookup Tables <span class="text-muted-2 text-xs">(' + total + ')</span>';
  const d = _ldsDiff;
  if(!total && !(d && d.tablesRemoved.length)){
    tree.innerHTML = '<li class="text-xs text-muted-2">No lookup data yet. Upload a Guidewire dictionary (.zip) to import its typelists.</li>';
    return;
  }
  const q = ((document.getElementById("ldsTreeSearch") || {}).value || "").trim().toLowerCase();
  const rows = q ? _ldsSnap.sets.filter(s => (s.lookupName || "").toLowerCase().includes(q)) : _ldsSnap.sets;
  let items = rows.map(s => {
    const tl = String(s.lookupName || "").toLowerCase();
    const st = d && d.tableStatus[tl];
    const cls = st === "added" ? " is-new" : st === "changed" ? " is-changed" : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
               : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    return '<li><div class="tree-node' + cls + ' ' + (String(s.id) === String(_ldsActiveId) ? "active" : "") + '" data-id="' + s.id + '" title="' + escapeHtml(s.lookupName) + '">' +
      '<i class="bi bi-table"></i> <span class="tree-name">' + escapeHtml(s.lookupName) + '</span>' +
      '<span class="text-muted-2 text-xs ms-1">(' + (s.valueCount || 0) + ')</span>' + badge +
    '</div></li>';
  }).join("");
  // Ghost nodes for removed typelists.
  if(d && d.tablesRemoved.length){
    d.tablesRemoved.forEach(t => {
      if(q && t.name.toLowerCase().indexOf(q) === -1) return;
      items += '<li><div class="tree-node is-removed" data-ghost="' + escapeHtml(t.name) + '" title="Removed since last import: ' + escapeHtml(t.name) + '">' +
        '<i class="bi bi-table"></i> <span class="tree-name">' + escapeHtml(t.name) + '</span> <span class="badge-soft badge-low diff-badge">REMOVED</span></div></li>';
    });
  }
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-collection"></i> <span class="tree-name">Typelists</span></div>' +
      '<ul class="tree-children">' + (items || '<li class="text-xs text-muted-2">No tables match.</li>') + '</ul>' +
    '</li>';
  tree.querySelectorAll("[data-id]").forEach(n => n.addEventListener("click", () => selectLdsTable(n.dataset.id)));
  tree.querySelectorAll("[data-ghost]").forEach(n => n.addEventListener("click", () => selectLdsGhost(n.dataset.ghost)));
}

function resetLdsGrid(){
  const body = document.getElementById("ldsGridBody");
  const title = document.getElementById("ldsTableTitle");
  const desc = document.getElementById("ldsTableDesc");
  if(title) title.innerHTML = '<i class="bi bi-card-checklist"></i> Select a table';
  if(desc) desc.textContent = "";
  if(body) body.innerHTML = '<tr><td colspan="3"><div class="empty-state"><i class="bi bi-mouse2"></i><h4>Select a table from the left to view its typecodes.</h4></div></td></tr>';
}

function selectLdsTable(id){
  _ldsActiveId = id;
  document.querySelectorAll("#ldsTree [data-id]").forEach(n => n.classList.toggle("active", String(n.dataset.id) === String(id)));
  document.querySelectorAll("#ldsTree [data-ghost]").forEach(n => n.classList.remove("active"));
  const s = _ldsSnap.sets.find(x => String(x.id) === String(id)) || {};
  const title = document.getElementById("ldsTableTitle");
  const desc = document.getElementById("ldsTableDesc");
  if(title) title.innerHTML = '<i class="bi bi-card-checklist"></i> ' + escapeHtml(s.lookupName || "") +
    ' <span class="text-muted-2 text-xs">(' + (s.valueCount || 0) + ' code' + (s.valueCount === 1 ? "" : "s") + ')</span>';
  const bits = [];
  if(s.sourceColumn) bits.push("source " + (s.sourceTable ? s.sourceTable + "." : "") + s.sourceColumn);
  if(s.targetColumn) bits.push("target " + (s.targetTable ? s.targetTable + "." : "") + s.targetColumn);
  if(desc) desc.textContent = bits.join("  ·  ");
  const cs = document.getElementById("ldsCodeSearch"); if(cs) cs.value = "";
  renderLdsCodes();
}

/* Show a removed typelist (ghost) — its former codes as read-only removed rows. */
function selectLdsGhost(name){
  _ldsActiveId = null;
  document.querySelectorAll("#ldsTree [data-id],#ldsTree [data-ghost]").forEach(n => n.classList.toggle("active", n.dataset.ghost === name));
  const title = document.getElementById("ldsTableTitle");
  const desc = document.getElementById("ldsTableDesc");
  const removed = _ldsDiff && _ldsDiff.tablesRemoved.find(t => t.name === name);
  const codes = removed ? removed.codes : [];
  if(title) title.innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) + ' <span class="badge-soft badge-low">removed</span>';
  if(desc) desc.textContent = "This typelist was removed since the last import.";
  const body = document.getElementById("ldsGridBody");
  body.innerHTML = codes.length ? codes.map((v, i) =>
    '<tr class="is-removed"><td class="mono">' + (i + 1) + '</td><td class="mono">' + escapeHtml(v.code || "") +
    '</td><td class="wrap">' + (escapeHtml(v.description || "") || "—") + '</td></tr>').join("")
    : '<tr><td colspan="3"><div class="empty-state"><i class="bi bi-trash"></i><h4>This typelist was removed since the last import.</h4></div></td></tr>';
}

function renderLdsCodes(){
  const body = document.getElementById("ldsGridBody");
  if(!body || _ldsActiveId === null) return;
  const s = _ldsSnap.sets.find(x => String(x.id) === String(_ldsActiveId)) || {};
  const tl = String(s.lookupName || "").toLowerCase();
  const values = _ldsValues[_ldsActiveId] || [];
  const d = _ldsDiff;
  const q = ((document.getElementById("ldsCodeSearch") || {}).value || "").trim().toLowerCase();
  const match = (v) => !q || (v.code || "").toLowerCase().includes(q) || (v.description || "").toLowerCase().includes(q);

  let rows = values.filter(match).map((v, i) => {
    const st = d && d.codeStatus[tl + "::" + String(v.code).toLowerCase()];
    const cls = st === "added" || st === "renamed" ? " is-new" : st === "changed" ? " is-changed" : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
               : st === "renamed" ? ' <span class="badge-soft badge-high diff-badge">RENAMED</span>'
               : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    return '<tr class="' + cls.trim() + '"><td class="mono">' + (i + 1) + '</td>' +
      '<td class="mono">' + escapeHtml(v.code || "") + badge + '</td>' +
      '<td class="wrap">' + (escapeHtml(v.description || "") || '<span class="text-muted-2">—</span>') + '</td></tr>';
  });

  // Ghost rows for removed / renamed-away codes in this table.
  const removed = (d && d.removedByTable[tl]) ? d.removedByTable[tl].filter(match) : [];
  removed.forEach(v => {
    const note = v._renamedTo ? ' <span class="text-muted-2">→ ' + escapeHtml(v._renamedTo) + '</span>' : '';
    const badge = v._renamedTo ? ' <span class="badge-soft badge-medium diff-badge">RENAMED</span>' : ' <span class="badge-soft badge-low diff-badge">REMOVED</span>';
    rows.push('<tr class="is-removed"><td class="mono">–</td><td class="mono">' + escapeHtml(v.code || "") + note + badge +
      '</td><td class="wrap">' + (escapeHtml(v.description || "") || "—") + '</td></tr>');
  });

  if(!rows.length){
    body.innerHTML = q
      ? '<tr><td colspan="3"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching codes</h4></div></td></tr>'
      : '<tr><td colspan="3"><div class="empty-state"><i class="bi bi-inbox"></i><h4>No typecode values captured for this table.</h4></div></td></tr>';
    return;
  }
  body.innerHTML = rows.join("");
}

/* ---------------- upload (Guidewire dictionary asks the product first) ---------------- */
function injectLdsProductModal(){
  if(document.getElementById("ldsProductModal")) return;
  const html =
    '<div class="modal fade" id="ldsProductModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-dialog-centered">' +
    '<div class="modal-content"><div class="modal-header">' +
      '<h5 class="modal-title"><i class="bi bi-box-seam me-1"></i> Import Guidewire dictionary</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>' +
    '<div class="modal-body">' +
      '<p class="text-xs text-muted-2 mb-2">Which product is this dictionary? Only that product’s <b>typelists</b> (code lists) will be imported.</p>' +
      '<div class="form-group"><label>Product</label>' +
        '<select class="form-select" id="ldsProduct">' +
          '<option value="claim">ClaimCenter — cctl_* typelists</option>' +
          '<option value="policy">PolicyCenter — pctl_* typelists</option>' +
          '<option value="billing">BillingCenter — bctl_* typelists</option>' +
        '</select></div>' +
      '<div class="text-xs text-muted-2" id="ldsProductFile"></div>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button type="button" class="btn btn-outline-soft btn-sm" data-bs-dismiss="modal">Cancel</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="ldsProductImport"><i class="bi bi-upload me-1"></i> Import</button>' +
    '</div></div></div></div>';
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("ldsProductImport").addEventListener("click", () => {
    const product = (document.getElementById("ldsProduct") || {}).value || "claim";
    const m = bootstrap.Modal.getInstance(document.getElementById("ldsProductModal")); if(m) m.hide();
    if(_ldsPendingFile){ uploadLds(_ldsPendingFile, product); _ldsPendingFile = null; }
  });
}

function openLdsProductModal(file){
  injectLdsProductModal();
  _ldsPendingFile = file;
  const fn = document.getElementById("ldsProductFile");
  if(fn) fn.textContent = "File: " + file.name;
  if(typeof bootstrap !== "undefined"){ new bootstrap.Modal(document.getElementById("ldsProductModal")).show(); }
}

async function uploadLds(file, product){
  const box = document.getElementById("ldsUploadResult");
  if(box) box.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span>Importing ' + escapeHtml(file.name) + '…</div>';
  const fd = new FormData(); fd.append("file", file);
  if(product) fd.append("product", product);
  try{
    const res = await fetch("/api/lookups/upload", {method:"POST", body: fd});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ if(box) box.innerHTML = ldsFail((j && j.error) || "Import failed."); return; }
    if(box) box.innerHTML = ldsOk("Imported " + j.created + " table" + (j.created === 1 ? "" : "s") +
      " (" + j.totalValues + " typecode value" + (j.totalValues === 1 ? "" : "s") +
      (j.skippedRows ? ", " + j.skippedRows + " skipped" : "") + ")." +
      (j.dictTables ? " Stored column descriptions for " + j.dictTables + " table(s) — used by Target System → AI fill." : "") +
      " Changes since your last import are highlighted below.");
    loadLds();   // baseline stays -> the diff highlights what this import changed
  }catch(e){ if(box) box.innerHTML = ldsFail("Cannot reach the server."); }
}
