/* =========================================================================
   visual-mapping.js — Visual drag-and-drop mapping: Staging Area -> Target.

   Left column  = active Staging Area fields (getTargetSchema).
   Right column = Target fields (getFinalTarget).
   Drag a left anchor to a right anchor to create a link (any cardinality).
   Click a connector line to set mapping type / transformation or delete it.
   Links persist in localStorage (aims_final_mappings). "Auto-map with AI"
   asks the backend to propose links (see P3 endpoint).
   ========================================================================= */

const SVGNS = "http://www.w3.org/2000/svg";
const VM_KEY = "aims_final_mappings";
const VM_TYPES = ["Direct","Derived","Lookup","Conditional","Constant","Default",
  "Concatenation","Split","Format Conversion","Data Type Conversion","Calculation",
  "Aggregation","Reference","Custom","Not Mapped"];

let vmStaging = null, vmTarget = null;
let vmLinks = [];
let vmDrag = null;          // active drag state
let vmActiveLinkId = null;  // link open in the popover
const vmAnchors = { left: {}, right: {} };   // key -> anchor element

function vmKey(entity, col){ return String(entity) + "::" + String(col); }
function vmGetLinks(){ return lsGet(VM_KEY, []) || []; }
function vmSaveLinks(){ lsSet(VM_KEY, vmLinks); }

document.addEventListener("DOMContentLoaded", async () => {
  await initShell("visual-mapping.html");
  vmStaging = getTargetSchema();
  vmTarget = getFinalTarget();
  vmLinks = vmGetLinks();

  wireVm();
  if(!vmReady()){ vmShowEmpty(); return; }
  vmInitInstructions();
  vmPopulateTableSelects();
  vmRenderColumns();
  vmRedraw();
});

const VM_INSTR_KEY = "aims_final_map_instructions";        // additional instructions
const VM_BASE_KEY = "aims_final_map_base_instruction";     // edited base instruction
let vmDefaultBase = "";                                    // server default (for Reset)

/* Show the (editable) base AI instruction + restore the saved additional one. */
async function vmInitInstructions(){
  const card = document.getElementById("vmInstrCard");
  if(card) card.style.display = "";
  const add = document.getElementById("vmAddInstr");
  if(add){
    add.value = lsGet(VM_INSTR_KEY, "") || "";
    add.addEventListener("input", debounce(() => lsSet(VM_INSTR_KEY, add.value || ""), 300));
  }
  const toggle = document.getElementById("vmInstrToggle"), body = document.getElementById("vmInstrBody");
  if(toggle && body) toggle.addEventListener("click", () => {
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "";
    toggle.innerHTML = '<i class="bi bi-chevron-' + (open ? "down" : "up") + '"></i>';
  });

  const box = document.getElementById("vmBaseInstr");
  // fetch the server default (used for Reset + as the initial value if unedited)
  try{
    const res = await fetch("/api/ai/final-map-instruction");
    const data = await res.json();
    if(data.ok) vmDefaultBase = data.instruction || "";
  }catch(e){ /* non-fatal */ }
  if(box){
    const saved = lsGet(VM_BASE_KEY, null);
    box.value = (saved != null && saved !== "") ? saved : vmDefaultBase;
    box.addEventListener("input", debounce(() => lsSet(VM_BASE_KEY, box.value || ""), 300));
  }
  const reset = document.getElementById("vmBaseReset");
  if(reset) reset.addEventListener("click", () => {
    if(box) box.value = vmDefaultBase;
    localStorage.removeItem(VM_BASE_KEY);
    showNotification("Base instruction reset to default.", "primary", 1500);
  });
}

/* Populate the per-side table pickers ("All tables" + each entity). Default to the
   first table on each side so the canvas is focused, not overwhelming. */
function vmPopulateTableSelects(){
  const opt = (e) => '<option value="' + escapeHtml(e.name) + '">' + escapeHtml(e.name) + '</option>';
  const l = document.getElementById("vmLeftTable"), r = document.getElementById("vmRightTable");
  l.innerHTML = '<option value="__all__">All tables</option>' + (vmStaging.entities || []).map(opt).join("");
  r.innerHTML = '<option value="__all__">All tables</option>' + (vmTarget.entities || []).map(opt).join("");
  if((vmStaging.entities || []).length) l.value = vmStaging.entities[0].name;
  if((vmTarget.entities || []).length) r.value = vmTarget.entities[0].name;
}

