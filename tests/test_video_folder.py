import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import folder_picker
import paths
import settings_manager
from blueprints.media import media_bp
from blueprints.profiles import profiles_bp

from tests.tmp_paths import canonical_temporary_directory


class VideoFolderTests(unittest.TestCase):
    """Dossier des vidéos choisi par l'utilisateur : préférence globale
    recording.output_dir, écrite par /api/video_folder et lue par
    paths.video_dir()."""

    def setUp(self):
        self.tmpdir = canonical_temporary_directory()
        self.addCleanup(self.tmpdir.cleanup)
        root = Path(self.tmpdir.name).resolve()
        self.data = root / 'data'
        self.custom = root / 'mes films'
        self.data.mkdir()

        env = mock.patch.dict(os.environ, {'MYGCFLOW_DATA_DIR': str(self.data)})
        env.start()
        self.addCleanup(env.stop)
        # Préférences dans le dossier temporaire : ni la configuration de
        # l'utilisateur ni celle des autres tests ne sont lues ou modifiées.
        settings = mock.patch.object(settings_manager, 'SETTINGS_PATH', root / 'settings.json')
        settings.start()
        self.addCleanup(settings.stop)

        app = Flask(__name__)
        app.register_blueprint(media_bp)
        app.register_blueprint(profiles_bp)
        self.client = app.test_client()

    def _choose(self, path):
        return self.client.post('/api/video_folder/choose', json={'path': path})

    def test_default_folder_until_one_is_chosen(self):
        state = self.client.get('/api/video_folder').get_json()

        self.assertTrue(state['is_default'])
        self.assertEqual(state['folder'], str(self.data / 'video'))
        self.assertIsNone(state['unavailable_folder'])
        self.assertEqual(paths.video_dir(), self.data / 'video')

    def test_chosen_folder_is_created_saved_and_used(self):
        response = self._choose(str(self.custom))
        state = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertFalse(state['is_default'])
        self.assertEqual(state['folder'], str(self.custom))
        self.assertTrue(self.custom.is_dir())
        self.assertEqual(paths.video_dir(), self.custom)
        # Relu depuis le disque : le choix survit au redémarrage.
        self.assertEqual(self.client.get('/api/video_folder').get_json()['folder'], str(self.custom))

    def test_relative_or_empty_path_is_refused(self):
        for bad in ('', '   ', 'films'):
            response = self._choose(bad)
            self.assertEqual(response.status_code, 400, bad)
            self.assertFalse(response.get_json()['success'])
        self.assertEqual(paths.video_dir(), self.data / 'video')

    def test_unwritable_folder_is_refused(self):
        with mock.patch('blueprints.media.tempfile.TemporaryFile', side_effect=PermissionError):
            response = self._choose(str(self.custom))

        self.assertEqual(response.status_code, 400)
        self.assertEqual(paths.video_dir(), self.data / 'video')

    def test_reset_returns_to_the_default_folder(self):
        self._choose(str(self.custom))
        state = self.client.post('/api/video_folder/reset').get_json()

        self.assertTrue(state['is_default'])
        self.assertEqual(paths.video_dir(), self.data / 'video')

    def test_vanished_folder_falls_back_and_is_reported(self):
        """Disque externe débranché : l'export ne doit pas échouer, et
        l'interface doit pouvoir dire où vont les vidéos en attendant."""
        self._choose(str(self.custom))
        self.custom.rmdir()

        state = self.client.get('/api/video_folder').get_json()

        self.assertEqual(paths.video_dir(), self.data / 'video')
        self.assertEqual(state['folder'], str(self.data / 'video'))
        self.assertEqual(state['unavailable_folder'], str(self.custom))
        self.assertFalse(state['is_default'])

    def test_picker_choice_is_saved(self):
        self.custom.mkdir()
        with mock.patch.object(folder_picker, 'pick_folder',
                               return_value=(folder_picker.PICKED, str(self.custom))) as picker:
            state = self.client.post('/api/video_folder/choose', json={}).get_json()

        picker.assert_called_once()
        self.assertEqual(state['folder'], str(self.custom))
        self.assertEqual(paths.video_dir(), self.custom)

    def test_cancelled_picker_changes_nothing(self):
        with mock.patch.object(folder_picker, 'pick_folder', return_value=(folder_picker.CANCELLED, None)):
            state = self.client.post('/api/video_folder/choose', json={}).get_json()

        self.assertTrue(state['cancelled'])
        self.assertTrue(state['is_default'])

    def test_unavailable_picker_asks_for_manual_entry(self):
        with mock.patch.object(folder_picker, 'pick_folder', return_value=(folder_picker.UNAVAILABLE, None)):
            response = self.client.post('/api/video_folder/choose', json={})

        self.assertEqual(response.status_code, 501)
        self.assertTrue(response.get_json()['picker_unavailable'])

    def test_settings_api_cannot_set_the_folder_unchecked(self):
        """PUT /api/settings ne vérifie pas les dossiers : il ne doit pas
        pouvoir en imposer un, ni effacer celui choisi."""
        self._choose(str(self.custom))
        self.client.put('/api/settings', json={'recording': {'output_dir': 'Z:\\ailleurs', 'fps': 24}})

        recording = self.client.get('/api/settings').get_json()['recording']
        self.assertEqual(recording['fps'], 24)
        self.assertEqual(recording['output_dir'], str(self.custom))


if __name__ == '__main__':
    unittest.main()
