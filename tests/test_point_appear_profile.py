import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import settings_manager
from settings_manager import SettingsManager


class PointAppearProfileTests(unittest.TestCase):
    """Apparition animée et persistance des points récents : réglages de profil."""

    def setUp(self):
        # Même isolation que test_profile_names : jamais le %APPDATA% réel.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-point-appear-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            # Lot d'exemples à jour : sinon la migration installerait les
            # exemples ajoutés depuis (cf. EXAMPLES_VERSION).
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

    def test_disabled_by_default(self):
        self.manager.create_profile("Neuf")
        points = self.manager.load_profile("Neuf").points
        self.assertFalse(points.appear_animation)
        self.assertEqual(points.recent_glow_days, 0)

    def test_round_trip(self):
        self.manager.create_profile("Anime")
        profile = self.manager.load_profile("Anime")
        profile.points.appear_animation = True
        self.manager.save_profile(profile)
        self.assertTrue(self.manager.load_profile("Anime").points.appear_animation)
        exported = self.manager._profile_to_dict(self.manager.load_profile("Anime"))
        self.assertIs(exported["points"]["appear_animation"], True)

    def test_recent_glow_round_trip_and_bounds(self):
        self.manager.create_profile("Persistance")
        profile = self.manager.load_profile("Persistance")
        profile.points.recent_glow_days = 30
        self.manager.save_profile(profile)
        self.assertEqual(self.manager.load_profile("Persistance").points.recent_glow_days, 30)

        # Valeur négative ou illisible : la persistance est simplement éteinte,
        # les expressions de style divisant par cette fenêtre.
        path = settings_manager.PROFILES_DIR / "Persistance.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["points"]["recent_glow_days"] = -5
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.manager.load_profile("Persistance").points.recent_glow_days, 0)

    def test_profile_saved_before_the_settings_existed_loads_disabled(self):
        self.manager.create_profile("Ancien")
        path = next(settings_manager.PROFILES_DIR.glob("*.json"))
        data = json.loads(path.read_text(encoding="utf-8"))
        data["points"].pop("appear_animation", None)
        data["points"].pop("recent_glow_days", None)
        path.write_text(json.dumps(data), encoding="utf-8")
        points = self.manager.load_profile("Ancien").points
        self.assertFalse(points.appear_animation)
        self.assertEqual(points.recent_glow_days, 0)


if __name__ == "__main__":
    unittest.main()
