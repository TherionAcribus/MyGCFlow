"""Parcours suggérés à la création (MyGCFlow_Plan_Parcours.md, lot 7).

Deux familles, tirées des trouvailles :
- les **séjours** : jours consécutifs (un jour sans trouvaille ne coupe pas)
  dont le centre est à plus de AWAY_KM du « centre habituel » ;
- les **grosses journées** près de chez soi : BIG_DAY_FINDS trouvailles ou
  plus dans la journée.

Centre habituel : la case de HOME_CELL_DEG degrés qui compte le plus de
journées de trouvailles, au centre moyen de ces journées. Une journée est
placée à la médiane de ses trouvailles (une cache lointaine isolée ne la
déplace pas).

Le nom proposé est le lieu (région, sinon pays) le plus représenté ; la page
y ajoute les dates. Les plages déjà enregistrées comme parcours ne sont plus
proposées.
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import date, datetime
from statistics import median

from models import Geocache

AWAY_KM = 100
HOME_CELL_DEG = 0.5
MAX_GAP_DAYS = 2        # deux dates à 2 jours d'écart : même séjour
MIN_TRIP_FINDS = 3
BIG_DAY_FINDS = 20
LIMIT = 6
PLACE_SHARE = 0.6       # part des trouvailles pour nommer par région
COUNTRY_SHARE = 0.8     # part pour un séjour « dans un seul pays »


def _haversine_km(a, b) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))


def find_days(session) -> list[dict]:
    """Une entrée par date de trouvaille : centre (médiane), nombre, pays et
    régions."""
    rows = session.query(
        Geocache.date_find, Geocache.latitude, Geocache.longitude, Geocache.country, Geocache.state,
    ).filter(
        Geocache.found.is_(True), Geocache.date_find.isnot(None),
        Geocache.latitude.isnot(None), Geocache.longitude.isnot(None),
    ).all()
    by_day: dict[date, list] = {}
    for found, lat, lon, country, state in rows:
        day = found.date() if isinstance(found, datetime) else found
        by_day.setdefault(day, []).append((lat, lon, country or '', state or ''))
    days = []
    for day, items in sorted(by_day.items()):
        days.append({
            'date': day,
            'lat': median(i[0] for i in items),
            'lon': median(i[1] for i in items),
            'finds': len(items),
            'countries': Counter(i[2] for i in items if i[2]),
            'states': Counter((i[2], i[3]) for i in items if i[3]),
        })
    return days


def home_center(days: list[dict]):
    """Centre habituel (lat, lon), ou None sans journée."""
    if not days:
        return None
    cells: dict[tuple, list] = {}
    for day in days:
        cell = (math.floor(day['lat'] / HOME_CELL_DEG), math.floor(day['lon'] / HOME_CELL_DEG))
        cells.setdefault(cell, []).append(day)
    best = max(cells.values(), key=lambda items: (len(items), sum(d['finds'] for d in items)))
    return (sum(d['lat'] for d in best) / len(best), sum(d['lon'] for d in best) / len(best))


def place_name(days: list[dict]) -> str:
    """Lieu le plus représenté : la région si elle domine un seul pays, le
    pays, ou les deux pays principaux."""
    countries = Counter()
    states = Counter()
    for day in days:
        countries.update(day['countries'])
        states.update(day['states'])
    total = sum(countries.values())
    if total == 0:
        return ''
    (country, count), *others = countries.most_common()
    if count / total < COUNTRY_SHARE and others:
        return f'{country} / {others[0][0]}'
    in_country = {state: n for (c, state), n in states.items() if c == country}
    if in_country:
        state, n = max(in_country.items(), key=lambda item: item[1])
        if n / count >= PLACE_SHARE:
            return state
    return country


def suggest(days: list[dict], existing: set | None = None, *, max_days: int = 92,
            limit: int | None = LIMIT) -> list[dict]:
    """Séjours et grosses journées, les plus récents d'abord. `existing` :
    plages (début, fin) déjà enregistrées, écartées."""
    existing = existing or set()
    home = home_center(days)
    if home is None:
        return []
    away = [d for d in days if _haversine_km(home, (d['lat'], d['lon'])) > AWAY_KM]
    trips: list[list[dict]] = []
    for day in away:
        current = trips[-1] if trips else None
        if (current and (day['date'] - current[-1]['date']).days <= MAX_GAP_DAYS
                and (day['date'] - current[0]['date']).days < max_days):
            current.append(day)
        else:
            trips.append([day])
    out = []
    in_trip = set()
    for trip in trips:
        finds = sum(d['finds'] for d in trip)
        in_trip.update(d['date'] for d in trip)
        if finds < MIN_TRIP_FINDS:
            continue
        out.append(_suggestion('trip', trip, finds))
    for day in days:
        if day['date'] not in in_trip and day['finds'] >= BIG_DAY_FINDS:
            out.append(_suggestion('day', [day], day['finds']))
    out = [s for s in out if (s['start'], s['end']) not in existing]
    out.sort(key=lambda s: s['end'], reverse=True)
    return out[:limit]


def _suggestion(kind: str, days: list[dict], finds: int) -> dict:
    return {
        'kind': kind,
        'start': days[0]['date'].isoformat(),
        'end': days[-1]['date'].isoformat(),
        'days': (days[-1]['date'] - days[0]['date']).days + 1,
        'findDays': len(days),
        'finds': finds,
        'place': place_name(days),
    }


def suggestions(session, existing_rows, *, max_days: int = 92,
                limit: int | None = LIMIT) -> dict:
    """Suggestions tronquées à `limit` (None : toutes), avec leur total."""
    existing = {(row['date_start'], row['date_end']) for row in existing_rows}
    full = suggest(find_days(session), existing, max_days=max_days, limit=None)
    return {'suggestions': full[:limit], 'total': len(full)}

