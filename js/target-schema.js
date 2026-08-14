/* =========================================================================
   target-schema.js
   Reads the uploaded Target Data Dictionary (.xlsx) and turns it into the
   app's target-metadata shape. The whole app reads the ACTIVE target schema
   from here (localStorage) instead of the built-in sample JSON.

   Expected workbook: one sheet, one row per target column, with columns like:
     Table | Entity | Column | DataType | Length | Mandatory | PK | FK |
     FK Reference | List Table | Business Term | Accepted Values | Default | Description
   Header names are matched flexibly (case / spacing / synonyms).
   Requires SheetJS (XLSX global) on pages that PARSE or EXPORT; pages that
   only READ the stored schema do not need it.
   ========================================================================= */

const LS_TARGET_SCHEMA = "aims_target_schema";

function getTargetSchema(){
  // Prefer deriving from the ACTIVE target connection (single source of truth).
  // This avoids storing a second full copy of a large schema (which could blow the
  // localStorage quota and leave the app with an empty target -> 0 mappings).
  try{
    const activeId = lsGet(LS_ACTIVE_TARGET, null);
    if(activeId){
      const conn = (getTargetConnections() || []).find(c => c.id === activeId);
      if(conn && conn.entities && conn.entities.length) return connToTargetSchema(conn);
    }
  }catch(e){ /* fall back to the stored blob below */ }
  return lsGet(LS_TARGET_SCHEMA, null);
}
function setTargetSchema(schema){
  // Best-effort: keep the legacy blob in sync for any code that reads it directly,
  // but don't let a quota failure here break activation (the connection store holds
  // the authoritative copy and getTargetSchema() derives from it).
  try{ lsSet(LS_TARGET_SCHEMA, schema); }catch(e){ console.warn("target schema blob not cached (quota):", e.message); }
}
function clearTargetSchema(){ lsRemove(LS_TARGET_SCHEMA); }
function hasTargetSchema(){ const s = getTargetSchema(); return !!(s && s.entities && s.entities.length); }

/* =========================================================================
   Dynamic TARGET CONNECTIONS (SQL Server or File System), mirroring the
   source-connection store. Multiple targets can be saved; ONE is "active",
   and the active connection is materialized into the single getTargetSchema()
   blob so every existing consumer (ai-mapping, workspace, dashboard,
   target-system) keeps working unchanged.
   ========================================================================= */
const LS_TARGET_CONNECTIONS = "aims_target_connections";
const LS_ACTIVE_TARGET = "aims_active_target";

function getTargetConnections(){ return lsGet(LS_TARGET_CONNECTIONS, []); }
function saveTargetConnections(list){ lsSet(LS_TARGET_CONNECTIONS, list); }
function getTargetConnection(id){ return getTargetConnections().find(c => c.id === id) || null; }
function upsertTargetConnection(conn){
  const list = getTargetConnections();
  const i = list.findIndex(c => c.id === conn.id);
  if(i !== -1) list[i] = conn; else list.push(conn);
  saveTargetConnections(list);
  return conn;
}
function deleteTargetConnection(id){
  saveTargetConnections(getTargetConnections().filter(c => c.id !== id));
  if(getActiveTargetId() === id){
    // Re-point to another connection if one remains, else clear the active target.
    const rest = getTargetConnections();
    if(rest.length) setActiveTarget(rest[0].id);
    else { lsRemove(LS_ACTIVE_TARGET); clearTargetSchema(); }
  }
}

function getActiveTargetId(){ return lsGet(LS_ACTIVE_TARGET, null); }
function setActiveTarget(id){
  const conn = getTargetConnection(id);
  if(!conn) return null;
  lsSet(LS_ACTIVE_TARGET, id);
  setTargetSchema(connToTargetSchema(conn));   // whole app now reads this target
  return conn;
}

