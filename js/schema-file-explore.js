/* =========================================================================
   schema-file-explore.js  (Discover ▸ Schema File Explore)
   Upload a Product schema file (an Excel data dictionary — Claim/Policy/Billing)
   and browse it like the
   Metadata Explorer: a table tree on the left, columns on the right. Re-uploading
   highlights "changes since last upload" exactly like Target System — reusing the
   shared diff engine (snapshotEntities / computeSchemaDiff in target-schema.js).
   The parsed schema + baseline are kept per-client in tenant docs
   aims_cmt_schema / aims_cmt_baseline. "Dismiss" re-baselines to current.
   ========================================================================= */

let _sfe = null;          // {application, fileName, at, entities:[{name,table,fields:[...]}]}
let _sfeDiff = null;      // computeSchemaDiff(baseline, entities) or null
let _sfeActive = null;    // active entity name
let _sfePending = null;   // file awaiting confirm (none needed; kept for symmetry)

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("schema-file-explore.html");
  loadSfe();

  const btn = document.getElementById("sfeUploadBtn");
  const file = document.getElementById("sfeFile");
  if(btn && file) btn.addEventListener("click", () => file.click());
  if(file) file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    if(f) uploadSfe(f);
  });
  const ts = document.getElementById("sfeTreeSearch");
  if(ts) ts.addEventListener("input", renderSfeTree);
  const cs = document.getElementById("sfeColSearch");
  if(cs) cs.addEventListener("input", renderSfeColumns);
});

