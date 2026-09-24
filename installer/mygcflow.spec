# -*- mode: python ; coding: utf-8 -*-
"""Construction de MyGCFlow.exe (PyInstaller, mode dossier).

    .venv-build\\Scripts\\pyinstaller installer\\mygcflow.spec --noconfirm

Résultat : dist\\MyGCFlow\\MyGCFlow.exe + dist\\MyGCFlow\\_internal\\ (bibliothèques et
ressources). Mode dossier plutôt que fichier unique : démarrage immédiat (pas
de décompression à chaque lancement) et bien moins de faux positifs antivirus.
"""

import os
import re
from pathlib import Path

from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo,
    VarStruct, VSVersionInfo,
)

ROOT = Path(SPECPATH).parent

VERSION = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "version.py").read_text(encoding="utf-8")).group(1)
_numbers = [int(part) for part in re.findall(r"\d+", VERSION)[:4]]
VERSION_TUPLE = tuple(_numbers + [0] * (4 - len(_numbers)))

# Fichiers générés en développement dans static/ : ce sont des données de
# l'utilisateur (désormais rangées dans paths.data_dir()), pas des ressources.
EXCLUDED_RESOURCES = {
    Path("static/geojson_data.json"),
    Path("static/json/country_state.json"),
}


def resource_tree(folder, suffixes=None):
    """Liste (source, destination) des fichiers d'un dossier de ressources."""
    entries = []
    for dirpath, _dirnames, filenames in os.walk(ROOT / folder):
        for name in filenames:
            source = Path(dirpath) / name
            relative = source.relative_to(ROOT)
            if relative in EXCLUDED_RESOURCES or "__pycache__" in relative.parts:
                continue
            if suffixes and source.suffix not in suffixes:
                continue
            entries.append((str(source), str(relative.parent)))
    return entries


datas = (
    resource_tree("templates")
    + resource_tree("static")
    # Seuls les catalogues compilés sont lus à l'exécution.
    + resource_tree("translations", suffixes={".mo"})
    + [(str(ROOT / "installer" / "licenses"), "licenses")]
)

version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=VERSION_TUPLE, prodvers=VERSION_TUPLE),
    kids=[
        StringFileInfo([StringTable("040C04B0", [
            StringStruct("CompanyName", "MyGCFlow"),
            StringStruct("FileDescription", "MyGCFlow"),
            StringStruct("FileVersion", VERSION),
            StringStruct("InternalName", "MyGCFlow"),
            StringStruct("OriginalFilename", "MyGCFlow.exe"),
            StringStruct("ProductName", "MyGCFlow"),
            StringStruct("ProductVersion", VERSION),
        ])]),
        VarFileInfo([VarStruct("Translation", [0x040C, 1200])]),
    ],
)

a = Analysis(
    [str(ROOT / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    # pystray choisit son moteur à l'exécution (import dynamique).
    hiddenimports=["pystray._win32"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Paquets parfois présents dans l'environnement mais inutiles à MyGCFlow.
    excludes=["tkinter", "numpy", "moviepy", "matplotlib", "IPython", "pytest"],
    noarchive=False,
)

# Babel embarque les données de ~1 000 locales (30 Mo) ; MyGCFlow n'est traduit
# qu'en français et en anglais.
KEPT_LOCALES = ("root", "fr", "en")


def _keep(entry):
    parts = Path(entry[0]).parts
    if len(parts) == 3 and parts[:2] == ("babel", "locale-data"):
        locale = Path(parts[2]).stem
        return locale.split("_")[0] in KEPT_LOCALES
    return True


a.datas = [entry for entry in a.datas if _keep(entry)]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MyGCFlow",
    icon=str(ROOT / "installer" / "mygcflow.ico"),
    version=version_info,
    console=False,
    # UPX déclenche des faux positifs antivirus pour un gain de taille modeste.
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    upx=False,
    name="MyGCFlow",
)
