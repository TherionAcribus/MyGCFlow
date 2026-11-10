"""Part des caches trouvées par zone (zone_share.py, GET /api/stats/found_share).

Mêmes règles que zone_model.mjs › shareEventsOfTable : le scénario de
`EventsTests` est celui de tests/js/zone_share.test.mjs.
"""

import os
import tempfile
import unittest
from datetime import date
from unittest import mock

import evolution_store as store
import zone_share
from evolution_csv import FileReport
from tests.test_evolution_csv import HEADER, row


def _day(iso):
    return date.fromisoformat(iso).toordinal() - date(1970, 1, 1).toordinal()


def _row(code, sub, placed, archived=None, region=None, country='FR', lat=48.0, lon=-2.0):
    return {
        'gc_code': code, 'lat': lat, 'lon': lon, 'placed': placed,
        'archived_on': archived, 'is_archived': 1 if archived else 0,
        'zone_country': country, 'zone_region': region if region is not None else (sub and sub[:5]),
        'zone_subregion': sub,
    }


class GridTests(unittest.TestCase):
    def test_cells_match_the_browser(self):
        # Valeurs de zone_grid.mjs › cellOf (Nantes, Paris, Brest, La Réunion,
        # Houston, Munich), lat0 = 45.
        points = [(-1.5536, 47.2184), (2.35, 48.85), (-4.4861, 48.3904), (55.4504, -20.8821),
                  (-95.3698, 29.7604), (11.5755, 48.1374)]
        expected = {
            5: ["h5/45/-631/1214", "h5/45/-591/1256", "h5/45/-693/1244", "h5/45/1141/-537",
                "h5/45/-1884/765", "h5/45/-437/1238"],
            25: ["h25/45/-126/243", "h25/45/-118/251", "h25/45/-139/249", "h25/45/228/-107",
                 "h25/45/-377/153", "h25/45/-87/247"],
            100: ["h100/45/-32/61", "h100/45/-30/63", "h100/45/-35/62", "h100/45/57/-27",
                  "h100/45/-94/38", "h100/45/-22/62"],
        }
        for size, ids in expected.items():
            self.assertEqual([zone_share.grid_cell(x, y, size, 45) for x, y in points], ids)
        self.assertIsNone(zone_share.grid_cell(0, 0, 25, 45))
        self.assertIsNone(zone_share.grid_cell(None, 47, 25, 45))

    def test_reference_latitude(self):
        self.assertEqual(zone_share.grid_reference([47.2, 48.4, 43.1, 49.9, 46.0]), 45)
        self.assertEqual(zone_share.grid_reference([-20.88, 12.5, 12.5]), 15)
        self.assertEqual(zone_share.grid_reference([]), 0)
        self.assertEqual(zone_share.grid_reference([89, None]), 70)


class EventsTests(unittest.TestCase):
    ROWS = [
        _row('GCA', 'FR-29', '2020-01-01', '2020-04-10'),   # j0 → j100
        _row('GCB', 'FR-29', '2020-01-06'),                 # j5
        _row('GCC', 'FR-29', '2020-01-21'),                 # j20
        _row('GCD', 'FR-44', '2020-01-01'),
        _row('GCE', 'FR-44', '2020-01-01', '2020-02-10'),   # archivée j40
        _row('GCF', '', '2020-01-01', country='', region=''),
    ]

    def test_events_follow_the_browser_rules(self):
        d0 = _day('2020-01-01')
        found = {'GCA': d0 + 10, 'GCB': d0 + 50, 'GCD': d0 - 30, 'GCE': d0 + 60}
        p = zone_share.build_share_payload(self.ROWS, found, level='subregion')
        self.assertEqual(p['ids'], ['FR-29', 'FR-44'])
        events = {(day - d0, z): (a, b, c, d) for day, z, a, b, c, d in zip(
            p['day'], p['zone'], p['placed'], p['archived'], p['found'], p['lost'])}
        self.assertEqual(events[(0, 0)], (1, 0, 0, 0))
        # D trouvée avant sa publication : comptée dès j0 ; E archivée j40.
        self.assertEqual(events[(0, 1)], (2, 0, 1, 0))
        self.assertEqual(events[(10, 0)], (0, 0, 1, 0))
        self.assertEqual(events[(40, 1)], (0, 1, 0, 0))
        # E trouvée après son archivage : apparition et disparition le même jour.
        self.assertEqual(events[(60, 1)], (0, 0, 1, 1))
        self.assertEqual(events[(100, 0)], (0, 1, 0, 1))
        self.assertEqual(events[(0, -1)], (1, 0, 0, 0))     # hors carte
        self.assertEqual(p['day'], sorted(p['day']))
        self.assertEqual(p['counts'], {'caches': 6, 'found': 4})

    def test_subregion_level_falls_back_to_the_region_without_level_2(self):
        rows = [_row('GC1', '', '2021-05-05', region='BE-VLG', country='BE'),
                _row('GC2', '', '2021-05-05', region='FR-BRE', country='FR')]
        p = zone_share.build_share_payload(rows, {}, level='subregion', has_subregions=lambda cc: cc != 'BE')
        self.assertEqual(p['ids'], ['BE-VLG'])
        self.assertEqual(sorted(p['zone']), [-1, 0])

    def test_grid_level(self):
        rows = [_row('GC1', 'FR-44', '2021-05-05', lat=47.2184, lon=-1.5536),
                _row('GC2', 'FR-44', '2021-05-05', lat=47.2190, lon=-1.5530)]
        p = zone_share.build_share_payload(rows, {'GC1': _day('2022-01-01')}, level='grid', grid_size=25)
        self.assertEqual(p['grid'], {'size': 25, 'lat0': 45})
        self.assertEqual(p['ids'], ['h25/45/-126/243'])

    def test_found_days_keep_the_first_find(self):
        features = [
            {'properties': {'gc_code': 'GC1', 'date_find': '2024-05-01T19:00:00'}},
            {'properties': {'gc_code': 'GC1', 'date_find': '2023-01-01'}},
            {'properties': {'record_uid': 'lab-1', 'date_find': '2023-01-01'}},
            {'properties': {'gc_code': 'GC2', 'date_find': None}},
        ]
        self.assertEqual(zone_share.found_days(features), {'GC1': _day('2023-01-01')})


