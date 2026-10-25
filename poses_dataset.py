"""Page « Mes poses » : vie des caches posées par le joueur (docs/mode-poses.md).

Lit les fiches `cache_ref` dont le joueur est propriétaire et tous les logs
`log_event` de ces caches (tous auteurs), importés par la carte « Mes logs »
(docs/logs-geocaching.md). Produit les données en colonnes de la page /poses,
au format de celles du mode Évolution (`evolution_store.load_payload`), plus
les changements d'état et les logs de chaque cache.

Règles (choix de l'utilisateur, 2026-10-25) :

- **Apparition** : publication (premier log « Publish Listing »), sinon date
  de pose déclarée ; une trouvaille antérieure (bêta-test) avance
  l'apparition. Sans publication, pose ni trouvaille : premier log ; sans
  aucun log ni date, la cache n'est pas datable (comptée, jamais placée).
- **Logs antérieurs à l'apparition** (notes du poseur ou du relecteur avant
  publication) : ramenés au jour de l'apparition (`folded`). Ils comptent
  partout (compteurs, Stats, popup) mais ne sont jamais dessinés — rien n'est
  à l'écran avant que la cache n'y soit.
- **États** : active → désactivée (22) → réactivée (23) ; archivée (5, 25)
  → désarchivée (12). Ordre `log_id` dans une journée ; seul le dernier état
  d'une journée compte. Un état final différent du statut de la fiche à
  l'export (`cache_ref.status`) ajoute un changement « déduit » à la date de
  l'export, sans flash : c'est la seule date où l'on sait qu'il était vrai.
"""

from __future__ import annotations

import csv
import io
import json
import threading
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterator

from flask_babel import gettext as _

import lab_geojson
import log_store
from log_formats import CATEGORY_FIND, log_category
from models import CacheRef, Geocache, LogEvent

# Version du format : entre dans l'ETag et la clé du mémo (une mise à jour du
# code qui change la charge utile — colonnes, raisons de `meta` — invalide
# les réponses gardées).
# 2 : raison « no-placed-caches » (caches posées, aucune plaçable).
PAYLOAD_VERSION = 2

# --- Types d'événements -----------------------------------------------------
#
# Code = position dans POSES_LOG_KINDS (servie au client avec les données).

KIND_PUBLISH = "publish"
KIND_FIND = "find"
KIND_DNF = "dnf"
KIND_NOTE = "note"
KIND_OWNER_NOTE = "owner_note"
KIND_ALERT = "alert"
KIND_MAINTENANCE = "maintenance"
KIND_DISABLE = "disable"
KIND_ENABLE = "enable"
KIND_UNARCHIVE = "unarchive"
KIND_ARCHIVE = "archive"
KIND_REVIEWER = "reviewer"
KIND_OTHER = "other"

POSES_LOG_KINDS = (
    KIND_PUBLISH, KIND_FIND, KIND_DNF, KIND_NOTE, KIND_OWNER_NOTE, KIND_ALERT,
    KIND_MAINTENANCE, KIND_DISABLE, KIND_ENABLE, KIND_UNARCHIVE, KIND_ARCHIVE,
    KIND_REVIEWER, KIND_OTHER,
)
KIND_CODE = {kind: code for code, kind in enumerate(POSES_LOG_KINDS)}

_KIND_BY_TYPE = {
    24: KIND_PUBLISH,
    45: KIND_ALERT, 7: KIND_ALERT,
    46: KIND_MAINTENANCE, 47: KIND_MAINTENANCE,
    22: KIND_DISABLE,
    23: KIND_ENABLE,
    12: KIND_UNARCHIVE,
    5: KIND_ARCHIVE, 25: KIND_ARCHIVE,
    18: KIND_REVIEWER, 68: KIND_REVIEWER, 76: KIND_REVIEWER,
}

# États d'une cache.
STATE_ACTIVE = 0
STATE_DISABLED = 1
STATE_ARCHIVED = 2
_STATE_BY_STATUS = {"active": STATE_ACTIVE, "disabled": STATE_DISABLED, "archived": STATE_ARCHIVED}

