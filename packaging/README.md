# Packaging — build a shareable `.exe`

Turn the whole app into a Windows executable you can hand to someone who has **no
Python and no source code**. It wraps the single-user launcher (`singleuser/run.py`),
which runs the full Flask backend + frontend locally and asks for the user's own
Claude (Anthropic) API key on first run.

## What you get

Running `build.ps1` produces:

| Output | What it is |
| --- | --- |
| `packaging/dist/AI Data Conversion Studio.exe` | **Portable single .exe** — double-click to run. On first launch a browser setup wizard asks for the API key. |
| `packaging/installer_output/AIMS-Setup.exe` | **Windows installer** — asks for the API key *during install*, adds Start Menu/desktop shortcuts + an uninstaller. Only built if [Inno Setup](https://jrsoftware.org/isdl.php) is installed. |

Send **either** file to the other person. The installer is the more polished option
(matches "ask for the key while installing"); the portable exe needs nothing installed.

## Build it

On the build machine you need **Python 3.10+** on PATH (and, for the installer,
**Inno Setup 6**). Then:

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

It creates a throwaway venv under `packaging\.buildvenv`, installs build deps +
PyInstaller, bundles the exe from `aims.spec`, and (if `ISCC.exe` is found) compiles
`installer.iss`. Re-run any time to rebuild. All build artifacts are gitignored.

## What's inside the exe

- The backend package (`server/app`) compiled to bytecode — **not shipped as source**.
- The frontend (`index.html`, `pages/`, `css/`, `js/`, `assets/`, `data/`) and the
  setup wizard, bundled as read-only resources.
- **All optional libraries** so every feature works out of the box: Excel/PDF/Word
  extraction (`openpyxl`/`pypdf`/`python-docx`), data profiling (`pandas`), and live
  SQL (`pyodbc`).

## Where the user's data goes (writable, outside the exe)

The bundle is read-only, so working state is written to a per-user folder:

```
%LOCALAPPDATA%\AI Data Conversion Studio\
  .env            <- the API key + model
  aims_app.db     <- connections, mappings, lookups (SQLite)
  aims_usage.db   <- local AI-usage log
```

Deleting that folder resets the app (and re-triggers the key prompt).

## Two things to tell the recipient

1. **Live SQL Server** needs the **Microsoft ODBC Driver 18 for SQL Server**
   installed on their machine — it's an OS driver and can't be bundled. Everything
   else (File System sources, AI mapping, Excel/PDF/Word, profiling, export) works
   with no extra install. The setup wizard links them to the driver.
2. **The frontend code is still readable in the browser's DevTools** — that's
   inherent to any web app. The exe hides it from the file system, and the Python
   backend ships as bytecode, but this is *casual* code-hiding, not strong IP
   protection.

## Notes / troubleshooting

- **SmartScreen**: an unsigned exe/installer may warn on first run ("More info →
  Run anyway"). Code-signing removes this but requires a certificate.
- **Antivirus false-positive**: PyInstaller one-file exes are occasionally flagged.
  A code-signing cert or shipping the installer usually helps.
- **Missing module at runtime**: add it to `hiddenimports` in `aims.spec` and rebuild.
- **Change model default**: it's picked in the wizard/installer; the built-in default
  is `claude-sonnet-5` (public Anthropic API).
