"""Tableaux de bord de la page Statistiques : fichier `dashboards.json`.

Préférence globale, rangée à part de `settings.json` (les tableaux de bord
grossissent : un graphique décrit sa source, ses périodes, ses filtres, sa
vue). Le client normalise le contenu (`static/js/dashboard_model.mjs`,
`chart_spec.mjs`) ; le serveur ne calcule rien avec, il ne vérifie que la
forme générale, la version et la taille avant d'écrire.
"""

import hashlib
import json
from pathlib import Path

from settings_manager import app_config_dir, atomic_write, backup_path

DASHBOARDS_VERSION = 1
MAX_BYTES = 1024 * 1024
MAX_DASHBOARDS = 20
MAX_ITEMS = 24
FILE_NAME = "dashboards.json"


class InvalidDocument(ValueError):
    """Document refusé : `code` dit pourquoi (repris dans la réponse HTTP)."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def dashboards_path() -> Path:
    # Relu à chaque appel : MYGCFLOW_CONFIG_DIR peut changer entre deux tests.
    return app_config_dir() / FILE_NAME


def _load_file(path: Path):
    """Document d'un fichier, ou None (absent, illisible, version inconnue)."""
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        validate_document(doc)
    except (OSError, ValueError):
        return None
    return doc


def read_status() -> dict:
    """{document, rev, corrupt, backup_available} — état complet du fichier.

    `rev` est le sha1 du contenu enregistré : il change à chaque écriture et
    sert de base de comparaison au PUT (en-tête X-Dashboard-Rev). `corrupt`
    distingue un fichier illisible d'un fichier simplement absent, pour
    proposer la restauration de la copie `.bak` laissée par atomic_write.
    """
    path = dashboards_path()
    if not path.exists():
        return {"document": None, "rev": None, "corrupt": False,
                "backup_available": _load_file(backup_path(path)) is not None}
    try:
        data = path.read_bytes()
    except OSError:
        return {"document": None, "rev": None, "corrupt": True,
                "backup_available": _load_file(backup_path(path)) is not None}
    rev = hashlib.sha1(data).hexdigest()
    try:
        doc = json.loads(data.decode("utf-8"))
        validate_document(doc)
        corrupt = False
    except (UnicodeDecodeError, ValueError):
        doc, corrupt = None, True
    return {"document": doc, "rev": rev, "corrupt": corrupt,
            "backup_available": _load_file(backup_path(path)) is not None}


def load_document():
    """Document enregistré, ou None (absent, illisible, version inconnue)."""
    return read_status()["document"]


def validate_document(doc):
    """Forme générale : {v, dashboards: [{id, items: [...]}, ...], active}."""
    if not isinstance(doc, dict):
        raise InvalidDocument("not-an-object")
    version = doc.get("v")
    if not isinstance(version, int) or isinstance(version, bool) or not 1 <= version <= DASHBOARDS_VERSION:
        raise InvalidDocument("unknown-version")
    dashboards = doc.get("dashboards")
    if not isinstance(dashboards, list) or len(dashboards) > MAX_DASHBOARDS:
        raise InvalidDocument("bad-dashboards")
    for dashboard in dashboards:
        if not isinstance(dashboard, dict) or not isinstance(dashboard.get("id"), str):
            raise InvalidDocument("bad-dashboard")
        items = dashboard.get("items")
        if not isinstance(items, list) or len(items) > MAX_ITEMS:
            raise InvalidDocument("bad-items")
        if any(not isinstance(item, dict) for item in items):
            raise InvalidDocument("bad-item")
    active = doc.get("active")
    if active is not None and not isinstance(active, str):
        raise InvalidDocument("bad-active")


def save_document(doc):
    """Écrit le document, renvoie sa révision (sha1 du contenu écrit).

    Un fichier principal illisible est d'abord renommé `.corrupt` : sinon
    atomic_write le recopierait dans `.bak` par-dessus la dernière copie
    valide, et la preuve de la corruption disparaîtrait.
    """
    validate_document(doc)
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(data.encode("utf-8")) > MAX_BYTES:
        raise InvalidDocument("too-large")
    path = dashboards_path()
    if path.exists() and _load_file(path) is None:
        path.replace(path.with_name(path.name + ".corrupt"))
    atomic_write(path, data)
    return hashlib.sha1(data.encode("utf-8")).hexdigest()


def restore_backup():
    """Réécrit le document depuis `dashboards.json.bak` ; le renvoie.

    Le fichier principal corrompu est conservé sous `.corrupt` (preuve et
    protection du `.bak`, qui reste la dernière copie valide).
    """
    doc = _load_file(backup_path(dashboards_path()))
    if doc is None:
        raise InvalidDocument("no-backup")
    path = dashboards_path()
    if path.exists():
        path.replace(path.with_name(path.name + ".corrupt"))
    atomic_write(path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    return doc


def delete_document():
    """Efface le fichier : la page recrée le tableau de bord par défaut."""
    dashboards_path().unlink(missing_ok=True)
