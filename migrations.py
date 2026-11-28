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


def _v6_lab_rang_et_images(db):
    # Rang de l'étape, nombre d'étapes et images (popup). Idempotent, comme v3.
    with db.engine.begin() as conn:
        columns = {row[1] for row in
                   conn.exec_driver_sql("PRAGMA table_info(lab_discovery)")}
        for name, sql_type in (("stage_number", "INTEGER"), ("stages_total", "INTEGER"),
                               ("stage_image_url", "VARCHAR(512)"),
                               ("adventure_image_url", "VARCHAR(512)")):
            if name not in columns:
                conn.exec_driver_sql(
                    f"ALTER TABLE lab_discovery ADD COLUMN {name} {sql_type}")


def _v7_region_factice(db):
    # Région « None » des GPX geocaching.com (pays sans régions) : remise à
    # NULL, comme le fait désormais l'import (bdd.clean_geo_text). Idempotent.
    # L'arbre pays/régions en cache est jeté pour être reconstruit ; le cache
    # GeoJSON persistant suit déjà la date de modification de la base.
    from bdd import GEO_PLACEHOLDERS
    import paths
    placeholders = sorted(GEO_PLACEHOLDERS)
    marks = ", ".join("?" for _ in placeholders)
    changed = 0
    with db.engine.begin() as conn:
        for column in ("country", "state"):
            changed += conn.exec_driver_sql(
                f"UPDATE geocache SET {column} = NULL "
                f"WHERE lower(trim({column})) IN ({marks})", tuple(placeholders)).rowcount
    if changed:
        logger.info("Région/pays factices remis à vide : %s géocache(s)", changed)
        try:
            paths.country_state_path().unlink(missing_ok=True)
        except OSError:
            pass


def _v8_tables_logs(db):
    # Logs Geocaching : collection, événements, fiches de caches
    # (docs/logs-geocaching.md). Idempotent, comme v2.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS log_collection ("
            "id INTEGER PRIMARY KEY, uid VARCHAR(64) UNIQUE NOT NULL, "
            "account_user_id INTEGER, account_username VARCHAR(255), "
            "revision INTEGER NOT NULL DEFAULT 0, "
            "last_import_at DATETIME, last_import_summary TEXT, "
            "created_at DATETIME)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS log_event ("
            "id INTEGER PRIMARY KEY, "
            "collection_id INTEGER NOT NULL REFERENCES log_collection (id), "
            "log_id INTEGER NOT NULL, gc_code VARCHAR(16) NOT NULL, "
            "type_id INTEGER NOT NULL, log_date DATE NOT NULL, "
            "author_id INTEGER, author_name VARCHAR(255), favorite BOOLEAN, "
            "source_format VARCHAR(32), source_exported_at DATETIME, "
            "imported_at DATETIME, updated_at DATETIME, "
            "CONSTRAINT uq_log_event_log_id UNIQUE (collection_id, log_id))"
        )
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS cache_ref ("
            "id INTEGER PRIMARY KEY, "
            "collection_id INTEGER NOT NULL REFERENCES log_collection (id), "
            "gc_code VARCHAR(16) NOT NULL, name VARCHAR(255), "
            "cache_type VARCHAR(50), container VARCHAR(50), "
            "difficulty FLOAT, terrain FLOAT, "
            "country VARCHAR(100), state VARCHAR(100), "
            "latitude FLOAT, longitude FLOAT, coordinate_source VARCHAR(32), "
            "corrected_latitude FLOAT, corrected_longitude FLOAT, "
            "owner_id INTEGER, owner_name VARCHAR(255), placed_date DATE, "
            "status VARCHAR(16), status_at DATETIME, favorite_points INTEGER, "
            "source_format VARCHAR(32), source_exported_at DATETIME, "
            "imported_at DATETIME, updated_at DATETIME, "
            "CONSTRAINT uq_cache_ref_gc_code UNIQUE (collection_id, gc_code))"
        )
        for idx in (
            "CREATE INDEX IF NOT EXISTS ix_log_event_cache "
            "ON log_event (collection_id, gc_code, log_date)",
            "CREATE INDEX IF NOT EXISTS ix_log_event_author "
            "ON log_event (collection_id, author_id, type_id, log_date)",
            "CREATE INDEX IF NOT EXISTS ix_log_event_date "
            "ON log_event (collection_id, log_date)",
            "CREATE INDEX IF NOT EXISTS ix_cache_ref_owner "
            "ON cache_ref (collection_id, owner_id)",
        ):
            conn.exec_driver_sql(idx)


