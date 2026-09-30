"""Stockage des bases du mode Évolution (SQLite, fichier evolution.db).

Une base (« dataset ») regroupe les caches d'une zone, fusionnées depuis un ou
plusieurs exports CSV. Une cache est identifiée par son code GC ; quand elle
figure dans plusieurs exports, c'est l'export le plus récent (colonne
« Ajouté ») qui fait foi, et à égalité le fichier importé en dernier. Une base
peut donc être complétée au fil du temps par de nouveaux exports : les caches
archivées entre-temps y prennent leur date d'archivage.

Le fichier est distinct de geocaching.db (voir paths.evolution_database_path)
et géré avec le module sqlite3 standard, avec son propre numéro de schéma
(PRAGMA user_version). Chaque appel ouvre sa propre connexion : les fonctions
sont utilisables depuis les requêtes comme depuis la tâche d'import.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections import OrderedDict
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

from evolution_csv import FileReport, ROW_FIELDS, iter_batches

SCHEMA_VERSION = 1
NAME_MAX_LENGTH = 100

# Nombre maximal de paramètres par requête IN (...) : SQLite en accepte 999
# dans les versions anciennes.
_IN_CHUNK = 900

_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    stats TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    report TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS imports_dataset ON imports(dataset_id);
CREATE TABLE IF NOT EXISTS caches (
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    gc_code TEXT NOT NULL,
    name TEXT,
    type TEXT,
    size TEXT,
    difficulty REAL,
    terrain REAL,
    owner TEXT,
    placed_by TEXT,
    country TEXT,
    region TEXT,
    county TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    placed TEXT NOT NULL,
    archived_on TEXT,
    is_archived INTEGER NOT NULL,
    exported_at TEXT NOT NULL,
    import_seq INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, gc_code)
) WITHOUT ROWID;
"""

_COLUMNS = ROW_FIELDS + ("import_seq",)
# Champs comparés pour distinguer une mise à jour réelle d'un simple
# ré-import à l'identique (l'horodatage d'export n'en fait pas partie).
_CONTENT_FIELDS = ROW_FIELDS[1:-1]
_EXPORTED_AT = ROW_FIELDS.index("exported_at")
_IS_ARCHIVED = ROW_FIELDS.index("is_archived")
_ARCHIVED_ON = ROW_FIELDS.index("archived_on")

_UPSERT = (
    f"INSERT INTO caches (dataset_id, {', '.join(_COLUMNS)}) "
    f"VALUES ({', '.join('?' * (len(_COLUMNS) + 1))}) "
    "ON CONFLICT (dataset_id, gc_code) DO UPDATE SET "
    + ", ".join(f"{c} = excluded.{c}" for c in _COLUMNS[1:])
    # Filet de sécurité : jamais d'écrasement par un export plus ancien.
    + " WHERE excluded.exported_at >= caches.exported_at"
)