/* Entities to render for one side, honouring its table picker. */
function vmSelectedEntities(schema, selectId){
  const sel = document.getElementById(selectId);
  const val = sel ? sel.value : "__all__";
  const ents = schema.entities || [];
  return (!val || val === "__all__") ? ents : ents.filter(e => e.name === val);
}

function vmReady(){
  return !!(vmStaging && vmStaging.entities && vmStaging.entities.length &&
            vmTarget && vmTarget.entities && vmTarget.entities.length);
}

function vmShowEmpty(){
  document.getElementById("vmWrap").style.display = "none";
  document.getElementById("vmEmpty").style.display = "";
  const noStaging = !(vmStaging && vmStaging.entities && vmStaging.entities.length);
  const noTarget = !(vmTarget && vmTarget.entities && vmTarget.entities.length);
  let msg = "";
  if(noStaging && noTarget) msg = "Load a Staging Area and a Target first, then come back to draw the mapping.";
  else if(noStaging) msg = "No active Staging Area. Add/activate one on the Staging Area page.";
  else msg = "No Target loaded. Upload a Target data dictionary on the Target System page.";
  document.getElementById("vmEmptyMsg").textContent = msg;
}

function wireVm(){
  document.getElementById("vmClearBtn").addEventListener("click", vmClear);
  document.getElementById("vmAutoBtn").addEventListener("click", vmAutoMap);
  document.getElementById("vmLeftSearch").addEventListener("input", debounce(() => vmFilter("left"), 150));
  document.getElementById("vmRightSearch").addEventListener("input", debounce(() => vmFilter("right"), 150));
  document.getElementById("vmLeftTable").addEventListener("change", () => { vmRenderColumns(); vmRedraw(); });
  document.getElementById("vmRightTable").addEventListener("change", () => { vmRenderColumns(); vmRedraw(); });
  window.addEventListener("resize", debounce(vmRedraw, 120));

  const canvas = document.getElementById("vmCanvas");
  canvas.addEventListener("mousedown", vmDragStart);

  const svg = document.getElementById("vmSvg");
  svg.addEventListener("click", (e) => {
    const line = e.target.closest(".vm-line");
    if(line && line.dataset.linkid) vmOpenPopover(line.dataset.linkid, e);
  });

  // popover controls
  document.getElementById("vmPopType").innerHTML = VM_TYPES.map(t => '<option>' + t + '</option>').join("");
  document.getElementById("vmPopType").addEventListener("change", vmPopApply);
  document.getElementById("vmPopRule").addEventListener("input", vmPopApply);
  document.getElementById("vmPopDelete").addEventListener("click", vmPopDelete);
  document.getElementById("vmPopClose").addEventListener("click", vmClosePopover);
  document.addEventListener("mousedown", (e) => {
    const pop = document.getElementById("vmPopover");
    if(pop.style.display !== "none" && !pop.contains(e.target) && !e.target.closest(".vm-line")) vmClosePopover();
  });
}

/* ---- render the two field columns ---- */
function vmColumnHTML(schema, side){
  return (schema.entities || []).map(ent => {
    const rows = (ent.fields || []).map(f => {
      const key = vmKey(ent.name, f.name);
      const type = (f.dataType || "") + (f.length ? "(" + f.length + ")" : "");
      const anchor = '<span class="vm-anchor" data-side="' + side + '" data-key="' + escapeHtml(key) + '" ' +
        'data-entity="' + escapeHtml(ent.name) + '" data-table="' + escapeHtml(ent.table || ent.name) + '" data-col="' + escapeHtml(f.name) + '"></span>';
      const label = '<span class="vm-fname" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="vm-ftype">' + escapeHtml(type) + '</span>';
      return '<div class="vm-field" data-key="' + escapeHtml(key) + '" data-name="' + escapeHtml(f.name.toLowerCase()) + '">' +
        (side === "left" ? (label + anchor) : (anchor + label)) + '</div>';
    }).join("");
    return '<div class="vm-entity"><div class="vm-entity-head"><i class="bi bi-diagram-2"></i> ' + escapeHtml(ent.name) + '</div>' +
      '<div class="vm-fields">' + rows + '</div></div>';
  }).join("");
}

