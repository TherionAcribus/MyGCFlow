"""Traces GPS des parcours (MyGCFlow_Plan_Parcours.md, § 9 ; lot 5).

Un fichier GPX (téléphone, montre, Strava…) donne des points horodatés en
UTC. À l'import :

- seuls les points de trace (`trk/trkseg/trkpt`) avec une heure sont gardés,
  segment par segment, dans l'ordre du fichier ;
- chaque segment est **simplifié** (Douglas-Peucker en distance synchronisée,
  SIMPLIFY_TOLERANCE_M) en gardant l'heure des points conservés : une journée
  enregistrée à la seconde passe de dizaines de milliers de points à quelques
  milliers, sans perdre les pauses ;
- la trace est stockée en JSON ([[lon, lat, t], ...] par segment, t en
  secondes UTC).

Rattachement des étapes, heure locale et géométrie : côté client
(static/js/parcours_tracks.mjs), comme la reconstruction.
"""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import parcours_store
from parcours_store import ParcoursError
from models import ParcoursTrack

MAX_TRACK_BYTES = 30 * 1024 * 1024
MAX_TRACKS = 50
SIMPLIFY_TOLERANCE_M = 10.0
# Après simplification, au-delà, on éclaircit uniformément (journée démesurée).
MAX_POINTS = 50_000
NAME_MAX_LENGTH = 255

_EARTH_M = 6_371_008.8