class RouteTests(unittest.TestCase):
    def setUp(self):
        from app import create_app
        from extensions import db
        self.db = db
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {'MYGCFLOW_CONFIG_DIR': self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.evo = os.path.join(self.tmp.name, 'evolution.db')
        self.app = create_app({
            'SQLALCHEMY_DATABASE_URI': f"sqlite:///{os.path.join(self.tmp.name, 'g.db')}",
            'EVOLUTION_DB_PATH': self.evo,
        })
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()
        self.dataset = store.create_dataset(self.evo, 'Bretagne')
        path = os.path.join(self.tmp.name, 'export.csv')
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write('\n'.join([
                HEADER,
                row('GC1', lat='48.3904', lon='-4.4861', region='Bretagne', placed='2020-01-01'),
                row('GC2', lat='48.3950', lon='-4.4900', region='Bretagne', placed='2020-02-01',
                    archived='true', archived_on='2021-01-01'),
                row('GC3', lat='47.2184', lon='-1.5536', region='Pays de la Loire', placed='2020-03-01'),
            ]) + '\n')
        store.import_file(self.evo, self.dataset['id'], path, FileReport(filename='export.csv'))
        self.features = [{'properties': {'gc_code': 'GC1', 'date_find': '2022-06-01'}}]

    def _dispose(self):
        self.db.session.remove()
        self.db.engine.dispose()
        self.ctx.pop()

    def get(self, query, **kwargs):
        with mock.patch('blueprints.statistics._base_features', return_value=(self.features, 1.0)):
            return self.client.get('/api/stats/found_share' + query, **kwargs)

    def test_serves_events_with_an_etag(self):
        response = self.get(f"?dataset={self.dataset['id']}&level=subregion")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['v'], zone_share.FORMAT_VERSION)
        self.assertEqual(sorted(data['ids']), ['FR-29', 'FR-44'])
        self.assertEqual(data['counts'], {'caches': 3, 'found': 1})
        self.assertEqual(data['dataset']['name'], 'Bretagne')
        self.assertEqual(sum(data['found']), 1)
        self.assertEqual(sum(data['archived']), 1)
        etag = response.headers['ETag']
        again = self.get(f"?dataset={self.dataset['id']}&level=subregion", headers={'If-None-Match': etag})
        self.assertEqual(again.status_code, 304)
        # Autre niveau, autre charge.
        region = self.get(f"?dataset={self.dataset['id']}&level=region").get_json()
        self.assertEqual(sorted(region['ids']), ['FR-BRE', 'FR-PDL'])
        grid = self.get(f"?dataset={self.dataset['id']}&level=grid&grid=50").get_json()
        self.assertEqual(grid['grid']['size'], 50)
        self.assertTrue(all(i.startswith('h50/') for i in grid['ids']))

    def test_new_finds_change_the_etag(self):
        first = self.get(f"?dataset={self.dataset['id']}&level=region")
        self.features = self.features + [{'properties': {'gc_code': 'GC3', 'date_find': '2023-01-01'}}]
        second = self.get(f"?dataset={self.dataset['id']}&level=region")
        self.assertNotEqual(first.headers['ETag'], second.headers['ETag'])
        self.assertEqual(second.get_json()['counts']['found'], 2)

    def test_bad_requests(self):
        self.assertEqual(self.get('?level=region').status_code, 400)
        self.assertEqual(self.get(f"?dataset={self.dataset['id']}&level=planet").status_code, 400)
        self.assertEqual(self.get('?dataset=999&level=region').status_code, 404)


if __name__ == '__main__':
    unittest.main()