function vmRenderColumns(){
  document.getElementById("vmEmpty").style.display = "none";
  document.getElementById("vmWrap").style.display = "";
  document.getElementById("vmLeftTitle").textContent = vmStaging.application || "Staging Area";
  document.getElementById("vmRightTitle").textContent = vmTarget.application || "Target";
  document.getElementById("vmLeft").innerHTML = vmColumnHTML({entities: vmSelectedEntities(vmStaging, "vmLeftTable")}, "left");
  document.getElementById("vmRight").innerHTML = vmColumnHTML({entities: vmSelectedEntities(vmTarget, "vmRightTable")}, "right");
  // index anchors by key for fast line drawing
  vmAnchors.left = {}; vmAnchors.right = {};
  document.querySelectorAll("#vmLeft .vm-anchor").forEach(a => vmAnchors.left[vmKey(a.dataset.entity, a.dataset.col)] = a);
  document.querySelectorAll("#vmRight .vm-anchor").forEach(a => vmAnchors.right[vmKey(a.dataset.entity, a.dataset.col)] = a);
}

/* ---- geometry + line drawing ---- */
function vmPoint(anchorEl){
  const c = document.getElementById("vmCanvas").getBoundingClientRect();
  const r = anchorEl.getBoundingClientRect();
  return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
}
function vmBezier(a, b){
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return "M " + a.x + " " + a.y + " C " + (a.x + dx) + " " + a.y + ", " + (b.x - dx) + " " + b.y + ", " + b.x + " " + b.y;
}

function vmRedraw(){
  const svg = document.getElementById("vmSvg");
  if(!svg) return;
  // Size the SVG explicitly to the canvas's real pixel box. Relying on CSS
  // height:100% inside the grid can resolve to 0 and clip every line (the cause
  // of "links exist but I can't see them"). Explicit px + matching viewBox keeps
  // 1 unit = 1px so vmPoint() canvas-pixel coords map exactly.
  const canvas = document.getElementById("vmCanvas");
  const w = canvas.scrollWidth, h = canvas.scrollHeight;
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.style.width = w + "px";
  svg.style.height = h + "px";
  // keep any temp drag path; remove committed lines
  svg.querySelectorAll(".vm-line:not(.vm-line-temp)").forEach(n => n.remove());
  document.querySelectorAll(".vm-anchor-linked").forEach(a => a.classList.remove("vm-anchor-linked"));
  document.querySelectorAll(".vm-field.vm-linked").forEach(f => f.classList.remove("vm-linked"));

  vmLinks.forEach(link => {
    const la = vmAnchors.left[vmKey(link.stagingEntity, link.stagingColumn)];
    const ra = vmAnchors.right[vmKey(link.targetEntity, link.targetColumn)];
    if(!la || !ra || la.offsetParent === null || ra.offsetParent === null) return;   // hidden by filter/selection
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("class", "vm-line" + (link.id === vmActiveLinkId ? " vm-line-active" : ""));
    p.setAttribute("d", vmBezier(vmPoint(la), vmPoint(ra)));
    p.dataset.linkid = link.id;
    svg.appendChild(p);
    la.classList.add("vm-anchor-linked"); ra.classList.add("vm-anchor-linked");
    la.closest(".vm-field").classList.add("vm-linked"); ra.closest(".vm-field").classList.add("vm-linked");
  });
  vmUpdateCounter();
}

function vmUpdateCounter(){
  const totalTargets = (vmTarget.entities || []).reduce((a, e) => a + (e.fields || []).length, 0);
  const mapped = new Set(vmLinks.map(l => vmKey(l.targetEntity, l.targetColumn))).size;
  document.getElementById("vmCounter").textContent = mapped + " / " + totalTargets + " Target fields mapped · " + vmLinks.length + " link(s)";
}

/* ---- drag to connect ----
   The whole LEFT field row is a drag source and the whole RIGHT field row is a
   drop target (not just the tiny dot), so mapping is forgiving to aim at. */
