"""Page « Statistiques » (/stats, blueprints/statistics.py) et en-tête partagé.

Plan : MyGCFlow_Plan_Statistiques.md. Les ressources hors ligne (ECharts
vendoré) sont couvertes par test_offline_assets.py, qui parcourt tous les
gabarits.
"""

import json
import os
import tempfile
import threading
import time
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
            self.assertEqual(again.headers["ETag"], etag)

    def test_known_finds_version_is_not_rebuilt(self):
        features = [_feature(date_find="2024-03-01")]
        with mock.patch("blueprints.statistics._base_features", return_value=(features, 123.0)):
            etag = self.client.get("/api/stats/finds").headers["ETag"]
            with mock.patch("blueprints.statistics.stats_finds.build_finds_payload") as build:
                again = self.client.get("/api/stats/finds", headers={"If-None-Match": etag})
                self.assertEqual(again.status_code, 304)
                build.assert_not_called()
        # Base modifiée : nouvelle version, colonnes reconstruites.
        with mock.patch("blueprints.statistics._base_features", return_value=(features, 456.0)):
            changed = self.client.get("/api/stats/finds", headers={"If-None-Match": etag})
            self.assertEqual(changed.status_code, 200)
            self.assertNotEqual(changed.headers["ETag"], etag)

    def test_new_zone_rules_refresh_the_finds_in_the_browser(self):
        # Même base, données ou règles de zones changées (mise à jour de
        # l'app) : les colonnes zone_* changent, le navigateur doit les
        # recevoir — un 304 gardait les locationless aux États-Unis.
        features = [_feature(date_find="2024-03-01")]
        with mock.patch("blueprints.statistics._base_features", return_value=(features, 123.0)):
            etag = self.client.get("/api/stats/finds").headers["ETag"]
            with mock.patch("blueprints.statistics.zones.data_signature", return_value="autre"):
                changed = self.client.get("/api/stats/finds", headers={"If-None-Match": etag})
            self.assertEqual(changed.status_code, 200)
            self.assertNotEqual(changed.headers["ETag"], etag)

    # ----- Sources dédiées (DNF et caches posées, hors règles de la carte) -----

    def test_dnf_route_returns_the_builder_payload(self):
        payload = {"features": [{"type": "Feature", "geometry": None,
                                 "properties": {"gc_code": "GC1ABCD"}}], "logs": 3}
        with mock.patch("blueprints.statistics.dnf_geojson.build_dnf_stats",
                        return_value=payload) as builder:
            response = self.client.get("/api/stats/dnf")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), payload)
            builder.assert_called_once()

    def test_owned_route_returns_the_builder_payload(self):
        payload = {"features": [{"type": "Feature", "geometry": None,
                                 "properties": {"gc_code": "GCP0001"}}],
                   "ownedTotal": 1, "undatable": 0, "revision": 2}
        with mock.patch("blueprints.statistics.owner_geojson.build_owner_stats",
                        return_value=payload) as builder:
            response = self.client.get("/api/stats/owned")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), payload)
            builder.assert_called_once()

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
        body = self.client.get("/api/dashboards").get_json()
        self.assertIsNone(body["document"])
        # …mais signalé corrompu, pas confondu avec une première visite.
        self.assertTrue(body["corrupt"])

    # ----- Révision, conflit entre onglets, restauration -----

    def _doc(self, ident="d1"):
        return {"v": 1, "active": ident,
                "dashboards": [{"id": ident, "name": "T", "items": []}]}

    def _status(self):
        return self.client.get("/api/dashboards").get_json()

    def test_get_reports_rev_and_flags(self):
        body = self._status()
        self.assertIsNone(body["document"])
        self.assertIsNone(body["rev"])
        self.assertFalse(body["corrupt"])
        self.assertFalse(body["backup_available"])
        rev = self.client.put("/api/dashboards", json=self._doc()).get_json()["rev"]
        self.assertTrue(rev)
        body = self._status()
        self.assertEqual(body["rev"], rev)
        self.assertFalse(body["corrupt"])

    def test_put_with_matching_rev_returns_the_new_rev(self):
        first = self.client.put("/api/dashboards", json=self._doc()).get_json()["rev"]
        response = self.client.put("/api/dashboards", json=self._doc("d2"),
                                   headers={"X-Dashboard-Rev": first})
        self.assertEqual(response.status_code, 200)
        second = response.get_json()["rev"]
        self.assertTrue(second)
        self.assertNotEqual(second, first)

    def test_put_with_a_stale_rev_is_refused(self):
        first = self.client.put("/api/dashboards", json=self._doc()).get_json()["rev"]
        # Un autre onglet écrit entre-temps.
        self.client.put("/api/dashboards", json=self._doc("d2"))
        response = self.client.put("/api/dashboards", json=self._doc("d3"),
                                   headers={"X-Dashboard-Rev": first})
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual(body["error"], "conflict")
        self.assertEqual(body["rev"], self._status()["rev"])
        # Le fichier garde la version de l'autre onglet.
        self.assertEqual(self._status()["document"]["dashboards"][0]["id"], "d2")

    def test_put_after_a_delete_conflicts_with_none(self):
        rev = self.client.put("/api/dashboards", json=self._doc()).get_json()["rev"]
        self.client.delete("/api/dashboards")
        response = self.client.put("/api/dashboards", json=self._doc(),
                                   headers={"X-Dashboard-Rev": rev})
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(response.get_json()["rev"])
        # 'none' = « le fichier était absent » : l'écriture repart.
        response = self.client.put("/api/dashboards", json=self._doc(),
                                   headers={"X-Dashboard-Rev": "none"})
        self.assertEqual(response.status_code, 200)

    def test_corrupt_file_is_flagged_with_backup(self):
        self.client.put("/api/dashboards", json=self._doc("d1"))
        self.client.put("/api/dashboards", json=self._doc("d2"))  # .bak = d1
        path = dashboards_store.dashboards_path()
        path.write_bytes(b"{corrompu")
        body = self._status()
        self.assertIsNone(body["document"])
        self.assertTrue(body["corrupt"])
        self.assertTrue(body["backup_available"])

    def test_overwriting_a_corrupt_file_keeps_the_proof(self):
        self.client.put("/api/dashboards", json=self._doc("d1"))
        path = dashboards_store.dashboards_path()
        path.write_bytes(b"{corrompu")
        response = self.client.put("/api/dashboards", json=self._doc())
        self.assertEqual(response.status_code, 200)
        corrupt = path.with_name(path.name + ".corrupt")
        self.assertTrue(corrupt.exists())
        self.assertEqual(corrupt.read_bytes(), b"{corrompu")

    def test_restore_brings_back_the_backup(self):
        self.client.put("/api/dashboards", json=self._doc("d1"))
        self.client.put("/api/dashboards", json=self._doc("d2"))  # .bak = d1
        path = dashboards_store.dashboards_path()
        path.write_bytes(b"{corrompu")
        response = self.client.post("/api/dashboards/restore")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["success"])
        self.assertEqual(body["document"]["dashboards"][0]["id"], "d1")
        self.assertEqual(body["rev"], self._status()["rev"])
        # Le corrompu est conservé sous .corrupt, la .bak reste intacte.
        self.assertEqual(path.with_name(path.name + ".corrupt").read_bytes(), b"{corrompu")
        self.assertTrue(self._status()["backup_available"])

    # ----- Écritures simultanées -----

    def test_simultaneous_puts_with_the_same_rev_cannot_both_win(self):
        rev = self.client.put("/api/dashboards", json=self._doc()).get_json()["rev"]
        real_write = dashboards_store.atomic_write

        def slow_write(*args, **kwargs):
            time.sleep(0.05)  # élargit la fenêtre entre contrôle et écriture
            return real_write(*args, **kwargs)

        outcomes = []

        def save(ident):
            try:
                dashboards_store.save_document(self._doc(ident), expected_rev=rev)
                outcomes.append("ok")
            except dashboards_store.RevisionConflict:
                outcomes.append("conflict")

        with mock.patch("dashboards_store.atomic_write", side_effect=slow_write):
            threads = [threading.Thread(target=save, args=(ident,)) for ident in ("a", "b")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(sorted(outcomes), ["conflict", "ok"])

    # ----- Sauvegarde d'un seul tableau (secours à la fermeture) -----

    def _two_dashboards(self):
        return {"v": 1, "active": "d1", "dashboards": [
            {"id": "d1", "name": "Un", "items": []},
            {"id": "d2", "name": "Deux", "items": []},
        ]}

    def test_put_one_dashboard_replaces_it_and_keeps_the_others(self):
        rev = self.client.put("/api/dashboards", json=self._two_dashboards()).get_json()["rev"]
        changed = {"id": "d2", "name": "Deux bis", "items": [{"size": "M", "spec": {"v": 1}}]}
        response = self.client.put("/api/dashboards/d2", json={"dashboard": changed, "active": "d2"},
                                   headers={"X-Dashboard-Rev": rev})
        self.assertEqual(response.status_code, 200)
        body = self._status()
        self.assertEqual(response.get_json()["rev"], body["rev"])
        self.assertEqual(body["document"]["active"], "d2")
        self.assertEqual([d["name"] for d in body["document"]["dashboards"]], ["Un", "Deux bis"])
        self.assertEqual(body["document"]["dashboards"][1], changed)

    def test_put_one_dashboard_checks_the_rev(self):
        rev = self.client.put("/api/dashboards", json=self._two_dashboards()).get_json()["rev"]
        self.client.put("/api/dashboards", json=self._two_dashboards() | {"active": "d2"})
        response = self.client.put("/api/dashboards/d1", json={"dashboard": {"id": "d1", "items": []}},
                                   headers={"X-Dashboard-Rev": rev})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["rev"], self._status()["rev"])

    def test_put_one_dashboard_refusals(self):
        response = self.client.put("/api/dashboards/d1", json={"dashboard": {"id": "d1", "items": []}})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "no-document")
        self.client.put("/api/dashboards", json=self._two_dashboards())
        unknown = self.client.put("/api/dashboards/d9", json={"dashboard": {"id": "d9", "items": []}})
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.get_json()["error"], "unknown-dashboard")
        mismatch = self.client.put("/api/dashboards/d1", json={"dashboard": {"id": "d2", "items": []}})
        self.assertEqual(mismatch.status_code, 400)
        too_many = {"id": "d1", "items": [{}] * (dashboards_store.MAX_ITEMS + 1)}
        self.assertEqual(self.client.put("/api/dashboards/d1", json={"dashboard": too_many}).status_code, 400)
        # Rien n'a bougé.
        self.assertEqual(self._status()["document"], self._two_dashboards())

    def test_restore_without_a_backup_is_404(self):
        path = dashboards_store.dashboards_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"{corrompu")
        response = self.client.post("/api/dashboards/restore")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "no-backup")


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

    def test_zone_columns(self):
        calls = []

        class Index:
            def assign(self, **kw):
                calls.append(kw)
                if kw["country"] == "France":
                    return ("FR", "FR-BRE", "FR-29", ("name", "name", "position"))
                return (None, None, None, (None, None, None))

        features = [
            _feature(country="France", state="Bretagne"),
            {"type": "Feature", "geometry": None, "properties": {"source_kind": "lab", "country": "Mars"}},
            _feature(country="France", state="Bretagne"),
        ]
        payload = stats_finds.build_finds_payload(features, Index())
        self.assertEqual(calls[0], {"country": "France", "state": "Bretagne", "lat": 48.8, "lon": 2.3})
        self.assertEqual(calls[1]["lat"], None)
        self.assertEqual(payload["dicts"]["zone_country"], ["FR"])
        self.assertEqual(payload["zone_country"], [0, -1, 0])
        self.assertEqual(payload["zone_region"], [0, -1, 0])
        self.assertEqual(payload["dicts"]["zone_subregion"], ["FR-29"])

    def test_locationless_finds_have_no_zone(self):
        class Index:
            def assign(self, **kw):
                raise AssertionError("une locationless ne se rattache pas")

        payload = stats_finds.build_finds_payload(
            [_feature(country="United States", state="Washington", cache_type="Locationless (Reverse) Cache")], Index())
        self.assertEqual(payload["zone_country"], [-1])

    def test_unreadable_zone_data_leaves_the_page_working(self):
        class Broken:
            def __init__(self):
                self.calls = 0

            def assign(self, **kw):
                self.calls += 1
                raise ValueError("fichier corrompu")

        broken = Broken()
        with self.assertLogs("stats_finds", level="ERROR"):
            payload = stats_finds.build_finds_payload([_feature(country="France")] * 3, broken)
        self.assertEqual(broken.calls, 1)          # pas une trace par trouvaille
        self.assertEqual(payload["zone_country"], [-1, -1, -1])
        self.assertEqual(payload["count"], 3)


if __name__ == "__main__":
    unittest.main()
