"""Rapport de rattachement (zone_report.py, GET /api/zones/report), sur les
vraies données de zones (geo/match)."""

import os
import tempfile
import unittest
from unittest import mock

import evolution_store as store
import zone_report
import zones
from evolution_csv import FileReport
from tests.test_evolution_csv import HEADER, row


class BuildReportTests(unittest.TestCase):
    def setUp(self):
        if not zones.get_index().available():
            self.skipTest("données de zones absentes")

    def test_recognized_names_give_an_empty_report(self):
        r = zone_report.build_report([
            ("France", "Bretagne", "Finistère", "FR", "FR-BRE", "FR-29", 3),
            ("Réunion", None, None, "FR", "FR-974", "FR-974", 1),   # pays GC = région
        ])
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["unrecognized"], [])
        self.assertEqual(r["outside"], {"country": 0, "region": 0, "subregion": 0})
        self.assertTrue(r["signature"])

    def test_unknown_names_by_level_with_the_zones_found_by_position(self):
        r = zone_report.build_report([
            ("France", "Atlantide", None, "FR", "FR-BRE", "FR-29", 5),
            ("France", "Atlantide", None, "FR", "FR-PDL", "FR-44", 2),
            ("Narnia", None, None, "DE", "DE-BY", "DE-09162", 1),
            ("France", "Bretagne", "Nulle-part", "FR", "FR-BRE", "FR-29", 4),
        ])
        by = {(i["level"], i["name"]): i for i in r["unrecognized"]}
        self.assertEqual(set(by), {("region", "Atlantide"), ("country", "Narnia"), ("subregion", "Nulle-part")})
        atl = by[("region", "Atlantide")]
        self.assertEqual((atl["country"], atl["country_name"], atl["count"]), ("FR", "France", 7))
        self.assertEqual(atl["zones"], [["FR-BRE", 5], ["FR-PDL", 2]])
        self.assertEqual(by[("country", "Narnia")]["zones"], [["DE", 1]])
        self.assertEqual(by[("subregion", "Nulle-part")]["zones"], [["FR-29", 4]])
        # Ordre : pays, régions, sous-régions.
        self.assertEqual([i["level"] for i in r["unrecognized"]], ["country", "region", "subregion"])

    def test_region_names_are_checked_in_the_country_found_by_position(self):
        # Pays inconnu de nom, placé en France : « Bretagne » y est reconnue.
        r = zone_report.build_report([("Armorique", "Bretagne", None, "FR", "FR-BRE", "FR-29", 2)])
        self.assertEqual([(i["level"], i["name"]) for i in r["unrecognized"]], [("country", "Armorique")])

    def test_outside_counts_per_level(self):
        r = zone_report.build_report([
            (None, None, None, None, None, None, 2),                 # sans position
            ("France", "Bretagne", None, "FR", "FR-BRE", None, 3),   # mystère
            ("Belgium", None, None, "BE", None, None, 1),            # région manquante
        ])
        self.assertEqual(r["outside"], {"country": 2, "region": 1, "subregion": 3})

    def test_finds_groups(self):
        feature = lambda **p: {"properties": p}
        groups = zone_report.finds_groups([
            feature(country="France", state="Bretagne", zone_country="FR", zone_region="FR-BRE", zone_subregion="FR-29"),
            feature(country="France", state="Bretagne ", zone_country="FR", zone_region="FR-BRE", zone_subregion="FR-29"),
            feature(source_kind="lab", zone_country="FR", zone_region="FR-IDF", zone_subregion="FR-75"),
            # Locationless : pays fictif, rien à signaler.
            feature(country="United States", state="Washington", cache_type="Locationless (Reverse) Cache"),
        ])
        self.assertIn(("France", "Bretagne", None, "FR", "FR-BRE", "FR-29", 2), groups)
        self.assertEqual(len(groups), 2)


class ReportRouteTests(unittest.TestCase):
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

    def _dispose(self):
        self.db.session.remove()
        self.db.engine.dispose()
        self.ctx.pop()

    def test_finds_report(self):
        features = [{'properties': {'country': 'France', 'state': 'Atlantide', 'zone_country': 'FR',
                                    'zone_region': 'FR-BRE', 'zone_subregion': 'FR-29'}}]
        with mock.patch('blueprints.statistics._base_features', return_value=(features, 1.0)):
            data = self.client.get('/api/zones/report').get_json()
        self.assertEqual(data['source'], 'finds')
        self.assertEqual(data['total'], 1)
        self.assertEqual([i['name'] for i in data['unrecognized']], ['Atlantide'])

    def test_evolution_report(self):
        dataset = store.create_dataset(self.evo, 'Zone')
        path = os.path.join(self.tmp.name, 'export.csv')
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write('\n'.join([HEADER, row('GC1'), row('GC2', region='Atlantide', lat='48.39', lon='-4.48')]) + '\n')
        store.import_file(self.evo, dataset['id'], path, FileReport(filename='export.csv'))
        data = self.client.get(f"/api/zones/report?source=evolution&dataset={dataset['id']}").get_json()
        self.assertEqual(data['total'], 2)
        self.assertEqual(data['dataset']['name'], 'Zone')
        names = {(i['level'], i['name']) for i in data['unrecognized']}
        self.assertIn(('region', 'Atlantide'), names)
        self.assertEqual(self.client.get('/api/zones/report?source=evolution').status_code, 400)
        self.assertEqual(self.client.get('/api/zones/report?source=evolution&dataset=999').status_code, 404)
        self.assertEqual(self.client.get('/api/zones/report?source=x').status_code, 400)


if __name__ == '__main__':
    unittest.main()
