"""Points DNF de la carte (docs/logs-geocaching.md, lot C).

Un point par cache où le joueur a au moins un DNF. Il apparaît au premier
DNF (`date_find`, nom partagé avec les trouvailles pour réutiliser filtres
et index par jour) et disparaît à la trouvaille qui le résout
(`resolved_date`) : celle du joueur, lue dans ses logs ou dans le My Finds.

Ces points ne sont jamais des trouvailles : servis à part du jeu principal
(`/api/logs/dnf_features`), ils n'entrent dans aucun compteur. Règles :

- une cache déjà trouvée avant son premier DNF n'a pas de point (un DNF
  postérieur à la trouvaille ne raconte pas une recherche) ;
- les DNF postérieurs à la résolution sont ignorés ;
- position : fiche `cache_ref` (correction manuelle ou fichier), sinon ligne
  `geocache` du My Finds ; sans position, la cache est comptée en attente et
  jamais placée à une position inventée.
"""

from __future__ import annotations

from collections import defaultdict

import log_store
from log_formats import CATEGORY_DNF, CATEGORY_FIND, log_category
from models import CacheRef, Geocache, LogEvent

SOURCE_KIND_DNF = "dnf"


def _chunks(items, size=900):
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _as_date(value):
    return value.date() if hasattr(value, "date") else value


def build_dnf_features(session) -> dict:
    """{features, pending, revision} — `revision` : celle de la collection de
    logs (le My Finds, qui résout des DNF, est relu à chaque appel)."""
    collection = log_store.get_collection(session)
    if collection is None or collection.account_user_id is None:
        return {"features": [], "pending": 0, "revision": collection.revision if collection else 0}

    dnf_dates = defaultdict(list)
    find_dates = defaultdict(list)
    for code, log_date, type_id in session.query(
            LogEvent.gc_code, LogEvent.log_date, LogEvent.type_id).filter(
            LogEvent.collection_id == collection.id,
            LogEvent.author_id == collection.account_user_id):
        category = log_category(type_id)
        if category == CATEGORY_DNF:
            dnf_dates[code].append(log_date)
        elif category == CATEGORY_FIND:
            find_dates[code].append(log_date)

    codes = sorted(dnf_dates)
    refs, finds = {}, {}
    for chunk in _chunks(codes):
        for ref in session.query(CacheRef).filter(
                CacheRef.collection_id == collection.id, CacheRef.gc_code.in_(chunk)):
            refs[ref.gc_code] = ref
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(chunk)):
            finds[row.gc_code] = row
            if row.found and row.date_find:
                find_dates[row.gc_code].append(_as_date(row.date_find))

    features, pending = [], 0
    for code in codes:
        first = min(dnf_dates[code])
        found = sorted(find_dates.get(code, []))
        if found and found[0] < first:
            continue                       # trouvée avant toute recherche infructueuse
        resolved = found[0] if found else None
        dates = sorted(d for d in dnf_dates[code] if resolved is None or d <= resolved)

        ref, row = refs.get(code), finds.get(code)

        def pick(ref_attr, row_attr=None):
            value = getattr(ref, ref_attr, None) if ref is not None else None
            if value is None and row is not None:
                value = getattr(row, row_attr or ref_attr, None)
            return value

        lat, lon = pick("latitude"), pick("longitude")
        if lat is None or lon is None:
            pending += 1
            continue
        placed = pick("placed_date", "published_date")
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
            "properties": {
                "source_kind": SOURCE_KIND_DNF,
                "record_uid": f"dnf:{code}",
                "gc_code": code,
                # Mêmes noms de propriétés que les trouvailles (bdd.create_geojson).
                "name": pick("name", "cache_name"),
                "owner": pick("owner_name", "owner"),
                "cache_type": pick("cache_type"),
                "difficulty": pick("difficulty"),
                "terrain": pick("terrain"),
                "container": pick("container"),
                "country": pick("country"),
                "state": pick("state"),
                "published_date": _as_date(placed).isoformat() if placed else None,
                "date_find": first.isoformat(),
                "dnf_dates": [d.isoformat() for d in dates],
                "resolved_date": resolved.isoformat() if resolved else None,
                "found": False,
            },
        })
    return {"features": features, "pending": pending, "revision": collection.revision}
