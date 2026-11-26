"""Itinéraires des parcours (parcours_routing.py, POST /api/parcours/routes).

Aucun appel réseau : `requests.get` / `requests.post` sont remplacés par des
réponses simulées au format OSRM (FOSSGIS) et openrouteservice."""

import os
import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest import mock

import requests

import parcours_routing as pr
from app import create_app
from extensions import db
from models import RouteLegCache

HOST = "http://127.0.0.1:51730"
A, B, C = [6.10, 45.90], [6.12, 45.91], [6.14, 45.90]


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def osrm_ok(points):
    legs = []
    for a, b in zip(points, points[1:]):
        mid = [(a[0] + b[0]) / 2, a[1] + 0.01]
        legs.append({'distance': 1500.0, 'duration': 600.0, 'steps': [
            {'geometry': {'coordinates': [a, mid]}}, {'geometry': {'coordinates': [mid, b]}}]})
    return {'code': 'Ok', 'routes': [{'legs': legs}]}


def ors_ok(points):
    coords, way_points = [], []
    for i, p in enumerate(points):
        if i:
            coords.append([(points[i - 1][0] + p[0]) / 2, p[1] + 0.01])
        way_points.append(len(coords))
        coords.append(p)
    return {'features': [{'geometry': {'coordinates': coords}, 'properties': {
        'way_points': way_points,
        'segments': [{'distance': 2000.0, 'duration': 300.0} for _ in points[1:]]}}]}


def points_of_osrm_url(url):
    raw = url.split('/driving/')[1]
    return [[float(v) for v in pair.split(',')] for pair in raw.split(';')]


class _Db(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        patcher = mock.patch.dict(pr.MIN_INTERVAL_S, {'fossgis': 0, 'ors': 0})
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.dict(pr.RETRY_DELAY_S, {'fossgis': 0, 'ors': 0})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()


class ProviderTests(unittest.TestCase):
    def test_osrm_splits_steps_by_leg(self):
        with mock.patch('requests.get', return_value=FakeResponse(200, osrm_ok([A, B, C]))) as get:
            legs = pr.route_osrm('https://routing.example', 'foot', [tuple(A), tuple(B), tuple(C)])
        url = get.call_args.args[0]
        self.assertTrue(url.startswith('https://routing.example/routed-foot/route/v1/driving/6.100000,45.900000;'))
        self.assertIn('MyGCFlow/', get.call_args.kwargs['headers']['User-Agent'])
        self.assertEqual(len(legs), 2)
        path, meters, seconds = legs[0]
        self.assertEqual((path[0], path[-1], len(path)), (A, B, 3))   # jonction des étapes dédoublonnée
        self.assertEqual((meters, seconds), (1500.0, 600.0))

    def test_osrm_failures(self):
        with mock.patch('requests.get', return_value=FakeResponse(200, {'code': 'NoRoute'})):
            self.assertEqual(pr.route_osrm('u', 'car', [A, B, C]), [None, None])
        with mock.patch('requests.get', return_value=FakeResponse(429, {})):
            with self.assertRaises(pr.RoutingError) as ctx:
                pr.route_osrm('u', 'car', [A, B])
            self.assertEqual(ctx.exception.code, 'quota')
        with mock.patch('requests.get', side_effect=requests.ConnectionError('hors ligne')):
            with self.assertRaises(pr.RoutingError) as ctx:
                pr.route_osrm('u', 'car', [A, B])
            self.assertEqual(ctx.exception.code, 'unavailable')

    def test_ors_splits_by_way_points(self):
        with mock.patch('requests.post', return_value=FakeResponse(200, ors_ok([A, B, C]))) as post:
            legs = pr.route_ors('https://ors.example', 'clé', 'bike', [A, B, C])
        self.assertEqual(post.call_args.args[0], 'https://ors.example/v2/directions/cycling-regular/geojson')
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'clé')
        self.assertEqual([leg[0][0] for leg in legs], [A, B])
        self.assertEqual([leg[0][-1] for leg in legs], [B, C])
        self.assertEqual(legs[1][1:], (2000.0, 300.0))

    def test_ors_failures(self):
        with self.assertRaises(pr.RoutingError) as ctx:
            pr.route_ors('u', '', 'car', [A, B])
        self.assertEqual(ctx.exception.code, 'key')
        with mock.patch('requests.post', return_value=FakeResponse(403, {})):
            with self.assertRaises(pr.RoutingError) as ctx:
                pr.route_ors('u', 'k', 'car', [A, B])
            self.assertEqual(ctx.exception.code, 'key')
        with mock.patch('requests.post', return_value=FakeResponse(404, {'error': {'code': 2010}})):
            self.assertEqual(pr.route_ors('u', 'k', 'car', [A, B]), [None])


