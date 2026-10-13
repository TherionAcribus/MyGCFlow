"""Projection GeoJSON des découvertes Adventure Lab (mode Normal).

Une ligne `lab_discovery` devient une feature Point uniquement si elle est
exploitable : coordonnées résolues (fichier coordonnées ou correction
manuelle) ET date de découverte connue. Les découvertes non résolues restent
en base et dans /api/labs/status — elles n'émettent jamais de point factice
([null,null], (0,0) forcé ou date empruntée).
"""

from __future__ import annotations

from models import LabDiscovery

LAB_CACHE_TYPE = "Adventure Lab"


def lab_record_uid(collection_uid: str, row) -> str:
    """Identité stable de la feature : UUID d'étape quand il existe,
    identité locale sinon (jamais de code GC fabriqué)."""
    return f"lab:{collection_uid}:{row.stage_uuid or row.local_uid}"


def lab_feature(row, collection_uid: str) -> dict:
    """Feature GeoJSON d'une découverte exploitable (cf. plan §8)."""
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
            "found": True,
            "date_precision": row.date_precision,
            "coordinate_scope": row.coordinate_scope,
            "difficulty": None,
            "terrain": None,
            "container": None,
            "country": None,
            "state": None,
            "owner": row.owner,
            "placed_by": None,
            "published_date": row.published_date.strftime("%Y-%m-%d")
            if row.published_date else None,
            "attributes": None,
        },
    }


def _ready_query(session):
    """Découvertes exploitables : résolues ET datées — le jeu animable."""
    collection = _get_collection(session)
    if collection is None:
        return None, []
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.ready_clause(),
    ).all()
    return collection.uid, rows


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
    collection_uid, rows = _ready_query(session)
    if not rows:
        return []
    features = [lab_feature(r, collection_uid) for r in rows]
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
    - pays/région : l'état neutre « tous » inclut les valeurs inconnues ;
      sous sélection géographique réelle, une valeur inconnue ne passe que
      via la sentinelle « Non renseigné » (`UNKNOWN_GEO`) ;
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
        ok_country = geo["neutral_country"] or UNKNOWN_GEO in sel_countries
        ok_state = geo["neutral_state"] or UNKNOWN_GEO in sel_states
    else:
        ok_country = not sel_countries or UNKNOWN_GEO in sel_countries
        ok_state = not sel_states or UNKNOWN_GEO in sel_states
    if not (ok_country and ok_state):
        return []

    collection_uid, rows = _ready_query(session)
    dates = selected_values.get("dates") or {}
    start = _parse_date(dates.get("startDate"))
    end = _parse_date(dates.get("endDate"))
    published = selected_values.get("published_dates") or {}
    pub_start = _parse_date(published.get("startDate"))
    pub_end = _parse_date(published.get("endDate"))
    features = []
    for r in rows:
        if start and end and not (start <= r.found_date <= end):
            continue
        if pub_start and pub_end and r.published_date \
                and not (pub_start <= r.published_date <= pub_end):
            continue
        features.append(lab_feature(r, collection_uid))
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