class InvalidTrack(ValueError):
    """Fichier refusé. `reason` : 'too_large', 'not_gpx', 'no_time'."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def _parse_time(text) -> float | None:
    if not text:
        return None
    value = text.strip()
    if value.endswith('Z'):
        value = value[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Le format GPX impose l'UTC : une heure sans fuseau est lue en UTC.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def parse_gpx(data: bytes) -> tuple[str, list[list[list[float]]], int]:
    """(nom, segments [[[lon, lat, t], ...]], nombre de points horodatés lus).
    Lève InvalidTrack."""
    if len(data) > MAX_TRACK_BYTES:
        raise InvalidTrack('too_large')
    name = ''
    segments = []
    current = None
    total = 0
    saw_gpx = False
    try:
        for event, element in ET.iterparse(_BytesReader(data), events=('start', 'end')):
            tag = _local(element.tag)
            if event == 'start':
                if tag == 'gpx':
                    saw_gpx = True
                elif tag == 'trkseg':
                    current = []
                continue
            if tag == 'name' and not name and element.text:
                name = element.text.strip()
            elif tag == 'trkpt' and current is not None:
                t = None
                for child in element:
                    if _local(child.tag) == 'time':
                        t = _parse_time(child.text)
                try:
                    lat = float(element.get('lat'))
                    lon = float(element.get('lon'))
                except (TypeError, ValueError):
                    lat = lon = None
                if t is not None and lat is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
                    current.append([lon, lat, t])
                    total += 1
                element.clear()
            elif tag == 'trkseg':
                if current:
                    current.sort(key=lambda p: p[2])
                    segments.append(current)
                current = None
    except ET.ParseError:
        raise InvalidTrack('not_gpx')
    if not saw_gpx:
        raise InvalidTrack('not_gpx')
    if total == 0:
        raise InvalidTrack('no_time')
    return name, segments, total


class _BytesReader:
    """Lecteur minimal pour iterparse sur des octets en mémoire."""

    def __init__(self, data: bytes):
        self._data = memoryview(data)
        self._pos = 0

    def read(self, size=-1):
        if size is None or size < 0:
            size = len(self._data) - self._pos
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return bytes(chunk)


def _xy(points):
    """Projection locale en mètres (équirectangulaire, autour du 1er point)."""
    lat0 = math.radians(points[0][1])
    k = math.cos(lat0)
    return [((p[0] - points[0][0]) * math.pi / 180 * _EARTH_M * k,
             (p[1] - points[0][1]) * math.pi / 180 * _EARTH_M) for p in points]


def simplify(points, tolerance_m=SIMPLIFY_TOLERANCE_M):
    """Douglas-Peucker itératif, en distance SYNCHRONISÉE : un point est
    comparé à la position qu'aurait le marcheur À SON HEURE sur le tronçon
    gardé (vitesse constante), pas au tronçon seul. Un Douglas-Peucker
    purement spatial efface une pause sur place — ses points sont alignés —
    et l'heure interpolée ensuite serait fausse de toute la durée de la
    pause. Garde premier et dernier point."""
    n = len(points)
    if n <= 2:
        return list(points)
    xy = _xy(points)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tolerance_m * tolerance_m
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        ta, tb = points[a][2], points[b][2]
        span = tb - ta
        worst, worst_d2 = -1, tol2
        for i in range(a + 1, b):
            px, py = xy[i]
            f = (points[i][2] - ta) / span if span > 0 else 0.0
            d2 = (px - ax - f * (bx - ax)) ** 2 + (py - ay - f * (by - ay)) ** 2
            if d2 > worst_d2:
                worst, worst_d2 = i, d2
        if worst >= 0:
            keep[worst] = True
            stack.append((a, worst))
            stack.append((worst, b))
    return [p for p, k in zip(points, keep) if k]


def _round(points):
    return [[round(p[0], 6), round(p[1], 6), int(round(p[2]))] for p in points]


def track_to_dict(row: ParcoursTrack, with_points=True) -> dict:
    out = {
        'id': row.id,
        'name': row.name or '',
        'pointCount': row.point_count,
        'sourcePointCount': row.source_point_count,
        'start': row.start_utc.replace(tzinfo=timezone.utc).isoformat() if row.start_utc else None,
        'end': row.end_utc.replace(tzinfo=timezone.utc).isoformat() if row.end_utc else None,
    }
    if with_points:
        out['segments'] = json.loads(row.segments)
    return out


def list_tracks(session, parcours_id: int) -> list[dict]:
    rows = session.query(ParcoursTrack).filter_by(parcours_id=parcours_id) \
        .order_by(ParcoursTrack.start_utc, ParcoursTrack.id).all()
    return [track_to_dict(row) for row in rows]


def save_track(session, parcours_id: int, data: bytes, file_name: str = '') -> dict:
    parcours = parcours_store.get(session, parcours_id)
    if session.query(ParcoursTrack).filter_by(parcours_id=parcours.id).count() >= MAX_TRACKS:
        raise ParcoursError('tracks-full')
    name, segments, total = parse_gpx(data)
    simplified = [simplify(segment) for segment in segments]
    kept = sum(len(s) for s in simplified)
    if kept > MAX_POINTS:
        step = math.ceil(kept / MAX_POINTS)
        simplified = [s[::step] + ([s[-1]] if (len(s) - 1) % step else []) for s in simplified]
        kept = sum(len(s) for s in simplified)
    simplified = [_round(s) for s in simplified if s]
    times = [p[2] for s in simplified for p in s]
    to_dt = lambda t: datetime.fromtimestamp(t, tz=timezone.utc).replace(tzinfo=None)  # noqa: E731
    row = ParcoursTrack(
        parcours_id=parcours.id,
        name=(name or file_name or '')[:NAME_MAX_LENGTH],
        segments=json.dumps(simplified, separators=(',', ':')),
        point_count=kept,
        source_point_count=total,
        start_utc=to_dt(min(times)),
        end_utc=to_dt(max(times)),
        created_at=datetime.now(),
    )
    session.add(row)
    parcours.updated_at = datetime.now()
    session.commit()
    return track_to_dict(row, with_points=False)


def delete_track(session, parcours_id: int, track_id: int) -> None:
    parcours = parcours_store.get(session, parcours_id)
    row = session.get(ParcoursTrack, track_id)
    if row is None or row.parcours_id != parcours.id:
        raise ParcoursError('track-not-found')
    session.delete(row)
    parcours.updated_at = datetime.now()
    session.commit()


def delete_all(session, parcours_id: int) -> None:
    """Traces d'un parcours (sans commit)."""
    session.query(ParcoursTrack).filter_by(parcours_id=parcours_id).delete()
