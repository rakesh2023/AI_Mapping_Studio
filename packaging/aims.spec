# PyInstaller spec for AI Data Conversion Studio (single-user, one-file .exe).
#
# Entry point is the single-user launcher (singleuser/run.py), which imports the
# existing Flask app unchanged and adds the first-run setup wizard. Everything the
# app needs at runtime is bundled: the whole `app` backend package, the static
# frontend, the setup wizard page, and all optional-feature libraries (Excel/PDF/
# Word, pandas profiling, pyodbc) so the shipped .exe works out of the box.
#
# Build with:   pyinstaller packaging\aims.spec --noconfirm
# (build.ps1 does this inside a clean venv.)
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

# SPECPATH is the directory that holds this spec file (packaging/); its parent is
# the repo root that holds index.html, server/, singleuser/, etc.
ROOT = os.path.dirname(os.path.abspath(SPECPATH))
SERVER = os.path.join(ROOT, "server")
SU = os.path.join(ROOT, "singleuser")

# --- Read-only resources bundled into the exe (extracted under sys._MEIPASS) --- #
datas = [
    (os.path.join(ROOT, "index.html"), "."),
    (os.path.join(ROOT, "pages"), "pages"),
    (os.path.join(ROOT, "css"), "css"),
    (os.path.join(ROOT, "js"), "js"),
    (os.path.join(ROOT, "assets"), "assets"),
    (os.path.join(ROOT, "data"), "data"),
    (os.path.join(SU, "setup.html"), "."),   # first-run wizard page
    # Non-.py runtime data files the backend opens by path (PyInstaller bundles
    # only .py as bytecode, so these must be added explicitly). app_db.py reads
    # schema.sql via __file__, so it must land next to it under app/db/.
    (os.path.join(SERVER, "app", "db", "schema.sql"), os.path.join("app", "db")),
]

binaries = []
hiddenimports = ["pyodbc"]

# Pull in every submodule of the backend: several services (KYD, etc.) are imported
# lazily inside functions, which PyInstaller's static analysis would otherwise miss.
hiddenimports += collect_submodules("app")

# Optional-feature + client libraries that ship dynamic submodules / data files.
for pkg in ("anthropic", "httpx", "certifi", "docx", "openpyxl", "pypdf",
            "pandas", "numpy"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        # A missing optional package at build time just means that feature isn't
        # bundled; the app still runs (capability guards degrade gracefully).
        pass

a = Analysis(
    [os.path.join(SU, "run.py")],
    pathex=[SU, SERVER],   # so `_envfile`, `setup_routes`, and `app` resolve
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

_icon = os.path.join(ROOT, "assets", "app.ico")
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AI Data Conversion Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,          # keep a console so the local URL + any errors are visible
    disable_windowed_traceback=False,
    icon=_icon if os.path.isfile(_icon) else None,
)