function sfeOk(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function sfeFail(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }

function loadSfe(){
  _sfe = lsGet("aims_cmt_schema", null);
  const baseline = lsGet("aims_cmt_baseline", null);
  if(_sfe && _sfe.entities && baseline){
    _sfeDiff = computeSchemaDiff(baseline, _sfe.entities);
  } else {
    _sfeDiff = null;
    if(_sfe && _sfe.entities && !baseline){    // first load with data but no baseline -> set silently
      const snap = snapshotEntities(_sfe.entities); snap.at = _sfe.at || null;
      lsSet("aims_cmt_baseline", snap);
    }
  }
  renderSfe();
}

/* Convert extract-source tables -> the entity shape the diff/tree expect. */
function _tablesToEntities(tables){
  return (tables || []).map(t => ({
    name: t.name, table: t.name, isListTable: false,
    fields: (t.columns || []).map(c => ({
      name: c.name, dataType: c.dataType || "", length: (c.length != null ? c.length : null),
      nullable: (c.nullable === undefined ? null : c.nullable),
      mandatory: !!c.mandatory, pk: !!c.pk, fk: !!c.fk, fkReference: c.fkReference || "",
      typeKey: c.typeKey || "", multipleFkType: c.multipleFkType || "",
      businessTerm: c.businessTerm || "", description: c.description || ""
    }))
  }));
}

async function uploadSfe(file){
  const box = document.getElementById("sfeUploadResult");
  if(box) box.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span>Reading ' + escapeHtml(file.name) + '…</div>';
  const fd = new FormData(); fd.append("file", file);
  try{
    const res = await fetch("/api/ai/extract-source", {method:"POST", body: fd});
    const j = await res.json().catch(() => ({}));
    if(!res.ok || !j.ok){ if(box) box.innerHTML = sfeFail((j && j.error) || "Could not read the schema file."); return; }
    const entities = _tablesToEntities(j.tables);
    if(!entities.length){ if(box) box.innerHTML = sfeFail("No tables/columns were found in the file."); return; }
    _sfe = {application: "Product Schema", fileName: file.name, at: new Date().toISOString(), entities: entities};
    lsSet("aims_cmt_schema", _sfe);
    // Baseline stays -> the diff highlights what changed. First-ever upload sets it silently.
    const baseline = lsGet("aims_cmt_baseline", null);
    if(!baseline){ const snap = snapshotEntities(entities); snap.at = _sfe.at; lsSet("aims_cmt_baseline", snap); _sfeDiff = null; }
    else _sfeDiff = computeSchemaDiff(baseline, entities);
    const cc = entities.reduce((n, e) => n + e.fields.length, 0);
    if(box) box.innerHTML = sfeOk("Loaded " + entities.length + " table" + (entities.length === 1 ? "" : "s") +
      " and " + cc + " column" + (cc === 1 ? "" : "s") + " from " + escapeHtml(file.name) +
      (_sfeDiff && _sfeDiff.hasChanges ? ". Changes since your last upload are highlighted below." : "."));
    renderSfe();
  }catch(e){ if(box) box.innerHTML = sfeFail("Cannot reach the server."); }
}

function renderSfe(){
  const has = _sfe && _sfe.entities && _sfe.entities.length;
  const loading = document.getElementById("sfeLoading");
  if(loading) loading.style.display = "none";
  document.getElementById("sfeEmpty").style.display = has ? "none" : "";
  document.getElementById("sfeLayout").style.display = has ? "" : "none";
  if(!has){ renderSfeDiffPanel(); return; }
  const meta = document.getElementById("sfeMeta");
  const cc = _sfe.entities.reduce((n, e) => n + e.fields.length, 0);
  if(meta) meta.innerHTML =
    '<span class="badge-soft badge-high"><i class="bi bi-file-earmark-spreadsheet"></i> ' + escapeHtml(_sfe.fileName || "Schema") + '</span> ' +
    '<span class="badge-soft badge-gray">' + _sfe.entities.length + ' tables</span> ' +
    '<span class="badge-soft badge-gray">' + cc + ' columns</span>';
  renderSfeDiffPanel();
  renderSfeTree();
  if(_sfeActive && _sfe.entities.some(e => e.name === _sfeActive)) selectSfe(_sfeActive);
  else { _sfeActive = null; resetSfeGrid(); }
}

/* ---------------- diff panel ---------------- */
function renderSfeDiffPanel(){
  const panel = document.getElementById("sfeDiffPanel");
  if(!panel) return;
  const d = _sfeDiff;
  if(!d || !d.hasChanges){ panel.style.display = "none"; panel.innerHTML = ""; return; }
  const c = d.counts, chips = [];
  if(c.tablesAdded)     chips.push('<span class="badge-soft badge-high">+' + c.tablesAdded + ' table' + (c.tablesAdded>1?"s":"") + '</span>');
  if(c.tablesRemoved)   chips.push('<span class="badge-soft badge-low">-' + c.tablesRemoved + ' table' + (c.tablesRemoved>1?"s":"") + '</span>');
  if(c.columnsAdded)    chips.push('<span class="badge-soft badge-high">+' + c.columnsAdded + ' col' + (c.columnsAdded>1?"s":"") + '</span>');
  if(c.columnsRenamed)  chips.push('<span class="badge-soft badge-medium">⇄ ' + c.columnsRenamed + ' renamed</span>');
  if(c.columnsModified) chips.push('<span class="badge-soft badge-medium">~' + c.columnsModified + ' changed</span>');
  if(c.columnsRemoved)  chips.push('<span class="badge-soft badge-low">-' + c.columnsRemoved + ' col' + (c.columnsRemoved>1?"s":"") + '</span>');
  const when = d.at ? '<span class="text-xs text-muted-2 ms-2">since ' + escapeHtml(formatDateTime(d.at)) + '</span>' : '';
  const sec = [];
  if(d.tablesAdded.length)     sec.push(_sfeSec("New tables", "badge-high", d.tablesAdded.map(escapeHtml)));
  if(d.tablesRemoved.length)   sec.push(_sfeSec("Removed tables", "badge-low", d.tablesRemoved.map(t => escapeHtml(t.name))));
  if(d.columnsAdded.length)    sec.push(_sfeSec("New columns", "badge-high", d.columnsAdded.map(x => escapeHtml(x.table + "." + x.col))));
  if(d.columnsRenamed.length)  sec.push(_sfeSec("Renamed columns", "badge-medium", d.columnsRenamed.map(x => escapeHtml(x.table + "." + x.from) + ' <span class="text-muted-2">→ ' + escapeHtml(x.to) + '</span>')));
  if(d.columnsModified.length) sec.push(_sfeSec("Changed columns", "badge-medium", d.columnsModified.map(x => escapeHtml(x.table + "." + x.col))));
  if(d.columnsRemoved.length)  sec.push(_sfeSec("Removed columns", "badge-low", d.columnsRemoved.map(x => escapeHtml(x.table + "." + x.col.name))));
  panel.style.display = "";
  panel.innerHTML =
    '<div class="d-flex align-items-center justify-content-between flex-wrap gap-2">' +
      '<div class="section-title mb-0"><i class="bi bi-clock-history"></i> Changes since last upload ' + when + '</div>' +
      '<div class="d-flex align-items-center gap-2 flex-wrap">' + chips.join(" ") +
        '<button type="button" class="btn btn-sm btn-outline-soft" id="sfeDismissBtn" title="Clear the change highlights"><i class="bi bi-check2 me-1"></i> Dismiss</button>' +
      '</div>' +
    '</div>' +
    '<div class="diff-details mt-2">' + sec.join("") + '</div>';
  const db = document.getElementById("sfeDismissBtn");
  if(db) db.addEventListener("click", dismissSfeDiff);
}

function _sfeSec(title, badge, items){
  return '<div class="diff-sec"><span class="badge-soft ' + badge + ' diff-sec-label">' + title + ' (' + items.length + ')</span>' +
    '<ul class="diff-list">' + items.map(i => '<li class="mono">' + i + '</li>').join("") + '</ul></div>';
}

function dismissSfeDiff(){
  if(_sfe && _sfe.entities){ const snap = snapshotEntities(_sfe.entities); snap.at = new Date().toISOString(); lsSet("aims_cmt_baseline", snap); }
  _sfeDiff = null;
  renderSfe();
  showNotification("Change highlights cleared.", "primary", 1400);
}

/* ---------------- tree + column grid ---------------- */
function renderSfeTree(){
  const tree = document.getElementById("sfeTree");
  const title = document.getElementById("sfeTreeTitle");
  const d = _sfeDiff;
  if(title) title.innerHTML = '<i class="bi bi-diagram-3"></i> Tables <span class="text-muted-2 text-xs">(' + _sfe.entities.length + ')</span>';
  const q = ((document.getElementById("sfeTreeSearch") || {}).value || "").trim().toLowerCase();
  const ents = q ? _sfe.entities.filter(e => (e.name || "").toLowerCase().includes(q)) : _sfe.entities;
  let items = ents.map(e => {
    const tl = String(e.name).toLowerCase();
    const st = d && d.entityStatus[tl];
    const cls = st === "added" ? " is-new" : st === "changed" ? " is-changed" : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
               : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    return '<li><div class="tree-node' + cls + ' ' + (e.name === _sfeActive ? "active" : "") + '" data-entity="' + escapeHtml(e.name) + '" title="' + escapeHtml(e.name) + '">' +
      '<i class="bi bi-diagram-2"></i> <span class="tree-name">' + escapeHtml(e.name) + '</span>' +
      '<span class="text-muted-2 text-xs ms-1">(' + e.fields.length + ')</span>' + badge + '</div></li>';
  }).join("");
  if(d && d.tablesRemoved.length){
    d.tablesRemoved.forEach(t => {
      if(q && t.name.toLowerCase().indexOf(q) === -1) return;
      items += '<li><div class="tree-node is-removed" data-ghost="' + escapeHtml(t.name) + '" title="Removed since last upload: ' + escapeHtml(t.name) + '">' +
        '<i class="bi bi-diagram-2"></i> <span class="tree-name">' + escapeHtml(t.name) + '</span> <span class="badge-soft badge-low diff-badge">REMOVED</span></div></li>';
    });
  }
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-box"></i> <span class="tree-name">' + escapeHtml(_sfe.application || "Schema") + '</span></div>' +
      '<ul class="tree-children">' + (items || '<li class="text-xs text-muted-2">No tables match.</li>') + '</ul>' +
    '</li>';
  tree.querySelectorAll("[data-entity]").forEach(n => n.addEventListener("click", () => selectSfe(n.dataset.entity)));
  tree.querySelectorAll("[data-ghost]").forEach(n => n.addEventListener("click", () => selectSfeGhost(n.dataset.ghost)));
}

function resetSfeGrid(){
  const b = document.getElementById("sfeGridBody");
  const t = document.getElementById("sfeTableTitle");
  const d = document.getElementById("sfeTableDesc");
  if(t) t.innerHTML = '<i class="bi bi-table"></i> Select a table';
  if(d) d.textContent = "";
  if(b) b.innerHTML = '<tr><td colspan="5"><div class="empty-state"><i class="bi bi-mouse2"></i><h4>Select a table from the left to view its columns.</h4></div></td></tr>';
}

function selectSfe(name){
  _sfeActive = name;
  document.querySelectorAll("#sfeTree [data-entity]").forEach(n => n.classList.toggle("active", n.dataset.entity === name));
  document.querySelectorAll("#sfeTree [data-ghost]").forEach(n => n.classList.remove("active"));
  const e = _sfe.entities.find(x => x.name === name) || {fields: []};
  const title = document.getElementById("sfeTableTitle");
  if(title) title.innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) + ' <span class="text-muted-2 text-xs">(' + e.fields.length + ' columns)</span>';
  const cs = document.getElementById("sfeColSearch"); if(cs) cs.value = "";
  document.getElementById("sfeTableDesc").textContent = "";
  renderSfeColumns();
}

