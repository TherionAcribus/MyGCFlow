"""Rattachement d'une cache à ses zones : pays, région, sous-région.

Trois niveaux génériques, les mêmes pour tous les pays (plan :
MyGCFlow_Plan_Carte_Zones.md, doc : docs/zones-ajouter-un-pays.md) :

    country     niveau 0, monde entier
    region      niveau 1 (le champ « State » de Geocaching.com)
    subregion   niveau 2 (départements, Landkreise, counties…), si le pays
                a une recette qui le fournit

Ordre de rattachement, à chaque niveau :
  1. le nom donné par Geocaching.com (pays, région ; comté pour Évolution),
     par les alias du pays — cohérent avec les filtres de la carte ;
  2. sinon la position : point dans polygone ;
  3. sinon la zone la plus proche à moins de NEAREST_MAX_M (cache côtière,
     îlot gommé par la simplification) ;
  4. sinon None : « hors carte ». Jamais d'erreur.

Les géométries viennent de geo/match/ (générées par
tools/build_geo_zones.py) : plus fines que celles de l'affichage
(static/geo/), sans encarts, coordonnées entières (1e-4 degré) codées en
différences puis compressées. Chargées à la demande, pays par pays.

Python pur : aucune dépendance géographique.
"""
from __future__ import annotations

import gzip
import json
import math
import threading
import unicodedata
from collections import namedtuple
from pathlib import Path

import paths

FORMAT_VERSION = 1
LEVELS = ("country", "region", "subregion")
COORD_SCALE = 10_000           # 1e-4 degré ≈ 11 m (simplification à 100 m)
NEAREST_MAX_M = 5_000
_CELL_DEG = 1.0                # grille de préfiltre des rectangles englobants
_CELL_MARGIN_DEG = 0.1         # ≥ NEAREST_MAX_M partout où il y a des caches
_EARTH_M_PER_DEG = 111_320.0


def match_dir() -> Path:
    return paths.resource_dir() / "geo" / "match"


# ---------------------------------------------------------------------------
# Noms

def normalize_name(value) -> str:
    """Clé de comparaison d'un nom : sans casse, accents, tirets, espaces ni
    ponctuation. « Grand-Est » = « Grand Est », « Friuli–Venezia Giulia » =
    « Friuli-Venezia Giulia », « Cataluña » = « Cataluna »."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return "".join(ch for ch in text.casefold() if ch.isalnum())


# ---------------------------------------------------------------------------
# Géométrie

def encode_ring(ring) -> list[int]:
    """[[x, y], …] en degrés → [dx0, dy0, dx1, dy1, …] entiers (1e-4 °)."""
    out, px, py = [], 0, 0
    for x, y in ring:
        ix, iy = round(x * COORD_SCALE), round(y * COORD_SCALE)
        out += (ix - px, iy - py)
        px, py = ix, iy
    return out


def decode_ring(deltas) -> list[float]:
    """Inverse d'encode_ring, à plat : [x0, y0, x1, y1, …] en degrés."""
    out, x, y = [], 0, 0
    for i in range(0, len(deltas), 2):
        x += deltas[i]
        y += deltas[i + 1]
        out += (x / COORD_SCALE, y / COORD_SCALE)
    return out


def _meters_per_deg_x(lat: float) -> float:
    return _EARTH_M_PER_DEG * max(math.cos(math.radians(lat)), 0.01)


