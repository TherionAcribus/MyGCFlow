"""Projection GeoJSON des découvertes Adventure Lab (mode Normal).

Une ligne `lab_discovery` devient une feature Point uniquement si elle est
exploitable : coordonnées résolues (fichier coordonnées ou correction
manuelle) ET date de découverte connue. Les découvertes non résolues restent
en base et dans /api/labs/status — elles n'émettent jamais de point factice
([null,null], (0,0) forcé ou date empruntée).
"""

from __future__ import annotations

import math
import re
import threading
from collections import defaultdict

from sqlalchemy import func

from models import Geocache, LabDiscovery

LAB_CACHE_TYPE = "Adventure Lab"

# Pays et région d'une étape : ceux de la géocache (de la base de
# l'utilisateur) la plus proche, à moins de ce rayon. Les GPX Lab2Gpx n'en
# portent pas (`<groundspeak:country />` vide). Mesuré le 2026-10-15 sur une
# base réelle (19 490 géocaches, pays de chacune deviné d'après les autres) :
# pays juste à 99,55 %, pays et région à 99,37 % ; 96,6 % des étapes Labs
# réelles ont une géocache à moins de 10 km. Au-delà : « Non renseigné ».
# Avantage décisif sur un découpage administratif embarqué : les noms sont
# exactement ceux des géocaches, donc ceux des filtres.
GEO_BORROW_RADIUS_KM = 10.0
_GEO_CELL_DEG = 0.1
_KM_PER_DEG = 111.195

_geo_lock = threading.Lock()
_geo_memo = {"key": None, "by_id": {}, "pairs": frozenset()}

_SOURCE_WALL_CLOCK = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})")


def found_local_time(row) -> str | None:
    """Heure de la découverte (`HH:MM:SS`), lue telle quelle dans l'instant
    source — pour /logs, l'heure locale du joueur sous une étiquette d'offset
    du Pacifique (docs/notes/lab-caches-sources.md), jamais convertie.

    Seulement quand la source porte un vrai instant de la même journée que
    `found_date` : une date corrigée à la main ou sans heure n'en a pas. Sert
    à ordonner les étapes d'une journée dans le trajet ; distincte de
    `time_find`, que les géocaches remplissent d'une heure factice (19:00 /
    20:00 UTC, minuit du Pacifique) et qui ne dit rien de l'ordre."""
    if row.date_basis != "source_offset" or row.date_precision != "instant" \
            or row.found_date is None:
        return None
    match = _SOURCE_WALL_CLOCK.match(row.source_date_text or "")
    if not match or match.group(1) != row.found_date.isoformat():
        return None
    return match.group(2)


def lab_record_uid(collection_uid: str, row) -> str:
    """Identité stable de la feature : UUID d'étape quand il existe,
    identité locale sinon (jamais de code GC fabriqué)."""
    return f"lab:{collection_uid}:{row.stage_uuid or row.local_uid}"


def _geocache_fingerprint(session) -> tuple:
    """Empreinte du contenu de `geocache` : un import remplace toute la
    table (les id peuvent repartir de 1), compter les lignes ne suffit pas."""
    return tuple(session.query(
        func.count(Geocache.id),
        func.total(Geocache.latitude), func.total(Geocache.longitude),
        func.total(func.length(Geocache.country)),
        func.total(func.length(Geocache.state)),
    ).one())


def _compute_borrowed_geo(session, rows) -> dict:
    """id → (pays, région) de la géocache la plus proche (≤ rayon), sinon
    (None, None). Grille de cellules de 0,1° ; distances équirectangulaires,
    exactes à l'échelle de 10 km (l'antiméridien n'est pas déplié)."""
    grid = defaultdict(list)
    for lat, lon, country, state in session.query(
            Geocache.latitude, Geocache.longitude, Geocache.country, Geocache.state
    ).filter(Geocache.latitude.isnot(None), Geocache.longitude.isnot(None),
             Geocache.country.isnot(None), Geocache.country != ''):
        grid[(math.floor(lat / _GEO_CELL_DEG), math.floor(lon / _GEO_CELL_DEG))].append(
            (lat, lon, country, state or None))

    radius = GEO_BORROW_RADIUS_KM
    span_lat = math.ceil(radius / _KM_PER_DEG / _GEO_CELL_DEG)
    out = {}
    for r in rows:
        cos_lat = max(0.01, math.cos(math.radians(r.latitude)))
        span_lon = math.ceil(radius / (_KM_PER_DEG * cos_lat) / _GEO_CELL_DEG)
        cy = math.floor(r.latitude / _GEO_CELL_DEG)
        cx = math.floor(r.longitude / _GEO_CELL_DEG)
        best, best_d = (None, None), radius
        for dy in range(-span_lat, span_lat + 1):
            for dx in range(-span_lon, span_lon + 1):
                for lat, lon, country, state in grid.get((cy + dy, cx + dx), ()):
                    d = math.hypot((lon - r.longitude) * _KM_PER_DEG * cos_lat,
                                   (lat - r.latitude) * _KM_PER_DEG)
                    if d <= best_d:
                        best, best_d = (country, state), d
        out[r.id] = best
    return out


