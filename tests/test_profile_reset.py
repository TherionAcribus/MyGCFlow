import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import MapProfile, SettingsManager


class ProfileResetTests(unittest.TestCase):
    """Réinitialisation d'un thème.

    Elle recréait le thème avec un uid neuf : le thème par défaut et le dernier
    thème actif, référencés par uid dans settings.json, étaient alors effacés
    sans message au démarrage suivant. Un thème d'exemple repartait en outre des
    valeurs neutres au lieu de son design d'origine.
    """

    def setUp(self):
        # Constantes redirigées : sans cela le test écrirait dans les profils
        # réels de l'utilisateur (%APPDATA%\MyGCFlow).
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-profile-reset-"))
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
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

        # Import tardif, sous les constantes redirigées : le blueprint construit
        # un SettingsManager au moment de son import.
        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = Flask(__name__)
        app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = app.test_client()

    def _customized(self, name: str) -> MapProfile:
        prof = self.manager.create_profile(name)
        prof.points.size = 42
        prof.flash.color = "#123456"
        self.manager.save_profile(prof)
        return prof

    def test_reset_keeps_the_uid(self):
        prof = self._customized("Alpha")
        self.manager.reset_profile("Alpha")
        self.assertEqual(self.manager.load_profile("Alpha").uid, prof.uid)

    def test_reset_keeps_the_default_and_last_theme_references(self):
        prof = self._customized("Alpha")

        def point_at_alpha(current):
            current.default_profile_uid = prof.uid
            current.last_profile_uid = prof.uid
            return current

        self.manager.update_app_settings(point_at_alpha)
        self.manager.reset_profile("Alpha")

        settings = self.manager.get_app_settings()
        self.assertEqual(settings.default_profile_uid, prof.uid)
        self.assertEqual(settings.last_profile_uid, prof.uid)

    def test_reset_of_a_user_theme_restores_the_default_values(self):
        self._customized("Alpha")
        reset = self.manager.reset_profile("Alpha")
        defaults = MapProfile()
        self.assertEqual(reset.points, defaults.points)
        self.assertEqual(reset.flash, defaults.flash)
        self.assertEqual(reset.map.tile_provider, "OSM")

    def test_reset_of_an_example_restores_its_original_design(self):
        name = "Aurore Polaire"
        self.manager.save_profile(SettingsManager._example_profile_definitions()[name])
        # Relu du disque : le CSS y est normalisé par sanitize_overlay_css.
        original = self.manager.load_profile(name)
        modified = self.manager.load_profile(name)
        modified.points.size = 99
        modified.infos.title.text = "Modifié"
        self.manager.save_profile(modified)

        self.manager.reset_profile(name)

        reset = self.manager.load_profile(name)
        self.assertEqual(reset.uid, original.uid)
        self.assertEqual(reset.points, original.points)
        self.assertEqual(reset.infos, original.infos)
        self.assertEqual(reset.map, original.map)

    def test_reset_of_a_missing_theme_fails_instead_of_creating_it(self):
        with self.assertRaises(FileNotFoundError):
            self.manager.reset_profile("Fantôme")
        self.assertNotIn("Fantôme", self.manager.list_profiles())

    def test_reset_endpoint_returns_404_for_a_missing_theme(self):
        resp = self.client.post("/api/profiles/Inconnu/reset")
        self.assertEqual(resp.status_code, 404)
        self.assertFalse(resp.get_json()["success"])

    def test_reset_endpoint_returns_the_preserved_uid(self):
        prof = self._customized("Alpha")
        resp = self.client.post("/api/profiles/Alpha/reset")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["uid"], prof.uid)


if __name__ == "__main__":
    unittest.main()
