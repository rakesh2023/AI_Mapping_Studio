# AI Data Conversion Studio — single-user

Run the whole app on your own machine with **your own Claude (Anthropic) API key**. No admin
rights, no installer, no `.exe` — just Python. On first launch it opens a **setup wizard** in your
browser that asks for your API key and lets you install optional features.

## Requirements
- **Python 3.10+** on your machine (`python --version`). Get it from
  [python.org/downloads](https://www.python.org/downloads/) — on Windows, tick *"Add python.exe to PATH"*.
- An **Anthropic API key** — create one at
  [console.anthropic.com](https://console.anthropic.com/settings/keys).
- (Optional) The **Microsoft ODBC Driver 18 for SQL Server**, only if you want to connect to a live
  SQL Server. It's an OS driver, so the wizard links you to it rather than installing it.

## Run it
1. Unzip this folder anywhere you like.
2. **Windows:** double-click **`run.bat`**.  **macOS/Linux:** run **`./run.sh`** in a terminal.
   - The first run creates a local `.venv` and installs base dependencies (no admin needed).
3. Your browser opens to the **setup wizard**:
   - **Step 1** — paste your Claude API key and pick a model → *Validate & save*.
   - **Step 2** — optionally install Excel/PDF/Word extraction, data profiling, or live SQL support
     (each installs into this app's local environment, then it restarts itself).
4. Click **Open the app** and start mapping.

Re-running `run.bat` / `run.sh` reuses the local environment and starts instantly.

## What works without extra installs
- The full mapping workflow with **File System** sources (upload Excel/CSV/SQL/PDF/etc.), AI mapping
  generation, workspace review, lookup mapping, validation config, ETL code, and export.
- Optional installs add: **Excel/PDF/Word** parsing (`office`), **Know Your Data / profiling**
  (`profiling`), and **live SQL Server** sources/targets (`sql` + the ODBC driver above).

## Where your data lives
- Your API key and settings: **`singleuser/.env`** (this folder — never leaves your machine).
- Your working data (connections, mappings, lookups): a local SQLite DB under **`singleuser/data/`**.
- Nothing is sent anywhere except the Anthropic API calls made with your key.

## Notes
- This single-user launcher is **isolated** from any multi-user/server setup: it ignores the
  server's shared `.env` and uses its own config + database, so it can't interfere with a shared
  deployment.
- To change your key or model later, open **`/setup`** in the app again.
- Change the port with `PORT=8080` (in `.env`) if `8000` is busy; set `AIMS_NO_BROWSER=1` to not
  auto-open the browser.
