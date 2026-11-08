"""Tableaux de bord de la page Statistiques : fichier `dashboards.json`.

Préférence globale, rangée à part de `settings.json` (les tableaux de bord
grossissent : un graphique décrit sa source, ses périodes, ses filtres, sa
vue). Le client normalise le contenu (`static/js/dashboard_model.mjs`,
`chart_spec.mjs`) ; le serveur ne calcule rien avec, il ne vérifie que la
forme générale, la version et la taille avant d'écrire.
"""

import json
from pathlib import Path

from settings_manager import app_config_dir, atomic_write

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


def load_document():
    """Document enregistré, ou None (absent, illisible, version inconnue)."""
    path = dashboards_path()
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        validate_document(doc)
    except (OSError, ValueError):
        return None
    return doc


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
    validate_document(doc)
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(data.encode("utf-8")) > MAX_BYTES:
        raise InvalidDocument("too-large")
    atomic_write(dashboards_path(), data)


def delete_document():
    """Efface le fichier : la page recrée le tableau de bord par défaut."""
    dashboards_path().unlink(missing_ok=True)