def borrowed_geo(session, collection, rows) -> dict:
    """Pays et région empruntés pour les découvertes exploitables `rows`
    (toutes, telles que `_ready_query` les charge) : id → (pays, région).

    Mémorisé tant que la collection (identité + révision, qui bouge à chaque
    mutation Labs) et le contenu de `geocache` n'ont pas changé — les
    filtres le redemandent à chaque requête."""
    key = _geo_key(session, collection)
    with _geo_lock:
        if _geo_memo["key"] == key:
            return _geo_memo["by_id"]
    by_id = _compute_borrowed_geo(session, rows)
    with _geo_lock:
        _geo_memo.update(key=key, by_id=by_id, pairs=frozenset(by_id.values()))
    return by_id


def _geo_key(session, collection) -> tuple:
    # created_at : un id de collection peut resservir après un « Vider ».
    return (collection.id, collection.created_at, collection.revision,
            _geocache_fingerprint(session))


def lab_geo_pairs(session) -> set:
    """Couples (pays, région) des découvertes exploitables — None pour une
    valeur inconnue. Alimente l'arbre pays/régions et la neutralité des
    filtres, qui doivent offrir ce que les Labs portent réellement. Sans
    relire les étapes tant que la mémorisation est valable."""
    collection = _get_collection(session)
    if collection is None:
        return set()
    key = _geo_key(session, collection)
    with _geo_lock:
        if _geo_memo["key"] == key:
            return set(_geo_memo["pairs"])
    _uid, _rows, geo = _ready_query(session)
    return set(geo.values())


def lab_feature(row, collection_uid: str, geo=(None, None)) -> dict:
    """Feature GeoJSON d'une découverte exploitable (cf. plan §8). `geo` :
    (pays, région) empruntés (`borrowed_geo`)."""
    uid = lab_record_uid(collection_uid, row)
    return {
        "type": "Feature",
        "id": uid,
        "geometry": {
            "type": "Point",
            "coordinates": [row.longitude, row.latitude],
        },
        "properties": {
            "source_kind": "lab",
            "record_uid": uid,
            "cache_type": LAB_CACHE_TYPE,
            "name": row.stage_title,
            "gc_code": None,
            "adventure_id": row.adventure_uuid,
            "stage_id": row.stage_uuid,
            "adventure_title": row.adventure_title,
            "adventure_url": row.adventure_url,
            "date_find": row.found_date.strftime("%Y-%m-%d") if row.found_date else None,
            "time_find": None,
            "found_local_time": found_local_time(row),
            "found": True,
            "date_precision": row.date_precision,
            "coordinate_scope": row.coordinate_scope,
            "difficulty": None,
            "terrain": None,
            "container": None,
            "country": geo[0],
            "state": geo[1],
            "owner": row.owner,
            "placed_by": None,
            "published_date": row.published_date.strftime("%Y-%m-%d")
            if row.published_date else None,
            "attributes": None,
        },
    }


def _ready_query(session):
    """Découvertes exploitables : résolues ET datées — le jeu animable —,
    avec leurs pays/région empruntés : (uid de collection, lignes, géo)."""
    collection = _get_collection(session)
    if collection is None:
        return None, [], {}
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.ready_clause(),
    ).all()
    geo = borrowed_geo(session, collection, rows) if rows else {}
    return collection.uid, rows, geo


def _get_collection(session):
    # Import local : lab_store importe déjà les modèles — éviter un cycle.
    from lab_store import get_collection
    return get_collection(session)


