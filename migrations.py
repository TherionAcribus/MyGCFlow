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


def _v2_tables_lab(db):
    # Tables Adventure Lab (historique + découvertes). Idempotent :
    # db.create_all() les crée déjà sur base neuve ; cette migration couvre
    # les bases où create_all aurait été sauté ou partiellement appliqué.
    from sqlalchemy import text
    with db.engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS lab_collection ("
            "id INTEGER PRIMARY KEY, uid VARCHAR(64) UNIQUE NOT NULL, "
            "account_label VARCHAR(255), revision INTEGER NOT NULL DEFAULT 0, "
            "last_import_at DATETIME, last_exported_at DATETIME, "
            "last_coverage VARCHAR(16), last_import_summary TEXT, "
            "created_at DATETIME)"
        ))
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS lab_discovery ("
            "id INTEGER PRIMARY KEY, "
            "collection_id INTEGER NOT NULL REFERENCES lab_collection (id), "
            "local_uid VARCHAR(64) NOT NULL, "
            "adventure_uuid VARCHAR(64), stage_uuid VARCHAR(64), "
            "adventure_title VARCHAR(255), stage_title VARCHAR(255), "
            "adventure_url VARCHAR(512), "
            "found_date DATE, found_at_utc DATETIME, "
            "found_at_offset_minutes INTEGER, "
            "date_precision VARCHAR(16), date_basis VARCHAR(32), "
            "source_date_text VARCHAR(64), "
            "latitude FLOAT, longitude FLOAT, "
            "coordinate_scope VARCHAR(16), coordinate_source VARCHAR(32), "
            "coordinate_status VARCHAR(16), "
            "source_format VARCHAR(32), source_record_key VARCHAR(128), "
            "is_archived BOOLEAN DEFAULT 0, "
            "imported_at DATETIME, updated_at DATETIME, "
            "CONSTRAINT uq_lab_discovery_stage UNIQUE (collection_id, stage_uuid), "
            "CONSTRAINT uq_lab_discovery_local_uid UNIQUE (collection_id, local_uid))"
        ))
        for idx in (
            "CREATE INDEX IF NOT EXISTS ix_lab_discovery_found_date "
            "ON lab_discovery (collection_id, found_date)",
            "CREATE INDEX IF NOT EXISTS ix_lab_discovery_adventure "
            "ON lab_discovery (collection_id, adventure_uuid)",
            "CREATE INDEX IF NOT EXISTS ix_lab_discovery_coord_status "
            "ON lab_discovery (collection_id, coordinate_status)",
        ):
            conn.execute(text(idx))


def _v3_lab_echec_recuperation(db):
    # Mémoire des Adventures que lab2gpx n'a pas su servir. Idempotent :
    # db.create_all() pose déjà la colonne sur une table créée à l'instant.
    with db.engine.begin() as conn:
        columns = {row[1] for row in
                   conn.exec_driver_sql("PRAGMA table_info(lab_discovery)")}
        if "coord_fetch_failed_at" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE lab_discovery ADD COLUMN coord_fetch_failed_at DATETIME")


def _v4_lab_coordonnees_proposees(db):
    # Proposition de coordonnées en attente de validation. Idempotent, comme v3.
    with db.engine.begin() as conn:
        columns = {row[1] for row in
                   conn.exec_driver_sql("PRAGMA table_info(lab_discovery)")}
        for name in ("suggested_latitude", "suggested_longitude"):
            if name not in columns:
                conn.exec_driver_sql(
                    f"ALTER TABLE lab_discovery ADD COLUMN {name} FLOAT")


def _v5_lab_proprietaire_publication(db):
    # Propriétaire et date de publication lus dans le GPX. Idempotent, comme v3.
    with db.engine.begin() as conn:
        columns = {row[1] for row in
                   conn.exec_driver_sql("PRAGMA table_info(lab_discovery)")}
        for name, sql_type in (("owner", "VARCHAR(255)"), ("published_date", "DATE")):
            if name not in columns:
                conn.exec_driver_sql(
                    f"ALTER TABLE lab_discovery ADD COLUMN {name} {sql_type}")


MIGRATIONS = [
    (1, _v1_colonnes_et_index),
    (2, _v2_tables_lab),
    (3, _v3_lab_echec_recuperation),
    (4, _v4_lab_coordonnees_proposees),
    (5, _v5_lab_proprietaire_publication),
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
