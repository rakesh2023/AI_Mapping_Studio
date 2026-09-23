# BillingCenter SQL conventions

Apply these when writing SQL against a Guidewire BillingCenter physical schema. They hold
across the whole schema even when a given table's column list doesn't show them.

- **Physical names**: entity tables are lowercase with a `bc_` prefix (`Charge` → `bc_charge`);
  typelist tables use `bctl_` (`Transaction` → `bctl_transaction`). Use the physical names from the
  supplied schema, not the entity/property names.
- **Primary key**: every entity has an `ID` column (surrogate bigint). It is not human-readable;
  `PublicID` is an external identifier, not the PK.
- **Foreign keys**: named `<PropertyName>ID` (e.g. `TAccountContainerID`, `PolicyPeriodID`,
  `ChargeID`, `TransactionID`). Join to the target table's `ID`. Use only FK columns present in the
  supplied schema; never invent one. Some FKs are virtual (no physical column) — only use ones shown.
- **Soft delete / retirement**: retirable entities have a physical **`Retired`** column — `0` = active,
  non-zero = retired. Add `WHERE Retired = 0` unless the user explicitly wants retired rows. (The
  property is named `RetiredValue`, but the physical column is `Retired` — never filter on
  `RetiredValue`.)
- **Typekey columns**: a typekey column (e.g. `Transaction.Subtype`, `LineItem.Type`) stores the
  typelist's **code value** directly (e.g. `WHERE Subtype = 'ChargePaidFromAccount'`). BillingCenter
  codes are **exact-case** (mixed-case, e.g. `ChargeBilled`, not lowercased) — match the exact spelling
  from the column's typelist code list; never guess from the human-readable label.
- **Including a typelist's display name**: to also return the human-readable label/description of a
  typekey column, **LEFT JOIN** the typelist's physical table (`bctl_<name>`, shown in the SCHEMA's
  "TYPELIST TABLES" section) on `<entity>.<TypekeyColumn> = <bctl_table>.ID` and select
  `<bctl_table>.NAME` (display) or `.DESCRIPTION`. The `bctl_` table's `ID` column equals the code
  stored in the typekey column. Use a LEFT JOIN so rows with a NULL/blank code are kept. When the
  request asks for "typelist code(s)/values/names", add one such LEFT JOIN per typekey column involved.
- **Money + currency pairs**: a money property ending `_amt` maps to a physical amount column with the
  `_amt` stripped (e.g. `Amount_amt` → column `Amount`), paired with a sibling typekey column
  `<Field>_cur` (typelist `Currency`). On money queries, also select the `_cur` column, or totals across
  multi-currency data are silently wrong.
- **Double-entry ledger backbone**: BillingCenter is T-account bookkeeping, not a flat "invoices" table.
  Every financial event is a `Transaction` row (`bc_transaction`); which kind it is is the `Subtype`
  typekey (e.g. `ChargeBilled`, `ChargePaidFromAccount`, `ChargeWrittenOff`). **The dollar amount is a
  column directly on `bc_transaction` (`Amount`, with `Amount_cur`)** — do NOT join a line-item table
  just to total a transaction. Join `bc_lineitem` (Credit/Debit postings) and `bc_taccount` only when
  true ledger-level detail is needed. `Charge` (`bc_charge`) generates `InvoiceItem` rows
  (`bc_invoiceitem`, the scheduled installments); `Invoice` (`bc_invoice`) groups invoice items.
- **"Which policy is this for"**: the FK from a `TAccountContainer` back to `PolicyPeriod` is often
  **virtual (no physical column)** — prefer a physical FK that exists lower down (e.g.
  `bc_invoiceitem.PolicyPeriodID`). Only use FK columns actually shown in the schema.
- **Subtypes / single-table inheritance**: heavily used. A subtype has no table of its own — its
  columns live on the parent entity's table (e.g. `Transaction`, `TAccountContainer`, `Invoice`,
  `Writeoff` are supertypes with many subtypes sharing one table). Query the parent's physical table and
  filter by the discriminator (`Subtype`) when a specific subtype is wanted.
- **Denormalized (`*Denorm`) fields**: BillingCenter leans on these for reporting (e.g. container
  `BilledDenorm`, `UnbilledDenorm`) — handy caches, but not the source of truth. Prefer summing
  `Transaction`/`LineItem` rows directly when precision matters.
- **One-to-many (arrays)**: not a column on this table — the FK lives on the child table pointing back
  (e.g. `Charge.InvoiceItems` → `bc_invoiceitem.ChargeID`). Join from the child side.
- **Audit columns**: most tables have `CreateTime`, `UpdateTime`, `CreateUser`/`UpdateUser`
  (FK to `bc_user`), and `PublicID`.
- **Dialect**: default to Microsoft SQL Server (T-SQL) unless told otherwise — e.g. dates via
  `DATEADD(day, -N, GETDATE())`.
- **Output**: a single **read-only `SELECT`** that answers the request. No `INSERT/UPDATE/DELETE/
  DROP/ALTER/EXEC/INTO`, no multiple statements, no comments, no variables. Use only the tables and
  columns given in the schema context — never invent a table, column, or code value.
