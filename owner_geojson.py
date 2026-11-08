"""Caches posées par le joueur sur la carte principale (docs/logs-geocaching.md,
§ Caches posées sur la carte).

Un point par cache posée, tiré des mêmes logs que la page « Mes poses »
(`poses_dataset.load_owned_caches`) et selon les mêmes règles d'apparition et
d'état (publication, sinon pose déclarée ; une trouvaille de bêta-test avance
l'apparition ; archivée = grisée). À la différence de Mes poses, **aucun log
des autres joueurs n'est montré** : seules les étapes du poseur lui-même
(maintenance, désactivation, réactivation, archivage, désarchivage) sont
servies, comme événements datés — flash sur la carte et étapes du trait de
déplacement.

Les changements d'état (`owner_states`) suivent en revanche tous les logs : une
cache archivée par un relecteur est bien archivée, elle est grisée — mais sans
flash ni étape de trajet, ce n'est pas un déplacement du poseur.

Comme les DNF, ces points ne sont jamais des trouvailles : servis à part
(`/api/logs/owner_features`), ils n'entrent dans aucun compteur. Mêmes noms de
propriétés que les trouvailles (`bdd.create_geojson`) pour réutiliser les
filtres ; `date_find` y vaut le jour d'apparition.

La page Statistiques a sa propre source, `build_owner_stats`
(`/api/stats/owned`) : toutes les caches posées comptent, sans position ni
date exigée — ne pas y réintroduire les règles d'affichage de la carte.
"""

from __future__ import annotations

from datetime import date

import lab_geojson
import log_store
import poses_dataset
from models import Geocache

SOURCE_KIND_OWNED = "owned"

# Étapes du poseur servies au client (types de poses_dataset.classify_log).
OWNER_EVENT_KINDS = (
    poses_dataset.KIND_MAINTENANCE,
    poses_dataset.KIND_DISABLE,
    poses_dataset.KIND_ENABLE,
    poses_dataset.KIND_UNARCHIVE,
    poses_dataset.KIND_ARCHIVE,
)


def _iso(value):
    return value.isoformat() if value is not None else None


def _by_owner(log, owner_id, owner_name) -> bool:
    if log.author_id is not None:
        return owner_id is not None and log.author_id == owner_id
    # Log sans identifiant d'auteur : reconnu au pseudo du compte.
    return bool(owner_name) and (log.author_name or "").strip().lower() == owner_name


def _empty(collection, **counts) -> dict:
    payload = {"features": [], "ownedTotal": 0, "pending": 0, "undatable": 0,
               "revision": collection.revision if collection else 0}
    payload.update(counts)
    return payload


def _empty_stats(collection) -> dict:
    """Charge utile vide de `/api/stats/owned` : pas de `pending`, compteur
    propre aux points de la carte."""
    return {"features": [], "ownedTotal": 0, "undatable": 0,
            "revision": collection.revision if collection else 0}


def _pick(ref, row):
    """Accesseur des propriétés d'une cache posée : la fiche `cache_ref`
    d'abord, la ligne `geocache` du My Finds en repli."""
    def pick(ref_attr, row_attr=None):
        value = getattr(ref, ref_attr, None)
        if value is None and row is not None:
            value = getattr(row, row_attr or ref_attr, None)
        return value
    return pick


def build_owner_features(session) -> dict:
    """{features, ownedTotal, pending, undatable, revision}.

    `ownedTotal` : caches posées reconnues, placées ou non — l'interface ne
    propose l'affichage que s'il est non nul. `pending` : sans position ;
    `undatable` : sans aucune date (jamais placées non plus).
    """
    collection = log_store.get_collection(session)
    if collection is None:
        return _empty(None)
    if collection.account_user_id is None and not collection.account_username:
        return _empty(collection)
    caches, _by_name = poses_dataset.load_owned_caches(session, collection)
    if not caches:
        return _empty(collection)

    rows = {}
    codes = [cache.ref.gc_code for cache in caches]
    for start in range(0, len(codes), 900):
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(codes[start:start + 900])):
            rows[row.gc_code] = row

    my_name = (collection.account_username or "").strip().lower()
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

    # Pays et région manquants : ceux du My Finds, sinon empruntés à la
    # trouvaille la plus proche (≤ 10 km), comme sur la page Mes poses — les
    # filtres par pays doivent les retenir.
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

    features = []
    for cache, row, lat, lon in sorted(placed, key=lambda item: (item[0].appear, item[0].ref.gc_code)):
        ref = cache.ref
        pick = _pick(ref, row)

        country, region = pick("country"), pick("state")
        if not country and ref.gc_code in borrowed:
            country, region = borrowed[ref.gc_code]
        owner_id = ref.owner_id if ref.owner_id is not None else collection.account_user_id
        # Étapes du poseur à partir de l'apparition : une maintenance notée
        # avant la publication se confond avec la pose.
        events = [[_iso(log.day), log.kind] for log in cache.logs
                  if log.kind in OWNER_EVENT_KINDS and log.day >= cache.appear
                  and _by_owner(log, owner_id, my_name)]
        appear = _iso(cache.appear)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {
                "source_kind": SOURCE_KIND_OWNED,
                "record_uid": f"owned:{ref.gc_code}",
                "gc_code": ref.gc_code,
                "name": pick("name", "cache_name"),
                "owner": pick("owner_name", "owner"),
                "cache_type": pick("cache_type"),
                "difficulty": pick("difficulty"),
                "terrain": pick("terrain"),
                "container": pick("container"),
                "country": country,
                "state": region,
                "published_date": appear,
                "date_find": appear,
                "appear_source": cache.appear_source,
                # [[jour, état]] : 0 active, 1 désactivée, 2 archivée
                # (poses_dataset.STATE_*), changements effectifs seulement.
                "owner_states": [[_iso(day), state] for day, state, _synthetic in cache.changes],
                # [[jour, type]] : étapes du poseur (OWNER_EVENT_KINDS).
                "owner_events": events,
                "found": False,
            },
        })
    return {"features": features, "ownedTotal": len(caches), "pending": pending,
            "undatable": undatable, "revision": collection.revision}


