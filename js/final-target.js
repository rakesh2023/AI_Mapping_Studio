/* =========================================================================
   final-target.js — the "Target System" page (the downstream, final schema).

   Upload a data dictionary -> AI-extract tables/columns -> store as the single
   Target schema (aims_final_target, via target-schema.js helpers). Browse it as
   an entity tree + fields grid. Re-uploading replaces it. The Visual Mapping
   page maps the Staging Area INTO this Target.

   Only CSV or Excel is accepted, and the file is ALWAYS extracted by the AI on
   the server (never parsed in the browser).
   Reuses: streamExtractFile + renderExtractProgress (common.js),
   extractedToEntities (target-schema.js).
   ========================================================================= */

let ftActiveEntity = null;

/* note helpers (target-system.js defines its own; this page needs local copies) */
function okNote(msg){ return '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> ' + msg + '</div>'; }
function failNote(msg){ return '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(msg) + '</div>'; }

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("final-target.html");
  document.getElementById("ftExtractBtn").addEventListener("click", ftExtract);
  document.getElementById("ftSearch").addEventListener("input", debounce(ftRenderFields, 150));
  ftRenderBrowser();
});

const FT_ALLOWED = ["csv", "xlsx", "xls"];

async function ftExtract(){
  const input = document.getElementById("ftFile");
  const el = document.getElementById("ftResult");
  const file = input.files && input.files[0];
  if(!file){ el.innerHTML = failNote("Choose a CSV or Excel file first."); return; }
  const ext = file.name.split(".").pop().toLowerCase();
  if(FT_ALLOWED.indexOf(ext) === -1){
    el.innerHTML = failNote("Only CSV or Excel files are supported here (.csv, .xlsx, .xls).");
    input.value = "";
    return;
  }
  el.innerHTML = '<div class="text-xs text-muted-2"><span class="spinner-border spinner-border-sm me-2"></span> Reading ' + escapeHtml(file.name) + '...</div>';

  try{
    // Always AI-extract on the server (never parse in the browser), using the rich
    // TARGET pipeline that captures PK/FK, descriptions and polymorphic FKs.
    const out = await streamExtractFile(file, (evt) => {
      if(evt.type === "start"){
        el.innerHTML = renderExtractProgress(0, evt.chunks || 0, 0, 0, "Starting…", evt.unit || "parts");
      } else if(evt.type === "progress"){
        el.innerHTML = renderExtractProgress(evt.done, evt.total, evt.tables, evt.columns, evt.label || "", "");
      }
    }, {base: "/api/ai/extract-target"});
    const entities = extractedToEntities(out.tables);
    const srcName = out.fileName || file.name;
    if(!entities || !entities.length){ el.innerHTML = failNote("No tables/columns could be read from the file."); return; }

    const cols = entities.reduce((a, e) => a + (e.fields || []).length, 0);
    const schema = {
      application: srcName.replace(/\.[^.]+$/, "") || "Target",
      version: "From file",
      sourceFileName: srcName,
      uploadedAt: new Date().toISOString(),
      tableCount: entities.length,
      columnCount: cols,
      entities: entities
    };
    try{ setFinalTarget(schema); }
    catch(err){ el.innerHTML = failNote("Could not save the Target (browser storage full?): " + (err.message || err)); return; }

    el.innerHTML = okNote("Loaded " + entities.length + " tables, " + cols + " columns as the Target from " + escapeHtml(srcName) + ".");
    input.value = "";
    ftRenderBrowser();
  }catch(err){
    el.innerHTML = failNote(err.message || "Could not read the file.");
  }
}

