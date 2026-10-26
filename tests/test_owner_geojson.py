"""Caches posées sur la carte principale (owner_geojson.py).

Fixture fictive tests/fixtures/gc_logs/logs-poses.json (compte 1234567, voir
tests/test_poses_dataset.py) : GCP0004 désactivée / réactivée deux fois par
son poseur, dont une maintenance ; GCP0005 archivée par le poseur, puis
désarchivée et archivée par un relecteur (42) ; GCP0006 archivée d'après son
statut à l'export ; GCP0007 sans position ; GCQ0001 d'un autre poseur.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

import log_formats as lf
import log_store
import owner_geojson
import poses_dataset as pd
from app import create_app
from extensions import db

FIXTURE = Path(__file__).parent / "fixtures" / "gc_logs" / "logs-poses.json"


class OwnerFeaturesTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()
        pd.clear_memo()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _commit(self):
        doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
        log_store.commit_logs(db.session, lf.parse_logs_json(json.dumps(doc).encode()))

    def _features(self):
        result = owner_geojson.build_owner_features(db.session)
        return {f["properties"]["gc_code"]: f for f in result["features"]}, result

    def test_empty_without_logs(self):
        features, result = self._features()
        self.assertEqual(features, {})
        self.assertEqual(result["ownedTotal"], 0)

    def test_owned_caches_only_with_counts(self):
        self._commit()
        features, result = self._features()
        # 8 caches posées, dont une sans position ; la cache d'un autre poseur
        # (GCQ0001) n'en est pas.
        self.assertEqual(result["ownedTotal"], 8)
        self.assertEqual(result["pending"], 1)
        self.assertEqual(sorted(features), [f"GCP000{i}" for i in (1, 2, 3, 4, 5, 6, 8)])
        props = features["GCP0001"]["properties"]
        self.assertEqual(props["source_kind"], "owned")
        self.assertFalse(props["found"])
        # Apparition = publication, servie sous les noms des trouvailles.
        self.assertEqual((props["date_find"], props["published_date"]), ("2018-03-05", "2018-03-05"))

    def test_beta_find_advances_the_appearance(self):
        self._commit()
        features, _ = self._features()
        self.assertEqual(features["GCP0003"]["properties"]["date_find"], "2019-01-10")
        self.assertEqual(features["GCP0003"]["properties"]["appear_source"], pd.APPEAR_BETA_FIND)

    def test_only_the_owner_steps_are_events(self):
        self._commit()
        features, _ = self._features()
        # Ni trouvailles, ni notes, ni signalement (45) des autres joueurs.
        self.assertEqual(features["GCP0004"]["properties"]["owner_events"], [
            ["2019-07-01", "disable"], ["2019-07-15", "enable"], ["2019-09-01", "disable"],
            ["2019-09-10", "maintenance"], ["2019-09-10", "enable"],
        ])
        self.assertEqual(features["GCP0001"]["properties"]["owner_events"], [])
        # Le relecteur désarchive puis archive : états suivis, aucune étape.
        props = features["GCP0005"]["properties"]
        self.assertEqual(props["owner_events"], [["2019-10-01", "archive"]])
        self.assertEqual(props["owner_states"], [
            ["2019-10-01", pd.STATE_ARCHIVED], ["2019-10-20", pd.STATE_ACTIVE],
            ["2020-03-01", pd.STATE_ARCHIVED],
        ])

    def test_inferred_archive_greys_without_event(self):
        self._commit()
        features, _ = self._features()
        props = features["GCP0006"]["properties"]
        self.assertEqual(props["owner_events"], [])
        self.assertEqual([state for _day, state in props["owner_states"]], [pd.STATE_ARCHIVED])

    def test_api_route(self):
        self._commit()
        client = self.app.test_client()
        data = client.get("/api/logs/owner_features").get_json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["features"]), 7)
        self.assertEqual(data["ownedTotal"], 8)

    def test_preferences(self):
        # Préférences dans un dossier temporaire (cf. test_dnf_geojson).
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
        self.assertEqual((defaults["owner_display"], defaults["owner_in_trail"]), (False, True))
        client.put("/api/settings", json={"owner_display": True, "owner_in_trail": False})
        saved = client.get("/api/settings").get_json()
        self.assertEqual((saved["owner_display"], saved["owner_in_trail"]), (True, False))
        # Une valeur non booléenne ne change rien ; les DNF n'en sont pas touchés.
        client.put("/api/settings", json={"owner_display": "non"})
        saved = client.get("/api/settings").get_json()
        self.assertIs(saved["owner_display"], True)
        self.assertIs(saved["dnf_display"], False)


class OwnerThemeTests(unittest.TestCase):
    """Forme, contour et flashs des caches posées dans le thème."""

    def test_defaults_and_legacy_theme(self):
        from settings_manager import MapProfile, coerce_profile
        import event_flash as ef
        profile = coerce_profile({"name": "Ancien", "points": {"shape": "triangle"}, "flash": {"mode": "circle"}})
        self.assertEqual((profile.points.owner_shape, profile.points.owner_border_color,
                          profile.points.owner_border_width), ("star", "#ffc107", 2))
        self.assertEqual(profile.flash.owner, ef.owner_flash_defaults())
        self.assertEqual(MapProfile().flash.owner["place"]["mode"], "star")

    def test_coercion_and_round_trip(self):
        from settings_manager import SettingsManager, coerce_profile
        profile = coerce_profile({"name": "T", "points": {
            "owner_shape": "hexagone", "owner_border_color": "#ABCDEF", "owner_border_width": 99,
        }, "flash": {"owner": {"maintenance": {"mode": "none"}, "inconnu": {"mode": "star"}}}})
        self.assertEqual(profile.points.owner_shape, "star")          # inconnue → défaut
        self.assertEqual(profile.points.owner_border_color, "#ABCDEF")
        self.assertEqual(profile.points.owner_border_width, 6)        # bornée
        self.assertEqual(profile.flash.owner["maintenance"]["mode"], "none")
        self.assertNotIn("inconnu", profile.flash.owner)
        # Aller-retour par la sérialisation de l'API (sans lire de fichier).
        data = SettingsManager.__new__(SettingsManager)._profile_to_dict(profile)
        self.assertEqual(data["points"]["owner_border_width"], 6)
        again = coerce_profile(data)
        self.assertEqual(again.points.owner_border_color, "#ABCDEF")
        self.assertEqual(again.flash.owner, profile.flash.owner)


if __name__ == "__main__":
    unittest.main()
