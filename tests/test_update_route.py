"""Route /check_version : périodicité des vérifications et version ignorée.

La logique de décision est testée unitairement dans test_check_version.py ; ce
fichier vérifie son branchement réel sur les préférences globales — c'est là que
se joue la promesse « la modale ne se rouvre pas à chaque démarrage ».
"""

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import SettingsManager


def _release(tag):
    return {
        "tag_name": tag,
        "body": "* Une nouveauté",
        "published_at": "2026-09-30T08:00:00Z",
        "draft": False,
        "prerelease": False,
        "html_url": f"https://github.com/TherionAcribus/MyGCFlow/releases/tag/{tag}",
        "assets": [],
    }


class CheckVersionRouteTests(unittest.TestCase):

    def setUp(self):
        # Les préférences réelles vivent dans %APPDATA%\MyGCFlow : sans
        # redirection des constantes de module, ce test écraserait la
        # configuration de l'utilisateur.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-update-route-"))
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

        from blueprints import core as core_bp_module

        patcher = mock.patch.object(core_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.app = Flask(__name__)
        self.app.config['APP_VERSION'] = '1.0.0'
        self.app.register_blueprint(core_bp_module.core_bp)
        self.client = self.app.test_client()

        self.get = mock.patch('options.requests.get').start()
        self.addCleanup(mock.patch.stopall)
        self._serve([_release("v1.1.0")])

    def _serve(self, releases):
        response = mock.MagicMock()
        response.status_code = 200
        response.json.return_value = releases
        response.raise_for_status = mock.MagicMock()
        self.get.return_value = response

    def test_startup_check_reports_the_update_and_records_the_date(self):
        payload = self.client.get('/check_version?mode=init').get_json()

        self.assertTrue(payload['update_available'])
        self.assertFalse(payload['skipped'])
        self.assertEqual(payload['latest_version']['version'], '1.1.0')
        self.assertIsNotNone(self.manager.get_app_settings().last_update_check)

    def test_second_startup_check_is_postponed(self):
        self.client.get('/check_version?mode=init')
        payload = self.client.get('/check_version?mode=init').get_json()

        self.assertFalse(payload['checked'])
        self.assertFalse(payload['update_available'])
        # Une seule requête réseau : la seconde vérification n'a pas eu lieu.
        self.assertEqual(self.get.call_count, 1)

    def test_manual_check_ignores_the_interval(self):
        self.client.get('/check_version?mode=init')
        payload = self.client.get('/check_version?mode=manual').get_json()

        self.assertTrue(payload['checked'])
        self.assertTrue(payload['update_available'])
        self.assertEqual(self.get.call_count, 2)

    def test_skipped_version_is_flagged(self):
        self.manager.update_app_settings(
            lambda current: _with(current, skipped_update_version='1.1.0')
        )

        payload = self.client.get('/check_version?mode=init').get_json()

        self.assertTrue(payload['update_available'])
        self.assertTrue(payload['skipped'])

    def test_a_later_version_is_announced_despite_the_skip(self):
        self.manager.update_app_settings(
            lambda current: _with(current, skipped_update_version='1.1.0')
        )
        self._serve([_release("v1.1.0"), _release("v1.2.0")])

        payload = self.client.get('/check_version?mode=init').get_json()

        self.assertEqual(payload['latest_version']['version'], '1.2.0')
        self.assertFalse(payload['skipped'])

    def test_a_failed_check_is_not_recorded(self):
        import requests

        self.get.side_effect = requests.ConnectionError("boom")

        payload = self.client.get('/check_version?mode=init').get_json()

        self.assertTrue(payload['error'])
        # Sans horodatage enregistré, le lancement suivant réessaie tout de suite.
        self.assertIsNone(self.manager.get_app_settings().last_update_check)

    def test_settings_write_keeps_the_skipped_version(self):
        """L'API settings accepte un patch partiel : écrire la langue ne doit pas
        réveiller une version que l'utilisateur a mise de côté."""
        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app.register_blueprint(profiles_bp_module.profiles_bp)

        self.client.put('/api/settings', json={'skipped_update_version': '1.1.0'})
        self.client.put('/api/settings', json={'language': 'en'})

        settings = self.manager.get_app_settings()
        self.assertEqual(settings.skipped_update_version, '1.1.0')
        self.assertEqual(settings.language, 'en')
        # Le lot d'exemples déjà installé ne doit pas repasser à 0 non plus.
        self.assertEqual(settings.examples_version, settings_manager.EXAMPLES_VERSION)


def _with(settings, **changes):
    from dataclasses import replace
    return replace(settings, **changes)


if __name__ == "__main__":
    unittest.main()
