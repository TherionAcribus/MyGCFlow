import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import (
    RecordingSettings,
    SettingsManager,
    coerce_map_center,
    coerce_recording_settings,
    coerce_settings,
)


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


class RecordingDefaultsMatchTheClientTests(unittest.TestCase):
    """Défauts vidéo du serveur et du client, qui doivent coïncider.

    Tant que `recording_configured` est faux, le client n'applique pas les
    réglages du serveur : il garde ceux de static/json/defaultValues.json. Une
    divergence ne se voit donc que dans l'interface. C'est ainsi que le mode
    d'enregistrement s'affichait « Images + ffmpeg » chez tout nouvel
    utilisateur — le JSON disait "images", le serveur "mediarecorder" — et que
    les blocs `.mediarecorder-only` (qualité, réglages avancés, cases à cocher)
    restaient masqués.
    """

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "static" / "json" / "defaultValues.json"
        cls.client_record = json.loads(path.read_text(encoding="utf-8"))["record"]

    def test_the_recording_mode_is_the_same_on_both_sides(self):
        self.assertEqual(self.client_record["mode"], RecordingSettings().mode)

    def test_the_shared_recording_defaults_are_the_same_on_both_sides(self):
        # Seuls les champs décrits des deux côtés : scale_factor et les réglages
        # audio n'ont pas d'équivalent dans le JSON client.
        server = RecordingSettings()
        media = self.client_record["mediaRecorder"]

        self.assertEqual(self.client_record["fps"], server.fps)
        self.assertEqual(media["mimeType"], server.mime_type)
        self.assertEqual(media["videoBitsPerSecond"] / 1_000_000, server.bitrate_mbps)
        self.assertEqual(media["slowdownFactor"], server.slowdown_factor)
        self.assertEqual(media["uploadToServer"], server.upload_to_server)
        self.assertEqual(media["downloadLocal"], server.download_local)
        self.assertEqual(media["offlineNormalization"], server.offline_normalization)


class ThemeCoercionTests(unittest.TestCase):
    def test_valid_themes_are_kept_and_others_fall_back_to_system(self):
        self.assertEqual(coerce_settings({"theme": "dark"}).theme, "dark")
        self.assertEqual(coerce_settings({"theme": "light"}).theme, "light")
        self.assertEqual(coerce_settings({"theme": "neon"}).theme, "system")
        self.assertEqual(coerce_settings({}).theme, "system")


class MapZoomCoercionTests(unittest.TestCase):
    """Bornes du zoom par défaut.

    L'interface pose min=0/max=22 sur le champ, mais ni un settings.json édité à
    la main ni un PUT /api/settings ne passent par elle.
    """

    def test_out_of_range_zoom_is_clamped(self):
        self.assertEqual(coerce_settings({"map_default_zoom": 99}).map_default_zoom, 22)
        self.assertEqual(coerce_settings({"map_default_zoom": -5}).map_default_zoom, 0)

    def test_zoom_inside_the_range_is_kept(self):
        self.assertEqual(coerce_settings({"map_default_zoom": 12}).map_default_zoom, 12)

    def test_absent_or_unreadable_zoom_stays_none(self):
        self.assertIsNone(coerce_settings({}).map_default_zoom)
        self.assertIsNone(coerce_settings({"map_default_zoom": None}).map_default_zoom)
        self.assertIsNone(coerce_settings({"map_default_zoom": "loin"}).map_default_zoom)


