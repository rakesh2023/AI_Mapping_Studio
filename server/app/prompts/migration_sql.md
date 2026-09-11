# Migration-tool schema SQL conventions (CMT / PMT)

Apply these when writing SQL against a Guidewire-style **migration-tool** schema — the CMT
(Claim Migration Tool) or PMT (Policy Migration Tool) staging database. Both follow the same
conventions; use the physical table/column names exactly as given in the SCHEMA.

- **Primary keys vary per table.** Each table's PK is a single column named **`PMT_ID`, `PMT_ID1`,
  or `PMT_ID2`** — the exact name differs by table, so use the PK column shown for each table in
  the SCHEMA; never assume `PMT_ID`.
- **Direct foreign keys**: a column whose FK target is shown (e.g. `PMT_Parent -> Account`) stores
  the target row's PK value — join `child.<fkcol> = parent.<parentPK>`. `PMT_Parent` is a very common
  direct FK to a row's logical parent; nothing special beyond knowing its target table.
- **Polymorphic foreign keys** (the one non-obvious pattern): a value column (e.g. `AccountHolder`)
  holds a PK value, and its sibling **`<col>_Type`** column names which target table that row points
  to (the SCHEMA lists the possible targets). SQL joins are static, so resolve a polymorphic FK by
  either:
  - **`UNION ALL`** of one `LEFT JOIN` per target table, each branch guarded by
    `<col>_Type = 'TargetTable'` (pad non-applicable columns with `NULL`, keep every branch's select
    list identical), **or**
  - **narrow to the specific target type** the request names (e.g. only `Company`): a single join
    `ON target.<PK> = parent.<col> AND parent.<col>_Type = 'Company'`.
  Never write a plain single-table join on a polymorphic column without the `_Type` guard — it
  returns wrong/empty rows for values pointing at other target types.
- **Typekey columns**: a column shown as `typekey.X` stores a short string **code** (e.g. `'open'`)
  from an external enumeration that is **not part of this schema**. Filter/group on it directly
  (`WHERE Status = 'open'`) — there is **no join target** here. The valid code values are not in the
  schema, so don't invent them; if a specific code matters and isn't given, flag it as a guess.
- **Dialect**: default to Microsoft SQL Server (T-SQL) unless told otherwise.
- **Output**: a single **read-only `SELECT`** using only the tables/columns in the SCHEMA (verbatim);
  no `INSERT/UPDATE/DELETE/DROP/ALTER/EXEC/INTO`, no multiple statements, no comments, no trailing
  semicolon. Confirm each joined column against the SCHEMA (right PK, `_Type` guard on every
  polymorphic column, exact name/casing).