/* ---- browse the stored Target (entity tree + fields grid) ---- */
function ftRenderBrowser(){
  const meta = getFinalTarget();
  const has = meta && meta.entities && meta.entities.length;
  document.getElementById("ftActiveBar").style.display = has ? "" : "none";
  document.getElementById("ftBrowseLayout").style.display = has ? "" : "none";
  document.getElementById("ftEmptyState").style.display = has ? "none" : "";
  if(!has) return;

  document.getElementById("ftSchemaMeta").innerHTML =
    '<span class="badge-soft badge-high"><i class="bi bi-bullseye"></i> ' + escapeHtml(meta.application || "Target") + '</span> ' +
    '<span class="badge-soft badge-gray">' + escapeHtml(meta.version || "") + '</span> ' +
    '<span class="badge-soft badge-gray">' + meta.tableCount + ' tables</span> ' +
    '<span class="badge-soft badge-gray">' + meta.columnCount + ' columns</span>';

  const tree = document.getElementById("ftTree");
  tree.innerHTML =
    '<li><div class="tree-node"><i class="bi bi-box"></i> ' + escapeHtml(meta.application || "Target Schema") + '</div>' +
      '<ul class="tree-children">' +
        meta.entities.map(e => '<li><div class="tree-node" data-ftentity="' + escapeHtml(e.name) + '"><i class="bi bi-diagram-2"></i> ' + escapeHtml(e.name) + '</div></li>').join("") +
      '</ul>' +
    '</li>';
  tree.querySelectorAll("[data-ftentity]").forEach(n => n.addEventListener("click", () => ftSelectEntity(n.dataset.ftentity)));

  ftSelectEntity(meta.entities[0].name);
}

function ftSelectEntity(name){
  const meta = getFinalTarget();
  ftActiveEntity = (meta.entities || []).find(e => e.name === name);
  if(!ftActiveEntity) return;
  document.querySelectorAll("[data-ftentity]").forEach(n => n.classList.toggle("active", n.dataset.ftentity === name));
  document.getElementById("ftTitle").innerHTML = '<i class="bi bi-table"></i> ' + escapeHtml(name) +
    ' <span class="text-muted-2 text-xs">(' + escapeHtml(ftActiveEntity.table || name) + ')</span>';
  ftRenderFields();
}

/* FK cell: normal FK shows the reference; a polymorphic FK gets a badge plus its
   discriminator column and the list of possible target tables. */
function ftFkCell(f){
  if(f.polymorphic){
    const types = (f.possibleTypes || []).join(", ");
    return '<span class="badge-soft badge-medium" title="Polymorphic foreign key">' +
        '<i class="bi bi-diagram-3"></i> Polymorphic FK</span>' +
      (f.typeColumn ? '<div class="text-xs text-muted-2 mt-1">by <span class="mono">' + escapeHtml(f.typeColumn) + '</span></div>' : "") +
      (types ? '<div class="text-xs mono" style="white-space:normal;">&rarr; ' + escapeHtml(types) + '</div>' : "");
  }
  if(f.fk){
    return '<i class="bi bi-link-45deg text-primary" title="Foreign Key"></i>' +
      (f.fkReference ? ' <span class="text-xs mono">' + escapeHtml(f.fkReference) + '</span>' : "");
  }
  return "";
}

function ftRenderFields(){
  if(!ftActiveEntity) return;
  const search = (document.getElementById("ftSearch").value || "").toLowerCase();
  const fields = (ftActiveEntity.fields || []).filter(f => !search || f.name.toLowerCase().indexOf(search) !== -1);
  const body = document.getElementById("ftFieldsBody");
  if(!fields.length){
    body.innerHTML = '<tr><td colspan="12"><div class="empty-state"><i class="bi bi-search"></i><h4>No matching fields</h4></div></td></tr>';
    return;
  }
  body.innerHTML = fields.map(f =>
    '<tr>' +
      '<td>' + escapeHtml(ftActiveEntity.name) + '</td>' +
      '<td class="mono">' + escapeHtml(ftActiveEntity.table || "") + '</td>' +
      '<td class="mono">' + escapeHtml(f.name) + '</td>' +
      '<td>' + escapeHtml(f.dataType || "") + '</td>' +
      '<td>' + (f.length ?? "-") + '</td>' +
      '<td>' + (f.mandatory ? '<span class="badge-soft badge-low">Required</span>' : '<span class="badge-soft badge-gray">Optional</span>') + '</td>' +
      '<td>' + (f.pk ? '<i class="bi bi-key-fill text-warning" title="Primary Key"></i>' : "") + '</td>' +
      '<td>' + ftFkCell(f) + '</td>' +
      '<td class="wrap">' + escapeHtml(f.description || "") + '</td>' +
      '<td>' + escapeHtml(f.businessTerm || "-") + '</td>' +
      '<td class="wrap">' + escapeHtml(f.accepted || "-") + '</td>' +
      '<td>' + escapeHtml(f.default ?? "-") + '</td>' +
    '</tr>'
  ).join("");
}