class EvolutionStoreError(Exception):
    """Erreur métier (nom invalide, base introuvable...), avec un code stable."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect(db_path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    # À répéter pour chaque connexion : sans lui, ON DELETE CASCADE est ignoré.
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= SCHEMA_VERSION:
        return
    # WAL : les lectures (liste des bases, données d'une autre base) restent
    # possibles pendant la longue transaction d'un import.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(_SCHEMA)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


# ---------------------------------------------------------------------------
# Bases
# ---------------------------------------------------------------------------

def validate_name(name) -> str:
    text = " ".join(str(name or "").split())
    if not text:
        raise EvolutionStoreError("name-empty")
    if len(text) > NAME_MAX_LENGTH:
        raise EvolutionStoreError("name-too-long")
    return text


def _dataset_dict(row: sqlite3.Row, import_count: int = 0) -> dict:
    try:
        stats = json.loads(row["stats"] or "{}")
    except ValueError:
        stats = {}
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "revision": row["revision"],
        "stats": stats,
        "import_count": import_count,
    }


def list_datasets(db_path) -> List[dict]:
    with _closing(connect(db_path)) as conn:
        counts = dict(conn.execute(
            "SELECT dataset_id, COUNT(*) FROM imports GROUP BY dataset_id").fetchall())
        rows = conn.execute("SELECT * FROM datasets ORDER BY name COLLATE NOCASE").fetchall()
        return [_dataset_dict(r, counts.get(r["id"], 0)) for r in rows]


def get_dataset(db_path, dataset_id: int) -> dict:
    with _closing(connect(db_path)) as conn:
        return _get_dataset(conn, dataset_id)


def _get_dataset(conn: sqlite3.Connection, dataset_id: int) -> dict:
    row = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    if row is None:
        raise EvolutionStoreError("not-found")
    count = conn.execute(
        "SELECT COUNT(*) FROM imports WHERE dataset_id = ?", (dataset_id,)).fetchone()[0]
    return _dataset_dict(row, count)


def create_dataset(db_path, name) -> dict:
    clean = validate_name(name)
    now = _now()
    with _closing(connect(db_path)) as conn:
        try:
            with conn:
                cur = conn.execute(
                    "INSERT INTO datasets (name, created_at, updated_at, stats) VALUES (?, ?, ?, ?)",
                    (clean, now, now, json.dumps(_empty_stats())),
                )
        except sqlite3.IntegrityError:
            raise EvolutionStoreError("name-taken")
        return _get_dataset(conn, cur.lastrowid)


def rename_dataset(db_path, dataset_id: int, name) -> dict:
    clean = validate_name(name)
    with _closing(connect(db_path)) as conn:
        _get_dataset(conn, dataset_id)
        try:
            with conn:
                conn.execute(
                    "UPDATE datasets SET name = ?, updated_at = ? WHERE id = ?",
                    (clean, _now(), dataset_id),
                )
        except sqlite3.IntegrityError:
            raise EvolutionStoreError("name-taken")
        return _get_dataset(conn, dataset_id)


def delete_dataset(db_path, dataset_id: int) -> None:
    with _closing(connect(db_path)) as conn:
        _get_dataset(conn, dataset_id)
        with conn:
            conn.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))
    _forget_payloads(db_path, dataset_id)


def list_imports(db_path, dataset_id: int) -> List[dict]:
    with _closing(connect(db_path)) as conn:
        _get_dataset(conn, dataset_id)
        rows = conn.execute(
            "SELECT id, filename, imported_at, report FROM imports WHERE dataset_id = ? ORDER BY id DESC",
            (dataset_id,),
        ).fetchall()
    result = []
    for r in rows:
        try:
            report = json.loads(r["report"] or "{}")
        except ValueError:
            report = {}
        result.append({"id": r["id"], "filename": r["filename"], "imported_at": r["imported_at"],
                       "report": report})
    return result


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def import_file(
    db_path,
    dataset_id: int,
    path: str,
    report: FileReport,
    on_progress: Optional[Callable[[float], None]] = None,
) -> FileReport:
    """Fusionne un fichier CSV dans une base, en une transaction.

    Le rapport reçoit, en plus des compteurs de lecture, le classement de
    chaque ligne valide : nouvelle, mise à jour (contenu modifié), inchangée,
    plus ancienne que la version déjà connue (ignorée) ou doublon interne au
    fichier.
    """
    with _closing(connect(db_path)) as conn:
        _get_dataset(conn, dataset_id)
        with conn:
            seq = conn.execute(
                "INSERT INTO imports (dataset_id, filename, imported_at) VALUES (?, ?, ?)",
                (dataset_id, report.filename or "", _now()),
            ).lastrowid
            seen: Dict[str, str] = {}  # code -> horodatage retenu dans ce fichier
            for batch in iter_batches(path, report, on_progress):
                _merge_batch(conn, dataset_id, seq, batch, seen, report)
            stats = _compute_stats(conn, dataset_id)
            conn.execute("UPDATE imports SET report = ? WHERE id = ?",
                         (json.dumps(report.to_dict(), ensure_ascii=False), seq))
            conn.execute(
                "UPDATE datasets SET revision = revision + 1, updated_at = ?, stats = ? WHERE id = ?",
                (_now(), json.dumps(stats), dataset_id),
            )
    _forget_payloads(db_path, dataset_id)
    return report


def _merge_batch(conn, dataset_id: int, seq: int, batch: List[tuple],
                 seen: Dict[str, str], report: FileReport) -> None:
    # Doublons à l'intérieur du fichier : la ligne la plus récente gagne, la
    # dernière à égalité. Ils ne comptent ni comme nouveaux ni comme mis à jour.
    fresh: "OrderedDict[str, tuple]" = OrderedDict()
    rewrites: List[tuple] = []
    for row in batch:
        code = row[0]
        exported_at = row[_EXPORTED_AT]
        if code in fresh:
            report.rows_duplicate += 1
            if exported_at >= fresh[code][_EXPORTED_AT]:
                fresh[code] = row
        elif code in seen:
            report.rows_duplicate += 1
            if exported_at >= seen[code]:
                seen[code] = exported_at
                rewrites.append(row)
        else:
            fresh[code] = row

    existing: Dict[str, sqlite3.Row] = {}
    codes = list(fresh)
    columns = ", ".join(("gc_code",) + _CONTENT_FIELDS + ("exported_at",))
    for start in range(0, len(codes), _IN_CHUNK):
        chunk = codes[start:start + _IN_CHUNK]
        placeholders = ", ".join("?" * len(chunk))
        for r in conn.execute(
            f"SELECT {columns} FROM caches WHERE dataset_id = ? AND gc_code IN ({placeholders})",
            (dataset_id, *chunk),
        ):
            existing[r["gc_code"]] = r

    to_write: List[tuple] = []
    for code, row in fresh.items():
        seen[code] = row[_EXPORTED_AT]
        old = existing.get(code)
        if old is None:
            report.rows_new += 1
            to_write.append(row)
            continue
        if row[_EXPORTED_AT] < old["exported_at"]:
            report.rows_older += 1
            continue
        changed = any(_differs(row[ROW_FIELDS.index(f)], old[f]) for f in _CONTENT_FIELDS)
        if changed:
            report.rows_updated += 1
        else:
            report.rows_unchanged += 1
        if row[_IS_ARCHIVED] and not old["is_archived"]:
            report.rows_newly_archived += 1
        to_write.append(row)

    params = [(dataset_id, *row, seq) for row in to_write + rewrites]
    if params:
        conn.executemany(_UPSERT, params)


def _differs(new, old) -> bool:
    if isinstance(new, float) or isinstance(old, float):
        if new is None or old is None:
            return new is not old
        return abs(float(new) - float(old)) > 1e-9
    return (new if new is not None else None) != (old if old is not None else None)


def _empty_stats() -> dict:
    return {
        "total": 0, "active": 0, "archived": 0, "archived_no_date": 0,
        "min_placed": None, "max_placed": None, "max_archived": None, "snapshot_date": None,
    }


def _compute_stats(conn, dataset_id: int) -> dict:
    row = conn.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN is_archived = 0 THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN is_archived = 1 AND archived_on IS NOT NULL THEN 1 ELSE 0 END) AS archived,
               SUM(CASE WHEN is_archived = 1 AND archived_on IS NULL THEN 1 ELSE 0 END) AS archived_no_date,
               MIN(placed) AS min_placed,
               MAX(placed) AS max_placed,
               MAX(archived_on) AS max_archived,
               MAX(exported_at) AS max_exported
        FROM caches WHERE dataset_id = ?
        """,
        (dataset_id,),
    ).fetchone()
    stats = _empty_stats()
    stats.update({
        "total": row["total"] or 0,
        "active": row["active"] or 0,
        "archived": row["archived"] or 0,
        "archived_no_date": row["archived_no_date"] or 0,
        "min_placed": row["min_placed"],
        "max_placed": row["max_placed"],
        "max_archived": row["max_archived"],
        "snapshot_date": (row["max_exported"] or "")[:10] or None,
    })
    return stats


