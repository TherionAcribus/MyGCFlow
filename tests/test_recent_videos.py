import os
import tempfile
import unittest
from unittest import mock

from flask import Flask, request

from capture import delete_video, list_recent_videos

from tests.tmp_paths import canonical_temporary_directory


class RecentVideosTests(unittest.TestCase):
    """Liste « Dernières vidéos » de l'onglet Export et suppression d'une vidéo."""

    def setUp(self):
        self.app = Flask(__name__)
        self.tmpdir = canonical_temporary_directory()
        self.previous_cwd = os.getcwd()
        env = mock.patch.dict(os.environ, {'MYGCFLOW_DATA_DIR': self.tmpdir.name})
        env.start()
        self.addCleanup(env.stop)
        # Aucun dossier choisi : la liste lit le dossier par défaut, sous la
        # racine temporaire, quelle que soit la configuration de la machine.
        folder = mock.patch('paths.configured_video_dir', return_value=None)
        folder.start()
        self.addCleanup(folder.stop)
        os.chdir(self.tmpdir.name)
        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(os.chdir, self.previous_cwd)
        os.makedirs('video')

    def _video(self, name, mtime, content=b'x'):
        path = os.path.join('video', name)
        with open(path, 'wb') as handle:
            handle.write(content)
        os.utime(path, (mtime, mtime))
        return path

    def _delete(self, file):
        with self.app.test_request_context('/api/videos/delete', method='POST', json={'file': file}):
            result = delete_video(request)
        response, *rest = result if isinstance(result, tuple) else (result,)
        return response.get_json(), (rest[0] if rest else 200)

    def test_missing_folder_gives_an_empty_list(self):
        os.rmdir('video')

        listing = list_recent_videos()

        self.assertTrue(listing['success'])
        self.assertEqual(listing['videos'], [])
        self.assertEqual(listing['total'], 0)

    def test_videos_are_listed_newest_first_with_their_size(self):
        self._video('ancien.mp4', 1000)
        self._video('recent.mp4', 3000, b'abcd')
        self._video('milieu.webm', 2000)

        listing = list_recent_videos()

        self.assertEqual([v['file'] for v in listing['videos']], ['recent.mp4', 'milieu.webm', 'ancien.mp4'])
        self.assertEqual(listing['videos'][0]['size_bytes'], 4)
        self.assertEqual(listing['videos'][0]['modified'], 3000)
        self.assertEqual(listing['folder'], os.path.join(os.getcwd(), 'video'))

    def test_limit_keeps_the_newest_and_reports_the_total(self):
        for index in range(5):
            self._video(f'film_{index}.mp4', 1000 + index)

        listing = list_recent_videos(2)

        self.assertEqual([v['file'] for v in listing['videos']], ['film_4.mp4', 'film_3.mp4'])
        self.assertEqual(listing['total'], 5)
        # Limite illisible ou hors bornes : valeur par défaut, jamais d'erreur.
        self.assertEqual(len(list_recent_videos('abc')['videos']), 5)
        self.assertEqual(len(list_recent_videos(0)['videos']), 1)

    def test_only_actionable_videos_are_listed(self):
        self._video('film.mp4', 1000)
        self._video('mygcflow_raw_20261006-101010.webm', 2000)  # enregistrement en cours
        self._video('notes.txt', 3000)
        self._video('nom avec espaces.mp4', 4000)  # introuvable par resolve_video_file
        os.makedirs(os.path.join('video', 'dossier.mp4'))

        self.assertEqual([v['file'] for v in list_recent_videos()['videos']], ['film.mp4'])

    def test_delete_sends_the_video_to_the_recycle_bin(self):
        path = self._video('film.mp4', 1000)
        with mock.patch('capture.recycle_bin.send_to_trash', return_value=True) as trash:
            payload, status = self._delete('film.mp4')

        self.assertEqual(status, 200)
        self.assertTrue(payload['success'])
        self.assertTrue(payload['recoverable'])
        self.assertEqual(os.path.abspath(trash.call_args.args[0]), os.path.abspath(path))

    def test_delete_unknown_or_outside_file_is_404(self):
        with open('secret.mp4', 'wb') as handle:
            handle.write(b'x')
        with mock.patch('capture.recycle_bin.send_to_trash') as trash:
            for file in ('absent.mp4', '../secret.mp4', ''):
                _payload, status = self._delete(file)
                self.assertEqual(status, 404, file)

        trash.assert_not_called()
        self.assertTrue(os.path.exists('secret.mp4'))

    def test_delete_failure_is_reported_not_raised(self):
        """Fichier ouvert dans un lecteur : Windows refuse la suppression."""
        self._video('film.mp4', 1000)
        with mock.patch('capture.recycle_bin.send_to_trash', side_effect=PermissionError):
            payload, status = self._delete('film.mp4')

        self.assertEqual(status, 409)
        self.assertFalse(payload['success'])


if __name__ == '__main__':
    unittest.main()
