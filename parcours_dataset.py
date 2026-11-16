"""Entrées d'un parcours (MyGCFlow_Plan_Parcours.md, § 3) : les étapes de
chaque jour de la plage, avec tous les indices utiles à la reconstruction de
l'ordre et des heures, qui se fait côté client (parcours_model.mjs).

Étapes possibles :

- `find` : une trouvaille du My Finds (`geocache`), clé = code GC. `logId` :
  identifiant Geocaching du log de trouvaille du même jour, lu dans
  `log_event` (alimenté par l'import My Finds et la carte « Mes logs ») — il
  croît avec l'ordre de SAISIE des logs, pas forcément avec l'ordre de
  passage ;
- `lab` : une étape Adventure Lab résolue et datée, clé = `lab:<uuid>`.
  `localTime` : heure locale réelle de la validation quand la source en
  porte une (`lab_geojson.found_local_time`) ;
- `dnf` : un DNF du joueur, clé = `dnf:<log_id>` — il s'est déplacé, même
  sans trouver. Écarté quand la même cache est trouvée le même jour : la
  trouvaille représente déjà le passage.

L'heure des trouvailles (`time_find`) n'est jamais servie : elle est
factice dans les GPX (19:00 / 20:00 UTC).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta

from sqlalchemy import func

import log_store
import parcours_store
from lab_geojson import found_local_time
from log_formats import CATEGORY_DNF, CATEGORY_FIND, log_category
from models import CacheRef, Geocache, LabDiscovery, LogEvent

KIND_FIND = 'find'
KIND_LAB = 'lab'
KIND_DNF = 'dnf'


def _chunks(items, size=900):
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _as_date(value):
    return value.date() if isinstance(value, datetime) else value


def _number(value):
    return float(value) if value is not None else None


def _my_logs(session, start: date, end: date):
    """{(code, jour) → plus petit log_id de trouvaille} et liste des DNF
    (log_id, code, jour) du joueur sur la plage. Vides sans logs importés
    ou sans compte identifié."""
    finds, dnfs = {}, []
    collection = log_store.get_collection(session)
    if collection is None or collection.account_user_id is None:
        return finds, dnfs, False
    rows = session.query(LogEvent.log_id, LogEvent.gc_code, LogEvent.log_date, LogEvent.type_id).filter(
        LogEvent.collection_id == collection.id,
        LogEvent.author_id == collection.account_user_id,
        LogEvent.log_date >= start,
        LogEvent.log_date <= end,
    )
    for log_id, code, day, type_id in rows:
        category = log_category(type_id)
        if category == CATEGORY_FIND:
            key = (code, day)
            if key not in finds or log_id < finds[key]:
                finds[key] = log_id
        elif category == CATEGORY_DNF:
            dnfs.append((log_id, code, day))
    return finds, dnfs, True


def _find_stops(session, start: date, end: date, find_logs: dict, counts: dict) -> dict:
    """{jour → [étape]} des trouvailles de la plage."""
    by_day = defaultdict(list)
    rows = session.query(Geocache).filter(
        Geocache.found.is_(True),
        Geocache.date_find >= datetime.combine(start, time.min),
        Geocache.date_find < datetime.combine(end + timedelta(days=1), time.min),
    )
    for row in rows:
        day = _as_date(row.date_find)
        if row.latitude is None or row.longitude is None:
            counts['missing_position'] += 1
            continue
        by_day[day].append({
            'key': row.gc_code,
            'kind': KIND_FIND,
            'code': row.gc_code,
            'name': row.cache_name,
            'type': row.cache_type,
            'difficulty': row.difficulty,
            'terrain': row.terrain,
            'lon': float(row.longitude),
            'lat': float(row.latitude),
            'logId': find_logs.get((row.gc_code, day)),
            'localTime': None,
        })
        counts['finds'] += 1
    return by_day


def _lab_stops(session, start: date, end: date, by_day: dict, counts: dict) -> None:
    # Import local : lab_store importe déjà les modèles — éviter un cycle
    # (même précaution que lab_geojson._get_collection).
    from lab_store import get_collection
    collection = get_collection(session)
    if collection is None:
        return
    rows = session.query(LabDiscovery).filter(
        LabDiscovery.collection_id == collection.id,
        LabDiscovery.ready_clause(),
        LabDiscovery.found_date >= start,
        LabDiscovery.found_date <= end,
    )
    for row in rows:
        by_day[row.found_date].append({
            'key': f"lab:{row.stage_uuid or row.local_uid}",
            'kind': KIND_LAB,
            'code': None,
            'name': row.stage_title,
            'adventure': row.adventure_title,
            'type': 'Lab Cache',
            'difficulty': None,
            'terrain': None,
            'lon': float(row.longitude),
            'lat': float(row.latitude),
            'logId': None,
            'localTime': found_local_time(row),
        })
        counts['labs'] += 1


def _dnf_stops(session, dnfs: list, by_day: dict, counts: dict) -> None:
    found_days = {(stop['code'], day) for day, stops in by_day.items()
                  for stop in stops if stop['kind'] == KIND_FIND}
    kept = [(log_id, code, day) for log_id, code, day in dnfs if (code, day) not in found_days]
    if not kept:
        return
    collection = log_store.get_collection(session)
    codes = sorted({code for _, code, _ in kept})
    refs, finds = {}, {}
    for chunk in _chunks(codes):
        for ref in session.query(CacheRef).filter(
                CacheRef.collection_id == collection.id, CacheRef.gc_code.in_(chunk)):
            refs[ref.gc_code] = ref
        for row in session.query(Geocache).filter(Geocache.gc_code.in_(chunk)):
            finds[row.gc_code] = row
    for log_id, code, day in kept:
        ref, row = refs.get(code), finds.get(code)

        def pick(ref_attr, row_attr=None):
            value = getattr(ref, ref_attr, None) if ref is not None else None
            if value is None and row is not None:
                value = getattr(row, row_attr or ref_attr, None)
            return value

        lat, lon = pick('latitude'), pick('longitude')
        if lat is None or lon is None:
            counts['missing_position'] += 1
            continue
        by_day[day].append({
            'key': f"dnf:{log_id}",
            'kind': KIND_DNF,
            'code': code,
            'name': pick('name', 'cache_name'),
            'type': pick('cache_type'),
            'difficulty': _number(pick('difficulty')),
            'terrain': _number(pick('terrain')),
            'lon': float(lon),
            'lat': float(lat),
            'logId': log_id,
            'localTime': None,
        })
        counts['dnf'] += 1


def _stop_sort_key(stop: dict):
    # Ordre stable du transport ; l'ordre de passage est décidé côté client.
    return (stop['logId'] is None, stop['logId'] or 0, stop['localTime'] or '', stop['key'])


def build_days(session, start: date, end: date, include_labs=True, include_dnf=True,
               keep_empty=True) -> dict:
    """{days: [{date, stops}], counts, logsAvailable} sur [start, end] — un
    jour par date, même sans étape quand `keep_empty` (les jours vides
    comptent dans un voyage). Sans parcours enregistré : sert aussi au banc
    de calibration (tools/parcours_bench_export.py)."""
    counts = {'finds': 0, 'labs': 0, 'dnf': 0, 'missing_position': 0}
    find_logs, dnfs, logs_available = _my_logs(session, start, end)
    by_day = _find_stops(session, start, end, find_logs, counts)
    if include_labs:
        _lab_stops(session, start, end, by_day, counts)
    if include_dnf:
        _dnf_stops(session, dnfs, by_day, counts)
    days = []
    day = start
    while day <= end:
        stops = by_day.get(day, [])
        if stops or keep_empty:
            days.append({'date': day.isoformat(), 'stops': sorted(stops, key=_stop_sort_key)})
        day += timedelta(days=1)
    return {'days': days, 'counts': counts, 'logsAvailable': logs_available}


def build_inputs(session, parcours_id: int) -> dict:
    """{parcours, days: [{date, stops}], counts, logsAvailable, overrides,
    places} du parcours — ajustements manuels compris (lot 3)."""
    parcours = parcours_store.get(session, parcours_id)
    payload = build_days(session, parcours.date_start, parcours.date_end,
                         include_labs=parcours.include_labs, include_dnf=parcours.include_dnf)
    return {'parcours': parcours_store.to_dict(parcours), **payload,
            **parcours_store.adjustments(session, parcours.id)}


def finds_extent(session) -> dict:
    """Première et dernière date de trouvaille : bornes du formulaire de
    création (la dernière sert de date proposée)."""
    first, last = session.query(func.min(Geocache.date_find), func.max(Geocache.date_find)).filter(
        Geocache.found.is_(True)).one()
    return {
        'first': _as_date(first).isoformat() if first else None,
        'last': _as_date(last).isoformat() if last else None,
    }
