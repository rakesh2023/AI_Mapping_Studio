<#
  Build the shareable AI Data Conversion Studio .exe (and, if Inno Setup is
  installed, the Setup installer).

  Usage (from the repo root or anywhere):
      powershell -ExecutionPolicy Bypass -File packaging\build.ps1

  Outputs:
      packaging\dist\AI Data Conversion Studio.exe        <- portable single .exe
      packaging\installer_output\AIMS-Setup.exe           <- installer (if ISCC found)

  Requires: Python 3.10+ on PATH. No admin rights. First run downloads build
  dependencies into a throwaway venv under packaging\.buildvenv.
#>
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Set-Location $here

Write-Host "== AI Data Conversion Studio — EXE build ==" -ForegroundColor Cyan

# 1) Clean, isolated build venv (keeps the bundle free of unrelated packages).
$venv = Join-Path $here ".buildvenv"
$py   = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "Creating build venv ..." -ForegroundColor Yellow
  # Use whichever launcher exists: the 'py' launcher isn't always installed.
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -m venv $venv
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -m venv $venv
  } else {
    throw "Python 3.10+ not found on PATH. Install it from https://www.python.org/downloads and tick 'Add python.exe to PATH'."
  }
}
if (-not (Test-Path $py)) { throw "Could not create a Python venv under $venv." }

# 2) Build/runtime dependencies (pinned in build-requirements.txt; installed from a
#    file so version specifiers containing '<' don't trip PowerShell's parser).
Write-Host "Installing build dependencies ..." -ForegroundColor Yellow
& $py -m pip install --upgrade pip
& $py -m pip install -r (Join-Path $here "build-requirements.txt")
if (-not $?) { throw "Dependency install failed (check network/proxy)." }

# 3) Bundle the one-file exe from the spec.
Write-Host "Running PyInstaller ..." -ForegroundColor Yellow
Remove-Item -Recurse -Force (Join-Path $here "build"), (Join-Path $here "dist") -ErrorAction SilentlyContinue
& $py -m PyInstaller (Join-Path $here "aims.spec") --distpath (Join-Path $here "dist") --workpath (Join-Path $here "build") --noconfirm
if (-not $?) { throw "PyInstaller build failed." }

$exe = Join-Path $here "dist\AI Data Conversion Studio.exe"
if (-not (Test-Path $exe)) { throw "Expected exe not found: $exe" }
Write-Host ""
Write-Host "Portable EXE built:" -ForegroundColor Green
Write-Host "  $exe"

# 4) Optionally compile the Windows installer with Inno Setup, if available.
$iscc = $null
foreach ($c in @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
  if ($c -and (Test-Path $c)) { $iscc = $c; break }
}
if (-not $iscc) {
  $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($cmd) { $iscc = $cmd.Source }
}

if ($iscc) {
  Write-Host ""
  Write-Host "Inno Setup found — building installer ..." -ForegroundColor Yellow
  & $iscc (Join-Path $here "installer.iss")
  if ($?) {
    Write-Host ""
    Write-Host "Installer built:" -ForegroundColor Green
    Write-Host "  $(Join-Path $here 'installer_output\AIMS-Setup.exe')"
  } else {
    Write-Warning "Installer compile failed — the portable EXE above is still usable."
  }
} else {
  Write-Host ""
  Write-Warning "Inno Setup (ISCC.exe) not found — skipped the installer."
  Write-Host "  Install it from https://jrsoftware.org/isdl.php and re-run to also produce AIMS-Setup.exe."
  Write-Host "  The portable EXE above already works on its own."
}