function vmLeftAnchorFrom(target){
  const a = target.closest('#vmLeft .vm-anchor'); if(a) return a;
  const f = target.closest('#vmLeft .vm-field'); return f ? f.querySelector('.vm-anchor') : null;
}
function vmRightAnchorAt(x, y){
  const el = document.elementFromPoint(x, y); if(!el) return null;
  const a = el.closest('#vmRight .vm-anchor'); if(a) return a;
  const f = el.closest('#vmRight .vm-field'); return f ? f.querySelector('.vm-anchor') : null;
}

function vmDragStart(e){
  const a = vmLeftAnchorFrom(e.target);
  if(!a) return;
  e.preventDefault();
  const svg = document.getElementById("vmSvg");
  const temp = document.createElementNS(SVGNS, "path");
  temp.setAttribute("class", "vm-line vm-line-temp");
  svg.appendChild(temp);
  vmDrag = { fromEl: a, temp: temp };
  a.classList.add("vm-anchor-hot");
  document.body.classList.add("vm-dragging");
  document.addEventListener("mousemove", vmDragMove);
  document.addEventListener("mouseup", vmDragEnd);
}
function vmDragMove(e){
  if(!vmDrag) return;
  const c = document.getElementById("vmCanvas").getBoundingClientRect();
  const to = { x: e.clientX - c.left, y: e.clientY - c.top };
  vmDrag.temp.setAttribute("d", vmBezier(vmPoint(vmDrag.fromEl), to));
  document.querySelectorAll('#vmRight .vm-anchor-hot').forEach(x => x.classList.remove("vm-anchor-hot"));
  const ra = vmRightAnchorAt(e.clientX, e.clientY);
  if(ra) ra.classList.add("vm-anchor-hot");
}
function vmDragEnd(e){
  document.removeEventListener("mousemove", vmDragMove);
  document.removeEventListener("mouseup", vmDragEnd);
  if(!vmDrag) return;
  if(vmDrag.temp) vmDrag.temp.remove();
  const from = vmDrag.fromEl;
  vmDrag = null;
  document.body.classList.remove("vm-dragging");
  document.querySelectorAll(".vm-anchor-hot").forEach(x => x.classList.remove("vm-anchor-hot"));
  const ra = vmRightAnchorAt(e.clientX, e.clientY);
  if(ra) vmCreateLink(from, ra);
}

function vmCreateLink(leftAnchor, rightAnchor, extra){
  const link = {
    id: uid("VMAP"),
    stagingEntity: leftAnchor.dataset.entity, stagingTable: leftAnchor.dataset.table, stagingColumn: leftAnchor.dataset.col,
    targetEntity: rightAnchor.dataset.entity, targetTable: rightAnchor.dataset.table, targetColumn: rightAnchor.dataset.col,
    mappingType: (extra && extra.mappingType) || "Direct",
    transformationRule: (extra && extra.transformationRule) || "",
    source: (extra && extra.source) || "user"
  };
  // reject exact-duplicate (same staging col -> same target col)
  const dup = vmLinks.some(l => l.stagingEntity === link.stagingEntity && l.stagingColumn === link.stagingColumn &&
                                l.targetEntity === link.targetEntity && l.targetColumn === link.targetColumn);
  if(dup){ showNotification("That link already exists.", "warning", 1800); return null; }
  vmLinks.push(link);
  vmSaveLinks();
  vmRedraw();
  return link;
}

/* ---- link editor popover ---- */
function vmOpenPopover(linkId, evt){
  const link = vmLinks.find(l => l.id === linkId);
  if(!link) return;
  vmActiveLinkId = linkId;
  const pop = document.getElementById("vmPopover");
  document.getElementById("vmPopTitle").innerHTML =
    '<span class="mono">' + escapeHtml(link.stagingColumn) + '</span> &rarr; <span class="mono">' + escapeHtml(link.targetColumn) + '</span>';
  document.getElementById("vmPopType").value = VM_TYPES.indexOf(link.mappingType) !== -1 ? link.mappingType : "Direct";
  document.getElementById("vmPopRule").value = link.transformationRule || "";
  pop.style.display = "";
  // position near the click, clamped to viewport
  const px = Math.min(evt.clientX + 12, window.innerWidth - 300 + window.scrollX);
  const py = evt.clientY + 12 + window.scrollY;
  pop.style.left = (px + window.scrollX) + "px";
  pop.style.top = py + "px";
  vmRedraw();   // highlight active line
}
function vmPopApply(){
  const link = vmLinks.find(l => l.id === vmActiveLinkId);
  if(!link) return;
  link.mappingType = document.getElementById("vmPopType").value;
  link.transformationRule = document.getElementById("vmPopRule").value;
  link.source = "user";
  vmSaveLinks();
}
function vmPopDelete(){
  vmLinks = vmLinks.filter(l => l.id !== vmActiveLinkId);
  vmSaveLinks();
  vmClosePopover();
  vmRedraw();
}
function vmClosePopover(){
  vmActiveLinkId = null;
  document.getElementById("vmPopover").style.display = "none";
  vmRedraw();
}

