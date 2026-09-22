# Construit GCMap pour Windows : exécutable (PyInstaller) puis installeur (Inno Setup).
#
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-SkipInstaller]
#
# Résultats dans dist\ :
#   dist\GCMap\GCMap.exe          version « portable » (dossier complet)
#   dist\GCMap-Setup-<ver>.exe    installeur (si Inno Setup 6 est présent)
#
# L'environnement de construction (.venv-build) est distinct de l'environnement
# de développement : seules les dépendances de requirements.txt sont
# embarquées dans l'exécutable.

param([switch]$SkipInstaller)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Échec : $Exe $($Arguments -join ' ') (code $LASTEXITCODE)" }
}

$Version = [regex]::Match((Get-Content -Raw 'version.py'), '__version__\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $Version) { throw 'Version introuvable dans version.py' }
Write-Host "== GCMap $Version"

# --- Environnement de construction -------------------------------------------
$VenvPython = Join-Path $Root '.venv-build\Scripts\python.exe'
$Uv = Get-Command uv -ErrorAction SilentlyContinue
if ($Uv) {
    if (-not (Test-Path $VenvPython)) { Invoke-Checked 'uv' @('venv', '.venv-build', '--python', '3.12') }
    Invoke-Checked 'uv' @('pip', 'install', '--python', $VenvPython, '-r', 'requirements-build.txt')
} else {
    if (-not (Test-Path $VenvPython)) { Invoke-Checked 'python' @('-m', 'venv', '.venv-build') }
    Invoke-Checked $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
    Invoke-Checked $VenvPython @('-m', 'pip', 'install', '-r', 'requirements-build.txt')
}

# --- Exécutable ---------------------------------------------------------------
Write-Host '== PyInstaller'
Invoke-Checked $VenvPython @('-m', 'PyInstaller', 'installer\gcmap.spec', '--noconfirm', '--clean',
                             '--distpath', 'dist', '--workpath', 'build')
Invoke-Checked $VenvPython @('installer\collect_licenses.py', 'dist\GCMap\_internal\licenses\python')

# --- Installeur ---------------------------------------------------------------
if ($SkipInstaller) { Write-Host '== Installeur ignoré (-SkipInstaller)'; exit 0 }

$Iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $Iscc) {
    $Iscc = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Iscc) {
    Write-Warning 'Inno Setup 6 introuvable : installeur non construit (winget install JRSoftware.InnoSetup).'
    exit 0
}
Write-Host '== Inno Setup'
Invoke-Checked $Iscc @("/DAppVersion=$Version", 'installer\gcmap.iss')
Write-Host "== Terminé : dist\GCMap-Setup-$Version.exe"
