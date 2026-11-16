"""Itinéraires réels des parcours (MyGCFlow_Plan_Parcours.md, § 10 ; lot 6).

Le trajet entre deux étapes suit les routes et chemins plutôt que la ligne
droite. Deux fournisseurs, appelés PAR LE SERVEUR (jamais par la page) :

- **FOSSGIS** (`routing.openstreetmap.de`, OSRM) — défaut, sans clé : à pied,
  vélo, voiture. Conditions : une requête par seconde au plus, aucune
  garantie de disponibilité, adresse à ne pas figer (elle est réglable) ;
- **openrouteservice** — clé gratuite créée par l'utilisateur, quotas
  publiés (2 000 itinéraires par jour, 40 par minute) : l'option « plus
  fiable ».

Chaque trajet calculé est gardé dans `route_leg_cache` (par fournisseur,
profil et coordonnées arrondies au 1e-5°) : la vidéo reste reproductible et
se refait hors ligne. Un trajet sans route possible (île, mer) est gardé
aussi, sans géométrie : il n'est plus redemandé, le client trace la ligne
droite. « Recalculer » (`force`) ignore le cache.

Une requête couvre une suite de trajets de même profil (MAX_WAYPOINTS points
au plus) : une journée coûte une poignée d'appels, découpés ensuite trajet
par trajet.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime

import requests

from models import RouteLegCache
from options import REPO_URL
from version import __version__

PROVIDER_FOSSGIS = 'fossgis'
PROVIDER_ORS = 'ors'
PROVIDERS = (PROVIDER_FOSSGIS, PROVIDER_ORS)
PROFILES = ('foot', 'bike', 'car')
FOSSGIS_DEFAULT_URL = 'https://routing.openstreetmap.de'
ORS_DEFAULT_URL = 'https://api.openrouteservice.org'
# openrouteservice refuse plus de 50 points par itinéraire (offre gratuite).
MAX_WAYPOINTS = 50
MAX_REQUEST_WAYPOINTS = 400
REQUEST_TIMEOUT_S = 25
# Écart minimal entre deux appels d'un même fournisseur (conditions FOSSGIS :
# une requête par seconde ; openrouteservice : 40 par minute).
MIN_INTERVAL_S = {PROVIDER_FOSSGIS: 1.05, PROVIDER_ORS: 1.6}
USER_AGENT = f"MyGCFlow/{__version__} (parcours ; +{REPO_URL})"

_OSRM_PROFILES = {'foot': 'foot', 'bike': 'bike', 'car': 'car'}
_ORS_PROFILES = {'foot': 'foot-walking', 'bike': 'cycling-regular', 'car': 'driving-car'}

_throttle_lock = threading.Lock()
_last_call: dict[str, float] = {}


class RoutingError(Exception):
    """Échec d'un fournisseur. `code` : 'unavailable' (réseau, serveur),
    'quota' (trop de requêtes), 'key' (clé openrouteservice refusée ou
    absente), 'invalid' (requête mal formée)."""

    def __init__(self, code: str, detail: str = ''):
        super().__init__(code)
        self.code = code
        self.detail = detail


def _throttle(provider: str) -> None:
    with _throttle_lock:
        wait = MIN_INTERVAL_S.get(provider, 1.0) - (time.monotonic() - _last_call.get(provider, -1e9))
        if wait > 0:
            time.sleep(wait)
        _last_call[provider] = time.monotonic()


def _point(p) -> tuple[float, float]:
    lon, lat = float(p[0]), float(p[1])
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise RoutingError('invalid')
    return lon, lat


def leg_key(a, b) -> str:
    raw = f"{a[0]:.5f},{a[1]:.5f}|{b[0]:.5f},{b[1]:.5f}"
    return hashlib.sha1(raw.encode('ascii')).hexdigest()


# --- Fournisseurs ---------------------------------------------------------------

def _join_steps(steps) -> list:
    path = []
    for step in steps:
        for coord in (step.get('geometry') or {}).get('coordinates') or []:
            point = [round(coord[0], 6), round(coord[1], 6)]
            if not path or path[-1] != point:
                path.append(point)
    return path


def route_osrm(base_url: str, profile: str, points: list) -> list:
    """[(chemin, mètres, secondes) | None] par trajet, via un serveur OSRM
    au format FOSSGIS (`/routed-<profil>/route/v1/driving/...`)."""
    coords = ';'.join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
    url = f"{base_url.rstrip('/')}/routed-{_OSRM_PROFILES[profile]}/route/v1/driving/{coords}"
    try:
        response = requests.get(url, params={'overview': 'false', 'steps': 'true', 'geometries': 'geojson'},
                                headers={'User-Agent': USER_AGENT}, timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        raise RoutingError('unavailable', str(exc))
    if response.status_code == 429:
        raise RoutingError('quota')
    try:
        body = response.json()
    except ValueError:
        raise RoutingError('unavailable', f'HTTP {response.status_code}')
    code = body.get('code')
    if code in ('NoRoute', 'NoSegment'):
        return [None] * (len(points) - 1)
    if response.status_code != 200 or code != 'Ok' or not body.get('routes'):
        raise RoutingError('unavailable', f"HTTP {response.status_code} {code or ''}".strip())
    legs = body['routes'][0].get('legs') or []
    if len(legs) != len(points) - 1:
        raise RoutingError('unavailable', 'legs')
    out = []
    for leg in legs:
        path = _join_steps(leg.get('steps') or [])
        out.append((path, float(leg.get('distance') or 0), float(leg.get('duration') or 0)) if len(path) >= 2 else None)
    return out


def route_ors(base_url: str, key: str, profile: str, points: list) -> list:
    """Même contrat que route_osrm, via openrouteservice (v2, GeoJSON)."""
    if not key:
        raise RoutingError('key')
    url = f"{base_url.rstrip('/')}/v2/directions/{_ORS_PROFILES[profile]}/geojson"
    try:
        response = requests.post(url, json={'coordinates': [list(p) for p in points]},
                                 headers={'Authorization': key, 'User-Agent': USER_AGENT},
                                 timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        raise RoutingError('unavailable', str(exc))
    if response.status_code in (401, 403):
        raise RoutingError('key')
    if response.status_code == 429:
        raise RoutingError('quota')
    try:
        body = response.json()
    except ValueError:
        raise RoutingError('unavailable', f'HTTP {response.status_code}')
    if response.status_code != 200:
        # 2009 : pas d'itinéraire ; 2010 : point inaccessible par la route.
        if (body.get('error') or {}).get('code') in (2009, 2010):
            return [None] * (len(points) - 1)
        raise RoutingError('unavailable', f'HTTP {response.status_code}')
    features = body.get('features') or []
    if not features:
        raise RoutingError('unavailable', 'features')
    coords = (features[0].get('geometry') or {}).get('coordinates') or []
    props = features[0].get('properties') or {}
    way_points = props.get('way_points') or []
    segments = props.get('segments') or []
    if len(way_points) != len(points) or len(segments) != len(points) - 1:
        raise RoutingError('unavailable', 'segments')
    out = []
    for i, segment in enumerate(segments):
        path = [[round(c[0], 6), round(c[1], 6)] for c in coords[way_points[i]:way_points[i + 1] + 1]]
        out.append((path, float(segment.get('distance') or 0), float(segment.get('duration') or 0))
                   if len(path) >= 2 else None)
    return out


# --- Cache et découpage -------------------------------------------------------------

def _cached(session, provider, profile, keys) -> dict:
    rows = session.query(RouteLegCache).filter(
        RouteLegCache.provider == provider, RouteLegCache.profile == profile,
        RouteLegCache.leg_key.in_(set(keys))).all() if keys else []
    return {row.leg_key: row for row in rows}


def _leg_dict(row: RouteLegCache, cached: bool) -> dict | None:
    if row.geometry is None:
        return {'path': None, 'cached': cached}
    return {'path': json.loads(row.geometry), 'distanceM': row.distance_m, 'durationS': row.duration_s,
            'cached': cached}


def route_legs(session, config: dict, profile: str, waypoints: list, force: bool = False) -> dict:
    """Itinéraire de chaque trajet entre `waypoints` consécutifs, pour le
    profil `profile`. Retourne {legs, provider, requested, error} : legs[i]
    vaut {path, distanceM, durationS, cached} (path null : pas de route,
    ligne droite) ou None (non calculé : fournisseur en échec, `error`)."""
    provider = config.get('provider') if config.get('provider') in PROVIDERS else PROVIDER_FOSSGIS
    if profile not in PROFILES:
        raise RoutingError('invalid')
    if not isinstance(waypoints, list) or not 2 <= len(waypoints) <= MAX_REQUEST_WAYPOINTS:
        raise RoutingError('invalid')
    try:
        points = [_point(p) for p in waypoints]
    except (TypeError, ValueError, IndexError):
        raise RoutingError('invalid')
    keys = [leg_key(points[i], points[i + 1]) for i in range(len(points) - 1)]
    rows = {} if force else _cached(session, provider, profile, keys)
    legs = [_leg_dict(rows[k], True) if k in rows else None for k in keys]
    missing = [i for i, leg in enumerate(legs) if leg is None]
    requested = 0
    error = None
    # Suites de trajets manquants, découpées en requêtes de MAX_WAYPOINTS
    # points au plus (le dernier point d'une requête ouvre la suivante).
    runs = []
    for i in missing:
        if runs and runs[-1][-1] == i - 1 and len(runs[-1]) < MAX_WAYPOINTS - 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    for run in runs:
        chunk = points[run[0]:run[-1] + 2]
        _throttle(provider)
        try:
            if provider == PROVIDER_ORS:
                results = route_ors(config.get('ors_url') or ORS_DEFAULT_URL, config.get('ors_key') or '', profile, chunk)
            else:
                results = route_osrm(config.get('fossgis_url') or FOSSGIS_DEFAULT_URL, profile, chunk)
        except RoutingError as exc:
            error = exc.code
            break
        requested += 1
        now = datetime.now()
        for offset, result in enumerate(results):
            i = run[0] + offset
            row = session.query(RouteLegCache).filter_by(provider=provider, profile=profile, leg_key=keys[i]).one_or_none()
            if row is None:
                row = RouteLegCache(provider=provider, profile=profile, leg_key=keys[i])
                session.add(row)
            row.geometry = json.dumps(result[0], separators=(',', ':')) if result else None
            row.distance_m = result[1] if result else None
            row.duration_s = result[2] if result else None
            row.fetched_at = now
            legs[i] = _leg_dict(row, False)
        session.commit()
    return {'legs': legs, 'provider': provider, 'requested': requested, 'error': error}
