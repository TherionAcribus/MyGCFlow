import io
import os
import re
import tempfile
import unittest
from unittest import mock

from flask import Flask, request

from capture import upload_video, video_base_name, video_output_path
from settings_manager import RECORDING_FILE_NAME_MAX_LENGTH, coerce_recording_settings


STAMP = r'\d{4}-\d{2}-\d{2}_\d{2}h\d{2}'


class VideoNamingTests(unittest.TestCase):
    """Nom des vidéos produites : <nom>_AAAA-MM-JJ_HHhMM.<ext>, identique pour
    les deux modes d'export, sans jamais écraser un fichier existant."""

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

    def test_base_name_is_reduced_to_a_portable_ascii_name(self):
        self.assertEqual(video_base_name('Été en Bretagne'), 'Ete_en_Bretagne')
        self.assertEqual(video_base_name('Encre & Papier'), 'Encre_Papier')

    def test_base_name_drops_a_typed_video_extension(self):
        self.assertEqual(video_base_name('film.mp4'), 'film')
        self.assertEqual(video_base_name('film.WEBM'), 'film')

    def test_empty_or_fully_filtered_base_name_falls_back(self):
        for raw in (None, '', '   ', '///', '日本'):
            self.assertEqual(video_base_name(raw), 'mygcflow')

    def test_base_name_cannot_leave_the_video_dir(self):
        path = video_output_path('../../evil')
        self.assertEqual(os.path.dirname(path), os.path.join(os.getcwd(), 'video'))

    def test_output_carries_a_single_readable_timestamp(self):
        name = os.path.basename(video_output_path('Bretagne'))
        self.assertRegex(name, rf'^Bretagne_{STAMP}\.mp4$')

    def test_existing_file_is_never_overwritten(self):
        first = video_output_path('Bretagne')
        open(first, 'wb').close()
        second = video_output_path('Bretagne')
        open(second, 'wb').close()
        third = video_output_path('Bretagne')

        self.assertRegex(os.path.basename(second), rf'^Bretagne_{STAMP}-2\.mp4$')
        self.assertRegex(os.path.basename(third), rf'^Bretagne_{STAMP}-3\.mp4$')

    def test_upload_video_follows_the_same_naming(self):
        data = {'video': (io.BytesIO(b'WEBM'), 'recording.webm'), 'fileName': 'Bretagne.webm'}
        with self.app.test_request_context('/upload_video', method='POST', data=data), \
                mock.patch('capture._probe_duration_seconds', return_value=None):
            payload = upload_video(request).get_json()

        self.assertTrue(payload['success'])
        self.assertRegex(payload['file'], rf'^Bretagne_{STAMP}\.webm$')
        self.assertTrue(os.path.isfile(os.path.join('video', payload['file'])))

    def test_file_name_setting_is_trimmed_and_bounded(self):
        self.assertEqual(coerce_recording_settings({'file_name': '  Bretagne  '}).file_name, 'Bretagne')
        self.assertEqual(
            len(coerce_recording_settings({'file_name': 'x' * 500}).file_name),
            RECORDING_FILE_NAME_MAX_LENGTH,
        )
        self.assertEqual(coerce_recording_settings({'file_name': 12}).file_name, '')

    def test_retired_destination_settings_are_ignored(self):
        """Un settings.json antérieur porte encore ces clés : elles ne doivent
        ni faire échouer la lecture ni réapparaître dans les réglages."""
        settings = coerce_recording_settings({'upload_to_server': False, 'download_local': False, 'fps': 24})

        self.assertEqual(settings.fps, 24)
        self.assertFalse(hasattr(settings, 'upload_to_server'))
        self.assertFalse(hasattr(settings, 'download_local'))


if __name__ == '__main__':
    unittest.main()
