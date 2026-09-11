# PolicyCenter SQL conventions

Apply these when writing SQL against a Guidewire PolicyCenter physical schema. They hold
across the whole schema even when a given table's column list doesn't show them.

- **Physical names**: entity tables are lowercase with a `pc_` prefix (`Policy` → `pc_policy`);
  typelist tables use `pctl_` (`PolicyPeriodStatus` → `pctl_policyperiodstatus`). Use the physical
  names from the supplied schema, not the entity/property names.
- **Primary key**: every entity has an `ID` column (surrogate bigint). It is not human-readable;
  `PublicID` is an external identifier, not the PK.
- **Foreign keys**: named `<PropertyName>ID` (e.g. `PolicyID`, `JobID`, `PeriodID`, `ContactID`).
  Join to the target table's `ID`. Use only FK columns present in the supplied schema; never invent
  one. Some FKs are virtual (no physical column) — only use ones shown in the schema.
- **Soft delete / retirement**: retirable entities have a physical **`Retired`** column — `0` = active,
  non-zero = retired. Add `WHERE Retired = 0` unless the user explicitly wants retired rows. (The
  property is named `RetiredValue`, but the physical column is `Retired` — never filter on
  `RetiredValue`.)
- **Typekey columns**: a typekey column (e.g. `PolicyPeriod.Status`, `Job.Subtype`) stores the
  typelist's **code value** directly (e.g. `WHERE Status = 'Bound'`). PolicyCenter codes are **not**
  consistently lowercase — match the exact spelling/case from the column's typelist code list; never
  guess from the human-readable label.
- **Including a typelist's display name**: to also return the human-readable label/description of a
  typekey column, **LEFT JOIN** the typelist's physical table (`pctl_<name>`, shown in the SCHEMA's
  "TYPELIST TABLES" section) on `<entity>.<TypekeyColumn> = <pctl_table>.ID` and select
  `<pctl_table>.NAME` (display) or `.DESCRIPTION`. The `pctl_` table's `ID` column equals the code
  stored in the typekey column. Use a LEFT JOIN so rows with a NULL/blank code are kept. When the
  request asks for "typelist code(s)/values/names", add one such LEFT JOIN per typekey column involved.
- **Money + currency pairs**: a money property ending `_amt` maps to a physical amount column with the
  `_amt` stripped (e.g. `EstimatedPremium_amt` → column `EstimatedPremium`), paired with a sibling
  typekey column `<Field>_cur` (typelist `Currency`). On money queries, also select the `_cur` column.
- **Subtypes / single-table inheritance**: heavily used. A subtype has no table of its own — its
  columns live on the parent entity's table (e.g. `Submission`, `Renewal`, `PolicyChange`,
  `Cancellation` all share `pc_job`). Query the parent's physical table and filter by the discriminator
  (`Subtype`) when a specific subtype is wanted.
- **Policy backbone**: most queries traverse `Account → Policy → PolicyPeriod → Job`, with most data on
  `pc_policyperiod`. A policy term has multiple period rows (branches/revisions) — when a single current
  row is wanted, filter `MostRecentModel = 1` and a specific `Status`; `PeriodID` groups branches of one
  term and `PolicyID` groups terms.
- **Business participants**: parties like the named insured or producer are modeled as roles on
  `PolicyContactRole` (`pc_policycontactrole`) joined to `Contact` (`pc_contact`), not as flat FKs.
  Some have a denormalized convenience FK on `PolicyPeriod` (e.g. `PNIContactDenorm`), but prefer the
  role join for correctness.
- **One-to-many (arrays)**: not a column on this table — the FK lives on the child table pointing back
  (e.g. `PolicyPeriod.Lines` → `pc_policyline.PolicyPeriodID`). Join from the child side.
- **Audit columns**: most tables have `CreateTime`, `UpdateTime`, `CreateUser`/`UpdateUser`
  (FK to `pc_user`), and `PublicID`.
- **Dialect**: default to Microsoft SQL Server (T-SQL) unless told otherwise — e.g. dates via
  `DATEADD(day, -N, GETDATE())`.
- **Output**: a single **read-only `SELECT`** that answers the request. No `INSERT/UPDATE/DELETE/
  DROP/ALTER/EXEC/INTO`, no multiple statements, no comments, no variables. Use only the tables and
  columns given in the schema context — never invent a table, column, or code value.