def build_owner_stats(session) -> dict:
    """{features, ownedTotal, undatable, revision} — caches posées pour la page
    Statistiques : aucune position requise (une cache sans coordonnées compte) ;
    l'emprunt pays/région au My Finds reste réservé aux caches placées. Une
    cache sans date d'apparition est servie avec `date_find` à null — comptée
    « sans date » par le client, jamais inventée."""
    collection = log_store.get_collection(session)
    if collection is None:
        return _empty_stats(None)
    if collection.account_user_id is None and not collection.account_username:
        return _empty_stats(collection)
    caches, _by_name = poses_dataset.load_owned_caches(session, collection)
    if not caches:
        return _empty_stats(collection)

    rows = {}
    codes = [cache.ref.gc_code for cache in caches]
    for start in range(0, len(codes), 900):
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(codes[start:start + 900])):
            rows[row.gc_code] = row

    # Toutes les caches posées, datables ou non : (cache, ligne My Finds,
    # latitude, longitude) — les deux dernières éventuellement absentes.
    entries, undatable = [], 0
    for cache in caches:
        row = rows.get(cache.ref.gc_code)
        lat = cache.ref.latitude if cache.ref.latitude is not None else getattr(row, "latitude", None)
        lon = cache.ref.longitude if cache.ref.longitude is not None else getattr(row, "longitude", None)
        if cache.appear is None:
            undatable += 1
        entries.append((cache, row, lat, lon))

    # Pays et région empruntés à la trouvaille la plus proche : seulement
    # pour une cache datée ET positionnée (la recherche exige les deux).
    need_geo = [item for item in entries
                if item[0].appear is not None and item[2] is not None and item[3] is not None
                and not (item[0].ref.country or getattr(item[1], "country", None))]
    borrowed = {}
    if need_geo:
        class _Pos:
            __slots__ = ("id", "latitude", "longitude")

            def __init__(self, ident, lat, lon):
                self.id, self.latitude, self.longitude = ident, lat, lon
        borrowed = lab_geojson.compute_borrowed_geo(
            session, [_Pos(item[0].ref.gc_code, float(item[2]), float(item[3]))
                      for item in need_geo])

    my_name = (collection.account_username or "").strip().lower()
    features = []
    for cache, row, _lat, _lon in sorted(
            entries, key=lambda item: (item[0].appear is None,
                                       item[0].appear or date.min,
                                       item[0].ref.gc_code)):
        ref = cache.ref
        pick = _pick(ref, row)

        country, region = pick("country"), pick("state")
        if not country and ref.gc_code in borrowed:
            country, region = borrowed[ref.gc_code]
        owner_id = ref.owner_id if ref.owner_id is not None else collection.account_user_id
        # Étapes du poseur à partir de l'apparition ; une cache sans date
        # d'apparition n'en a pas (aucune borne de départ).
        events = [] if cache.appear is None else [
            [_iso(log.day), log.kind] for log in cache.logs
            if log.kind in OWNER_EVENT_KINDS and log.day >= cache.appear
            and _by_owner(log, owner_id, my_name)]
        appear = _iso(cache.appear)
        features.append({
            "type": "Feature",
            "geometry": None,
            "properties": {
                "source_kind": SOURCE_KIND_OWNED,
                "record_uid": f"owned:{ref.gc_code}",
                "gc_code": ref.gc_code,
                "name": pick("name", "cache_name"),
                "owner": pick("owner_name", "owner"),
                "cache_type": pick("cache_type"),
                "difficulty": pick("difficulty"),
                "terrain": pick("terrain"),
                "container": pick("container"),
                "country": country,
                "state": region,
                "published_date": appear,
                "date_find": appear,
                "appear_source": cache.appear_source,
                "owner_states": [[_iso(day), state] for day, state, _synthetic in cache.changes],
                "owner_events": events,
                "found": False,
            },
        })
    return {"features": features, "ownedTotal": len(caches),
            "undatable": undatable, "revision": collection.revision}