def _v9_logs_horizon_dnf(db):
    # Horizon DNF de la collecte du favori (log_collection.dnf_covered_at) :
    # n'avance que sur un export à couverture DNF complète — une collecte
    # « caches posées seulement » ne doit pas faire sauter la fenêtre
    # incrémentale suivante. Idempotent, comme v3. Le rattrapage reprend
    # l'ancien calcul de l'horizon (max des exported_at des exports
    # mygcflow-logs), qui surestime si la dernière collecte était réduite
    # aux posées — borne haute tolérée, la collecte complète la rattrape.
    with db.engine.begin() as conn:
        columns = {row[1] for row in
                   conn.exec_driver_sql("PRAGMA table_info(log_collection)")}
        if "dnf_covered_at" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE log_collection ADD COLUMN dnf_covered_at DATETIME")
        conn.exec_driver_sql(
            "UPDATE log_collection SET dnf_covered_at = ("
            "SELECT max(source_exported_at) FROM log_event "
            "WHERE log_event.collection_id = log_collection.id "
            "AND source_format = 'mygcflow-logs')")



def _v10_table_parcours(db):
    # Parcours (MyGCFlow_Plan_Parcours.md, lot 0) : la sélection seule. Les
    # tables des ajustements, photos, traces et itinéraires viendront avec
    # leurs lots. Idempotent, comme v2.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours ("
            "id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL, "
            "date_start DATE NOT NULL, date_end DATE NOT NULL, "
            "include_labs BOOLEAN NOT NULL DEFAULT 1, "
            "include_dnf BOOLEAN NOT NULL DEFAULT 1, "
            "created_at DATETIME, updated_at DATETIME)"
        )



def _v11_ajustements_parcours(db):
    # Parcours, lot 3 : ajustements manuels des étapes et lieux posés.
    # Idempotent, comme v2.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours_override ("
            "id INTEGER PRIMARY KEY, "
            "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
            "stop_key VARCHAR(96) NOT NULL, rank INTEGER, pinned_time VARCHAR(5), "
            "day DATE, excluded BOOLEAN NOT NULL DEFAULT 0, "
            "CONSTRAINT uq_parcours_override_key UNIQUE (parcours_id, stop_key))"
        )
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours_place ("
            "id INTEGER PRIMARY KEY, "
            "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
            "kind VARCHAR(8) NOT NULL, name VARCHAR(80), "
            "latitude FLOAT NOT NULL, longitude FLOAT NOT NULL, "
            "date DATE, time VARCHAR(5), created_at DATETIME)"
        )



def _v12_photos_parcours(db):
    # Parcours, lot 4 : photos et décalage d'horloge par appareil.
    # Idempotent, comme v2.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours_photo ("
            "id INTEGER PRIMARY KEY, "
            "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
            "file VARCHAR(40) NOT NULL, original_name VARCHAR(255), "
            "taken_at VARCHAR(19), offset_minutes INTEGER, "
            "latitude FLOAT, longitude FLOAT, camera VARCHAR(120), "
            "width INTEGER, height INTEGER, stop_key VARCHAR(96), created_at DATETIME)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours_camera ("
            "id INTEGER PRIMARY KEY, "
            "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
            "camera VARCHAR(120) NOT NULL, offset_minutes INTEGER NOT NULL DEFAULT 0, "
            "CONSTRAINT uq_parcours_camera UNIQUE (parcours_id, camera))"
        )



def _v13_traces_parcours(db):
    # Parcours, lot 5 : traces GPS et décalage UTC du parcours. Idempotent.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS parcours_track ("
            "id INTEGER PRIMARY KEY, "
            "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
            "name VARCHAR(255), segments TEXT NOT NULL, "
            "point_count INTEGER NOT NULL DEFAULT 0, "
            "source_point_count INTEGER NOT NULL DEFAULT 0, "
            "start_utc DATETIME, end_utc DATETIME, created_at DATETIME)"
        )
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours)")}
        if "utc_offset_minutes" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours ADD COLUMN utc_offset_minutes INTEGER")



