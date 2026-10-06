import os
import tempfile
import unittest
from unittest import mock

from flask import Flask, request

from capture import describe_video, open_video, resolve_video_file, reveal_video


class VideoReadyTests(unittest.TestCase):
    """Écran de fin d'export : description du fichier produit et actions
    « Afficher dans le dossier » / « Ouvrir dans le lecteur »."""

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        env = mock.patch.dict(os.environ, {'MYGCFLOW_DATA_DIR': self.tmpdir.name})
        env.start()
        self.addCleanup(env.stop)
        os.chdir(self.tmpdir.name)
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(os.chdir, self.previous_cwd)
        os.makedirs('video')
        with open(os.path.join('video', 'film.mp4'), 'wb') as handle:
            handle.write(b'x' * 2048)

    def _call(self, handler, payload):
        with self.app.test_request_context('/', method='POST', json=payload):
            result = handler(request)
        response, *rest = result if isinstance(result, tuple) else (result,)
        return response.get_json(), (rest[0] if rest else 200)

    def test_describe_reports_name_folder_size_and_duration(self):
        path = os.path.join(os.getcwd(), 'video', 'film.mp4')
        with mock.patch('capture._probe_duration_seconds', return_value=12.5):
            info = describe_video(path)

        self.assertEqual(info['file'], 'film.mp4')
        self.assertEqual(info['folder'], os.path.dirname(path))
        self.assertEqual(info['size_bytes'], 2048)
        self.assertEqual(info['duration_seconds'], 12.5)

    def test_describe_missing_file_does_not_raise(self):
        with mock.patch('capture._probe_duration_seconds', return_value=None):
            info = describe_video(os.path.join('video', 'absent.mp4'))

        self.assertEqual(info['file'], 'absent.mp4')
        self.assertIsNone(info['size_bytes'])
        self.assertIsNone(info['duration_seconds'])

    def test_resolve_finds_only_files_of_the_video_dir(self):
        self.assertTrue(resolve_video_file('film.mp4').endswith(os.path.join('video', 'film.mp4')))
        self.assertIsNone(resolve_video_file('absent.mp4'))
        self.assertIsNone(resolve_video_file(''))
        self.assertIsNone(resolve_video_file(None))

    def test_resolve_neutralises_traversal(self):
        """Un fichier hors du dossier des vidéos ne doit jamais être atteint."""
        with open('secret.mp4', 'wb') as handle:
            handle.write(b'x')

        self.assertIsNone(resolve_video_file('../secret.mp4'))
        self.assertIsNone(resolve_video_file(os.path.abspath('secret.mp4')))

    def test_reveal_selects_the_file_in_explorer(self):
        with mock.patch('capture.platform.system', return_value='Windows'), \
                mock.patch('capture.subprocess.Popen') as popen:
            payload, status = self._call(reveal_video, {'file': 'film.mp4'})

        self.assertEqual(status, 200)
        self.assertTrue(payload['success'])
        command = popen.call_args.args[0]
        self.assertEqual(command[:2], ['explorer', '/select,'])
        self.assertTrue(command[2].endswith(os.path.join('video', 'film.mp4')))

    def test_reveal_unknown_file_is_404_and_launches_nothing(self):
        with mock.patch('capture.subprocess.Popen') as popen:
            payload, status = self._call(reveal_video, {'file': '../secret.mp4'})

        self.assertEqual(status, 404)
        self.assertFalse(payload['success'])
        popen.assert_not_called()

    def test_open_hands_the_file_to_the_system(self):
        with mock.patch('capture._open_with_system') as opener:
            payload, status = self._call(open_video, {'file': 'film.mp4'})

        self.assertEqual(status, 200)
        self.assertTrue(payload['success'])
        self.assertTrue(opener.call_args.args[0].endswith(os.path.join('video', 'film.mp4')))

    def test_open_unknown_file_is_404_and_launches_nothing(self):
        with mock.patch('capture._open_with_system') as opener:
            _payload, status = self._call(open_video, {'file': 'absent.mp4'})

        self.assertEqual(status, 404)
        opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
