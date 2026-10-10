import io
import os
import tempfile
import time
import unittest
from unittest import mock

from flask import Flask, request

from capture import (
    VIDEO_STREAM_MAX_AGE_S,
    _assemble_pictures,
    _video_streams,
    captured_session_dir,
    clear_pictures_directory,
    count_captured_pictures,
    process_recorded_video,
    recorded_video_path,
    upload_image,
    upload_images,
    video_stream_abort,
    video_stream_append,
    video_stream_begin,
    video_stream_finish,
)
from tests.tmp_paths import canonical_temporary_directory


def _file(name, content=b'webp-bytes'):
    return (io.BytesIO(content), name)


class UploadImagesTests(unittest.TestCase):
    """Réception groupée des frames (une requête pour N images)."""

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = canonical_temporary_directory()
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
        self.tmpdir = canonical_temporary_directory()
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


class VideoStreamTests(unittest.TestCase):
    """Flux de délestage MediaRecorder : les fragments .webm sont écrits sur
    disque au fil de l'eau au lieu de s'accumuler en mémoire navigateur."""

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = canonical_temporary_directory()
        self.previous_cwd = os.getcwd()
        env = mock.patch.dict(os.environ, {'MYGCFLOW_DATA_DIR': self.tmpdir.name})
        env.start()
        self.addCleanup(env.stop)
        os.chdir(self.tmpdir.name)
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(os.chdir, self.previous_cwd)
        self.addCleanup(_video_streams.clear)

    def _begin(self):
        with self.app.test_request_context('/video_stream_begin', method='POST'):
            return video_stream_begin().get_json()['stream_id']

    def _append(self, stream_id, index, content=b'x'):
        data = {'stream_id': stream_id, 'index': str(index), 'chunk': _file('c.webm', content)}
        with self.app.test_request_context('/video_stream_append', method='POST', data=data):
            response, *rest = _unpack(video_stream_append(request))
            return response.get_json(), (rest[0] if rest else 200)

    def _finish(self, stream_id, file_name='out.webm'):
        with self.app.test_request_context(
            '/video_stream_finish', method='POST', json={'stream_id': stream_id, 'fileName': file_name},
        ):
            response, *rest = _unpack(video_stream_finish(request))
            return response.get_json(), (rest[0] if rest else 200)

    def test_begin_creates_stream_file(self):
        stream_id = self._begin()
        self.assertIn(stream_id, _video_streams)
        self.assertTrue(os.path.isfile(_video_streams[stream_id]['path']))

    def test_appends_concatenate_in_order(self):
        stream_id = self._begin()
        for i, chunk in enumerate((b'AAA', b'BBB', b'CCC')):
            payload, status = self._append(stream_id, i, chunk)
            self.assertEqual(status, 200)
            self.assertTrue(payload['success'])

        with open(_video_streams[stream_id]['path'], 'rb') as handle:
            self.assertEqual(handle.read(), b'AAABBBCCC')
        self.assertEqual(_video_streams[stream_id]['index'], 3)

    def test_out_of_order_index_is_rejected(self):
        """Un fragment hors séquence corromprait le conteneur EBML : refus 409."""
        stream_id = self._begin()
        self._append(stream_id, 0, b'AAA')

        payload, status = self._append(stream_id, 5, b'XXX')

        self.assertEqual(status, 409)
        self.assertEqual(payload['expected'], 1)
        with open(_video_streams[stream_id]['path'], 'rb') as handle:
            self.assertEqual(handle.read(), b'AAA')

    def test_append_on_unknown_stream_is_404(self):
        payload, status = self._append('inconnu', 0)
        self.assertEqual(status, 404)
        self.assertFalse(payload['success'])

    def test_append_without_chunk_is_400(self):
        stream_id = self._begin()
        with self.app.test_request_context(
            '/video_stream_append', method='POST',
            data={'stream_id': stream_id, 'index': '0'},
        ):
            response, *rest = _unpack(video_stream_append(request))
            self.assertEqual(rest[0] if rest else 200, 400)

    def test_finish_remuxes_into_the_working_dir_and_purges(self):
        """finish remuxe (sans ré-encodage) en raw_<id>.webm dans le dossier de
        travail, retire le flux du registre et supprime le fichier de flux.
        Rien n'est écrit dans le dossier des vidéos. ffmpeg est simulé en échec
        pour exercer le repli « copie brute » sans dépendre du binaire."""
        stream_id = self._begin()
        self._append(stream_id, 0, b'WEBMDATA')
        raw_path = _video_streams[stream_id]['path']

        fake_proc = mock.Mock(returncode=1, stderr=b'')
        with mock.patch('capture.subprocess.run', return_value=fake_proc):
            payload, status = self._finish(stream_id, 'capture.webm')

        self.assertEqual(status, 200)
        self.assertEqual(payload['file'], f'raw_{stream_id}.webm')
        out = os.path.join('video_streams', payload['file'])
        self.assertTrue(os.path.isfile(out))
        self.assertFalse(os.path.exists('video'))
        self.assertEqual(recorded_video_path(payload['file']), os.path.join(os.getcwd(), out))
        with open(out, 'rb') as handle:
            self.assertEqual(handle.read(), b'WEBMDATA')
        self.assertNotIn(stream_id, _video_streams)
        self.assertFalse(os.path.exists(raw_path))

    def test_finish_on_unknown_stream_is_404(self):
        _payload, status = self._finish('inconnu')
        self.assertEqual(status, 404)

    def test_abort_removes_stream_file(self):
        stream_id = self._begin()
        self._append(stream_id, 0, b'AAA')
        raw_path = _video_streams[stream_id]['path']

        with self.app.test_request_context(
            '/video_stream_abort', method='POST', json={'stream_id': stream_id},
        ):
            payload = video_stream_abort(request).get_json()

        self.assertTrue(payload['success'])
        self.assertNotIn(stream_id, _video_streams)
        self.assertFalse(os.path.exists(raw_path))

    def test_process_recorded_video_accepts_recorded_file(self):
        """Le flux remuxé doit pouvoir être désigné par son nom — sans
        re-téléversement du fichier complet."""
        os.makedirs('video_streams')
        raw = os.path.join(os.getcwd(), 'video_streams', 'raw_abc.webm')
        with open(raw, 'wb') as handle:
            handle.write(b'WEBM')

        with self.app.test_request_context(
            '/process_recorded_video', method='POST',
            data={'recorded_file': 'raw_abc.webm', 'slowdown': '1', 'fps': '30'},
        ):
            with mock.patch('task_manager.task_manager') as tm:
                tm.submit.return_value = mock.Mock(id='task-1', state='running')
                response, *rest = _unpack(process_recorded_video(request))
                payload = response.get_json()

        self.assertEqual(rest[0] if rest else 200, 202)
        self.assertTrue(payload['success'])
        self.assertEqual(payload['task_id'], 'task-1')
        # Le traitement lit le brut du dossier de travail…
        self.assertEqual(tm.submit.call_args.args[3], raw)
        # …et écrit le MP4 dans le dossier des vidéos.
        self.assertEqual(os.path.dirname(tm.submit.call_args.args[4]), os.path.join(os.getcwd(), 'video'))

    def test_uploaded_recording_is_kept_out_of_the_video_dir(self):
        """Téléversement d'un bloc (sans flux) : le .webm brut ne doit pas
        apparaître parmi les vidéos de l'utilisateur."""
        with self.app.test_request_context(
            '/process_recorded_video', method='POST',
            data={'video': _file('recording.webm', b'WEBM'), 'slowdown': '1'},
        ):
            with mock.patch('task_manager.task_manager') as tm:
                tm.submit.return_value = mock.Mock(id='task-2', state='running')
                response, *rest = _unpack(process_recorded_video(request))

        self.assertEqual(rest[0] if rest else 200, 202)
        self.assertEqual(os.listdir('video'), [])
        raw = tm.submit.call_args.args[3]
        self.assertEqual(os.path.dirname(raw), os.path.join(os.getcwd(), 'video_streams'))
        with open(raw, 'rb') as handle:
            self.assertEqual(handle.read(), b'WEBM')

    def test_recorded_file_only_reaches_finished_recordings(self):
        """Ni un flux encore ouvert, ni un fichier d'un autre dossier."""
        os.makedirs('video_streams')
        os.makedirs('video')
        for path in (os.path.join('video_streams', 'stream_abc.webm'),
                     os.path.join('video_streams', 'raw_abc.txt'),
                     os.path.join('video', 'raw_film.webm')):
            with open(path, 'wb') as handle:
                handle.write(b'x')

        for name in ('stream_abc.webm', 'raw_abc.txt', 'raw_film.webm', '../video/raw_film.webm', '', None):
            self.assertIsNone(recorded_video_path(name), name)

    def test_sweep_removes_stale_recordings_but_keeps_recent_ones(self):
        """Un brut dont le traitement a échoué ne doit pas s'accumuler."""
        stream_id = self._begin()
        streams_dir = os.path.dirname(_video_streams[stream_id]['path'])
        stale = os.path.join(streams_dir, 'raw_vieux.webm')
        fresh = os.path.join(streams_dir, 'raw_recent.webm')
        for path in (stale, fresh):
            with open(path, 'wb') as handle:
                handle.write(b'x')
        old = time.time() - VIDEO_STREAM_MAX_AGE_S - 60
        os.utime(stale, (old, old))

        self._begin()  # chaque ouverture de flux balaie le dossier

        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(fresh))

    def test_process_recorded_video_rejects_traversal_in_recorded_file(self):
        """secure_filename réduit '../..' à un nom plat : pas de sortie de video/."""
        with self.app.test_request_context(
            '/process_recorded_video', method='POST',
            data={'recorded_file': '../../etc/passwd'},
        ):
            response, *rest = _unpack(process_recorded_video(request))
            self.assertEqual(rest[0] if rest else 200, 400)


def _unpack(result):
    """Normalise une réponse Flask (`response` ou `(response, status)`) en tuple."""
    return result if isinstance(result, tuple) else (result,)


if __name__ == '__main__':
    unittest.main()
