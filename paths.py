"""Emplacements des fichiers de MyGCFlow.

Deux racines distinctes :

- les **ressources** (templates, static, translations) : livrées avec
  l'application, en lecture seule. Une fois installée (Program Files) ou
  empaquetée par PyInstaller (dossier temporaire `sys._MEIPASS`), l'application
  n'a pas le droit d'y écrire ;
- les **données** (base, caches, captures, pistes audio, vidéos) : propres à
  l'utilisateur, conservées entre deux versions et à la désinstallation.

Chaque racine suit l'emplacement propre à la plateforme : %LOCALAPPDATA% sous
Windows, ~/Library/Application Support sous macOS, $XDG_DATA_HOME
(~/.local/share) sous Linux/BSD pour les données ; %APPDATA%, même dossier
macOS et $XDG_CONFIG_HOME (~/.config) pour la configuration.

Les préférences et profils ont leur propre emplacement
(%APPDATA%\\MyGCFlow sous Windows), géré par
settings_manager.app_config_dir().

Toutes les fonctions sont évaluées à l'appel (pas de constantes de module) :
les tests redirigent les données via une variable d'environnement posée après
l'import.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "MyGCFlow"
# Nom historique (GCMap) : sert à reprendre les données d'une installation
# antérieure au changement de nom. À retirer quand plus aucune installation
# n'est concernée.
LEGACY_APP_NAME = "GCMap"

# Dossier « Vidéos » de Windows (FOLDERID_Videos), qui suit une éventuelle
# redirection OneDrive, contrairement à ~/Videos.
_FOLDERID_VIDEOS = "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}"

# Vrai dès qu'une reprise du dossier de l'ancien nom a été tentée : data_dir()
# est appelée à chaque accès aux fichiers, le test ne doit pas se répéter.
_legacy_data_checked = False


def is_frozen() -> bool:
    """Vrai quand MyGCFlow tourne depuis l'exécutable PyInstaller."""
    return bool(getattr(sys, "frozen", False))


def resource_dir() -> Path:
    """Racine des ressources en lecture seule (templates, static, translations)."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def _data_override() -> str | None:
    # MYGCFLOW_DATA_DIR redirige toutes les données (base, caches, médias).
    # MYGCFLOW_RUNTIME_DIR est l'ancien nom, encore posé par le harnais Playwright.
    # Les variantes GCMAP_* datent d'avant le changement de nom.
    return (
        os.getenv("MYGCFLOW_DATA_DIR")
        or os.getenv("MYGCFLOW_RUNTIME_DIR")
        or os.getenv("GCMAP_DATA_DIR")
        or os.getenv("GCMAP_RUNTIME_DIR")
    )


def _xdg_dir(env_var: str, fallback: Path) -> Path:
    """Sous-dossier XDG : $env_var s'il est absolu, sinon `fallback` sous $HOME."""
    base = os.getenv(env_var)
    if base and Path(base).is_absolute():
        return Path(base)
    return Path.home() / fallback


def user_dir(kind: str) -> Path:
    """Base utilisateur des données (`"data"`) ou de la configuration (`"config"`).

    Windows : %LOCALAPPDATA% / %APPDATA% (repli sur le dossier personnel).
    macOS : ~/Library/Application Support dans les deux cas.
    Linux/BSD : $XDG_DATA_HOME ($HOME/.local/share) et $XDG_CONFIG_HOME
    ($HOME/.config), conformément à la spec XDG Base Directory.
    """
    home = Path.home()
    if os.name == "nt":
        env = "APPDATA" if kind == "config" else "LOCALAPPDATA"
        return Path(os.getenv(env) or home)
    if sys.platform == "darwin":
        return home / "Library" / "Application Support"
    if kind == "config":
        return _xdg_dir("XDG_CONFIG_HOME", Path(".config"))
    return _xdg_dir("XDG_DATA_HOME", Path(".local") / "share")


def data_dir() -> Path:
    """Racine des données de l'utilisateur.

    - variable d'environnement si fournie (tests, installation portable) ;
    - application installée : sous la base propre à la plateforme
      (%LOCALAPPDATA% sous Windows — données volumineuses et propres à la
      machine, donc pas dans le profil itinérant %APPDATA% —,
      ~/Library/Application Support sous macOS, $XDG_DATA_HOME sous
      Linux/BSD). Les données d'installations antérieures (ancien nom,
      dossier personnel d'avant XDG) sont reprises au passage ;
    - développement : le dossier du projet, où se trouvent les données
      historiques (instance/geocaching.db, video/, audio/, captured/).
    """
    override = _data_override()
    if override:
        return Path(override).resolve()
    if is_frozen():
        base = user_dir("data")
        current = base / APP_NAME
        _adopt_legacy_data_dir(current, base / LEGACY_APP_NAME)
        if os.name != "nt":
            # Builds antérieurs à la prise en charge XDG/macOS : leurs données
            # tombaient directement dans le dossier personnel.
            _adopt_legacy_data_dir(current, Path.home() / APP_NAME)
            _adopt_legacy_data_dir(current, Path.home() / LEGACY_APP_NAME)
        return current
    return resource_dir()


