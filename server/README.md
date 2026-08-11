# AI Mapping Studio — local backend

Adds a **real SQL Server connection** to the Metadata Explorer. A browser cannot
open a database socket directly, so this small Flask service holds the ODBC
driver and exposes the schema over HTTP. It also serves the static site, so
everything runs on one origin (`http://localhost:8000`).

## Prerequisites
- Python 3.9+
- Microsoft ODBC Driver for SQL Server (17 or 18) installed on this machine.
  Download: https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server

## Setup
```
cd server
pip install -r requirements.txt
python app.py
```
Open **http://localhost:8000/** → Metadata Explorer → **Connect to Database**.

> Stop the old `python -m http.server` first — this Flask app replaces it and
> serves the same site on port 8000, plus the `/api/db/*` endpoints.

## Endpoints
- `GET  /api/db/drivers`  — ODBC drivers available on the machine
- `POST /api/db/test`     — test a connection (returns SQL Server version)
- `POST /api/db/metadata` — real tables + columns (PK/FK, row counts) as JSON

## Connection payload
```json
{
  "driver": "ODBC Driver 17 for SQL Server",
  "server": "localhost\\SQLEXPRESS",
  "database": "LegacyPolicyDB",
  "schema": "dbo",
  "trusted": false,
  "username": "sa",
  "password": "••••••"
}
```
Set `"trusted": true` to use Windows integrated auth (omit username/password).

Credentials are used only to open a short-lived connection per request and are
never written to disk.
