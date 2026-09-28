import io
import os
import tempfile
import unittest
from unittest import mock

from flask import Flask, request

from capture import (
    _assemble_pictures,
    captured_session_dir,
    clear_pictures_directory,
    count_captured_pictures,
    upload_image,
    upload_images,
)


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


class SessionIsolationTests(unittest.TestCase):
    """Isolation des captures : chaque enregistrement écrit dans son sous-dossier
    captured/<session>/, ce qui empêche les uploads tardifs d'une session
    précédente de se mélanger à la capture suivante."""

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

    def _post(self, data):
        with self.app.test_request_context('/upload_images', method='POST', data=data):
            response, *rest = _unpack(upload_images(request))
            return response.get_json(), (rest[0] if rest else 200)

    def test_session_writes_into_its_own_subdir(self):
        payload, status = self._post({
            'images': [_file('image_0001.webp')],
            'counters': ['1'],
            'session': 'cap-test-1',
        })

        self.assertEqual(status, 200)
        self.assertTrue(payload['success'])
        self.assertEqual(
            sorted(os.listdir(os.path.join('captured', 'cap-test-1'))),
            ['image_0001.webp'],
        )
        # Rien à la racine de captured/ : la session est isolée.
        self.assertEqual(os.listdir('captured'), ['cap-test-1'])

    def test_late_upload_of_previous_session_does_not_mix(self):
        """Un lot arrivant après le démarrage d'une nouvelle session atterrit dans
        son propre dossier au lieu de se mélanger aux frames en cours."""
        self._post({'images': [_file('image_0001.webp')], 'counters': ['1'], 'session': 'cap-old'})
        self._post({'images': [_file('image_0001.webp')], 'counters': ['1'], 'session': 'cap-new'})

        self.assertEqual(os.listdir(os.path.join('captured', 'cap-old')), ['image_0001.webp'])
        self.assertEqual(os.listdir(os.path.join('captured', 'cap-new')), ['image_0001.webp'])

    def test_session_traversal_stays_inside_captured(self):
        payload, status = self._post({
            'images': [_file('image_0001.webp')],
            'counters': ['1'],
            'session': '../../evil',
        })

        self.assertEqual(status, 200)
        # Le fichier reste dans l'arborescence captured/, jamais à côté, quel que
        # soit le sous-dossier sain produit par secure_filename.
        written = [os.path.join(r, f) for r, _d, files in os.walk('captured') for f in files]
        self.assertEqual(len(written), 1)
        self.assertTrue(written[0].endswith('image_0001.webp'))
        self.assertFalse(os.path.exists(os.path.join('..', 'evil')))
        self.assertFalse(os.path.exists(os.path.join('..', 'image_0001.webp')))
        self.assertFalse(os.path.exists('image_0001.webp'))

    def test_count_includes_session_subdirs(self):
        """Le compteur de reliquats voit les frames des sessions isolées."""
        self._post({'images': [_file('image_0001.webp')], 'counters': ['1'], 'session': 'cap-a'})
        self._post({'images': [_file('image_0002.webp')], 'counters': ['2']})

        self.assertEqual(count_captured_pictures(), 2)

    def test_clear_removes_session_subdirs(self):
        self._post({'images': [_file('image_0001.webp')], 'counters': ['1'], 'session': 'cap-a'})

        with self.app.test_request_context('/clear_pictures_directory', method='POST'):
            payload = clear_pictures_directory().get_json()

        self.assertTrue(payload['success'])
        self.assertEqual(count_captured_pictures(), 0)
        self.assertFalse(os.path.exists(os.path.join('captured', 'cap-a')))

    def test_assembly_refuses_missing_frames(self):
        """Le client annonce N frames capturées : un upload perdu doit faire
        échouer l'assemblage au lieu de produire une vidéo tronquée."""
        session_dir = captured_session_dir('cap-partiel')
        os.makedirs(session_dir)
        for i in range(3):
            with open(os.path.join(session_dir, f'image_{i:04d}.webp'), 'wb') as f:
                f.write(b'x')

        result = _assemble_pictures(str(session_dir), 'out.mp4', fps=30, expected_frames=4)

        self.assertFalse(result['success'])
        self.assertIn('attendues', result['message'])

    def test_assembly_refuses_noncontiguous_indices(self):
        """Comptage OK mais trou dans la numérotation : la continuité protège
        contre une frame perdue compensée par un doublon."""
        folder = os.path.join('captured', 'cap-gap')
        os.makedirs(folder)
        for i in (0, 1, 3):  # image_0002 absente
            with open(os.path.join(folder, f'image_{i:04d}.webp'), 'wb') as f:
                f.write(b'x')

        result = _assemble_pictures(folder, 'out.mp4', fps=30)

        self.assertFalse(result['success'])
        self.assertIn('continue', result['message'])


def _unpack(result):
    """Normalise une réponse Flask (`response` ou `(response, status)`) en tuple."""
    return result if isinstance(result, tuple) else (result,)


if __name__ == '__main__':
    unittest.main()