def _v14_itineraires_parcours(db):
    # Parcours, lot 6 : cache des itinéraires et mode de trajet par étape.
    # Idempotent.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS route_leg_cache ("
            "id INTEGER PRIMARY KEY, provider VARCHAR(16) NOT NULL, "
            "profile VARCHAR(8) NOT NULL, leg_key VARCHAR(40) NOT NULL, "
            "geometry TEXT, distance_m FLOAT, duration_s FLOAT, fetched_at DATETIME, "
            "CONSTRAINT uq_route_leg_cache UNIQUE (provider, profile, leg_key))"
        )
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_override)")}
        if "leg_mode" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours_override ADD COLUMN leg_mode VARCHAR(8)")


def _v15_affichage_photos_parcours(db):
    # Parcours, lot 8 : réglages d'affichage par photo (masquée, légende,
    # cadrage). Idempotent.
    columns_sql = {
        "hidden": "BOOLEAN NOT NULL DEFAULT 0",
        "caption": "VARCHAR(200)",
        "aspect": "VARCHAR(8)",
        "focus_x": "INTEGER",
        "focus_y": "INTEGER",
        "zoom": "INTEGER",
    }
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_photo)")}
        for name, sql in columns_sql.items():
            if name not in columns:
                conn.exec_driver_sql(f"ALTER TABLE parcours_photo ADD COLUMN {name} {sql}")


def _v16_duree_visite_parcours(db):
    # Parcours : durée de visite imposée par étape (minutes). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_override)")}
        if "visit_min" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours_override ADD COLUMN visit_min INTEGER")


def _v17_role_base_parcours(db):
    # Parcours : rôle d'une base (départ, retour, ou les deux). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_place)")}
        if "role" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE parcours_place ADD COLUMN role VARCHAR(8) NOT NULL DEFAULT 'both'")


def _v18_categories_lieux_parcours(db):
    # Parcours : catégorie d'affichage d'un lieu ou d'une base (icône), et
    # icône Tabler libre pour la catégorie « custom ». Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_place)")}
        if "category" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE parcours_place ADD COLUMN category VARCHAR(16) NOT NULL DEFAULT 'other'")
        if "icon" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE parcours_place ADD COLUMN icon VARCHAR(48)")


def _v19_trouvailles_fiche_cache(db):
    # Logs : nombre de trouvailles d'une cache lu sur sa fiche
    # (contrat mygcflow-logs, `found_count`). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(cache_ref)")}
        if "found_count" not in columns:
            conn.exec_driver_sql("ALTER TABLE cache_ref ADD COLUMN found_count INTEGER")


def _v20_waypoints_fiche_cache(db):
    # Logs : waypoints (parkings) lus sur la fiche d'une cache (contrat
    # mygcflow-logs, `waypoints`). Idempotent.
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS cache_waypoint ("
            "id INTEGER PRIMARY KEY, "
            "collection_id INTEGER NOT NULL REFERENCES log_collection(id), "
            "gc_code VARCHAR(16) NOT NULL, kind VARCHAR(16) NOT NULL, name VARCHAR(255), "
            "latitude FLOAT NOT NULL, longitude FLOAT NOT NULL)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_cache_waypoint_code ON cache_waypoint (collection_id, gc_code)")


def _v21_position_etape_parcours(db):
    # Parcours : position d'une étape posée à la main (lot 15). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_override)")}
        for name in ("latitude", "longitude"):
            if name not in columns:
                conn.exec_driver_sql(f"ALTER TABLE parcours_override ADD COLUMN {name} FLOAT")


def _v22_lecture_parcours(db):
    # Parcours : réglages de lecture propres (JSON épars de surcharges sur la
    # préférence globale `parcours_playback`). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours)")}
        if "playback" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours ADD COLUMN playback TEXT")


def _v23_numero_serie_appareil_photo(db):
    # Parcours : numéro de série du boîtier (EXIF BodySerialNumber), pour
    # distinguer deux appareils du même modèle. Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_photo)")}
        if "camera_serial" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours_photo ADD COLUMN camera_serial VARCHAR(40)")


def _v24_photo_favorite_parcours(db):
    # Parcours : photo favorite (cartons d'ouverture, de journée et de fin ;
    # priorité au-delà du plafond par étape). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_photo)")}
        if "favorite" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours_photo ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT 0")


def _v25_affichage_photos_par_parcours(db):
    # Parcours : affichage des photos propre (JSON épars de surcharges sur la
    # préférence globale `parcours_photo_display`). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours)")}
        if "photo_display" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours ADD COLUMN photo_display TEXT")


