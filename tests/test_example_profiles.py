"""Installation des profils d'exemple, et ajout d'exemples par une version ultérieure.

Le lot initial n'est installé qu'au tout premier lancement : un exemple supprimé
ne doit jamais revenir. Les exemples ajoutés plus tard (EXAMPLES_VERSION) doivent
pourtant atteindre les installations existantes — une fois, et sans toucher aux
profils déjà présents.
"""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import settings_manager
from settings_manager import (
    EXAMPLE_PROFILE_BATCHES,
    EXAMPLES_ADDED_AFTER_V1,
    EXAMPLES_VERSION,
    SettingsManager,
)


class ExampleProfileSeedingTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-examples-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        self.settings_path = tmp / "settings.json"
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": self.settings_path,
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (tmp / "profiles").mkdir(parents=True, exist_ok=True)

    def _settings(self) -> dict:
        return settings_manager.read_json(self.settings_path)

    def test_first_launch_installs_every_example_including_the_animation_styles(self):
        profiles = SettingsManager().list_profiles()
        self.assertIn("Default", profiles)
        for name in EXAMPLES_ADDED_AFTER_V1:
            self.assertIn(name, profiles)
        self.assertEqual(self._settings().get("examples_version"), EXAMPLES_VERSION)

    def test_an_existing_installation_receives_only_the_new_examples(self):
        # Installation d'avant ces exemples : le lot initial a été posé, puis
        # l'utilisateur a supprimé tous les exemples sauf un.
        settings_manager.write_json(self.settings_path, {"examples_seeded": True})
        kept = SettingsManager().create_profile("Mon Profil")
        self.assertEqual(self._settings().get("examples_version"), EXAMPLES_VERSION)

        profiles = SettingsManager().list_profiles()
        self.assertEqual(
            sorted(profiles), sorted({"Mon Profil"} | EXAMPLES_ADDED_AFTER_V1)
        )
        # Les exemples du lot initial, supprimés, ne reviennent pas.
        self.assertNotIn("Default", profiles)
        # Le profil de l'utilisateur est intact (même uid, pas réécrit).
        self.assertEqual(SettingsManager().load_profile("Mon Profil").uid, kept.uid)

    def test_a_version_two_installation_receives_only_the_version_three_collection(self):
        settings_manager.write_json(
            self.settings_path,
            {"examples_seeded": True, "examples_version": 2},
        )

        profiles = SettingsManager().list_profiles()

        self.assertEqual(set(profiles), EXAMPLE_PROFILE_BATCHES[3])
        self.assertNotIn("Équilibré", profiles)
        self.assertNotIn("Cinématique", profiles)

    def test_a_new_example_deleted_by_the_user_does_not_come_back(self):
        settings_manager.write_json(self.settings_path, {"examples_seeded": True})
        manager = SettingsManager()
        name = sorted(EXAMPLES_ADDED_AFTER_V1)[0]
        manager.delete_profile(name)

        self.assertNotIn(name, SettingsManager().list_profiles())

    def test_resetting_the_settings_does_not_bring_the_examples_back(self):
        manager = SettingsManager()
        for name in list(EXAMPLES_ADDED_AFTER_V1) + ["Default"]:
            manager.delete_profile(name)
        manager.reset_app_settings()

        # Nouveau gestionnaire : c'est là que la migration s'exécuterait.
        profiles = SettingsManager().list_profiles()
        for name in list(EXAMPLES_ADDED_AFTER_V1) + ["Default"]:
            self.assertNotIn(name, profiles)

    def test_the_animation_styles_use_the_new_flash_and_appearance(self):
        manager = SettingsManager()
        balanced = manager.load_profile("Équilibré")
        cinematic = manager.load_profile("Cinématique")

        self.assertEqual(balanced.flash.mode, "impulse")
        self.assertEqual(cinematic.flash.mode, "impulse")
        # « Équilibré » vise les grosses bases : pas d'apparition animée.
        self.assertFalse(balanced.points.appear_animation)
        self.assertTrue(cinematic.points.appear_animation)
        # « Cinématique » met aussi en avant les caches des 30 derniers jours.
        self.assertEqual(balanced.points.recent_glow_days, 0)
        self.assertEqual(cinematic.points.recent_glow_days, 30)
        # Un flash bien plus court que les 2000 ms par défaut.
        self.assertLess(balanced.flash.duration, 1000)
        self.assertLess(cinematic.flash.duration, 1000)

    def test_the_aesthetic_collection_stays_compact_and_explores_distinct_settings(self):
        manager = SettingsManager()
        collection = [manager.load_profile(name) for name in EXAMPLE_PROFILE_BATCHES[3]]

        self.assertEqual(len(collection), 6)
        self.assertTrue(all(profile.points.size <= 7 for profile in collection))
        self.assertTrue(all(
            profile.points.mode != "icone" or profile.points.icon_size <= 18
            for profile in collection
        ))
        self.assertEqual(
            {profile.map.tile_provider for profile in collection},
            {"OSM", "stamenToner", "vectorMap", "watercolor"},
        )
        self.assertEqual(
            {profile.flash.mode for profile in collection},
            {"none", "impulse", "star", "square", "triangle", "diamond"},
        )
        self.assertTrue(any(profile.animation.camera_follow for profile in collection))
        self.assertTrue(any(not profile.animation.enabled for profile in collection))
        self.assertTrue(any(profile.points.fill_color_type == "none" for profile in collection))
        self.assertTrue(any(profile.points.mode == "icone" for profile in collection))


if __name__ == "__main__":
    unittest.main()
