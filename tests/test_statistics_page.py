"""Page « Statistiques » (/stats, blueprints/statistics.py) et en-tête partagé.

Plan : MyGCFlow_Plan_Statistiques.md. Les ressources hors ligne (ECharts
vendoré) sont couvertes par test_offline_assets.py, qui parcourt tous les
gabarits.
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import dashboards_store
import stats_finds
from app import create_app
from extensions import db


class StatisticsPageTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        # Configuration isolée : dashboards.json est écrit dans ce dossier.
        patcher = mock.patch.dict(os.environ, {"MYGCFLOW_CONFIG_DIR": self.tmpdir.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def test_page_is_served_without_the_map(self):
        response = self.client.get("/stats")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-page="stats"', html)
        self.assertIn('static/vendor/echarts/echarts.min.js', html)
        self.assertIn('static/vendor/echarts/langFR.js', html)
        self.assertIn('static/js/stats_page.js', html)
        # Ni carte ni graphe de la page carte.
        self.assertNotIn('vendor/ol/ol.js', html)
        self.assertNotIn('static/js/index.js', html)

    def test_stats_link_is_active_on_its_page_only(self):
        stats = self.client.get("/stats").get_data(as_text=True)
        self.assertIn('id="linkStatsMode" class="app-mode-link active"', stats)
        self.assertIn('id="linkMainMode" class="app-mode-link "', stats)

        for path in ("/", "/evolution", "/poses"):
            html = self.client.get(path).get_data(as_text=True)
            self.assertIn('id="linkStatsMode"', html, path)
            self.assertIn('id="linkStatsMode" class="app-mode-link "', html, path)

    def test_header_keeps_theme_selector_on_every_page(self):
        for path in ("/", "/stats"):
            html = self.client.get(path).get_data(as_text=True)
            self.assertIn('id="appHeaderTheme"', html, path)

    def test_quit_button_follows_the_launcher(self):
        self.assertNotIn('id="buttonQuitAppHeader"', self.client.get("/stats").get_data(as_text=True))
        self.app.config['QUIT_HOOK'] = lambda: None
        self.assertIn('id="buttonQuitAppHeader"', self.client.get("/stats").get_data(as_text=True))

    # ----- Données des trouvailles -----

    def test_finds_route_serves_columns_with_an_etag(self):
        features = [_feature(date_find="2024-03-01", cache_type="Traditional Cache")]
        with mock.patch("blueprints.statistics._base_features", return_value=(features, 123.0)):
            response = self.client.get("/api/stats/finds")
            self.assertEqual(response.status_code, 200)
            body = response.get_json()
            self.assertEqual(body["count"], 1)
            self.assertEqual(body["dicts"]["cache_type"], ["Traditional Cache"])
            etag = response.headers["ETag"]
            again = self.client.get("/api/stats/finds", headers={"If-None-Match": etag})
            self.assertEqual(again.status_code, 304)

    # ----- Tableaux de bord -----

    def test_dashboards_start_empty_then_round_trip(self):
        self.assertIsNone(self.client.get("/api/dashboards").get_json()["document"])
        doc = {"v": 1, "active": "d1", "dashboards": [
            {"id": "d1", "name": "Mon tableau", "items": [{"size": "M", "spec": {"v": 1, "groupBy": "year"}}]},
        ]}
        response = self.client.put("/api/dashboards", json=doc)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/dashboards").get_json()["document"], doc)
        on_disk = json.loads(dashboards_store.dashboards_path().read_text(encoding="utf-8"))
        self.assertEqual(on_disk, doc)

    def test_dashboards_reject_bad_shapes(self):
        cases = {
            "not-an-object": [1, 2],
            "unknown-version": {"v": 2, "dashboards": []},
            "bad-dashboards": {"v": 1, "dashboards": "x"},
            "bad-dashboard": {"v": 1, "dashboards": [{"name": "sans id", "items": []}]},
            "bad-items": {"v": 1, "dashboards": [{"id": "d", "items": [{}] * (dashboards_store.MAX_ITEMS + 1)}]},
            "bad-item": {"v": 1, "dashboards": [{"id": "d", "items": ["x"]}]},
            "bad-active": {"v": 1, "dashboards": [], "active": 3},
        }
        for code, doc in cases.items():
            response = self.client.put("/api/dashboards", json=doc)
            self.assertEqual(response.status_code, 400, code)
            self.assertEqual(response.get_json()["error"], code)
        self.assertFalse(dashboards_store.dashboards_path().exists())

    def test_dashboards_reject_a_too_large_document(self):
        big = {"v": 1, "dashboards": [{"id": "d", "name": "x" * (dashboards_store.MAX_BYTES + 10), "items": []}]}
        response = self.client.put("/api/dashboards", json=big)
        self.assertEqual(response.status_code, 413)

    def test_delete_removes_the_file(self):
        self.client.put("/api/dashboards", json={"v": 1, "dashboards": []})
        self.assertTrue(dashboards_store.dashboards_path().exists())
        self.assertEqual(self.client.delete("/api/dashboards").status_code, 200)
        self.assertFalse(dashboards_store.dashboards_path().exists())
        self.assertEqual(self.client.delete("/api/dashboards").status_code, 200)

    def test_unreadable_file_reads_as_absent(self):
        path = dashboards_store.dashboards_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{pas du json", encoding="utf-8")
        self.assertIsNone(self.client.get("/api/dashboards").get_json()["document"])


def _feature(**props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [2.3, 48.8]},
            "properties": {"source_kind": "geocache", **props}}


class FindsPayloadTests(unittest.TestCase):
    def test_columns_and_dictionaries(self):
        features = [
            _feature(date_find="2024-03-01", published_date="2020-01-02", cache_type="Traditional Cache",
                     gc_code="GC1", difficulty=1.5, terrain=2, container="Small", country="France",
                     state="Bretagne", owner="Alice",
                     attributes=[{"id": 6, "name": "Recommended for kids", "inc": 1},
                                 {"id": 40, "name": "Stealth required", "inc": 0},
                                 {"id": 6, "name": "Recommended for kids", "inc": 1}]),
            _feature(date_find=None, cache_type="Traditional Cache", gc_code="GC2", difficulty=None,
                     terrain="bad", container="", country="France", owner=None,
                     attributes=[{"id": None, "name": "Sans id", "inc": "1"}]),
            {"type": "Feature", "geometry": None, "properties": {
                "source_kind": "lab", "record_uid": "lab-1", "cache_type": "Adventure Lab",
                "date_find": "2024-05-05", "difficulty": None, "attributes": None, "country": "Belgique"}},
        ]
        payload = stats_finds.build_finds_payload(features)
        self.assertEqual(payload["v"], stats_finds.PAYLOAD_VERSION)
        self.assertEqual(payload["count"], 3)
        self.assertEqual(payload["date"], ["2024-03-01", None, "2024-05-05"])
        self.assertEqual(payload["published"], ["2020-01-02", None, None])
        self.assertEqual(payload["kind"], [0, 0, 1])
        self.assertEqual(payload["code"], ["GC1", "GC2", "lab-1"])
        self.assertEqual(payload["difficulty"], [1.5, None, None])
        self.assertEqual(payload["terrain"], [2, None, None])
        self.assertEqual(payload["dicts"]["cache_type"], ["Traditional Cache", "Adventure Lab"])
        self.assertEqual(payload["cache_type"], [0, 0, 1])
        self.assertEqual(payload["container"], [0, -1, -1])
        self.assertEqual(payload["dicts"]["country"], ["France", "Belgique"])
        self.assertEqual(payload["country"], [0, 0, 1])
        self.assertEqual(payload["state"], [0, -1, -1])
        self.assertEqual(payload["owner"], [0, -1, -1])
        # Attribut absent (inc 0) écarté, doublon compté une fois, repli sur le nom.
        self.assertEqual(payload["dicts"]["attribute"],
                         [{"key": "6", "name": "Recommended for kids"}, {"key": "Sans id", "name": "Sans id"}])
        self.assertEqual(payload["attributes"], [[0], [1], []])

    def test_empty_base(self):
        payload = stats_finds.build_finds_payload([])
        self.assertEqual(payload["count"], 0)
        self.assertEqual(payload["date"], [])


if __name__ == "__main__":
    unittest.main()