class CacheTests(_Db):
    CONFIG = {'provider': 'fossgis', 'fossgis_url': 'https://routing.example'}

    def fake_get(self, url, **kwargs):
        return FakeResponse(200, osrm_ok(points_of_osrm_url(url)))

    def test_cache_hit_force_and_chunks(self):
        with mock.patch('requests.get', side_effect=self.fake_get) as get:
            first = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B, C])
            self.assertEqual((first['requested'], get.call_count), (1, 1))
            self.assertEqual([leg['cached'] for leg in first['legs']], [False, False])
            again = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B, C])
            self.assertEqual((again['requested'], get.call_count), (0, 1))
            self.assertEqual([leg['cached'] for leg in again['legs']], [True, True])
            self.assertEqual(again['legs'][0]['durationS'], 600.0)
            # Autre profil : autre itinéraire.
            pr.route_legs(db.session, self.CONFIG, 'car', [A, B])
            self.assertEqual(get.call_count, 2)
            forced = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B], force=True)
            self.assertEqual(forced['requested'], 1)
            # 60 points : deux requêtes (50 points au plus chacune).
            many = [[6.0 + i * 0.001, 45.0] for i in range(60)]
            result = pr.route_legs(db.session, self.CONFIG, 'foot', many)
            self.assertEqual(result['requested'], 2)
            self.assertTrue(all(leg and leg['path'] for leg in result['legs']))
        self.assertEqual(RouteLegCache.query.filter_by(profile='foot').count(), 2 + 59)

    def test_unroutable_legs_are_cached_without_geometry(self):
        with mock.patch('requests.get', return_value=FakeResponse(200, {'code': 'NoRoute'})) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [A, B])
            self.assertEqual(result['legs'], [{'path': None, 'cached': False}])
            pr.route_legs(db.session, self.CONFIG, 'car', [A, B])
            self.assertEqual(get.call_count, 1)

    def test_noroute_is_isolated_to_the_failing_leg(self):
        """« Pas de route » sur une suite de plusieurs trajets : la requête
        est re-découpée et seul le trajet coupable est gardé sans géométrie
        (les voisins gardent leur itinéraire)."""
        d = [6.16, 45.92]

        def fake_get(url, **kwargs):
            pts = points_of_osrm_url(url)
            # Le détroit B → C n'a pas de route ; le reste est routable.
            if any(a == B and b == C for a, b in zip(pts, pts[1:])):
                return FakeResponse(200, {'code': 'NoRoute'})
            return FakeResponse(200, osrm_ok(pts))

        with mock.patch('requests.get', side_effect=fake_get) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [A, B, C, d])
            self.assertEqual([leg['path'] is not None for leg in result['legs']],
                             [True, False, True])
            self.assertEqual(result['requested'], get.call_count)
            # Requête entière, moitié fautive, puis les deux trajets isolés.
            self.assertEqual(get.call_count, 5)
            pr.route_legs(db.session, self.CONFIG, 'car', [A, B, C, d])
            self.assertEqual(get.call_count, 5)
        self.assertEqual(RouteLegCache.query.filter(
            RouteLegCache.profile == 'car', RouteLegCache.geometry.is_(None)).count(), 1)

    def test_nosegment_is_isolated_to_legs_touching_the_point(self):
        """Un point hors du réseau (NoSegment) condamne les deux trajets
        qui le touchent, pas les autres."""
        d = [6.16, 45.92]

        def fake_get(url, **kwargs):
            pts = points_of_osrm_url(url)
            if B in pts:
                return FakeResponse(200, {'code': 'NoSegment'})
            return FakeResponse(200, osrm_ok(pts))

        with mock.patch('requests.get', side_effect=fake_get) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [A, B, C, d])
            self.assertEqual([leg['path'] is not None for leg in result['legs']],
                             [False, False, True])

    def test_ors_noroute_is_isolated(self):
        """Même isolation chez openrouteservice (erreur 2009/2010)."""
        config = {'provider': 'ors', 'ors_url': 'https://ors.example', 'ors_key': 'k'}
        d = [6.16, 45.92]

        def fake_post(url, json=None, **kwargs):
            if B in json['coordinates']:
                return FakeResponse(404, {'error': {'code': 2010}})
            return FakeResponse(200, ors_ok(json['coordinates']))

        with mock.patch('requests.post', side_effect=fake_post):
            result = pr.route_legs(db.session, config, 'car', [A, B, C, d])
            self.assertEqual([leg['path'] is not None for leg in result['legs']],
                             [False, False, True])

    def test_provider_failure_leaves_legs_uncomputed(self):
        with mock.patch('requests.get', side_effect=requests.Timeout('lent')) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B])
        self.assertEqual((result['legs'], result['error']), ([None], 'unavailable'))
        self.assertEqual(get.call_count, 2)   # retentative unique sur « unavailable »
        self.assertEqual(RouteLegCache.query.count(), 0)

    def test_unavailable_is_retried_once(self):
        """Erreur réseau passagère : la retentative espacée suffit."""
        responses = [requests.ConnectionError('coupure'), FakeResponse(200, osrm_ok([A, B]))]
        with mock.patch('requests.get', side_effect=responses) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B])
        self.assertIsNone(result['error'])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(len(result['legs'][0]['path']), 3)

    def test_persistent_unavailable_fails_after_one_retry(self):
        """Panne durable : échec « unavailable » après deux tentatives,
        sans boucle."""
        with mock.patch('requests.get', side_effect=requests.ConnectionError('hors ligne')) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B])
        self.assertEqual((result['legs'], result['error']), ([None], 'unavailable'))
        self.assertEqual(get.call_count, 2)
        self.assertEqual(RouteLegCache.query.count(), 0)

    def test_quota_is_never_retried(self):
        """Quota : insister ne changerait rien — un seul appel."""
        with mock.patch('requests.get', return_value=FakeResponse(429, {})) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'foot', [A, B])
        self.assertEqual((result['legs'], result['error']), ([None], 'quota'))
        self.assertEqual(get.call_count, 1)

    def test_recent_noroute_verdict_is_kept(self):
        """Un verdict « pas de route » récent n'est pas redemandé."""
        db.session.add(RouteLegCache(
            provider='fossgis', profile='car', leg_key=pr.leg_key(A, B),
            geometry=None, fetched_at=datetime.now() - timedelta(days=5)))
        db.session.commit()
        with mock.patch('requests.get') as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [A, B])
        get.assert_not_called()
        self.assertEqual(result['legs'], [{'path': None, 'cached': True}])

    def test_stale_noroute_verdict_is_rechecked(self):
        """Un verdict « pas de route » plus vieux que NO_ROUTE_TTL_DAYS (ou
        sans fetched_at) est redemandé : la ligne est alors réécrite —
        itinéraire trouvé, ou fetched_at simplement rafraîchi."""
        stale_date = datetime.now() - timedelta(days=pr.NO_ROUTE_TTL_DAYS + 1)
        db.session.add(RouteLegCache(
            provider='fossgis', profile='car', leg_key=pr.leg_key(A, B),
            geometry=None, fetched_at=stale_date))
        db.session.commit()
        # Le fournisseur a maintenant une route : la ligne est mise à jour.
        with mock.patch('requests.get', side_effect=self.fake_get) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [A, B])
        self.assertEqual(get.call_count, 1)
        self.assertEqual(result['legs'][0]['cached'], False)
        row = RouteLegCache.query.filter_by(leg_key=pr.leg_key(A, B)).one()
        self.assertIsNotNone(row.geometry)
        self.assertGreater(row.fetched_at, stale_date)
        # Encore « pas de route » : géométrie toujours nulle, mais le
        # verdict est repoussé d'autant.
        db.session.add(RouteLegCache(
            provider='fossgis', profile='car', leg_key=pr.leg_key(B, C),
            geometry=None, fetched_at=stale_date))
        db.session.commit()
        with mock.patch('requests.get', return_value=FakeResponse(200, {'code': 'NoRoute'})) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [B, C])
        self.assertEqual(get.call_count, 1)
        self.assertEqual(result['legs'], [{'path': None, 'cached': False}])
        row = RouteLegCache.query.filter_by(leg_key=pr.leg_key(B, C)).one()
        self.assertIsNone(row.geometry)
        self.assertGreater(row.fetched_at, stale_date)
        # fetched_at NULL (vieille ligne) : vaut périmé, donc redemandé.
        d = [6.16, 45.92]
        db.session.add(RouteLegCache(
            provider='fossgis', profile='car', leg_key=pr.leg_key(C, d),
            geometry=None, fetched_at=None))
        db.session.commit()
        with mock.patch('requests.get', side_effect=self.fake_get) as get:
            result = pr.route_legs(db.session, self.CONFIG, 'car', [C, d])
        self.assertEqual(get.call_count, 1)

    def test_invalid_requests(self):
        for profile, waypoints in [('plane', [A, B]), ('foot', [A]), ('foot', [[200, 0], B]), ('foot', 'x')]:
            with self.assertRaises(pr.RoutingError):
                pr.route_legs(db.session, self.CONFIG, profile, waypoints)


