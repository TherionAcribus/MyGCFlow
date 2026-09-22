"""Emplacements des fichiers de GCMap.

Deux racines distinctes :

- les **ressources** (templates, static, translations) : livrées avec
  l'application, en lecture seule. Une fois installée (Program Files) ou
  empaquetée par PyInstaller (dossier temporaire `sys._MEIPASS`), l'application
  n'a pas le droit d'y écrire ;
- les **données** (base, caches, captures, pistes audio, vidéos) : propres à
  l'utilisateur, conservées entre deux versions et à la désinstallation.

Les préférences et profils ont leur propre emplacement (%APPDATA%\\GCMap),
géré par settings_manager.app_config_dir().

Toutes les fonctions sont évaluées à l'appel (pas de constantes de module) :
les tests redirigent les données via une variable d'environnement posée après
l'import.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "GCMap"

# Dossier « Vidéos » de Windows (FOLDERID_Videos), qui suit une éventuelle
# redirection OneDrive, contrairement à ~/Videos.
_FOLDERID_VIDEOS = "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}"


def is_frozen() -> bool:
    """Vrai quand GCMap tourne depuis l'exécutable PyInstaller."""
    return bool(getattr(sys, "frozen", False))


def resource_dir() -> Path:
    """Racine des ressources en lecture seule (templates, static, translations)."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def _data_override() -> str | None:
    # GCMAP_DATA_DIR redirige toutes les données (base, caches, médias).
    # GCMAP_RUNTIME_DIR est l'ancien nom, encore posé par le harnais Playwright.
    return os.getenv("GCMAP_DATA_DIR") or os.getenv("GCMAP_RUNTIME_DIR")


def data_dir() -> Path:
    """Racine des données de l'utilisateur.

    - variable d'environnement si fournie (tests, installation portable) ;
    - application installée : %LOCALAPPDATA%\\GCMap (données volumineuses et
      propres à la machine, donc pas dans le profil itinérant %APPDATA%) ;
    - développement : le dossier du projet, où se trouvent les données
      historiques (instance/geocaching.db, video/, audio/, captured/).
    """
    override = _data_override()
    if override:
        return Path(override).resolve()
    if is_frozen():
        base = os.getenv("LOCALAPPDATA") or os.path.expanduser("~")
        return Path(base) / APP_NAME
    return resource_dir()


def instance_dir() -> Path:
    return data_dir() / "instance"


def database_path() -> Path:
    return instance_dir() / "geocaching.db"


def geojson_data_path() -> Path:
    """GeoJSON complet persisté (cache reconstruit à partir de la base)."""
    return instance_dir() / "geojson_data.json"


def geojson_indexes_path() -> Path:
    return instance_dir() / "geojson_indexes.json"


def country_state_path() -> Path:
    """Arbre pays → régions extrait de la base (cache reconstruit à la demande)."""
    return instance_dir() / "country_state.json"


def captured_dir() -> Path:
    """Images de l'enregistrement en mode « images », vidé après assemblage."""
    return data_dir() / "captured"


def audio_dir() -> Path:
    return data_dir() / "audio"


def video_dir() -> Path:
    """Dossier des vidéos produites.

    Application installée : « Vidéos\\GCMap », là où l'utilisateur s'attend à
    retrouver ses films. Sinon (développement, tests), sous la racine des
    données, comme auparavant.
    """
    if is_frozen() and not _data_override():
        videos = _known_folder(_FOLDERID_VIDEOS) or Path.home() / "Videos"
        return videos / APP_NAME
    return data_dir() / "video"


def logs_dir() -> Path:
    return data_dir() / "logs"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _known_folder(folder_id: str) -> Path | None:
    """Chemin d'un dossier connu Windows (SHGetKnownFolderPath), None ailleurs."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        import uuid
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        u = uuid.UUID(folder_id)
        guid = GUID(u.time_low, u.time_mid, u.time_hi_version,
                    (ctypes.c_ubyte * 8).from_buffer_copy(u.bytes[8:]))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
            return None
        try:
            return Path(out.value) if out.value else None
        finally:
            ctypes.windll.ole32.CoTaskMemFree(out)
    except Exception:
        return None