# Source de la date d'apparition (popup, tests).
APPEAR_PUBLISH = 0
APPEAR_PLACED = 1
APPEAR_BETA_FIND = 2
APPEAR_FIRST_LOG = 3

# Statut final servi au client (colonne `status`, compatible avec
# evolution_timeline.filterRows qui réserve 2 aux « archivées sans date ») :
STATUS_ACTIVE = 0
STATUS_ARCHIVED = 1
STATUS_DISABLED = 3


def classify_log(type_id: int, author_id, owner_id) -> str:
    """Type d'événement d'un log sur une cache posée.

    Une trouvaille, un DNF ou une note n'est « reçu » que s'il vient d'un
    autre joueur : ceux du poseur sur sa propre cache (présence à son propre
    event, note de maintenance) sont des notes du poseur.
    """
    kind = _KIND_BY_TYPE.get(type_id)
    if kind is not None:
        return kind
    category = log_category(type_id)
    by_owner = owner_id is not None and author_id == owner_id
    if category == CATEGORY_FIND:
        return KIND_OWNER_NOTE if by_owner else KIND_FIND
    if type_id == 3:
        return KIND_OWNER_NOTE if by_owner else KIND_DNF
    if type_id == 4:
        return KIND_OWNER_NOTE if by_owner else KIND_NOTE
    return KIND_OTHER


def _next_state(state: int, kind: str) -> int:
    if kind == KIND_ARCHIVE:
        return STATE_ARCHIVED
    if kind == KIND_UNARCHIVE:
        return STATE_ACTIVE if state == STATE_ARCHIVED else state
    if state == STATE_ARCHIVED:
        return state                     # désactiver une cache archivée ne change rien
    if kind == KIND_DISABLE:
        return STATE_DISABLED
    if kind == KIND_ENABLE:
        return STATE_ACTIVE
    return state


def _as_date(value):
    if value is None:
        return None
    return value.date() if isinstance(value, datetime) else value


@dataclass
class _Log:
    log_id: int
    day: date
    kind: str
    author_id: int | None
    author_name: str | None
    favorite: bool


@dataclass
class OwnedCache:
    """Une cache posée et ses logs, règles appliquées."""
    ref: CacheRef
    logs: list            # _Log triés (date, log_id)
    appear: date | None
    appear_source: int | None
    changes: list         # (date, état, déduit) — changements effectifs
    final_state: int
    inferred: bool


def appearance(ref, logs) -> tuple:
    """(date, source) de l'apparition d'une cache posée, ou (None, None)."""
    publish = next((log.day for log in logs if log.kind == KIND_PUBLISH), None)
    if publish is not None:
        base, source = publish, APPEAR_PUBLISH
    elif ref.placed_date is not None:
        base, source = _as_date(ref.placed_date), APPEAR_PLACED
    else:
        base, source = None, None
    first_find = next((log.day for log in logs if log.kind == KIND_FIND), None)
    if first_find is not None and (base is None or first_find < base):
        return first_find, APPEAR_BETA_FIND
    if base is not None:
        return base, source
    if logs:
        return logs[0].day, APPEAR_FIRST_LOG
    return None, None


def state_changes(ref, logs, appear: date) -> tuple:
    """(changements, état final, déduit) : changements effectifs
    [(date, état, déduit)], le premier jour au plus tôt à l'apparition.

    L'état part d'« active » à l'apparition ; les logs antérieurs y sont
    rejoués (un changement d'état n'est émis qu'à partir de ce jour). Un état
    final qui contredit le statut de la fiche à l'export (`status`,
    `status_at`) ajoute un changement déduit à cette date.
    """
    state = STATE_ACTIVE
    by_day = OrderedDict()
    for log in logs:
        state = _next_state(state, log.kind)
        by_day[max(log.day, appear)] = state
    changes = []
    previous = STATE_ACTIVE
    for day, value in by_day.items():
        if value != previous:
            changes.append((day, value, False))
            previous = value
    inferred = False
    expected = _STATE_BY_STATUS.get((ref.status or "").lower())
    if expected is not None and expected != previous:
        last_day = max([appear] + [log.day for log in logs])
        at = _as_date(ref.status_at)
        day = at if at is not None and at > last_day else last_day
        changes.append((day, expected, True))
        previous = expected
        inferred = True
    return changes, previous, inferred


