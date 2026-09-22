import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import settings_manager
from settings_manager import SettingsManager


class PointAppearProfileTests(unittest.TestCase):
    """Le réglage « apparition animée des points » est un réglage de profil."""

    def setUp(self):
        # Même isolation que test_profile_names : jamais le %APPDATA% réel.
        tmp = Path(tempfile.mkdtemp(prefix="gcmap-point-appear-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {"examples_seeded": True})
        self.manager = SettingsManager()

    def test_disabled_by_default(self):
        self.manager.create_profile("Neuf")
        self.assertFalse(self.manager.load_profile("Neuf").points.appear_animation)

    def test_round_trip(self):
        self.manager.create_profile("Anime")
        profile = self.manager.load_profile("Anime")
        profile.points.appear_animation = True
        self.manager.save_profile(profile)
        self.assertTrue(self.manager.load_profile("Anime").points.appear_animation)
        exported = self.manager._profile_to_dict(self.manager.load_profile("Anime"))
        self.assertIs(exported["points"]["appear_animation"], True)

    def test_profile_saved_before_the_setting_existed_loads_disabled(self):
        self.manager.create_profile("Ancien")
        path = next(settings_manager.PROFILES_DIR.glob("*.json"))
        data = json.loads(path.read_text(encoding="utf-8"))
        data["points"].pop("appear_animation", None)
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertFalse(self.manager.load_profile("Ancien").points.appear_animation)


if __name__ == "__main__":
    unittest.main()
