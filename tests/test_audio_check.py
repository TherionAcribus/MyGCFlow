import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from blueprints.media import media_bp
from capture import _get_ffmpeg_exe

from tests.tmp_paths import canonical_temporary_directory


class AudioCheckTests(unittest.TestCase):
    """POST /api/audio/check : la musique est sondée dès son choix —
    absente → 404, sans piste audio lisible → readable faux, sinon sa
    durée est renvoyée."""

    def setUp(self):
        self.tmpdir = canonical_temporary_directory()
        self.addCleanup(self.tmpdir.cleanup)
        root = Path(self.tmpdir.name).resolve()
        self.data = root / 'data'
        self.audio = self.data / 'audio'
        self.audio.mkdir(parents=True)

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
        self.client = app.test_client()

    def _check(self, name):
        return self.client.post('/api/audio/check', json={'file': name})

    def _tone(self, name, seconds=2):
        """Sinus de `seconds` écrit dans audio/ (même recette que
        test_audio_library : pas de binaire versionné)."""
        subprocess.run(
            [_get_ffmpeg_exe(), '-y', '-v', 'error', '-f', 'lavfi', '-t', str(seconds),
             '-i', 'sine=frequency=440:sample_rate=44100', str(self.audio / name)],
            check=True,
        )
        return name

    def test_a_readable_track_reports_its_duration(self):
        name = self._tone('fond.wav', 2)

        response = self._check(name)

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertTrue(payload['readable'])
        self.assertAlmostEqual(payload['duration'], 2.0, delta=0.2)

    def test_an_unreadable_file_is_flagged_not_refused(self):
        # 200, pas d'erreur : c'est le client qui défait le choix.
        (self.audio / 'casse.mp3').write_bytes(b'pas de la musique')

        response = self._check('casse.mp3')

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload['success'])
        self.assertFalse(payload['readable'])
        self.assertIsNone(payload['duration'])

    def test_a_missing_track_is_a_404(self):
        response = self._check('absente.mp3')

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.get_json()['success'])

    def test_a_path_is_never_followed_outside_the_folder(self):
        # « ../x » réduit à « x » par safe_audio_name : un fichier du dossier
        # parent n'est jamais sondé.
        (self.data / 'x').write_bytes(b'hors du dossier')

        response = self._check('../x')

        self.assertEqual(response.status_code, 404)


if __name__ == '__main__':
    unittest.main()