def has_ready_labs(session) -> bool:
    """Vrai si au moins une découverte est exploitable (résolue + datée)."""
    collection = _get_collection(session)
    if collection is None:
        return False
    return session.query(LabDiscovery.id).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.ready_clause(),
    ).first() is not None


def build_lab_features(session) -> list:
    """Features des découvertes exploitables, tri date puis identité stable."""
    collection_uid, rows, geo = _ready_query(session)
    if not rows:
        return []
    features = [lab_feature(r, collection_uid, geo.get(r.id, (None, None)))
                for r in rows]
    features.sort(key=_feature_sort_key)
    return features


def build_lab_features_matching(session, selected_values: dict,
                                geo: dict | None = None) -> list:
    """Features Labs respectant les critères du filtre (repli SQL).

    Politique commune aux trois moteurs de filtrage (plan §9.2/9.3) :
    - `sources` : liste explicite ; « lab » absent => aucune feature Lab
      (champ non transmis => pas de restriction, compatibilité MVP avant
      le sélecteur de sources) ;
    - sélection de type obligatoire et contenant « Adventure Lab » ;
    - difficulté/terrain/taille : non applicables aux Labs, ils ne retirent
      jamais une feature Lab ;
    - période de pose : appliquée aux Labs dont la publication est connue
      (lue dans le GPX) ; une publication inconnue ne retire jamais un Lab ;
    - pays/région : ceux empruntés à la géocache la plus proche
      (`borrowed_geo`), filtrés comme ceux d'une géocache — l'état neutre
      « tous » inclut les valeurs inconnues ; sous sélection géographique
      réelle, une valeur inconnue ne passe que via la sentinelle « Non
      renseigné » (`UNKNOWN_GEO`) ;
    - plage de dates de trouvaille appliquée à `found_date`.

    `geo` est le contexte calculé par l'appelant (filter_session) :
    {"neutral_country": bool, "neutral_state": bool}. Sans contexte, une
    sélection nommée est considérée stricte (comportement sûr).
    """
    from geojson_cache import UNKNOWN_GEO

    sources = selected_values.get("sources")
    if isinstance(sources, list) and "lab" not in sources:
        return []
    types = selected_values.get("type") or []
    if not isinstance(types, list) or LAB_CACHE_TYPE not in types:
        return []

    sel_countries = set(str(c) for c in (selected_values.get("countries") or []))
    sel_states = set(str(s) for s in (selected_values.get("states") or []))
    if geo is not None:
        neutral_country, neutral_state = geo["neutral_country"], geo["neutral_state"]
    else:
        neutral_country, neutral_state = not sel_countries, not sel_states

    collection_uid, rows, borrowed = _ready_query(session)
    dates = selected_values.get("dates") or {}
    start = _parse_date(dates.get("startDate"))
    end = _parse_date(dates.get("endDate"))
    published = selected_values.get("published_dates") or {}
    pub_start = _parse_date(published.get("startDate"))
    pub_end = _parse_date(published.get("endDate"))
    features = []
    for r in rows:
        country, state = borrowed.get(r.id, (None, None))
        if not neutral_country and (country or UNKNOWN_GEO) not in sel_countries:
            continue
        if not neutral_state and (state or UNKNOWN_GEO) not in sel_states:
            continue
        if start and end and not (start <= r.found_date <= end):
            continue
        if pub_start and pub_end and r.published_date \
                and not (pub_start <= r.published_date <= pub_end):
            continue
        features.append(lab_feature(r, collection_uid, (country, state)))
    features.sort(key=_feature_sort_key)
    return features


def _parse_date(value):
    from geojson_cache import _parse_date as _p
    return _p(value)


def _feature_sort_key(feature: dict):
    """Tri déterministe du jeu complet : date de trouvaille puis identité
    stable (record_uid Labs, gc_code géocaches)."""
    props = feature.get("properties") or {}
    identity = props.get("record_uid") or props.get("gc_code") \
        or props.get("name") or ""
    return (props.get("date_find") or "9999-12-31", identity)


def merge_sorted(cache_features: list, lab_features: list) -> list:
    """Fusion des deux sources triées par date puis identité stable."""
    return sorted([*cache_features, *lab_features], key=_feature_sort_key)