/* ---- filter, clear ---- */
function vmFilter(side){
  const q = (document.getElementById(side === "left" ? "vmLeftSearch" : "vmRightSearch").value || "").toLowerCase();
  const root = document.getElementById(side === "left" ? "vmLeft" : "vmRight");
  root.querySelectorAll(".vm-field").forEach(f => {
    f.style.display = (!q || f.dataset.name.indexOf(q) !== -1) ? "" : "none";
  });
  vmRedraw();
}

async function vmClear(){
  if(!vmLinks.length){ showNotification("No links to clear.", "primary", 1400); return; }
  const ok = await confirmDialog("Remove all " + vmLinks.length + " mapping link(s)? This cannot be undone.", "Clear Mapping");
  if(!ok) return;
  vmLinks = [];
  vmSaveLinks();
  vmClosePopover();
  vmRedraw();
  showNotification("Mapping cleared.", "primary", 1400);
}

/* ---- AI auto-map (backend endpoint added in P3) ---- */
async function vmAutoMap(){
  const proc = document.getElementById("vmProcess");
  proc.innerHTML = '<div class="hint-note"><span class="spinner-border spinner-border-sm me-2"></span> Asking AI to suggest Staging Area &rarr; Target links… <span class="text-muted-2">(wide tables are processed in batches — this can take a minute or two)</span></div>';
  try{
    // Scope to the currently-picked tables (choose "All tables" on a side to map everything).
    const packEnts = (ents) => ents.map(e => ({entity: e.name, table: e.table || e.name,
      columns: (e.fields || []).map(f => ({name: f.name, dataType: f.dataType, businessTerm: f.businessTerm || ""}))}));
    const payload = {
      staging: packEnts(vmSelectedEntities(vmStaging, "vmLeftTable")),
      target: packEnts(vmSelectedEntities(vmTarget, "vmRightTable")),
      baseInstruction: (document.getElementById("vmBaseInstr") || {}).value || "",
      instructions: (document.getElementById("vmAddInstr") || {}).value || ""
    };
    const res = await fetch("/api/ai/suggest-final-mappings", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    const data = await res.json();
    if(!data.ok){ proc.innerHTML = '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error || "Auto-map failed.") + '</div>'; return; }
    const added = vmApplySuggestions(data.links || []);
    proc.innerHTML = '<div class="hint-note" style="background:var(--success-bg);color:var(--success);border-color:#bfe8cf;"><i class="bi bi-check-circle"></i> AI added ' + added + ' new link(s). Review and adjust by dragging; click a line to edit.</div>';
  }catch(e){
    proc.innerHTML = '<div class="hint-note" style="background:var(--danger-bg);color:var(--danger);border-color:#f7c9c6;"><i class="bi bi-x-circle"></i> Backend not reachable. Start it with: cd server &amp;&amp; python main.py</div>';
  }
}

/* Apply AI-suggested links, resolving names to real anchors; skip unknowns/dupes. */
function vmApplySuggestions(suggestions){
  let added = 0;
  suggestions.forEach(s => {
    const la = vmAnchors.left[vmKey(s.stagingEntity, s.stagingColumn)];
    const ra = vmAnchors.right[vmKey(s.targetEntity, s.targetColumn)];
    if(!la || !ra) return;
    const link = vmCreateLink(la, ra, {mappingType: s.mappingType || "Direct", transformationRule: s.transformationRule || "", source: "ai"});
    if(link) added++;
  });
  return added;
}