def _collection_owner(collection):
    return collection.account_user_id, (collection.account_username or "").strip().lower()


def _owned_refs(session, collection) -> tuple:
    """(fiches posées par le joueur, nombre reconnues au seul pseudo)."""
    me, my_name = _collection_owner(collection)
    refs, by_name = [], 0
    for ref in session.query(CacheRef).filter(CacheRef.collection_id == collection.id):
        if ref.owner_id is not None:
            if me is not None and ref.owner_id == me:
                refs.append(ref)
        elif my_name and (ref.owner_name or "").strip().lower() == my_name:
            # Fiche dont le collecteur n'a pas pu lire l'identifiant du
            # propriétaire : reconnue au pseudo du compte.
            refs.append(ref)
            by_name += 1
    refs.sort(key=lambda r: r.gc_code)
    return refs, by_name


def load_owned_caches(session, collection) -> tuple:
    """([OwnedCache], nombre reconnues au pseudo)."""
    refs, by_name = _owned_refs(session, collection)
    if not refs:
        return [], by_name
    owner_of = {ref.gc_code: (ref.owner_id if ref.owner_id is not None else collection.account_user_id)
                for ref in refs}
    logs = defaultdict(list)
    codes = list(owner_of)
    for start in range(0, len(codes), 900):
        chunk = codes[start:start + 900]
        for log_id, code, type_id, log_date, author_id, author_name, favorite in session.query(
                LogEvent.log_id, LogEvent.gc_code, LogEvent.type_id, LogEvent.log_date,
                LogEvent.author_id, LogEvent.author_name, LogEvent.favorite).filter(
                LogEvent.collection_id == collection.id, LogEvent.gc_code.in_(chunk)):
            logs[code].append(_Log(
                log_id=log_id, day=_as_date(log_date),
                kind=classify_log(type_id, author_id, owner_of[code]),
                author_id=author_id, author_name=author_name, favorite=favorite is True))
    caches = []
    for ref in refs:
        cache_logs = sorted(logs.get(ref.gc_code, []), key=lambda log: (log.day, log.log_id))
        appear, source = appearance(ref, cache_logs)
        if appear is None:
            caches.append(OwnedCache(ref, cache_logs, None, None, [], STATE_ACTIVE, False))
            continue
        changes, final_state, inferred = state_changes(ref, cache_logs, appear)
        caches.append(OwnedCache(ref, cache_logs, appear, source, changes, final_state, inferred))
    return caches, by_name


# --- Charge utile -------------------------------------------------------------

_memo_lock = threading.Lock()
_memo = OrderedDict()
_MEMO_SIZE = 2


def _memo_key(session, collection) -> tuple:
    # created_at : un id de collection peut resservir après un « Vider » ;
    # l'empreinte de `geocache` couvre positions et pays empruntés au My Finds.
    return (collection.id, str(collection.created_at), collection.revision,
            lab_geojson.geocache_fingerprint(session), PAYLOAD_VERSION)


def _empty_payload(reason: str, collection=None) -> dict:
    payload = {
        "account": _account(collection),
        "revision": collection.revision if collection else 0,
        "origin": None, "count": 0,
        "code": [], "name": [], "lon": [], "lat": [], "placed": [], "archived": [], "status": [],
        "type": [], "size": [], "difficulty": [], "terrain": [], "country": [], "region": [],
        "geoBorrowed": [], "appearSource": [],
        "types": [], "sizes": [], "difficulties": [], "terrains": [], "countries": [], "regions": [],
        "st": {"cache": [], "day": [], "state": [], "synthetic": []},
        "ev": {"cache": [], "day": [], "kind": [], "fav": [], "folded": [], "author": []},
        "logKinds": list(POSES_LOG_KINDS),
        "authors": [],
    }
    payload["meta"] = _meta(reason=reason)
    return payload


