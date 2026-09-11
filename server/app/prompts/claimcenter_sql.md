# ClaimCenter SQL conventions

Apply these when writing SQL against a Guidewire ClaimCenter physical schema. They hold
across the whole schema even when a given table's column list doesn't show them.

- **Physical names**: entity tables are lowercase with a `cc_` prefix (`Claim` → `cc_claim`);
  typelist tables use `cctl_` (`ClaimState` → `cctl_claimstate`). Use the physical names from
  the supplied schema, not the entity/property names.
- **Primary key**: every entity has an `ID` column (surrogate bigint). It is not human-readable;
  `PublicID` is an external identifier, not the PK.
- **Foreign keys**: named `<PropertyName>ID` (e.g. `AssignedUserID`, `PolicyID`). Join to the
  target table's `ID`. Use only FK columns present in the supplied schema; never invent one.
- **Soft delete / retirement**: retirable entities have a `RetiredValue` column — `0` = active,
  non-zero = retired. Add `WHERE RetiredValue = 0` unless the user explicitly wants retired rows.
- **Typekey columns**: a typekey column (e.g. `Claim.State`, `Claim.LossCause`) stores the
  typelist's **code value** (e.g. `WHERE State = 'open'`). Use the exact code shown in the column's
  typelist code list — match the spelling/case verbatim; never guess from the human-readable label.
- **Including a typelist's display name**: to also return the human-readable label/description of a
  typekey column, **LEFT JOIN** the typelist's physical table (`cctl_<name>`, shown in the SCHEMA's
  "TYPELIST TABLES" section) on `<entity>.<TypekeyColumn> = <cctl_table>.ID` and select
  `<cctl_table>.NAME` (display) or `.DESCRIPTION`. The `cctl_` table's `ID` column equals the code
  stored in the typekey column. Use a LEFT JOIN so rows with a NULL/blank code are kept. When the
  request asks for "typelist code(s)/values/names", add one such LEFT JOIN per typekey column
  involved.
- **One-to-many (arrays)**: not a column on this table — the FK lives on the child table pointing
  back (e.g. `Claim.Exposures` → `cc_exposure.ClaimID`). Join from the child side.
- **Audit columns**: most tables have `CreateTime`, `UpdateTime`, `CreateUser`/`UpdateUser`
  (FK to `cc_user`), and `PublicID`.
- **Dialect**: default to Microsoft SQL Server (T-SQL) unless told otherwise — e.g. dates via
  `DATEADD(day, -N, GETDATE())`.
- **Output**: a single **read-only `SELECT`** that answers the request. No `INSERT/UPDATE/DELETE/
  DROP/ALTER/EXEC/INTO`, no multiple statements, no comments, no variables. Use only the tables and
  columns given in the schema context — never invent a table, column, or code value.
