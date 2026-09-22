import os
import tempfile
import unittest
from unittest import mock

from flask import Flask

from capture import clear_pictures_directory, count_captured_pictures


class CapturedPicturesCountTests(unittest.TestCase):
    """Comptage des images restées dans captured/.

    Le client s'en sert pour n'afficher le bouton de suppression que lorsqu'il y a
    réellement quelque chose à supprimer.
    """

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        # capture.py écrit dans paths.captured_dir() : on redirige les données
        # vers le dossier temporaire, où les assertions lisent « captured/ ».
        env = mock.patch.dict(os.environ, {'GCMAP_DATA_DIR': self.tmpdir.name})
        env.start()
        self.addCleanup(env.stop)
        os.chdir(self.tmpdir.name)
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(os.chdir, self.previous_cwd)

    def _write(self, name, content=b'x'):
        os.makedirs('captured', exist_ok=True)
        with open(os.path.join('captured', name), 'wb') as handle:
            handle.write(content)

    def test_missing_directory_counts_zero(self):
        self.assertEqual(count_captured_pictures(), 0)

    def test_empty_directory_counts_zero(self):
        os.makedirs('captured', exist_ok=True)
        self.assertEqual(count_captured_pictures(), 0)

    def test_counts_every_supported_image_format(self):
        self._write('image_0001.webp')
        self._write('image_0002.PNG')
        self._write('image_0003.jpg')
        self._write('image_0004.jpeg')

        self.assertEqual(count_captured_pictures(), 4)

    def test_ignores_non_image_files(self):
        self._write('.gitkeep')
        self._write('notes.txt')
        os.makedirs(os.path.join('captured', 'sous-dossier'), exist_ok=True)

        self.assertEqual(count_captured_pictures(), 0)

    def test_clear_reports_the_remaining_count(self):
        self._write('image_0001.webp')
        self._write('image_0002.webp')

        with self.app.test_request_context('/clear_pictures_directory', method='POST'):
            payload = clear_pictures_directory().get_json()

        self.assertTrue(payload['success'])
        self.assertEqual(payload['count'], 0)
        self.assertEqual(count_captured_pictures(), 0)


if __name__ == '__main__':
    unittest.main()
