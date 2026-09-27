# IN vs OUT value-difference stored procedure (CMT / PMT / BMT)

Generate a **metadata-driven data-reconciliation stored procedure** that finds, per table, the **column
values that changed** between a migration tool's **input** database and its **post-conversion output**
database. Both databases have the **same physical schema** on the **same SQL Server instance**; only the
*database names* differ and are supplied at run time as parameters.

The procedure must cover **every table in the supplied list** — there may be dozens or hundreds — so it is
**data-driven**: it loops over the table list and, for each table, discovers that table's columns from the
**database catalog at run time** and builds the comparison with dynamic SQL. Do NOT hand-write a separate
block per column.

## Matching a row in IN to the same row in OUT (IMPORTANT)

Rows are matched on the table's **primary key** (`PMT_ID`, or a composite like `PMT_ID1` + `PMT_ID2`;
given per table in `@tables.PkCols`). The key value is the **same** in both databases EXCEPT the OUT
database prefixes it with a `<random-number>_` prefix — e.g. IN `ABC123` becomes OUT `789_ABC123`. So
**normalize the OUT key by stripping a leading run of digits followed by an underscore** before joining.
For a key column `K`, the normalized OUT expression is:

```
CASE
    WHEN o.[K] LIKE '[0-9]%[_]%'
     AND SUBSTRING(o.[K], 1, CHARINDEX('_', o.[K]) - 1) NOT LIKE '%[^0-9]%'
    THEN STUFF(o.[K], 1, CHARINDEX('_', o.[K]), '')   -- drop "<digits>_" prefix
    ELSE o.[K]
END
```

Join `i.[K] = <that normalized OUT expression>` for the key column (AND together all key columns for a
composite key). This tolerates OUT rows that happen to have no prefix (the ELSE keeps them as-is).

## The one and only output

A **single result set** with exactly these five columns, in this order:

| Column        | Meaning                                                     |
|---------------|-------------------------------------------------------------|
| `Table Name`  | the table being compared                                    |
| `Column name` | the column whose value differs                              |
| `Primary Key` | the **IN** database's primary-key value for that row (identifies which record differs) |
| `InValue`     | the value in the IN database for that row/column            |
| `OutValue`    | the value in the OUT database for that row/column           |

One output row for **every (table, key-matched row, column) where the IN value differs from the OUT
value**, ordered by `Table Name`, then `Column name`, then `Primary Key`. No row counts, no missing-key
lists.

**`Primary Key`** carries the IN-side key value (`i.<pk>`), converted to `NVARCHAR(MAX)`. For a composite
key, concatenate the IN key columns with a `|` separator, e.g. `CONCAT(i.[PMT_ID], N'|', i.[PMT_ID2])`;
for a single key it is `CONVERT(NVARCHAR(MAX), i.[PMT_ID])`.

## Columns to compare (and to skip)

Each `@tables` row also carries an **`OnlyCols`** list (from the TABLES `OnlyCompare` field):

- **`OnlyCols` is empty** → compare every **non-key data column**: discover the columns COMMON to both
  databases from the catalog at run time, then exclude the PK column(s) and the `IgnoreCols` (FK) list.