class MapCenterCoercionTests(unittest.TestCase):
    """Plages du centre par défaut.

    Le client refuse déjà lat hors [-90, 90] et lon hors [-180, 180], mais ni un
    settings.json édité à la main ni un PUT /api/settings ne passent par lui.
    """

    def test_a_center_on_the_globe_is_kept(self):
        self.assertEqual(coerce_map_center([2.35, 48.85]), (2.35, 48.85))

    def test_out_of_range_values_are_refused_rather_than_clamped(self):
        # Ramener 400 à 180 désignerait un endroit que l'utilisateur n'a pas
        # choisi : on garde ce qui était en place.
        previous = (2.35, 48.85)
        self.assertEqual(coerce_map_center([400.0, 48.85], previous), previous)
        self.assertEqual(coerce_map_center([2.35, 200.0], previous), previous)
        self.assertIsNone(coerce_map_center([400.0, 48.85]))

    def test_non_finite_values_never_reach_the_settings_file(self):
        # json.dumps écrirait `NaN`, que les analyseurs stricts refusent.
        self.assertIsNone(coerce_map_center([float("nan"), 48.85]))
        self.assertIsNone(coerce_map_center([2.35, float("inf")]))

    def test_an_unusable_shape_clears_the_center(self):
        self.assertIsNone(coerce_map_center(None, (2.35, 48.85)))
        self.assertIsNone(coerce_map_center([1.0], (2.35, 48.85)))

    def test_unreadable_numbers_keep_the_previous_center(self):
        previous = (2.35, 48.85)
        self.assertEqual(coerce_map_center(["ici", "là"], previous), previous)

    def test_settings_on_disk_are_checked_after_the_v1_reordering(self):
        # v1 stockait [latitude, longitude] : une longitude de 150 est légitime,
        # elle ne doit pas être lue comme une latitude hors bornes.
        s = coerce_settings({"version": 1, "map_default_center": [45.0, 150.0]})
        self.assertEqual(s.map_default_center, (150.0, 45.0))

        s = coerce_settings({"version": 2, "map_default_center": [150.0, 45.0]})
        self.assertEqual(s.map_default_center, (150.0, 45.0))

    def test_an_out_of_range_center_on_disk_is_dropped(self):
        self.assertIsNone(coerce_settings({"map_default_center": [2.35, 200.0]}).map_default_center)


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

        self.app = Flask(__name__)
        self.app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = self.app.test_client()

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

    def test_a_zoom_sent_out_of_range_is_stored_clamped(self):
        self.client.put('/api/settings', json={'map_default_zoom': 99})

        self.assertEqual(self.client.get('/api/settings').get_json()['map_default_zoom'], 22)
        # Borné à l'écriture, pas seulement à la relecture : le fichier lui-même
        # ne doit pas contenir 99.
        stored = settings_manager.read_json(settings_manager.SETTINGS_PATH)
        self.assertEqual(stored['map_default_zoom'], 22)

    def test_a_center_sent_off_the_globe_leaves_the_stored_one_untouched(self):
        self.client.put('/api/settings', json={'map_default_center': [2.35, 48.85]})
        self.client.put('/api/settings', json={'map_default_center': [2.35, 200.0]})

        self.assertEqual(
            self.client.get('/api/settings').get_json()['map_default_center'], [2.35, 48.85]
        )

    def test_a_null_center_clears_the_setting(self):
        self.client.put('/api/settings', json={'map_default_center': [2.35, 48.85]})
        self.client.put('/api/settings', json={'map_default_center': None})

        self.assertIsNone(self.client.get('/api/settings').get_json()['map_default_center'])

    def test_two_simultaneous_patches_do_not_erase_each_other(self):
        """Deux écritures qui se croisent doivent toutes deux survivre.

        Le serveur de développement Flask traite les requêtes en parallèle. Un
        PUT partiel relit les champs absents de son corps : si deux requêtes
        lisent le même état de départ, la seconde réécrit l'ancienne valeur du
        champ modifié par la première (« lost update »). C'était observable en
        changeant la langue pendant qu'un blur enregistrait le centre de carte.

        L'écriture est ralentie pour élargir la fenêtre entre lecture et
        écriture : sans le verrou, ce test échoue de façon reproductible.
        """
        real_write_json = settings_manager.write_json

        def slow_write_json(path, obj):
            time.sleep(0.15)
            real_write_json(path, obj)

        # Un client par thread : ils partagent l'application, donc le même
        # gestionnaire de préférences, comme deux onglets du navigateur.
        def put(payload):
            self.app.test_client().put('/api/settings', json=payload)

        with mock.patch.object(settings_manager, 'write_json', slow_write_json):
            first = threading.Thread(target=put, args=({'theme': 'dark'},))
            second = threading.Thread(target=put, args=({'language': 'en'},))
            first.start()
            time.sleep(0.05)  # la seconde requête arrive pendant l'écriture de la première
            second.start()
            first.join()
            second.join()

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'dark')
        self.assertEqual(payload['language'], 'en')

    def test_reset_returns_the_defaults_of_the_new_preferences(self):
        self.client.put('/api/settings', json={'theme': 'dark', 'recording': {'fps': 60}})
        self.assertEqual(self.client.post('/api/settings/reset').status_code, 200)

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'system')
        self.assertEqual(payload['recording']['fps'], 30)
        self.assertFalse(payload['recording_configured'])


if __name__ == "__main__":
    unittest.main()
