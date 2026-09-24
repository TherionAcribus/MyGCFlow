import io
import os
import tempfile
import unittest
from unittest import mock

from flask import Flask, request

from capture import upload_image, upload_images


def _file(name, content=b'webp-bytes'):
    return (io.BytesIO(content), name)


class UploadImagesTests(unittest.TestCase):
    """Réception groupée des frames (une requête pour N images)."""

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = tempfile.TemporaryDirectory()
        self.previous_cwd = os.getcwd()
        # capture.py écrit dans paths.captured_dir() : on redirige les données
        # vers le dossier temporaire, où les assertions lisent « captured/ ».
        env = mock.patch.dict(os.environ, {'MYGCFLOW_DATA_DIR': self.tmpdir.name})
        env.start()
        self.addCleanup(env.stop)
        os.chdir(self.tmpdir.name)
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(os.chdir, self.previous_cwd)

    def _post(self, data):
        with self.app.test_request_context('/upload_images', method='POST', data=data):
            response, *rest = _unpack(upload_images(request))
            return response.get_json(), (rest[0] if rest else 200)

    def _captured(self):
        return sorted(os.listdir('captured'))

    def test_batch_saves_every_image(self):
        payload, status = self._post({
            'images': [_file('image_0001.webp'), _file('image_0002.webp'), _file('image_0003.webp')],
            'counters': ['1', '2', '3'],
            'numberSize': '4',
        })

        self.assertEqual(status, 200)
        self.assertTrue(payload['success'])
        self.assertEqual(payload['count'], 3)
        self.assertEqual(self._captured(), ['image_0001.webp', 'image_0002.webp', 'image_0003.webp'])

    def test_missing_filenames_fall_back_to_counters(self):
        payload, status = self._post({
            'images': [_file(''), _file('')],
            'counters': ['7', '8'],
            'numberSize': '5',
        })

        self.assertEqual(status, 200)
        self.assertEqual(payload['files'], ['image_00007.webp', 'image_00008.webp'])

    def test_path_traversal_in_filename_is_neutralised(self):
        self._post({
            'images': [_file('../../evil.webp')],
            'counters': ['1'],
        })

        self.assertEqual(self._captured(), ['evil.webp'])
        self.assertFalse(os.path.exists(os.path.join('..', '..', 'evil.webp')))

    def test_empty_batch_is_rejected(self):
        payload, status = self._post({'counters': ['1']})

        self.assertEqual(status, 400)
        self.assertFalse(payload['success'])

    def test_retrying_a_batch_overwrites_the_same_files(self):
        """Un lot renvoyé après erreur réseau ne doit pas dupliquer les frames."""
        data = {'images': [_file('image_0001.webp', b'v1')], 'counters': ['1']}
        self._post(data)
        self._post({'images': [_file('image_0001.webp', b'v2')], 'counters': ['1']})

        self.assertEqual(self._captured(), ['image_0001.webp'])
        with open(os.path.join('captured', 'image_0001.webp'), 'rb') as handle:
            self.assertEqual(handle.read(), b'v2')

    def test_single_upload_route_still_works(self):
        with self.app.test_request_context(
            '/upload_image',
            method='POST',
            data={'image': _file('image_0042.webp'), 'counter': '42', 'numberSize': '4'},
        ):
            payload = upload_image(request).get_json()

        self.assertTrue(payload['success'])
        self.assertEqual(self._captured(), ['image_0042.webp'])


def _unpack(result):
    """Normalise une réponse Flask (`response` ou `(response, status)`) en tuple."""
    return result if isinstance(result, tuple) else (result,)


if __name__ == '__main__':
    unittest.main()