# ---------------------------------------------------------------------------
# Lecture
# ---------------------------------------------------------------------------

# Dernières charges utiles construites, par (fichier, base, révision) : un
# rechargement de page ou un retour sur la même base ne relit pas la base.
_PAYLOAD_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_PAYLOAD_CACHE_SIZE = 3
_payload_lock = threading.Lock()


def _forget_payloads(db_path, dataset_id: int) -> None:
    key_prefix = (str(Path(db_path)), dataset_id)
    with _payload_lock:
        for key in [k for k in _PAYLOAD_CACHE if k[:2] == key_prefix]:
            del _PAYLOAD_CACHE[key]


def load_payload(db_path, dataset_id: int) -> tuple:
    """(base, JSON en colonnes encodé en UTF-8) pour l'affichage d'une base.

    Format pensé pour 100 000+ caches : des tableaux parallèles plutôt qu'une
    FeatureCollection, et seulement ce dont le rendu a besoin (le nom et le
    propriétaire sont chargés à la demande par la popup). Les dates sont des
    jours depuis `origin` (le placement le plus ancien) ; archived vaut -1
    quand la cache ne disparaît pas (active, ou archivée sans date connue).
    status : 0 active, 1 archivée datée, 2 archivée sans date.
    """
    dataset = get_dataset(db_path, dataset_id)
    key = (str(Path(db_path)), dataset_id, dataset["revision"])
    with _payload_lock:
        cached = _PAYLOAD_CACHE.get(key)
        if cached is not None:
            _PAYLOAD_CACHE.move_to_end(key)
            return dataset, cached

    with _closing(connect(db_path)) as conn:
        rows = conn.execute(
            "SELECT gc_code, lon, lat, placed, archived_on, is_archived, type, country, region "
            "FROM caches WHERE dataset_id = ? ORDER BY placed, gc_code",
            (dataset_id,),
        ).fetchall()

    stats = dataset["stats"]
    origin = rows[0]["placed"] if rows else (stats.get("snapshot_date") or date.today().isoformat())
    origin_ord = date.fromisoformat(origin).toordinal()
    ordinals: Dict[str, int] = {}

    def day(iso: str) -> int:
        value = ordinals.get(iso)
        if value is None:
            value = date.fromisoformat(iso).toordinal() - origin_ord
            ordinals[iso] = value
        return value

    tables = {"type": {}, "country": {}, "region": {}}

    def index_of(kind: str, value) -> int:
        table = tables[kind]
        label = value or ""
        idx = table.get(label)
        if idx is None:
            idx = table[label] = len(table)
        return idx

    payload = {
        "dataset": {"id": dataset["id"], "name": dataset["name"], "revision": dataset["revision"]},
        "origin": origin,
        "count": len(rows),
        "code": [], "lon": [], "lat": [], "placed": [], "archived": [], "status": [],
        "type": [], "country": [], "region": [],
    }
    for r in rows:
        payload["code"].append(r["gc_code"])
        payload["lon"].append(round(r["lon"], 6))
        payload["lat"].append(round(r["lat"], 6))
        payload["placed"].append(day(r["placed"]))
        if r["is_archived"] and r["archived_on"]:
            payload["archived"].append(day(r["archived_on"]))
            payload["status"].append(1)
        else:
            payload["archived"].append(-1)
            payload["status"].append(2 if r["is_archived"] else 0)
        payload["type"].append(index_of("type", r["type"]))
        payload["country"].append(index_of("country", r["country"]))
        payload["region"].append(index_of("region", r["region"]))
    payload["types"] = list(tables["type"])
    payload["countries"] = list(tables["country"])
    payload["regions"] = list(tables["region"])
    payload["meta"] = {
        "total": stats.get("total", len(rows)),
        "active": stats.get("active", 0),
        "archived": stats.get("archived", 0),
        "archivedNoDate": stats.get("archived_no_date", 0),
        "minPlaced": stats.get("min_placed"),
        "maxPlaced": stats.get("max_placed"),
        "maxArchived": stats.get("max_archived"),
        "snapshotDate": stats.get("snapshot_date"),
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _payload_lock:
        _PAYLOAD_CACHE[key] = body
        _PAYLOAD_CACHE.move_to_end(key)
        while len(_PAYLOAD_CACHE) > _PAYLOAD_CACHE_SIZE:
            _PAYLOAD_CACHE.popitem(last=False)
    return dataset, body


def get_cache(db_path, dataset_id: int, gc_code: str) -> dict:
    with _closing(connect(db_path)) as conn:
        _get_dataset(conn, dataset_id)
        row = conn.execute(
            "SELECT gc_code, name, type, size, difficulty, terrain, owner, placed_by, country, "
            "region, county, placed, archived_on, is_archived, exported_at "
            "FROM caches WHERE dataset_id = ? AND gc_code = ?",
            (dataset_id, str(gc_code or "").strip().upper()),
        ).fetchone()
    if row is None:
        raise EvolutionStoreError("cache-not-found")
    return dict(row)


class _closing:
    """Ferme la connexion en sortie de bloc (sqlite3.Connection ne le fait pas)."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        return self.conn

    def __exit__(self, *exc) -> None:
        self.conn.close()
