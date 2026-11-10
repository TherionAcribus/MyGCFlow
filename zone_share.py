"""Part des caches trouvées par zone : croisement d'un jeu Évolution et de mes
trouvailles, pour la couche de zones de la carte (`GET /api/stats/found_share`).

Plan : MyGCFlow_Plan_Carte_Zones.md § 8 ; doc : docs/carte-zones.md.

La page Statistiques fait ce croisement elle-même (les deux tables y sont
chargées). La carte, elle, ne charge pas les centaines de milliers de caches
d'un jeu : le serveur lui envoie des événements agrégés par (jour, zone),
dans le format que lit `zone_model.mjs › createShareState` :

    placed    caches du jeu apparues ce jour-là dans la zone ;
    archived  caches disparues (archivage daté) ;
    found     caches du jeu que j'ai trouvées, comptées à partir de ma
              trouvaille (ou de leur apparition si l'export la date après) ;
    lost      caches trouvées qui disparaissent ce jour-là.

Mêmes règles que `zone_model.mjs › shareEventsOfTable` (testées des deux
côtés). Jours : numéros de jour depuis le 1970-01-01, comme `dayNumber` côté
client. Zones : indices dans `ids`, -1 = hors carte.

Niveau « grille » : cases hexagonales calculées comme `zone_grid.mjs ›
cellOf`, latitude de référence tirée du jeu. Le client ne fait que dessiner
les cases dont il reçoit les ids (le contour se déduit de l'id) : un écart
d'arrondi entre Python et JavaScript ne peut donc pas mélanger deux cases.
"""
from __future__ import annotations

import math
from datetime import date

FORMAT_VERSION = 1
LEVELS = ("country", "region", "subregion", "grid")
GRID_SIZES = (5, 10, 25, 50, 100)
GRID_DEFAULT_SIZE = 25

_EPOCH = date(1970, 1, 1).toordinal()
_KM_PER_DEG = 111.32
_SQRT3 = math.sqrt(3)


def epoch_day(value):
    """Numéro de jour d'une date « YYYY-MM-DD… », ou None."""
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10]).toordinal() - _EPOCH
    except ValueError:
        return None


def _js_round(x: float) -> int:
    """`Math.round` de JavaScript (moitiés vers +∞), pas l'arrondi bancaire."""
    return math.floor(x + 0.5)


def grid_reference(latitudes) -> int:
    """Latitude de référence de la grille (zone_grid.mjs › gridReference)."""
    values = sorted(v for v in latitudes if v is not None and -90 <= v <= 90)
    if not values:
        return 0
    median = values[len(values) // 2]
    return max(-70, min(70, _js_round(median / 5) * 5))


def grid_cell(lon, lat, size: int, lat0: int):
    """Id de la case d'un point (zone_grid.mjs › cellOf), ou None."""
    if lon is None or lat is None or not (-90 <= lat <= 90) or (lon == 0 and lat == 0):
        return None
    radius = size / _SQRT3
    x = lon * _KM_PER_DEG * math.cos(lat0 * math.pi / 180)
    y = lat * _KM_PER_DEG
    qf = ((_SQRT3 / 3) * x - y / 3) / radius
    rf = ((2 / 3) * y) / radius
    sf = -qf - rf
    q, r, s = _js_round(qf), _js_round(rf), _js_round(sf)
    dq, dr, ds = abs(q - qf), abs(r - rf), abs(s - sf)
    if dq > dr and dq > ds:
        q = -r - s
    elif dr > ds:
        r = -q - s
    return f"h{size}/{lat0}/{q}/{r}"


def found_days(features) -> dict:
    """Code GC → jour de ma première trouvaille, depuis les features du jeu
    de base de la carte (trouvailles ; les étapes Lab n'ont pas de code GC)."""
    out = {}
    for feature in features or ():
        props = (feature or {}).get("properties") or {}
        code = props.get("gc_code")
        day = epoch_day(props.get("date_find"))
        if not code or day is None:
            continue
        known = out.get(code)
        if known is None or day < known:
            out[code] = day
    return out


def build_share_payload(rows, found: dict, *, level: str, grid_size: int = GRID_DEFAULT_SIZE,
                        has_subregions=None) -> dict:
    """Événements agrégés d'un jeu.

    `rows` : dicts (ou sqlite3.Row) avec gc_code, lat, lon, placed,
    archived_on, is_archived, zone_country, zone_region, zone_subregion.
    `has_subregions(cc)` : le pays a-t-il un niveau 2 ? Sinon, au niveau
    « subregion », ses caches comptent dans leur région (comme
    chart_zones.mjs › mixedZoneTable côté client).
    """
    if level not in LEVELS:
        raise ValueError(level)
    grid_size = grid_size if grid_size in GRID_SIZES else GRID_DEFAULT_SIZE
    rows = list(rows)
    lat0 = grid_reference(r["lat"] for r in rows) if level == "grid" else None
    has_subregions = has_subregions or (lambda cc: True)
    sub_memo = {}

    ids, index = [], {}
    sums = {}
    days = {}

    def day_of(iso):
        value = days.get(iso)
        if value is None and iso not in days:
            value = days[iso] = epoch_day(iso)
        return value

    def zone_of(r):
        if level == "grid":
            zone = grid_cell(r["lon"], r["lat"], grid_size, lat0)
        elif level == "subregion":
            zone = r["zone_subregion"]
            cc = r["zone_country"]
            if not zone and cc:
                if cc not in sub_memo:
                    sub_memo[cc] = bool(has_subregions(cc))
                if not sub_memo[cc]:
                    zone = r["zone_region"]
        else:
            zone = r["zone_" + level]
        if not zone:
            return -1
        k = index.get(zone)
        if k is None:
            k = index[zone] = len(ids)
            ids.append(zone)
        return k

    def bump(day, z, slot):
        entry = sums.get((day, z))
        if entry is None:
            entry = sums[(day, z)] = [0, 0, 0, 0]
        entry[slot] += 1

    found_count = 0
    for r in rows:
        placed = day_of(r["placed"])
        if placed is None:
            continue
        z = zone_of(r)
        end = day_of(r["archived_on"]) if r["is_archived"] and r["archived_on"] else None
        if end is not None:
            end = max(end, placed)
        bump(placed, z, 0)
        if end is not None:
            bump(end, z, 1)
        f = found.get(r["gc_code"])
        if f is None:
            continue
        found_count += 1
        start = max(f, placed)
        bump(start, z, 2)
        # Trouvée après l'archivage : jamais active au numérateur.
        if end is not None:
            bump(max(end, start), z, 3)

    keys = sorted(sums)
    payload = {
        "v": FORMAT_VERSION,
        "level": level,
        "ids": ids,
        "day": [k[0] for k in keys],
        "zone": [k[1] for k in keys],
        "placed": [sums[k][0] for k in keys],
        "archived": [sums[k][1] for k in keys],
        "found": [sums[k][2] for k in keys],
        "lost": [sums[k][3] for k in keys],
        "counts": {"caches": len(rows), "found": found_count},
    }
    if level == "grid":
        payload["grid"] = {"size": grid_size, "lat0": lat0}
    return payload
