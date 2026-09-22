import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import SettingsManager


class ProfileDeleteTests(unittest.TestCase):
    """Suppression d'un profil : succès silencieux vs 404.

    Un DELETE sur un profil absent renvoyait success: true, ce qui rendait
    indétectable une désynchronisation entre la liste affichée et le disque
    (profil déjà supprimé, nom mal encodé, fichier renommé à la main).
    """

    def setUp(self):
        # Les profils réels vivent dans %APPDATA%\GCMap : sans redirection des
        # constantes de module, ce test supprimerait des profils de l'utilisateur.
        tmp = Path(tempfile.mkdtemp(prefix="gcmap-profile-delete-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Flag de seeding posé d'avance : chaque test part d'un dossier vide, sans
        # la dizaine de profils d'exemple que le premier lancement installerait.
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            # Lot d'exemples à jour : sinon la migration installerait les
            # exemples ajoutés depuis (cf. EXAMPLES_VERSION).
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

    def test_delete_removes_an_existing_profile(self):
        self.manager.create_profile("Alpha")
        self.manager.delete_profile("Alpha")
        self.assertEqual(self.manager.list_profiles(), [])

    def test_delete_raises_when_the_profile_does_not_exist(self):
        with self.assertRaises(FileNotFoundError):
            self.manager.delete_profile("Fantome")

    def test_api_delete_returns_200_for_an_existing_profile(self):
        self.manager.create_profile("Alpha")
        response = self.client.delete('/api/profiles/Alpha')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['success'])
        self.assertEqual(self.manager.list_profiles(), [])

    def test_api_delete_returns_404_for_a_missing_profile(self):
        response = self.client.delete('/api/profiles/Fantome')
        self.assertEqual(response.status_code, 404)
        payload = response.get_json()
        self.assertFalse(payload['success'])
        self.assertIn('Fantome', payload['message'])

    def test_api_delete_twice_returns_404_the_second_time(self):
        # Le cas réel : deux clics sur la corbeille, ou une liste obsolète.
        self.manager.create_profile("Alpha")
        self.assertEqual(self.client.delete('/api/profiles/Alpha').status_code, 200)
        self.assertEqual(self.client.delete('/api/profiles/Alpha').status_code, 404)


if __name__ == "__main__":
    unittest.main()
