"""Versionnement du schéma de la base SQLite.

`db.create_all()` crée les tables absentes mais ne modifie jamais une table
existante : une colonne ajoutée au modèle casserait la base d'un utilisateur
qui met à jour l'application. Le numéro de schéma est stocké dans la base
elle-même (PRAGMA user_version, 0 pour une base jamais migrée) et chaque
migration n'est appliquée qu'une fois, dans l'ordre.

Pour faire évoluer le schéma : modifier models.py, puis ajouter à MIGRATIONS
une fonction `(version suivante, fonction)` qui amène une base existante au
nouveau schéma. Ne jamais modifier une migration déjà publiée.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)


def _v1_colonnes_et_index(db):
    # Rattrape toutes les bases antérieures au versionnement : colonnes
    # ajoutées au fil des versions et index de filtrage. Idempotent.
    from bdd import ensure_geocache_columns, ensure_geocache_indexes
    ensure_geocache_columns(db)
    ensure_geocache_indexes(db)


MIGRATIONS = [
    (1, _v1_colonnes_et_index),
]

LATEST_VERSION = MIGRATIONS[-1][0]


def get_schema_version(db) -> int:
    with db.engine.connect() as conn:
        return int(conn.exec_driver_sql("PRAGMA user_version").scalar() or 0)


def _set_schema_version(db, version: int) -> None:
    with db.engine.begin() as conn:
        conn.exec_driver_sql(f"PRAGMA user_version = {int(version)}")


def _has_data(db) -> bool:
    # Une base toute neuve (créée à l'instant par create_all) ne mérite pas
    # de sauvegarde.
    try:
        with db.engine.connect() as conn:
            return conn.exec_driver_sql("SELECT 1 FROM geocache LIMIT 1").first() is not None
    except Exception:
        return True


def _backup(db, version: int) -> None:
    """Copie la base avant migration : une migration ratée reste récupérable."""
    database = db.engine.url.database
    if not database:
        return
    path = Path(database)
    if not path.exists() or not _has_data(db):
        return
    backup = path.with_name(f"{path.name}.v{version}.bak")
    shutil.copy2(path, backup)
    logger.info("Sauvegarde de la base avant migration : %s", backup)


def upgrade(db) -> int:
    """Amène la base au dernier schéma connu et renvoie sa version finale."""
    if db.engine.url.get_backend_name() != "sqlite":
        return LATEST_VERSION

    current = get_schema_version(db)
    if current > LATEST_VERSION:
        # Base ouverte par une version plus récente de MyGCFlow puis revenue à une
        # version antérieure : on ne touche à rien.
        logger.warning(
            "Schéma de base v%s plus récent que cette version de MyGCFlow (v%s).",
            current, LATEST_VERSION,
        )
        return current

    pending = [(v, fn) for v, fn in MIGRATIONS if v > current]
    if not pending:
        return current

    _backup(db, current)
    for version, migrate in pending:
        logger.info("Migration du schéma de base : v%s → v%s", current, version)
        migrate(db)
        _set_schema_version(db, version)
        current = version
    return current