class ApiTests(_Db):
    def setUp(self):
        super().setUp()
        self.client = self.app.test_client()
        self.config = {'enabled': False, 'provider': 'fossgis', 'fossgis_url': 'https://routing.example',
                       'ors_url': 'https://ors.example', 'ors_key': ''}
        manager = SimpleNamespace(get_app_settings=lambda: SimpleNamespace(parcours_routing=self.config))
        patcher = mock.patch('blueprints.parcours.get_settings_manager', return_value=manager)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, body):
        return self.client.post('/api/parcours/routes', json=body, headers={'Origin': HOST}, base_url=HOST)

    def test_disabled_then_enabled(self):
        self.assertEqual(self.post({'profile': 'foot', 'waypoints': [A, B]}).status_code, 409)
        self.config['enabled'] = True
        with mock.patch('requests.get', return_value=FakeResponse(200, osrm_ok([A, B]))):
            body = self.post({'profile': 'foot', 'waypoints': [A, B]}).get_json()
        self.assertEqual((body['provider'], body['requested'], body['error']), ('fossgis', 1, None))
        self.assertEqual(len(body['legs'][0]['path']), 3)
        self.assertEqual(self.post({'profile': 'plane', 'waypoints': [A, B]}).status_code, 400)

    def test_provider_failure_is_reported_with_a_message(self):
        self.config.update(enabled=True, provider='ors', ors_key='')
        body = self.post({'profile': 'car', 'waypoints': [A, B]}).get_json()
        self.assertEqual((body['error'], body['legs']), ('key', [None]))
        self.assertTrue(body['message'])

    def test_cache_stats_and_clear(self):
        cache = '/api/parcours/routes/cache'
        self.assertEqual(self.client.get(cache).get_json()['count'], 0)
        self.config['enabled'] = True
        with mock.patch('requests.get', side_effect=lambda url, **kw:
                        FakeResponse(200, osrm_ok(points_of_osrm_url(url)))):
            self.post({'profile': 'foot', 'waypoints': [A, B, C]})
        stats = self.client.get(cache).get_json()
        self.assertEqual((stats['count'], stats['providers']), (2, {'fossgis': 2}))
        removed = self.client.delete(cache, headers={'Origin': HOST},
                                     base_url=HOST).get_json()
        self.assertEqual(removed['removed'], 2)
        self.assertEqual(RouteLegCache.query.count(), 0)
        self.assertEqual(self.client.get(cache).get_json()['count'], 0)


class SettingsTests(unittest.TestCase):
    def test_coercion(self):
        from settings_manager import PARCOURS_ROUTING_DEFAULTS, coerce_parcours_routing
        self.assertEqual(coerce_parcours_routing(None), PARCOURS_ROUTING_DEFAULTS)
        out = coerce_parcours_routing({'enabled': True, 'provider': 'ors', 'ors_key': ' abc ',
                                       'fossgis_url': 'ftp://x'}, PARCOURS_ROUTING_DEFAULTS)
        self.assertEqual((out['enabled'], out['provider'], out['ors_key']), (True, 'ors', 'abc'))
        self.assertEqual(out['fossgis_url'], PARCOURS_ROUTING_DEFAULTS['fossgis_url'])
        # Patch partiel : la clé reste si elle n'est pas renvoyée.
        self.assertEqual(coerce_parcours_routing({'enabled': False}, out)['ors_key'], 'abc')


if __name__ == '__main__':
    unittest.main()
