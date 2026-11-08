import json
import os
import tempfile
import unittest
from datetime import datetime

import dnf_geojson
import log_formats as lf
import log_store
from app import create_app
from extensions import db
from models import Geocache

from tests.test_log_formats import CONTRACT

ME = 1234567


def _doc():
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def _log(log_id, code, type_id, day, author=ME):
    return {"log_id": log_id, "gc_code": code, "type_id": type_id, "date": day,
            "author": {"id": author, "name": "x"}}


class DnfFeaturesTests(unittest.TestCase):
    """Un point par cache en DNF : apparition, résolution, position."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _commit(self, doc):
        log_store.commit_logs(db.session, lf.parse_logs_json(json.dumps(doc).encode()))

    def _features(self):
        result = dnf_geojson.build_dnf_features(db.session)
        return {f["properties"]["gc_code"]: f for f in result["features"]}, result

    def _stats(self):
        result = dnf_geojson.build_dnf_stats(db.session)
        return {f["properties"]["gc_code"]: f for f in result["features"]}, result

    def _find(self, code, day, lat=48.5, lon=2.5):
        db.session.add(Geocache(gc_code=code, latitude=lat, longitude=lon, found=True,
                                date_find=datetime.fromisoformat(day + "T20:00:00"),
                                cache_name="Trouvée", cache_type="Wherigo Cache",
                                difficulty=3.0, terrain=3.0, country="France"))
        db.session.commit()

    def test_contract_fixture(self):
        self._commit(_doc())
        features, result = self._features()
        # GC9ZZZZ : DNF non résolu, placé par sa fiche. GC2PR3N : DNF résolu
        # par un Found it, mais sans aucune position connue → en attente.
        self.assertEqual(list(features), ["GC9ZZZZ"])
        self.assertEqual(result["pending"], 1)
        props = features["GC9ZZZZ"]["properties"]
        self.assertEqual(props["source_kind"], "dnf")
        self.assertEqual((props["date_find"], props["resolved_date"]), ("2021-05-02", None))
        self.assertEqual(props["cache_type"], "Multi-cache")
        self.assertEqual(features["GC9ZZZZ"]["geometry"]["coordinates"], [7.0, 48.0])

    def test_my_finds_places_and_resolves(self):
        self._commit(_doc())
        self._find("GC2PR3N", "2012-01-08")
        features, result = self._features()
        props = features["GC2PR3N"]["properties"]
        self.assertEqual((props["date_find"], props["resolved_date"]), ("2011-08-20", "2012-01-08"))
        self.assertEqual(props["dnf_dates"], ["2011-08-20"])
        self.assertEqual(props["name"], "Trouvée")            # repli sur le My Finds
        self.assertEqual(features["GC2PR3N"]["geometry"]["coordinates"], [2.5, 48.5])
        self.assertEqual(result["pending"], 0)

    def test_several_dnf_and_later_ones_ignored(self):
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [
            _log(1, "GC1ABCD", 3, "2016-01-01"), _log(2, "GC1ABCD", 3, "2016-02-01"),
            _log(3, "GC1ABCD", 2, "2016-03-01"), _log(4, "GC1ABCD", 3, "2017-01-01"),
        ]
        self._commit(doc)
        props = self._features()[0]["GC1ABCD"]["properties"]
        self.assertEqual(props["dnf_dates"], ["2016-01-01", "2016-02-01"])
        self.assertEqual(props["resolved_date"], "2016-03-01")

    def test_found_before_any_dnf_has_no_point(self):
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [_log(1, "GC1ABCD", 3, "2016-01-01")]
        self._commit(doc)
        self._find("GC1ABCD", "2015-06-01")
        self.assertEqual(self._features()[0], {})

    def test_other_players_dnf_are_not_mine(self):
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [_log(1, "GC1ABCD", 3, "2016-01-01", author=42)]
        self._commit(doc)
        self.assertEqual(self._features()[0], {})

    def test_without_logs(self):
        result = dnf_geojson.build_dnf_features(db.session)
        self.assertEqual((result["features"], result["pending"]), ([], 0))

    # ----- Source dédiée de la page Statistiques (/api/stats/dnf) -----

    def test_stats_count_a_dnf_on_a_cache_found_before(self):
        # Même scénario que test_found_before_any_dnf_has_no_point : la carte
        # écarte le point, les statistiques comptent le DNF réel.
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [_log(1, "GC1ABCD", 3, "2016-01-01")]
        self._commit(doc)
        self._find("GC1ABCD", "2015-06-01")
        features, result = self._stats()
        self.assertEqual(list(features), ["GC1ABCD"])
        props = features["GC1ABCD"]["properties"]
        self.assertIsNone(features["GC1ABCD"]["geometry"])
        self.assertEqual(props["dnf_dates"], ["2016-01-01"])
        self.assertEqual(props["date_find"], "2016-01-01")
        self.assertEqual(result["logs"], 1)

    def test_stats_keep_every_dnf_even_after_the_find(self):
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [
            _log(1, "GC1ABCD", 3, "2016-01-01"), _log(2, "GC1ABCD", 3, "2016-02-01"),
            _log(3, "GC1ABCD", 2, "2016-03-01"), _log(4, "GC1ABCD", 3, "2017-01-01"),
        ]
        self._commit(doc)
        features, result = self._stats()
        props = features["GC1ABCD"]["properties"]
        # Le DNF postérieur à la résolution compte (dnf_dates complet).
        self.assertEqual(props["dnf_dates"], ["2016-01-01", "2016-02-01", "2017-01-01"])
        self.assertNotIn("resolved_date", props)
        self.assertEqual(result["logs"], 3)

    def test_stats_serve_caches_without_a_position(self):
        self._commit(_doc())
        features, result = self._stats()
        # GC2PR3N : « pending » sur la carte (aucune position), servie ici
        # avec une géométrie nulle comme les autres.
        self.assertEqual(sorted(features), ["GC2PR3N", "GC9ZZZZ"])
        for feature in features.values():
            self.assertIsNone(feature["geometry"])
        self.assertIsNone(features["GC2PR3N"]["properties"]["published_date"])
        self.assertEqual(result["logs"], 2)

    def test_stats_ignore_other_players_and_the_empty_collection(self):
        self.assertEqual(dnf_geojson.build_dnf_stats(db.session),
                         {"features": [], "logs": 0})
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = [_log(1, "GC1ABCD", 3, "2016-01-01", author=42)]
        self._commit(doc)
        features, result = self._stats()
        self.assertEqual(features, {})
        self.assertEqual(result["logs"], 0)

    def test_route(self):
        self._commit(_doc())
        body = self.app.test_client().get("/api/logs/dnf_features").get_json()
        self.assertTrue(body["success"])
        self.assertEqual([f["properties"]["gc_code"] for f in body["features"]], ["GC9ZZZZ"])

    def test_preferences(self):
        # Préférences dans un dossier temporaire : sans cela, le test écrivait
        # dans la configuration réelle (dnf_display=True y restait et le test
        # échouait au lancement suivant).
        from pathlib import Path
        from unittest import mock
        import settings_manager
        from blueprints import profiles as profiles_bp_module
        cfg = Path(self.tmpdir.name) / "cfg"
        for name, value in {"CONFIG_DIR": cfg, "PROFILES_DIR": cfg / "profiles",
                            "SETTINGS_PATH": cfg / "settings.json"}.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True, "examples_version": settings_manager.EXAMPLES_VERSION})
        patcher = mock.patch.object(profiles_bp_module, "settings_manager", settings_manager.SettingsManager())
        patcher.start()
        self.addCleanup(patcher.stop)

        client = self.app.test_client()
        defaults = client.get("/api/settings").get_json()
        self.assertEqual((defaults["dnf_display"], defaults["dnf_in_trail"]), (False, True))
        client.put("/api/settings", json={"dnf_display": True, "dnf_in_trail": False})
        saved = client.get("/api/settings").get_json()
        self.assertEqual((saved["dnf_display"], saved["dnf_in_trail"]), (True, False))
        # Une valeur non booléenne ne change rien (même règle que les Labs).
        client.put("/api/settings", json={"dnf_display": "non"})
        self.assertIs(client.get("/api/settings").get_json()["dnf_display"], True)


if __name__ == "__main__":
    unittest.main()