function selectSfeGhost(name){
  _sfeActive = null;
  document.querySelectorAll("#sfeTree [data-entity],#sfeTree [data-ghost]").forEach(n => n.classList.toggle("active", n.dataset.ghost === name));
  const removed = _sfeDiff && _sfeDiff.tablesRemoved.find(t => t.name === name);
  const cols = removed ? removed.cols : [];
  document.getElementById("sfeTableTitle").innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) + ' <span class="badge-soft badge-low">removed</span>';
  document.getElementById("sfeTableDesc").textContent = "This table was removed since the last upload.";
  const body = document.getElementById("sfeGridBody");
  body.innerHTML = cols.length ? cols.map(c =>
    '<tr class="is-removed"><td class="mono">' + escapeHtml(c.name || "") + '</td>' +
    '<td class="mono">' + escapeHtml(c.dataType || "") + '</td>' +
    '<td>' + (c.mandatory === true ? "No" : c.mandatory === false ? "Yes" : "-") + '</td>' +
    '<td>' + (c.pk ? '<i class="bi bi-key-fill text-warning"></i>' : "-") + '</td>' +
    '<td class="mono">' + (escapeHtml(c.typeKey || "") || "-") + '</td>' +
    '<td class="mono">' + (c.fk ? (escapeHtml(c.fkReference || "") || "Yes") : "-") + '</td>' +
    '<td class="mono">' + (escapeHtml(c.multipleFkType || "") || "-") + '</td></tr>').join("")
    : '<tr><td colspan="7"><div class="empty-state"><i class="bi bi-trash"></i><h4>This table was removed since the last upload.</h4></div></td></tr>';
}