def _adopt_legacy_data_dir(current: Path, legacy: Path) -> None:
    """Reprend le dossier de données de l'ancien nom (GCMap), une seule fois.

    Renommage atomique (même volume). Sans effet si le dossier actuel existe
    déjà ou si l'ancien est absent ; un échec n'est pas bloquant, l'application
    repart alors sur des données vierges.
    """
    global _legacy_data_checked
    if _legacy_data_checked or current == legacy or current.exists() or not legacy.is_dir():
        return
    _legacy_data_checked = True
    try:
        current.parent.mkdir(parents=True, exist_ok=True)
        os.rename(legacy, current)
    except OSError:
        pass


def instance_dir() -> Path:
    return data_dir() / "instance"


def database_path() -> Path:
    return instance_dir() / "geocaching.db"


def evolution_database_path() -> Path:
    """Bases du mode Évolution (caches d'une zone importées depuis des CSV).

    Fichier distinct de geocaching.db : le cache GeoJSON des trouvailles est
    indexé sur la date de modification de celle-ci, et « Supprimer mes
    trouvailles » ne doit pas toucher aux bases du mode Évolution.
    """
    return instance_dir() / "evolution.db"


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


def video_streams_dir() -> Path:
    """Fragments .webm délestés pendant un enregistrement MediaRecorder.

    Chaque flux est un fichier stream_<id>.webm alimenté en append au fil de
    l'eau, remuxé ici même en raw_<id>.webm à la fin de la capture. Ce brut est
    supprimé une fois le MP4 produit : le dossier des vidéos ne reçoit que des
    vidéos terminées.
    """
    return data_dir() / "video_streams"


def audio_dir() -> Path:
    return data_dir() / "audio"


def images_dir() -> Path:
    """Images de l'utilisateur posées sur la carte (onglet Images), normalisées
    à l'envoi (image_library.py)."""
    return data_dir() / "images"


def default_video_dir() -> Path:
    """Dossier des vidéos tant que l'utilisateur n'en a pas choisi un autre.

    Application installée : le dossier « Vidéos » propre à la plateforme
    (dossier connu Windows, dossier XDG localisé sous Linux, ~/Videos en
    repli) suivi du nom de l'application — là où l'utilisateur s'attend à
    retrouver ses films. Sinon (développement, tests), sous la racine des
    données, comme auparavant.
    """
    if is_frozen() and not _data_override():
        videos = _known_folder(_FOLDERID_VIDEOS) or _xdg_videos_dir() or Path.home() / "Videos"
        return videos / APP_NAME
    return data_dir() / "video"


def configured_video_dir() -> Path | None:
    """Dossier des vidéos choisi dans l'onglet Export, None s'il n'y en a pas.

    Lu dans settings.json à chaque appel : le choix s'applique à l'export
    suivant sans redémarrage. Le chemin est renvoyé tel qu'enregistré, qu'il
    soit encore accessible ou non — c'est video_dir() qui décide du repli.
    """
    try:
        # Import tardif : settings_manager fige le dossier de configuration à
        # son import, que les tests redirigent par variable d'environnement.
        import settings_manager

        recording = settings_manager.read_json(settings_manager.SETTINGS_PATH).get("recording")
        raw = recording.get("output_dir") if isinstance(recording, dict) else None
    except Exception:
        return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = Path(raw.strip())
    return path if path.is_absolute() else None


def video_dir() -> Path:
    """Dossier des vidéos produites : celui choisi par l'utilisateur, sinon
    celui par défaut.

    Un dossier choisi devenu inaccessible (disque externe débranché, dossier
    supprimé) ne doit pas faire échouer un export : on retombe sur le dossier
    par défaut, et l'onglet Export signale l'écart.
    """
    custom = configured_video_dir()
    if custom is not None and custom.is_dir():
        return custom
    return default_video_dir()


def logs_dir() -> Path:
    return data_dir() / "logs"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _xdg_videos_dir() -> Path | None:
    """Dossier « Vidéos » XDG (user-dirs.dirs), None hors Linux ou si illisible."""
    if os.name == "nt" or sys.platform == "darwin":
        return None
    config = _xdg_dir("XDG_CONFIG_HOME", Path(".config")) / "user-dirs.dirs"
    try:
        for line in config.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if not sep or key.strip() != "XDG_VIDEOS_DIR":
                continue
            path = Path(value.strip().strip('"').replace("$HOME", str(Path.home())))
            return path if path.is_absolute() else None
    except OSError:
        pass
    return None


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