- **`OnlyCols` is a specific list** → the user chose exactly which columns to compare, so compare **only
  those** columns: intersect the `OnlyCols` list with the columns present in both databases, and still
  exclude the PK column(s). (Do NOT apply the IgnoreCols filter here — the user's explicit choice wins.)

Always skip the primary-key column(s) themselves (they are the join key and carry the OUT prefix).

## Procedure shape (metadata-driven)

```
CREATE OR ALTER PROCEDURE dbo.usp_ReconcileInVsOut
    @InDbName    sysname,
    @OutDbName   sysname,
    @SchemaName  sysname = 'dbo'
AS
BEGIN
    SET NOCOUNT ON;

    -- Tables to compare: TableName, PK column(s), FK cols to ignore, and OnlyCols (empty = all).
    DECLARE @tables TABLE (TableName sysname, PkCols NVARCHAR(4000), IgnoreCols NVARCHAR(MAX),
                           OnlyCols NVARCHAR(MAX));
    INSERT INTO @tables (TableName, PkCols, IgnoreCols, OnlyCols) VALUES
        (N'Activity', N'PMT_ID', N'PMT_Parent', N''),                 -- '' OnlyCols = compare all
        (N'Attorney', N'PMT_ID,PMT_ID2', N'PMT_Parent', N'FirstName,LastName'),  -- compare only these
        ... ;   -- one row per table from the TABLES list (OnlyCols = '' when OnlyCompare is 'all comparable columns')

    CREATE TABLE #diffs ([Table Name] sysname, [Column name] sysname, [Primary Key] NVARCHAR(MAX),
                         InValue NVARCHAR(MAX), OutValue NVARCHAR(MAX));

    DECLARE @t sysname, @pk NVARCHAR(4000), @ignore NVARCHAR(MAX), @only NVARCHAR(MAX);
    DECLARE tcur CURSOR LOCAL FAST_FORWARD FOR SELECT TableName, PkCols, IgnoreCols, OnlyCols FROM @tables;
    OPEN tcur; FETCH NEXT FROM tcur INTO @t, @pk, @ignore, @only;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- 1) Split @pk / @ignore / @only into column lists (STRING_SPLIT).
        -- 2) Build the PK join predicate using the OUT-prefix-stripping CASE above (AND per key col).
        -- 3) Build the IN-side PK-value expression: single key -> CONVERT(NVARCHAR(MAX), i.[pk]);
        --    composite -> CONCAT(i.[pk1], N'|', i.[pk2], ...).
        -- 4) Determine the columns to compare from INFORMATION_SCHEMA.COLUMNS (present in BOTH DBs):
        --      if @only <> '' -> only columns IN @only (minus the PK);
        --      else            -> all columns minus the PK columns and the @ignore (FK) columns.
        -- 5) For each such column build a UNION ALL branch and INSERT INTO #diffs:
        --      SELECT N'<t>', N'<col>', <in-pk-value-expr>,
        --             CONVERT(NVARCHAR(MAX), i.[col]), CONVERT(NVARCHAR(MAX), o.[col])
        --      FROM <In 3-part> i JOIN <Out 3-part> o ON <normalized pk join>
        --      WHERE EXISTS (SELECT i.[col] EXCEPT SELECT o.[col])
        --    Assemble the per-table dynamic SQL and EXEC sys.sp_executesql it.
        FETCH NEXT FROM tcur INTO @t, @pk, @ignore, @only;
    END
    CLOSE tcur; DEALLOCATE tcur;

    SELECT [Table Name], [Column name], [Primary Key], InValue, OutValue
    FROM #diffs ORDER BY [Table Name], [Column name], [Primary Key];
END
```

- Emit **exactly one** `CREATE OR ALTER PROCEDURE dbo.usp_ReconcileInVsOut` — no `GO`, no `USE`, no batch
  separators, no statements outside the procedure, no markdown fences.
- Populate `@tables` with **every** table in the TABLES list below (and only those), with each table's PK
  column(s) and FK-ignore columns exactly as given.

## Column discovery at run time

```
SELECT c.COLUMN_NAME
FROM   <InDb>.INFORMATION_SCHEMA.COLUMNS c
WHERE  c.TABLE_SCHEMA = @SchemaName AND c.TABLE_NAME = @t
  AND  EXISTS (SELECT 1 FROM <OutDb>.INFORMATION_SCHEMA.COLUMNS o
              WHERE o.TABLE_SCHEMA = @SchemaName AND o.TABLE_NAME = @t AND o.COLUMN_NAME = c.COLUMN_NAME)
  AND  c.COLUMN_NAME NOT IN (<PK columns>) AND c.COLUMN_NAME NOT IN (<IgnoreCols>)
```

`<InDb>`/`<OutDb>` are built with `QUOTENAME(@InDbName)`/`QUOTENAME(@OutDbName)`. The
`WHERE EXISTS(SELECT i.<col> EXCEPT SELECT o.<col>)` test is NULL-safe (two NULLs equal; NULL vs a value
is a difference). `CONVERT(NVARCHAR(MAX), …)` lets any column type share the result set.

## Why dynamic SQL is mandatory

A database name **cannot** be parameterized in static T‑SQL, so build each statement as an
`NVARCHAR(MAX)` string and run it with `EXEC sys.sp_executesql`. Compose 3‑part names from the parameters:
`QUOTENAME(@InDbName)+N'.'+QUOTENAME(@SchemaName)+N'.'+QUOTENAME(@t)` (and the same with `@OutDbName`).

## Identifier quoting — REQUIRED (the database, tables AND columns can all contain spaces)

The **database name**, **schema**, **table names** AND **column names** may all be reserved T‑SQL
keywords (`Order`, `User`) **or contain spaces** (`My Claims DB`, `Loss Date`, `Trip Segment`). So the
generated proc MUST bracket-quote **every** identifier with `QUOTENAME(...)` — never build a name by bare
string concatenation. Concretely:

- **Database**: `QUOTENAME(@InDbName)` / `QUOTENAME(@OutDbName)` everywhere the db is referenced —
  including in the catalog query: `QUOTENAME(@InDbName) + N'.INFORMATION_SCHEMA.COLUMNS'` → e.g.
  `[My Claims DB].INFORMATION_SCHEMA.COLUMNS`. (`@InDbName`/`@OutDbName`/`@SchemaName` are passed as
  parameters to the run-time catalog lookup and compared as data, which is space-safe; when they name an
  object in dynamic SQL they must be `QUOTENAME`d.)
- **Table**: `QUOTENAME(@t)` in the 3‑part name.
- **PK / join columns**: `QUOTENAME(@keycol)` in both the join predicate and the `[Primary Key]` value
  expression (`CONVERT(NVARCHAR(MAX), i.' + QUOTENAME(@keycol) + N')`, and the composite `CONCAT(...)`).
- **Compared columns**: the catalog-discovered column variable via `QUOTENAME(@col)` in the SELECT list,
  the `CONVERT`, and the `EXCEPT` difference test.

`QUOTENAME(N'Loss Date')` → `[Loss Date]`; `QUOTENAME(N'Order')` → `[Order]`. Literal table/column names
you write out (`N'<t>' AS [Table Name]`) come verbatim from the supplied lists (they may contain spaces —
that's fine inside an `N'...'` literal); double any single quote inside a literal (`N'O''Brien'`). Never
emit a bare `i.Loss Date`, `o.Order`, or `MyDb.dbo.MyTable` without brackets.

## Validity — the output MUST parse as SQL Server T‑SQL

- Default dialect is **Microsoft SQL Server (T‑SQL)**. The procedure must be **syntactically valid**:
  balanced `BEGIN`/`END`, valid cursor open/fetch/close/deallocate, parentheses and quotes; a single
  well-formed `CREATE OR ALTER PROCEDURE`; every dynamic-SQL holder declared `NVARCHAR(MAX)`.
- **Data types**: use ONLY concrete built-in types — `sysname`, `NVARCHAR(MAX)`, `NVARCHAR(4000)`, `INT`.
  Every compared value is `CONVERT(NVARCHAR(MAX), …)`. **Never** invent, reference, or declare a
  user-defined type, and never emit a placeholder token such as `NULL_PLACEHOLDER` where a data type is
  expected — that produces "Cannot find data type" errors.
- Re-read your own output and fix any syntax error — it is checked and must compile cleanly, formatted
  with uppercase keywords and 4‑space indentation.

## Safety

- **Read-only against the data.** Use only `SELECT` (with `EXCEPT`, joins) and the catalog views. Never
  `INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE / MERGE` against the compared databases (only the
  `#diffs` temp table is written), and never `DROP`/`CREATE` a database. The only DDL is the outer
  `CREATE OR ALTER PROCEDURE` and `#diffs`.