_PARCOURS_PLACE_COLUMNS = ("id, parcours_id, kind, name, latitude, longitude, "
                           "date, time, created_at, role, category, icon")
_PARCOURS_PLACE_TABLE = (
    "id INTEGER PRIMARY KEY AUTOINCREMENT, "
    "parcours_id INTEGER NOT NULL REFERENCES parcours (id), "
    "kind VARCHAR(8) NOT NULL, name VARCHAR(80), "
    "latitude FLOAT NOT NULL, longitude FLOAT NOT NULL, "
    "date DATE, time VARCHAR(5), created_at DATETIME, "
    "role VARCHAR(8) NOT NULL DEFAULT 'both', "
    "category VARCHAR(16) NOT NULL DEFAULT 'other', icon VARCHAR(48)")


def _v26_ids_lieux_parcours(db):
    # Parcours : id des lieux jamais réattribués (AUTOINCREMENT). Les
    # ajustements et photos d'un lieu supprimé survivent sous sa clé
    # « place:<id> » pour qu'Annuler les restaure ; sans AUTOINCREMENT,
    # SQLite réattribuait l'id au lieu suivant, qui en héritait par accident.
    # Idempotent : la reconstruction est sautée si la table l'a déjà.
    with db.engine.begin() as conn:
        ddl = conn.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='parcours_place'"
        ).scalar()
        if ddl is None:
            conn.exec_driver_sql(f"CREATE TABLE parcours_place ({_PARCOURS_PLACE_TABLE})")
            return
        if 'AUTOINCREMENT' in ddl.upper():
            return
        conn.exec_driver_sql(f"CREATE TABLE parcours_place_v26 ({_PARCOURS_PLACE_TABLE})")
        conn.exec_driver_sql(
            f"INSERT INTO parcours_place_v26 ({_PARCOURS_PLACE_COLUMNS}) "
            f"SELECT {_PARCOURS_PLACE_COLUMNS} FROM parcours_place")
        conn.exec_driver_sql("DROP TABLE parcours_place")
        conn.exec_driver_sql("ALTER TABLE parcours_place_v26 RENAME TO parcours_place")
        # Un INSERT explicite met déjà la séquence au plus grand id ; la
        # poser aussi pour une table vide rend le « jamais réattribué » net.
        conn.exec_driver_sql("DELETE FROM sqlite_sequence WHERE name='parcours_place'")
        conn.exec_driver_sql(
            "INSERT INTO sqlite_sequence (name, seq) "
            "SELECT 'parcours_place', COALESCE(MAX(id), 0) FROM parcours_place")


def _v27_fiche_etape_parcours(db):
    # Parcours : fiche de l'étape forcée ou masquée (« force » / « hide »,
    # null : suit les réglages). Idempotent.
    with db.engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parcours_override)")}
        if "info_card" not in columns:
            conn.exec_driver_sql("ALTER TABLE parcours_override ADD COLUMN info_card VARCHAR(8)")


MIGRATIONS = [
    (1, _v1_colonnes_et_index),
    (2, _v2_tables_lab),
    (3, _v3_lab_echec_recuperation),
    (4, _v4_lab_coordonnees_proposees),
    (5, _v5_lab_proprietaire_publication),
    (6, _v6_lab_rang_et_images),
    (7, _v7_region_factice),
    (8, _v8_tables_logs),
    (9, _v9_logs_horizon_dnf),
    (10, _v10_table_parcours),
    (11, _v11_ajustements_parcours),
    (12, _v12_photos_parcours),
    (13, _v13_traces_parcours),
    (14, _v14_itineraires_parcours),
    (15, _v15_affichage_photos_parcours),
    (16, _v16_duree_visite_parcours),
    (17, _v17_role_base_parcours),
    (18, _v18_categories_lieux_parcours),
    (19, _v19_trouvailles_fiche_cache),
    (20, _v20_waypoints_fiche_cache),
    (21, _v21_position_etape_parcours),
    (22, _v22_lecture_parcours),
    (23, _v23_numero_serie_appareil_photo),
    (24, _v24_photo_favorite_parcours),
    (25, _v25_affichage_photos_par_parcours),
    (26, _v26_ids_lieux_parcours),
    (27, _v27_fiche_etape_parcours),
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