def _account(collection):
    if collection is None:
        return None
    return {"user_id": collection.account_user_id, "username": collection.account_username}


def _meta(**values) -> dict:
    meta = {
        "reason": None, "ownedTotal": 0, "pending": 0, "undatable": 0, "inferredStates": 0,
        "foldedLogs": 0, "ownerMatchedByName": 0, "logs": 0, "finds": 0, "favorites": 0,
        "dnf": 0, "snapshotDate": None, "lastImportAt": None,
    }
    meta.update(values)
    return meta


def build_payload(session) -> dict:
    """Données de la page /poses (voir le docstring du module)."""
    collection = log_store.get_collection(session)
    if collection is None:
        return _empty_payload("no-collection")
    if collection.account_user_id is None and not collection.account_username:
        return _empty_payload("no-account", collection)
    caches, by_name = load_owned_caches(session, collection)
    if not caches:
        payload = _empty_payload("no-owned-caches", collection)
        payload["meta"]["ownerMatchedByName"] = by_name
        return payload

    # Positions et attributs : fiche, sinon ligne du My Finds au même code.
    rows = {}
    codes = [c.ref.gc_code for c in caches]
    for start in range(0, len(codes), 900):
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(codes[start:start + 900])):
            rows[row.gc_code] = row

    placed, pending, undatable = [], 0, 0
    for cache in caches:
        row = rows.get(cache.ref.gc_code)
        lat = cache.ref.latitude if cache.ref.latitude is not None else getattr(row, "latitude", None)
        lon = cache.ref.longitude if cache.ref.longitude is not None else getattr(row, "longitude", None)
        if cache.appear is None:
            undatable += 1
            continue
        if lat is None or lon is None:
            pending += 1
            continue
        placed.append((cache, row, float(lat), float(lon)))
    placed.sort(key=lambda item: (item[0].appear, item[0].ref.gc_code))

    if not placed:
        # Des caches posées existent mais aucune n'a position ET date :
        # raison propre pour que la page l'explique (en attente / non datable).
        payload = _empty_payload("no-placed-caches", collection)
        payload["meta"].update(ownedTotal=len(caches), pending=pending, undatable=undatable,
                               ownerMatchedByName=by_name)
        return payload

    # Pays et région manquants : ceux du My Finds, sinon empruntés à la
    # trouvaille la plus proche (≤ 10 km), comme les étapes Labs.
    need_geo = [item for item in placed
                if not (item[0].ref.country or getattr(item[1], "country", None))]
    borrowed = {}
    if need_geo:
        class _Pos:
            __slots__ = ("id", "latitude", "longitude")

            def __init__(self, ident, lat, lon):
                self.id, self.latitude, self.longitude = ident, lat, lon
        borrowed = lab_geojson.compute_borrowed_geo(
            session, [_Pos(item[0].ref.gc_code, item[2], item[3]) for item in need_geo])

    origin = placed[0][0].appear
    origin_ord = origin.toordinal()

    def day(value: date) -> int:
        return value.toordinal() - origin_ord

    tables = {key: {} for key in ("type", "size", "difficulty", "terrain", "country", "region")}

    def index_of(kind, value) -> int:
        table = tables[kind]
        label = value or ""
        idx = table.get(label)
        if idx is None:
            idx = table[label] = len(table)
        return idx

    def rating(value):
        return "" if value is None else f"{value:g}"

    payload = {
        "account": _account(collection),
        "revision": collection.revision,
        "origin": origin.isoformat(),
        "count": len(placed),
        "code": [], "name": [], "lon": [], "lat": [], "placed": [], "archived": [], "status": [],
        "type": [], "size": [], "difficulty": [], "terrain": [], "country": [], "region": [],
        "geoBorrowed": [], "appearSource": [],
    }
    authors, author_index = [], {}
    st = {"cache": [], "day": [], "state": [], "synthetic": []}
    events = []                          # (jour, cache, log_id, kind, fav, folded, auteur)
    folded_total = inferred_total = 0
    counts = defaultdict(int)
    snapshot = None
    for k, (cache, row, lat, lon) in enumerate(placed):
        ref = cache.ref

        def pick(ref_attr, row_attr=None):
            value = getattr(ref, ref_attr, None)
            if value is None and row is not None:
                value = getattr(row, row_attr or ref_attr, None)
            return value

        country, state, geo_borrowed = pick("country"), pick("state"), False
        if not country and ref.gc_code in borrowed:
            country, state = borrowed[ref.gc_code]
            geo_borrowed = country is not None
        payload["code"].append(ref.gc_code)
        payload["name"].append(pick("name", "cache_name") or "")
        payload["lon"].append(round(lon, 6))
        payload["lat"].append(round(lat, 6))
        payload["placed"].append(day(cache.appear))
        archived_day = -1
        if cache.final_state == STATE_ARCHIVED:
            archived_day = day(next(d for d, s, _syn in reversed(cache.changes) if s == STATE_ARCHIVED))
        payload["archived"].append(archived_day)
        payload["status"].append({STATE_ARCHIVED: STATUS_ARCHIVED,
                                  STATE_DISABLED: STATUS_DISABLED}.get(cache.final_state, STATUS_ACTIVE))
        payload["type"].append(index_of("type", pick("cache_type")))
        payload["size"].append(index_of("size", pick("container")))
        payload["difficulty"].append(index_of("difficulty", rating(pick("difficulty"))))
        payload["terrain"].append(index_of("terrain", rating(pick("terrain"))))
        payload["country"].append(index_of("country", country))
        payload["region"].append(index_of("region", state))
        payload["geoBorrowed"].append(1 if geo_borrowed else 0)
        payload["appearSource"].append(cache.appear_source)

        for change_day, value, synthetic in cache.changes:
            st["cache"].append(k)
            st["day"].append(day(change_day))
            st["state"].append(value)
            st["synthetic"].append(1 if synthetic else 0)
        if cache.inferred:
            inferred_total += 1

        for log in cache.logs:
            folded = log.day < cache.appear
            folded_total += folded
            slot = -1
            if log.author_id is not None or log.author_name:
                key = log.author_id if log.author_id is not None else f"name:{log.author_name}"
                slot = author_index.get(key)
                if slot is None:
                    slot = author_index[key] = len(authors)
                    authors.append(log.author_name or "")
                elif log.author_name:
                    authors[slot] = log.author_name     # pseudo le plus récent (logs triés)
            events.append((day(max(log.day, cache.appear)), k, log.log_id, KIND_CODE[log.kind],
                           1 if (log.favorite and log.kind == KIND_FIND) else 0, 1 if folded else 0, slot))
            counts[log.kind] += 1
            if log.favorite and log.kind == KIND_FIND:
                counts["favorite"] += 1

        status_day = _as_date(ref.status_at)
        if status_day is not None and (snapshot is None or status_day > snapshot):
            snapshot = status_day

    # Changements d'état triés par (jour, cache) ; logs par (jour, cache, log_id).
    order = sorted(range(len(st["day"])), key=lambda i: (st["day"][i], st["cache"][i]))
    payload["st"] = {key: [values[i] for i in order] for key, values in st.items()}
    events.sort()
    payload["ev"] = {
        "cache": [e[1] for e in events], "day": [e[0] for e in events], "kind": [e[3] for e in events],
        "fav": [e[4] for e in events], "folded": [e[5] for e in events], "author": [e[6] for e in events],
    }
    payload["logKinds"] = list(POSES_LOG_KINDS)
    payload["authors"] = authors
    for kind in ("type", "size", "difficulty", "terrain", "country", "region"):
        payload[{"type": "types", "size": "sizes", "difficulty": "difficulties", "terrain": "terrains",
                 "country": "countries", "region": "regions"}[kind]] = list(tables[kind])

    # Date de fin : export le plus récent qui atteste un statut, jamais avant
    # le dernier événement connu.
    last_day = max([events[-1][0] if events else 0] + payload["st"]["day"] + payload["placed"])
    last_date = date.fromordinal(origin_ord + last_day)
    if snapshot is None or snapshot < last_date:
        snapshot = last_date
    payload["meta"] = _meta(
        ownedTotal=len(caches), pending=pending, undatable=undatable, inferredStates=inferred_total,
        foldedLogs=folded_total, ownerMatchedByName=by_name, logs=len(events),
        finds=counts[KIND_FIND], favorites=counts["favorite"], dnf=counts[KIND_DNF],
        snapshotDate=snapshot.isoformat() if snapshot else None,
        lastImportAt=collection.last_import_at.isoformat() if collection.last_import_at else None,
    )
    return payload