class Zone:
    """Une zone : identifiant, parent, rectangle englobant et anneaux.

    Test d'appartenance pair-impair sur tous les anneaux (trous et
    multipolygones compris). Les arêtes sont rangées par bandes horizontales
    à la première interrogation : un test ne parcourt que celles qui
    croisent la latitude du point.
    """

    __slots__ = ("id", "parent", "bbox", "rings", "_bands", "_band_y0", "_band_h")

    def __init__(self, zone_id, parent, rings):
        self.id = zone_id
        self.parent = parent
        self.rings = rings  # listes à plat [x0, y0, x1, y1, …], en degrés
        xs = [v for r in rings for v in r[0::2]]
        ys = [v for r in rings for v in r[1::2]]
        self.bbox = (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, 0, 0)
        self._bands = None

    def _edges(self):
        for r in self.rings:
            n = len(r)
            for i in range(0, n, 2):
                j = (i + 2) % n
                yield r[i], r[i + 1], r[j], r[j + 1]

    def _build_bands(self):
        edges = [e for e in self._edges() if e[1] != e[3]]
        x0, y0, x1, y1 = self.bbox
        count = max(1, min(4096, len(edges) // 4))
        height = (y1 - y0) / count or 1.0
        bands = [[] for _ in range(count)]
        for e in edges:
            lo = int((min(e[1], e[3]) - y0) / height)
            hi = int((max(e[1], e[3]) - y0) / height)
            for b in range(max(lo, 0), min(hi, count - 1) + 1):
                bands[b].append(e)
        self._bands, self._band_y0, self._band_h = bands, y0, height

    def contains(self, x: float, y: float) -> bool:
        x0, y0, x1, y1 = self.bbox
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            return False
        if self._bands is None:
            self._build_bands()
        b = min(int((y - self._band_y0) / self._band_h), len(self._bands) - 1)
        inside = False
        for ax, ay, bx, by in self._bands[b]:
            if (ay > y) != (by > y):
                if ax + (y - ay) * (bx - ax) / (by - ay) > x:
                    inside = not inside
        return inside

    def distance_m(self, x: float, y: float) -> float:
        """Distance au bord le plus proche, en mètres (projection locale
        équirectangulaire : assez juste à quelques km)."""
        kx, ky = _meters_per_deg_x(y), _EARTH_M_PER_DEG
        best = math.inf
        for ax, ay, bx, by in self._edges():
            ax, ay = (ax - x) * kx, (ay - y) * ky
            bx, by = (bx - x) * kx, (by - y) * ky
            dx, dy = bx - ax, by - ay
            length2 = dx * dx + dy * dy
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
            px, py = ax + t * dx, ay + t * dy
            d = px * px + py * py
            if d < best:
                best = d
        return math.sqrt(best)


class ZoneSet:
    """Zones d'un niveau (d'un pays), avec une grille de préfiltre."""

    def __init__(self, zones):
        self.zones = list(zones)
        self.by_id = {z.id: z for z in self.zones}
        self._cells = {}
        for z in self.zones:
            x0, y0, x1, y1 = z.bbox
            for cx in range(math.floor((x0 - _CELL_MARGIN_DEG) / _CELL_DEG),
                            math.floor((x1 + _CELL_MARGIN_DEG) / _CELL_DEG) + 1):
                for cy in range(math.floor((y0 - _CELL_MARGIN_DEG) / _CELL_DEG),
                                math.floor((y1 + _CELL_MARGIN_DEG) / _CELL_DEG) + 1):
                    self._cells.setdefault((cx, cy), []).append(z)

    def candidates(self, x, y):
        return self._cells.get((math.floor(x / _CELL_DEG), math.floor(y / _CELL_DEG)), ())

    def locate(self, x, y, *, among=None):
        """(zone, 'position' | 'nearest') ou (None, None). `among` : ids
        autorisés (enfants d'une région déjà connue)."""
        cands = [z for z in self.candidates(x, y) if among is None or z.parent in among]
        for z in cands:
            if z.contains(x, y):
                return z, "position"
        margin_x = NEAREST_MAX_M / _meters_per_deg_x(y)
        margin_y = NEAREST_MAX_M / _EARTH_M_PER_DEG
        best, best_d = None, NEAREST_MAX_M
        for z in cands:
            x0, y0, x1, y1 = z.bbox
            if x0 - margin_x <= x <= x1 + margin_x and y0 - margin_y <= y <= y1 + margin_y:
                d = z.distance_m(x, y)
                if d <= best_d:
                    best, best_d = z, d
        return (best, "nearest") if best else (None, None)


# ---------------------------------------------------------------------------
# Index

Assignment = namedtuple("Assignment", "country region subregion via")
Assignment.__doc__ = ("Ids de zone par niveau (None = hors carte) ; `via` : "
                      "comment chaque niveau a été trouvé ('name', "
                      "'position', 'nearest' ou None).")

_NONE = Assignment(None, None, None, (None, None, None))


def _read_match(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("v") != FORMAT_VERSION:
        raise ValueError(f"{path.name} : format {data.get('v')!r} inconnu")
    return data


def _zone_set(records):
    return ZoneSet(Zone(r["id"], r.get("parent"), [decode_ring(d) for d in r["rings"]])
                   for r in records)


class _Country:
    """Niveaux 1 et 2 d'un pays : zones et noms (portée : le pays pour les
    régions, la région pour les sous-régions)."""

    def __init__(self, data):
        self.levels = {}
        self.names = {}
        for level in ("region", "subregion"):
            records = data.get("levels", {}).get(level)
            if records is None:
                continue
            self.levels[level] = _zone_set(records)
            self.names[level] = {key: tuple(ids) for key, ids in data.get("names", {}).get(level, {}).items()}

    def by_name(self, level, name, parent=None):
        """Id unique pour ce nom, ou None. Pour une sous-région, la région
        connue lève l'ambiguïté (« Washington County » existe dans une trentaine d'États)."""
        ids = self.names.get(level, {}).get(normalize_name(name))
        if not ids:
            return None
        if parent is not None:
            zones = self.levels[level].by_id
            ids = tuple(i for i in ids if zones[i].parent == parent) or ids
        return ids[0] if len(ids) == 1 else None


class ZoneIndex:
    """Point d'entrée : `assign(...)` pour une cache. Thread-safe pour la
    lecture ; les fichiers sont chargés une fois, à la demande."""

    def __init__(self, directory: Path | None = None):
        self.directory = Path(directory) if directory else match_dir()
        self._lock = threading.Lock()
        self._world = None
        self._countries = {}
        self._memo = {}
        self._available = None

    # -- chargement --------------------------------------------------------
    def available(self) -> bool:
        if self._available is None:
            self._available = (self.directory / "countries.json.gz").is_file()
        return self._available

    def _load_world(self):
        if self._world is None:
            with self._lock:
                if self._world is None:
                    data = _read_match(self.directory / "countries.json.gz")
                    self._world = {
                        "zones": _zone_set(data["zones"]),
                        "names": data.get("names", {}),
                        "as_region": data.get("as_region", {}),
                        "files": set(data.get("files", [])),
                    }
        return self._world

    def country(self, country_id):
        world = self._load_world()
        if country_id not in world["files"]:
            return None
        if country_id not in self._countries:
            with self._lock:
                if country_id not in self._countries:
                    data = _read_match(self.directory / f"{country_id}.json.gz")
                    self._countries[country_id] = _Country(data)
        return self._countries[country_id]

    # -- rattachement ------------------------------------------------------
    def assign(self, *, country=None, state=None, county=None, lat=None, lon=None) -> Assignment:
        if not self.available():
            return _NONE
        key = (country or None, state or None, county or None,
               None if lat is None else round(float(lat), 6),
               None if lon is None else round(float(lon), 6))
        hit = self._memo.get(key)
        if hit is None:
            hit = self._assign(*key)
            if len(self._memo) > 500_000:
                self._memo.clear()
            self._memo[key] = hit
        return hit

    def _assign(self, country_name, state_name, county_name, lat, lon):
        world = self._load_world()
        has_pos = (lat is not None and lon is not None
                   and -90 <= lat <= 90 and -180 <= lon <= 180
                   and not (lat == 0 and lon == 0))
        x, y = lon, lat

        country_id = region_id = sub_id = None
        via = [None, None, None]

        # Pays (et région pour les « pays » GC qui sont des régions chez nous).
        key = normalize_name(country_name)
        if key and key in world["as_region"]:
            country_id, region_id = world["as_region"][key]
            via[0] = via[1] = "name"
        elif key and len(world["names"].get(key, ())) == 1:
            country_id = world["names"][key][0]
            via[0] = "name"
        elif has_pos:
            zone, how = world["zones"].locate(x, y)
            if zone:
                country_id, via[0] = zone.id, how
            else:
                # Îlots effacés par la simplification du contour des pays
                # (Helgoland, île de Sein…) : les niveaux fins des pays
                # voisins les ont encore.
                country_id, region_id, via = self._locate_in_neighbours(x, y)

        info = self.country(country_id) if country_id else None
        if info is None:
            return Assignment(country_id, None, None, tuple(via))

        # Région.
        regions = info.levels.get("region")
        if regions and region_id is None:
            region_id = info.by_name("region", state_name) if state_name else None
            if region_id:
                via[1] = "name"
            elif has_pos:
                zone, how = regions.locate(x, y)
                if zone:
                    region_id, via[1] = zone.id, how

        # Sous-région : nom (Évolution), puis position — seulement parmi les
        # enfants de la région trouvée, pour que la somme des sous-régions
        # fasse toujours la région. Une position qui contredit la région de
        # Geocaching.com de plus de NEAREST_MAX_M (coordonnées corrigées d'un
        # mystère, par exemple) laisse la cache hors carte à ce niveau.
        subs = info.levels.get("subregion")
        if subs:
            if county_name:
                sub_id = info.by_name("subregion", county_name, parent=region_id)
                if sub_id and region_id and subs.by_id[sub_id].parent != region_id:
                    sub_id = None
                if sub_id:
                    via[2] = "name"
            if sub_id is None and has_pos:
                zone, how = subs.locate(x, y, among={region_id} if region_id else None)
                if zone:
                    sub_id, via[2] = zone.id, how
            if sub_id and region_id is None:
                region_id = subs.by_id[sub_id].parent
                via[1] = "parent"

        return Assignment(country_id, region_id, sub_id, tuple(via))

    def _locate_in_neighbours(self, x, y):
        """(pays, région, via) d'après le niveau le plus fin des pays dont le
        rectangle englobant passe à moins de _NEIGHBOUR_DEG du point."""
        world = self._load_world()
        best = (None, None, [None, None, None])
        for zone in world["zones"].zones:
            x0, y0, x1, y1 = zone.bbox
            if not (x0 - _NEIGHBOUR_DEG <= x <= x1 + _NEIGHBOUR_DEG
                    and y0 - _NEIGHBOUR_DEG <= y <= y1 + _NEIGHBOUR_DEG):
                continue
            info = self.country(zone.id)
            if info is None:
                continue
            for level in ("subregion", "region"):
                zset = info.levels.get(level)
                if not zset:
                    continue
                hit, how = zset.locate(x, y)
                if hit is None:
                    continue
                region = hit.parent if level == "subregion" else hit.id
                found = (zone.id, region, [how, "parent" if level == "subregion" else how, None])
                if how == "position":
                    return found
                if best[0] is None:
                    best = found
                break
        return best


_NEIGHBOUR_DEG = 0.5
_index = None
_index_lock = threading.Lock()


def get_index() -> ZoneIndex:
    global _index
    if _index is None:
        with _index_lock:
            if _index is None:
                _index = ZoneIndex()
    return _index