/* Build the getTargetSchema() blob from a connection's stored entities[]. */
function connToTargetSchema(conn){
  const entities = conn.entities || [];
  const columnCount = entities.reduce((a,e) => a + (e.fields||[]).length, 0);
  return {
    application: conn.name || "Target Schema",
    module: conn.type || "",
    version: conn.type === "SQL Server" ? "From database" : "From file",
    sourceFileName: conn.fileName || conn.name || "target",
    uploadedAt: conn.loadedAt || new Date().toISOString(),
    tableCount: entities.length,
    columnCount: columnCount,
    entities: entities
  };
}

/* Convert /api/db/metadata (tables[].columns[]) -> target entities[]/fields[]. */
function dbMetadataToEntities(data){
  return (data.tables || []).map(t => ({
    name: t.name,
    table: t.name,
    description: t.description || "",
    isListTable: false,
    fields: (t.columns || []).map(c => ({
      name: c.name,
      dataType: (c.dataType || "").toLowerCase(),
      length: c.length ?? null,
      mandatory: c.nullable === false,
      pk: !!c.pk,
      fk: !!c.fk,
      fkReference: c.fkReference || "",
      description: c.description || "",
      businessTerm: c.businessTerm || "",
      accepted: null,
      default: c.default ?? null
    }))
  }));
}

/* Convert /api/ai/extract-source tables[] -> target entities[]/fields[]. */
function extractedToEntities(tables){
  return (tables || []).map(t => ({
    name: t.name,
    table: t.name,
    description: "",
    isListTable: false,
    fields: (t.columns || []).map(c => ({
      name: c.name,
      dataType: (c.dataType || "").toLowerCase(),
      length: c.length ?? null,
      mandatory: false,
      pk: false,
      fk: false,
      fkReference: "",
      description: c.description || "",
      businessTerm: c.businessTerm || "",
      accepted: null,
      default: null
    }))
  }));
}

/* One-time migration: if a legacy single uploaded schema exists but no target
   connections, seed one connection from it and mark it active. Safe to call on
   every page load — it does nothing once a connection exists. */
function migrateLegacyTargetSchema(){
  if(getTargetConnections().length) return;
  const s = getTargetSchema();
  if(s && s.entities && s.entities.length){
    const conn = {
      id: uid("TGT"),
      name: s.application || s.sourceFileName || "Uploaded Target Schema",
      type: "File System",
      fileName: s.sourceFileName || "",
      status: "Loaded",
      loadedAt: s.uploadedAt || new Date().toISOString(),
      tableCount: s.tableCount || s.entities.length,
      columnCount: s.columnCount || s.entities.reduce((a,e)=>a+(e.fields||[]).length,0),
      entities: s.entities
    };
    upsertTargetConnection(conn);
    lsSet(LS_ACTIVE_TARGET, conn.id);
  }
}