function _sfeChangeMap(tl, name){
  const out = {};
  const mod = _sfeDiff && _sfeDiff.columnsModified.find(m => String(m.table).toLowerCase() === tl && String(m.col).toLowerCase() === String(name).toLowerCase());
  if(mod) mod.changes.forEach(ch => { out[ch.attr] = ch; });
  return out;
}
function _sfeRenameFrom(tl, name){
  const r = _sfeDiff && _sfeDiff.columnsRenamed.find(x => String(x.table).toLowerCase() === tl && String(x.to).toLowerCase() === String(name).toLowerCase());
  return r ? r.from : "";
}

function renderSfeColumns(){
  const body = document.getElementById("sfeGridBody");
  if(!body || _sfeActive === null) return;
  const e = _sfe.entities.find(x => x.name === _sfeActive) || {fields: [], table: ""};
  const tl = String(e.name || "").toLowerCase();
  const d = _sfeDiff;
  const q = ((document.getElementById("sfeColSearch") || {}).value || "").trim().toLowerCase();
  const match = (c) => !q || (c.name || "").toLowerCase().includes(q) || (c.businessTerm || "").toLowerCase().includes(q);

  const yesNo = (v) => v === true ? "Yes" : v === false ? "No" : "-";
  let rows = e.fields.filter(match).map(f => {
    const st = d && d.columnStatus[tl + "::" + String(f.name).toLowerCase()];
    const cls = st === "added" ? "is-new" : (st === "changed" || st === "renamed") ? "is-changed" : "";
    const badge = st === "added" ? ' <span class="badge-soft badge-high diff-badge">NEW</span>'
               : st === "renamed" ? ' <span class="badge-soft badge-medium diff-badge">RENAMED</span>'
               : st === "changed" ? ' <span class="badge-soft badge-medium diff-badge">CHANGED</span>' : '';
    const ch = (st === "changed") ? _sfeChangeMap(tl, f.name) : {};
    const was = (attr, fmt) => ch[attr] ? '<span class="was">was ' + escapeHtml(fmt(ch[attr].from)) + '</span>' : '';
    const hl = (attr) => ch[attr] ? ' cell-changed' : '';
    const rf = st === "renamed" ? _sfeRenameFrom(tl, f.name) : "";
    const isNull = (f.nullable === true ? "Yes" : f.nullable === false ? "No" : "-");
    const fk = f.fk ? (f.fkReference ? escapeHtml(f.fkReference) : "Yes") : "-";
    return '<tr class="' + cls + '">' +
      '<td class="mono' + (st === "renamed" ? " cell-changed" : "") + '">' + escapeHtml(f.name) + badge +
        (rf ? '<span class="was">was ' + escapeHtml(rf) + '</span>' : '') + '</td>' +
      '<td class="mono' + hl("dataType") + '">' + escapeHtml(f.dataType || "") + was("dataType", v => v || "∅") + '</td>' +
      '<td class="' + hl("mandatory").trim() + '">' + isNull + was("mandatory", v => v ? "No" : "Yes") + '</td>' +
      '<td class="' + hl("pk").trim() + '">' + (f.pk ? '<i class="bi bi-key-fill text-warning"></i>' : "-") + was("pk", v => v ? "yes" : "no") + '</td>' +
      '<td class="mono' + hl("typeKey") + '">' + (escapeHtml(f.typeKey || "") || "-") + was("typeKey", v => v || "∅") + '</td>' +
      '<td class="mono' + hl("fk") + hl("fkReference") + '">' + fk + was("fkReference", v => v || "∅") + '</td>' +
      '<td class="mono' + hl("multipleFkType") + '">' + (escapeHtml(f.multipleFkType || "") || "-") + was("multipleFkType", v => v || "∅") + '</td></tr>';
  });

  const removed = (d && d.removedByTable[tl]) ? d.removedByTable[tl].filter(match) : [];
  removed.forEach(c => {
    const note = c._renamedTo ? ' <span class="text-muted-2">→ ' + escapeHtml(c._renamedTo) + '</span>' : '';
    const badge = c._renamedTo ? ' <span class="badge-soft badge-medium diff-badge">RENAMED</span>' : ' <span class="badge-soft badge-low diff-badge">REMOVED</span>';
    rows.push('<tr class="is-removed"><td class="mono">' + escapeHtml(c.name || "") + note + badge + '</td>' +
      '<td class="mono">' + escapeHtml(c.dataType || "") + '</td>' +
      '<td>' + (c.mandatory === true ? "No" : c.mandatory === false ? "Yes" : "-") + '</td>' +
      '<td>' + (c.pk ? '<i class="bi bi-key-fill text-warning"></i>' : "-") + '</td>' +
      '<td class="mono">' + (escapeHtml(c.typeKey || "") || "-") + '</td>' +
      '<td class="mono">' + (c.fk ? (escapeHtml(c.fkReference || "") || "Yes") : "-") + '</td>' +
      '<td class="mono">' + (escapeHtml(c.multipleFkType || "") || "-") + '</td></tr>');
  });

  if(!rows.length){
    body.innerHTML = q
      ? '<tr><td colspan="7"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching columns</h4></div></td></tr>'
      : '<tr><td colspan="7"><div class="empty-state"><i class="bi bi-inbox"></i><h4>No columns in this table.</h4></div></td></tr>';
    return;
  }
  body.innerHTML = rows.join("");
}
