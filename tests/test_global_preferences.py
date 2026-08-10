import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import SettingsManager, coerce_recording_settings, coerce_settings


class RecordingCoercionTests(unittest.TestCase):
    """Bornes des réglages vidéo lus depuis le disque.

    settings.json est un fichier éditable à la main : une valeur hors plage ne
    doit pas produire un enregistrement impossible (0 image/seconde, bitrate
    négatif, codec vide).
    """

    def test_out_of_range_values_are_clamped_to_the_ui_limits(self):
        r = coerce_recording_settings({
            "fps": 999,
            "bitrate_mbps": 0,
            "scale_factor": 12,
            "slowdown_factor": 0,
            "audio_volume": 4.5,
        })

        self.assertEqual(r.fps, 60)
        self.assertEqual(r.bitrate_mbps, 1)
        self.assertEqual(r.scale_factor, 3.0)
        self.assertEqual(r.slowdown_factor, 1)
        self.assertEqual(r.audio_volume, 1.0)

    def test_unknown_mode_and_empty_mime_fall_back_to_defaults(self):
        r = coerce_recording_settings({"mode": "quantique", "mime_type": ""})

        self.assertEqual(r.mode, "mediarecorder")
        self.assertEqual(r.mime_type, "video/webm;codecs=vp9")

    def test_garbage_payload_yields_defaults(self):
        self.assertEqual(coerce_recording_settings(None), coerce_recording_settings({}))


class ThemeCoercionTests(unittest.TestCase):
    def test_valid_themes_are_kept_and_others_fall_back_to_system(self):
        self.assertEqual(coerce_settings({"theme": "dark"}).theme, "dark")
        self.assertEqual(coerce_settings({"theme": "light"}).theme, "light")
        self.assertEqual(coerce_settings({"theme": "neon"}).theme, "system")
        self.assertEqual(coerce_settings({}).theme, "system")


class RecordingConfiguredFlagTests(unittest.TestCase):
    """Drapeau qui pilote la reprise des anciens réglages du localStorage.

    Le client ne doit pousser ses réglages locaux que tant que le serveur n'en a
    jamais reçu : sans ce drapeau, un bloc `recording` toujours rempli de valeurs
    par défaut rendrait « jamais configuré » indiscernable de « configuré ».
    """

    def test_settings_written_before_the_migration_count_as_unconfigured(self):
        self.assertFalse(coerce_settings({"language": "fr"}).recording_configured)

    def test_a_recording_block_on_disk_counts_as_configured(self):
        self.assertTrue(coerce_settings({"recording": {"fps": 24}}).recording_configured)


class SettingsApiTests(unittest.TestCase):
    def setUp(self):
        # Les préférences réelles vivent dans %APPDATA%\GCMap : sans redirection
        # des constantes de module, ce test écraserait la configuration de
        # l'utilisateur (thème, langue, profil par défaut).
        tmp = Path(tempfile.mkdtemp(prefix="gcmap-global-prefs-"))
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

        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = Flask(__name__)
        app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = app.test_client()

    def test_get_exposes_theme_and_recording(self):
        payload = self.client.get('/api/settings').get_json()

        self.assertEqual(payload['theme'], 'system')
        self.assertFalse(payload['recording_configured'])
        self.assertEqual(payload['recording']['fps'], 30)

    def test_theme_survives_a_round_trip(self):
        self.assertEqual(self.client.put('/api/settings', json={'theme': 'dark'}).status_code, 200)

        self.assertEqual(self.client.get('/api/settings').get_json()['theme'], 'dark')

    def test_an_invalid_theme_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'theme': 'dark'})
        self.client.put('/api/settings', json={'theme': 'chartreuse'})

        self.assertEqual(self.client.get('/api/settings').get_json()['theme'], 'dark')

    def test_a_partial_recording_patch_keeps_the_other_video_settings(self):
        self.client.put('/api/settings', json={'recording': {'fps': 24, 'bitrate_mbps': 12}})
        self.client.put('/api/settings', json={'recording': {'download_local': False}})

        recording = self.client.get('/api/settings').get_json()['recording']
        self.assertEqual(recording['fps'], 24)
        self.assertEqual(recording['bitrate_mbps'], 12)
        self.assertFalse(recording['download_local'])

    def test_writing_recording_marks_the_settings_as_configured(self):
        self.client.put('/api/settings', json={'recording': {'fps': 24}})

        self.assertTrue(self.client.get('/api/settings').get_json()['recording_configured'])

    def test_a_patch_without_theme_or_recording_preserves_them(self):
        # Le cas réel : l'utilisateur change la langue depuis un autre écran, la
        # requête ne porte que `language`.
        self.client.put('/api/settings', json={'theme': 'light', 'recording': {'fps': 24}})
        self.client.put('/api/settings', json={'language': 'en'})

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['language'], 'en')
        self.assertEqual(payload['theme'], 'light')
        self.assertEqual(payload['recording']['fps'], 24)

    def test_reset_returns_the_defaults_of_the_new_preferences(self):
        self.client.put('/api/settings', json={'theme': 'dark', 'recording': {'fps': 60}})
        self.assertEqual(self.client.post('/api/settings/reset').status_code, 200)

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'system')
        self.assertEqual(payload['recording']['fps'], 30)
        self.assertFalse(payload['recording_configured'])


if __name__ == "__main__":
    unittest.main()