/* ---- header normalisation ---- */
function normHeader(h){ return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

const HEADER_MAP = {
  table:        ["table","tablename","targettable","physicaltable"],
  entity:       ["entity","entityname","targetentity","object","objectname"],
  column:       ["column","columnname","field","fieldname","targetcolumn","attribute","attributename"],
  datatype:     ["datatype","type","columntype","sqltype","fieldtype"],
  length:       ["length","len","size","columnlength","fieldlength"],
  mandatory:    ["mandatory","required","notnull","ismandatory","isrequired"],
  nullable:     ["nullable","isnullable","allownull","allownulls"],
  pk:           ["pk","primarykey","ispk","isprimarykey","primary","key"],
  fk:           ["fk","foreignkey","isfk","isforeignkey","foreign"],
  fkref:        ["fkreference","foreignkeyreference","references","reference","reftable","referencedtable","fktable","referencedcolumn","parenttable"],
  listtable:    ["listtable","islisttable","list","islist","lookup","lookuptable","referencetable","referencedata","typelist","typecode"],
  description:  ["description","desc","comment","comments","notes","definition","remarks"],
  businessterm: ["businessterm","business","glossaryterm","businessname","term"],
  accepted:     ["acceptedvalues","accepted","allowedvalues","validvalues","values","domain","enumeration","enum","codes"],
  defaultval:   ["default","defaultvalue","defaultval"]
};

function buildHeaderIndex(rawHeaders){
  const idx = {};
  rawHeaders.forEach(h => {
    const n = normHeader(h);
    for(const canon in HEADER_MAP){
      if(HEADER_MAP[canon].indexOf(n) !== -1 && idx[canon] === undefined){ idx[canon] = h; break; }
    }
  });
  return idx;
}

function truthy(v){
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return ["y","yes","true","t","1","x","✓","pk","fk","required","mandatory","not null"].indexOf(s) !== -1;
}
function cell(row, idx, canon){ return idx[canon] !== undefined ? row[idx[canon]] : ""; }
function toStr(v){ return v == null ? "" : String(v).trim(); }

/* ---- parse a workbook (ArrayBuffer) into the target-metadata shape ---- */
function parseTargetWorkbook(arrayBuffer, fileName){
  if(typeof XLSX === "undefined") throw new Error("Excel parser (SheetJS) is not loaded on this page.");
  const wb = XLSX.read(arrayBuffer, {type:"array"});
  const ws = wb.Sheets[wb.SheetNames[0]];
  if(!ws) throw new Error("The workbook has no sheets.");
  const rows = XLSX.utils.sheet_to_json(ws, {defval:"", raw:false});
  if(!rows.length) throw new Error("The first sheet is empty.");

  const idx = buildHeaderIndex(Object.keys(rows[0]));
  if(idx.column === undefined || (idx.table === undefined && idx.entity === undefined)){
    throw new Error("Could not find required columns. Need at least a Table/Entity column and a Column column.");
  }

  const entityMap = {};   // key -> entity object
  let columnCount = 0;

  rows.forEach(row => {
    const colName = toStr(cell(row, idx, "column"));
    const tableName = toStr(cell(row, idx, "table"));
    const entityName = toStr(cell(row, idx, "entity")) || tableName;
    const key = (entityName || tableName);
    if(!colName || !key) return;   // skip blank/heading rows

    if(!entityMap[key]){
      entityMap[key] = {
        name: entityName || tableName,
        table: tableName || entityName,
        description: "",
        isListTable: false,
        fields: []
      };
    }
    const ent = entityMap[key];

    // list-table flag can be set on any row of the table
    if(truthy(cell(row, idx, "listtable"))) ent.isListTable = true;

    // mandatory: explicit column, else derived from nullable
    let mandatory = false;
    if(idx.mandatory !== undefined) mandatory = truthy(cell(row, idx, "mandatory"));
    else if(idx.nullable !== undefined) mandatory = !truthy(cell(row, idx, "nullable"));

    const lenRaw = toStr(cell(row, idx, "length"));
    const lenNum = lenRaw && !isNaN(+lenRaw) ? +lenRaw : (lenRaw || null);

    ent.fields.push({
      name: colName,
      dataType: toStr(cell(row, idx, "datatype")) || "varchar",
      length: lenNum,
      mandatory: mandatory,
      pk: truthy(cell(row, idx, "pk")),
      fk: truthy(cell(row, idx, "fk")),
      fkReference: toStr(cell(row, idx, "fkref")),
      description: toStr(cell(row, idx, "description")),
      businessTerm: toStr(cell(row, idx, "businessterm")),
      accepted: toStr(cell(row, idx, "accepted")) || null,
      default: toStr(cell(row, idx, "defaultval")) || null
    });
    columnCount++;
  });

  const entities = Object.values(entityMap);
  if(!entities.length) throw new Error("No target tables/columns could be read from the file.");

  return {
    application: "Uploaded Target Schema",
    module: "",
    version: "From file",
    sourceFileName: fileName || "target-schema.xlsx",
    uploadedAt: new Date().toISOString(),
    tableCount: entities.length,
    columnCount: columnCount,
    entities: entities
  };
}

/* ---- read a File object and store it as the active target schema ---- */
function ingestTargetSchemaFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const schema = parseTargetWorkbook(reader.result, file.name);
        setTargetSchema(schema);
        resolve(schema);
      }catch(err){ reject(err); }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