def load_payload(session) -> tuple:
    """(clé de version, JSON encodé en UTF-8), mémorisé tant que la collection
    de logs et le contenu de `geocache` n'ont pas changé."""
    collection = log_store.get_collection(session)
    key = _memo_key(session, collection) if collection is not None else ("none", PAYLOAD_VERSION)
    with _memo_lock:
        body = _memo.get(key)
        if body is not None:
            _memo.move_to_end(key)
            return key, body
    body = json.dumps(build_payload(session), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _memo_lock:
        _memo[key] = body
        _memo.move_to_end(key)
        while len(_memo) > _MEMO_SIZE:
            _memo.popitem(last=False)
    return key, body


def clear_memo() -> None:
    with _memo_lock:
        _memo.clear()


# --- Popup ----------------------------------------------------------------------

def cache_details(session, gc_code: str) -> dict | None:
    """Détails d'une cache posée pour la popup, None si elle n'est pas au joueur."""
    collection = log_store.get_collection(session)
    if collection is None:
        return None
    code = (gc_code or "").strip().upper()
    caches, _by_name = load_owned_caches(session, collection)
    cache = next((c for c in caches if c.ref.gc_code == code), None)
    if cache is None:
        return None
    ref = cache.ref
    by_kind = defaultdict(int)
    favorites = 0
    first_find = None
    reviewer_archive = False
    owner = ref.owner_id if ref.owner_id is not None else collection.account_user_id
    for log in cache.logs:
        by_kind[log.kind] += 1
        if log.kind == KIND_FIND:
            favorites += 1 if log.favorite else 0
            if first_find is None:
                first_find = log
        if log.kind == KIND_ARCHIVE and log.author_id is not None and log.author_id != owner:
            reviewer_archive = True
    publish = next((log.day for log in cache.logs if log.kind == KIND_PUBLISH), None)
    return {
        "gc_code": ref.gc_code,
        "name": ref.name,
        "cache_type": ref.cache_type,
        "container": ref.container,
        "difficulty": ref.difficulty,
        "terrain": ref.terrain,
        "country": ref.country,
        "state": ref.state,
        "placed_date": _iso(ref.placed_date),
        "published_date": _iso(publish),
        "appear_date": _iso(cache.appear),
        "appear_source": cache.appear_source,
        "status": ref.status,
        "status_at": _iso(_as_date(ref.status_at)),
        "favorite_points": ref.favorite_points,
        "favorites": favorites,
        "counts": dict(by_kind),
        "logs": len(cache.logs),
        "first_find": ({"date": _iso(first_find.day), "author": first_find.author_name}
                       if first_find else None),
        "last_log_date": _iso(cache.logs[-1].day) if cache.logs else None,
        "archived_by_reviewer": reviewer_archive,
        "final_state": cache.final_state,
    }


def _iso(value):
    return value.isoformat() if value is not None else None


# --- Export CSV -----------------------------------------------------------------
#
# Bouton « Exporter en CSV » de l'onglet Données : TOUTES les caches posées de
# la collection — en attente (sans position) et non datables comprises —
# indépendamment des filtres appliqués côté client. Séparateur « ; », fins de
# ligne CRLF et BOM UTF-8 en tête (convention Excel francophone, comme les
# exports des panneaux Stats), une ligne par cache, ordre du code GC
# (load_owned_caches).

# Lignes par morceau produit : le corps complet n'est jamais matérialisé.
_EXPORT_CHUNK = 500


def export_csv(session) -> Iterator[str]:
    """CSV des caches posées, produit en flux (morceaux de texte UTF-8).

    Sans collection ni cache posée, l'en-tête seule est servie (le lien
    n'apparaît à l'écran qu'avec des données).
    """
    collection = log_store.get_collection(session)
    # BOM UTF-8 en premier : Excel lit alors les accents sans assistant.
    yield "\ufeff"
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow((
        _("Code GC"), _("Nom"), _("Type"), _("Taille"), _("D"), _("T"),
        _("Latitude"), _("Longitude"), _("Pays"), _("Région"),
        _("Apparition"), _("Source d'apparition"), _("Statut"),
        _("Trouvailles"), _("Favoris"), _("DNF"), _("Logs"),
        _("Première trouvaille"), _("Premier trouveur"), _("Dernier log"),
    ))
    yield buf.getvalue()
    buf.seek(0)
    buf.truncate()
    if collection is None:
        return
    caches, _by_name = load_owned_caches(session, collection)
    if not caches:
        return

    # Position, nom, pays et région : fiche, sinon ligne du My Finds au même
    # code (comme la charge utile, sans l'emprunt au voisinage propre à la carte).
    rows = {}
    codes = [cache.ref.gc_code for cache in caches]
    for start in range(0, len(codes), 900):
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(codes[start:start + 900])):
            rows[row.gc_code] = row

    appear_sources = {
        APPEAR_PUBLISH: _("Publication"),
        APPEAR_PLACED: _("Date de pose"),
        APPEAR_BETA_FIND: _("Bêta-trouvaille"),
        APPEAR_FIRST_LOG: _("Premier log"),
    }
    # Mêmes libellés que le filtre « État actuel » de l'onglet Données.
    status_labels = {
        STATE_ACTIVE: _("Active"),
        STATE_DISABLED: _("Désactivée"),
        STATE_ARCHIVED: _("Archivée"),
    }
    pending = 0
    for cache in caches:
        ref = cache.ref
        row = rows.get(ref.gc_code)

        def pick(ref_attr, row_attr=None):
            value = getattr(ref, ref_attr, None)
            if value is None and row is not None:
                value = getattr(row, row_attr or ref_attr, None)
            return value

        lat = ref.latitude if ref.latitude is not None else getattr(row, "latitude", None)
        lon = ref.longitude if ref.longitude is not None else getattr(row, "longitude", None)
        difficulty = pick("difficulty")
        terrain = pick("terrain")
        # Comptes comme cache_details : trouvailles reçues, favoris posés sur
        # une trouvaille, DNF reçus ; logs = total de la cache.
        finds = favorites = dnf = 0
        first_find = None
        for log in cache.logs:
            if log.kind == KIND_FIND:
                finds += 1
                if log.favorite:
                    favorites += 1
                if first_find is None:
                    first_find = log
            elif log.kind == KIND_DNF:
                dnf += 1
        # Non datable : l'état n'a jamais été joué (final_state reste
        # « active ») ; le statut de la fiche à l'export fait foi.
        status = cache.final_state
        if cache.appear is None:
            status = _STATE_BY_STATUS.get((ref.status or "").lower(), STATE_ACTIVE)
        writer.writerow((
            ref.gc_code,
            pick("name", "cache_name") or "",
            pick("cache_type") or "",
            pick("container") or "",
            "" if difficulty is None else f"{difficulty:g}",
            "" if terrain is None else f"{terrain:g}",
            "" if lat is None else repr(float(lat)),
            "" if lon is None else repr(float(lon)),
            pick("country") or "",
            pick("state") or "",
            cache.appear.isoformat() if cache.appear is not None else "",
            appear_sources.get(cache.appear_source, ""),
            status_labels.get(status, ""),
            finds, favorites, dnf, len(cache.logs),
            first_find.day.isoformat() if first_find else "",
            (first_find.author_name or "") if first_find else "",
            cache.logs[-1].day.isoformat() if cache.logs else "",
        ))
        pending += 1
        if pending >= _EXPORT_CHUNK:
            yield buf.getvalue()
            buf.seek(0)
            buf.truncate()
            pending = 0
    if pending:
        yield buf.getvalue()
