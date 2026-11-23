import os
import subprocess
import unittest
from unittest import mock

import video_chapters as vc
from capture import _assemble_pictures, _get_ffmpeg_exe, _process_recorded_video
from tests.tmp_paths import canonical_temporary_directory


def _chapters(*starts):
    return [{'start': start, 'day': index + 1, 'date': f'{index + 12:02d}/07/2025'}
            for index, start in enumerate(starts)]


class ParseChaptersTests(unittest.TestCase):
    """Chapitres reçus du client : validés sans jamais faire échouer l'export."""

    def test_json_string_is_parsed_sorted_and_first_starts_at_zero(self):
        raw = '[{"start": 20, "day": 3, "date": "14/07"}, {"start": 0.4, "day": 1, "date": "12/07"}]'
        self.assertEqual(vc.parse_chapters(raw), [
            {'start': 0.0, 'day': 1, 'date': '12/07'},
            {'start': 20.0, 'day': 3, 'date': '14/07'},
        ])

    def test_invalid_entries_are_dropped(self):
        raw = [
            {'start': 0, 'day': 1, 'date': 'a\nb'},
            {'start': 'x', 'day': 2},
            {'start': -1, 'day': 2},
            {'start': float('nan'), 'day': 2},
            {'start': 5, 'day': 0},
            'nope',
            {'start': 5, 'day': 2},
            {'start': 5, 'day': 3},  # même instant : le premier reste
        ]
        self.assertEqual(vc.parse_chapters(raw), [
            {'start': 0.0, 'day': 1, 'date': 'ab'},
            {'start': 5.0, 'day': 2, 'date': ''},
        ])

    def test_fewer_than_two_chapters_means_none(self):
        self.assertEqual(vc.parse_chapters('[{"start": 0, "day": 1}]'), [])
        self.assertEqual(vc.parse_chapters('pas du json'), [])
        self.assertEqual(vc.parse_chapters(None), [])
        self.assertEqual(vc.parse_chapters(''), [])

    def test_within_duration_drops_chapters_past_the_end(self):
        chapters = _chapters(0, 10, 30)
        self.assertEqual(len(vc.within_duration(chapters, 31)), 3)
        self.assertEqual(len(vc.within_duration(chapters, 30)), 2)
        self.assertEqual(vc.within_duration(chapters, 5), [])
        self.assertEqual(vc.within_duration(chapters, None), chapters)


class FormatTests(unittest.TestCase):

    def test_titles(self):
        a, b, c = _chapters(0, 10, 20)
        self.assertEqual(vc.chapter_title([a]), 'Jour 1 — 12/07/2025')
        self.assertEqual(vc.chapter_title([{**a, 'date': ''}]), 'Jour 1')
        self.assertEqual(vc.chapter_title([b, c]), 'Jours 2 à 3 — 13/07/2025 → 14/07/2025')

    def test_ffmetadata_lists_every_chapter_in_milliseconds(self):
        text = vc.ffmetadata_text(_chapters(0, 1.5, 3.25), total_seconds=4)
        self.assertTrue(text.startswith(';FFMETADATA1\n'))
        self.assertEqual(text.count('[CHAPTER]'), 3)
        self.assertIn('START=1500\nEND=3250\n', text)
        self.assertIn('START=3250\nEND=4000\n', text)

    def test_ffmetadata_escapes_special_characters(self):
        chapters = [{'start': 0, 'day': 1, 'date': 'a=b;c#d\\e'}, {'start': 1, 'day': 2, 'date': ''}]
        self.assertIn('title=Jour 1 — a\\=b\\;c\\#d\\\\e\n', vc.ffmetadata_text(chapters, 2))

    def test_timestamps(self):
        self.assertEqual(vc.format_timestamp(0), '0:00')
        self.assertEqual(vc.format_timestamp(65.9), '1:05')
        self.assertEqual(vc.format_timestamp(3725), '1:02:05')

    def test_youtube_list(self):
        text = vc.youtube_text(_chapters(0, 12.5, 30), total_seconds=45)
        self.assertEqual(text, '0:00 Jour 1 — 12/07/2025\n0:12 Jour 2 — 13/07/2025\n0:30 Jour 3 — 14/07/2025\n')

    def test_youtube_merges_short_days_into_the_previous_one(self):
        # Jour 2 : 4 s → rejoint le jour 1 ; le jour 4 (dernier, 6 s) rejoint le 3.
        groups = vc.youtube_groups(_chapters(0, 15, 19, 40, 60), total_seconds=66)
        self.assertEqual([[c['day'] for c in g] for g in groups], [[1, 2], [3], [4, 5]])
        # Premier jour trop court : il rejoint le suivant, le chapitre reste à 0:00.
        groups = vc.youtube_groups(_chapters(0, 5, 20, 40), total_seconds=60)
        self.assertEqual([[c['day'] for c in g] for g in groups], [[1, 2], [3], [4]])
        self.assertTrue(vc.youtube_text(_chapters(0, 15, 19, 40, 60), 66).startswith('0:00 Jours 1 à 2'))

    def test_youtube_rejects_lists_it_would_ignore(self):
        # Moins de trois chapitres une fois les journées courtes regroupées.
        self.assertIsNone(vc.youtube_text(_chapters(0, 15), 40))
        self.assertIsNone(vc.youtube_text(_chapters(0, 5, 9, 30), 35))
        # Durée inconnue : impossible de juger le dernier chapitre.
        self.assertIsNone(vc.youtube_text(_chapters(0, 15, 30), None))

    def test_chapters_file_sits_next_to_the_video(self):
        self.assertEqual(vc.chapters_file_path(os.path.join('v', 'film.mp4')),
                         os.path.join('v', 'film.youtube.txt'))


def _ffmpeg():
    try:
        return _get_ffmpeg_exe()
    except Exception:
        return None


def _probe_chapters(ffmpeg, path):
    """Chapitres lus par ffmpeg : [(début, fin, titre)]."""
    out = subprocess.run([ffmpeg, '-hide_banner', '-i', path], capture_output=True, text=True,
                         encoding='utf-8', errors='replace').stderr
    chapters, current = [], None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('Chapter #'):
            start = float(line.split('start ')[1].split(',')[0])
            end = float(line.split('end ')[1])
            current = [start, end, None]
            chapters.append(current)
        elif current is not None and line.startswith('title') and current[2] is None:
            current[2] = line.split(':', 1)[1].strip()
    return [tuple(c) for c in chapters]


@unittest.skipUnless(_ffmpeg(), 'ffmpeg (imageio-ffmpeg) indisponible')
class EncodingTests(unittest.TestCase):
    """Les deux encodages intègrent les chapitres au MP4 et écrivent la liste
    YouTube à côté."""

    def setUp(self):
        self.tmpdir = canonical_temporary_directory()
        self.addCleanup(self.tmpdir.cleanup)
        self.ffmpeg = _ffmpeg()
        # 40 s à 2 i/s : de quoi tenir trois chapitres YouTube de 10 s.
        self.frames = os.path.join(self.tmpdir.name, 'frames')
        os.makedirs(self.frames)
        subprocess.run([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=2:duration=40',
                        os.path.join(self.frames, 'image_%04d.png')], check=True)
        self.chapters = _chapters(0, 12, 25)

    def _check(self, result, output):
        self.assertTrue(result['success'], result.get('message'))
        probed = _probe_chapters(self.ffmpeg, output)
        self.assertEqual([round(c[0], 1) for c in probed], [0.0, 12.0, 25.0])
        self.assertAlmostEqual(probed[-1][1], 40.0, delta=0.6)
        self.assertEqual(probed[1][2], 'Jour 2 — 13/07/2025')
        self.assertEqual(result['chapters']['count'], 3)
        self.assertEqual(result['chapters']['file'], os.path.basename(vc.chapters_file_path(output)))
        with open(vc.chapters_file_path(output), encoding='utf-8') as f:
            self.assertEqual(f.read(), result['chapters']['youtube'])
        self.assertTrue(result['chapters']['youtube'].startswith('0:00 Jour 1 — 12/07/2025\n0:12 '))

    def test_assembled_pictures_carry_chapters(self):
        output = os.path.join(self.tmpdir.name, 'out', 'film.mp4')
        result = _assemble_pictures(self.frames, output, fps=2, chapters=self.chapters)
        self._check(result, output)

    def test_processed_recording_carries_chapters(self):
        raw = os.path.join(self.tmpdir.name, 'raw.mp4')
        subprocess.run([self.ffmpeg, '-v', 'error', '-framerate', '2', '-i',
                        os.path.join(self.frames, 'image_%04d.png'), '-pix_fmt', 'yuv420p', raw], check=True)
        output = os.path.join(self.tmpdir.name, 'out', 'rec.mp4')
        result = _process_recorded_video(raw, output, fps=2, chapters=self.chapters)
        self._check(result, output)

    def test_chapters_survive_the_music_input(self):
        # Avec une musique, l'entrée des chapitres passe au rang 2.
        audio_dir = os.path.join(self.tmpdir.name, 'audio')
        os.makedirs(audio_dir)
        subprocess.run([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=5',
                        os.path.join(audio_dir, 'bip.wav')], check=True)
        output = os.path.join(self.tmpdir.name, 'out', 'music.mp4')
        with mock.patch('paths.audio_dir', return_value=audio_dir):
            result = _assemble_pictures(self.frames, output, fps=2, audio_path='bip.wav', chapters=self.chapters)
        self._check(result, output)

    def test_without_chapters_nothing_is_added(self):
        output = os.path.join(self.tmpdir.name, 'out', 'plain.mp4')
        result = _assemble_pictures(self.frames, output, fps=2)
        self.assertTrue(result['success'], result.get('message'))
        self.assertEqual(_probe_chapters(self.ffmpeg, output), [])
        self.assertEqual(result['chapters'], {'count': 0, 'youtube': None, 'file': None})
        self.assertFalse(os.path.exists(vc.chapters_file_path(output)))

    def test_unwritable_list_keeps_the_video(self):
        output = os.path.join(self.tmpdir.name, 'out', 'film.mp4')
        real_open = open

        def failing_open(path, *args, **kwargs):
            if str(path).endswith(vc.CHAPTERS_FILE_SUFFIX):
                raise OSError('disque plein')
            return real_open(path, *args, **kwargs)

        with mock.patch('builtins.open', failing_open):
            result = _assemble_pictures(self.frames, output, fps=2, chapters=self.chapters)
        self.assertTrue(result['success'])
        self.assertIsNone(result['chapters']['file'])
        self.assertIsNotNone(result['chapters']['youtube'])


if __name__ == '__main__':
    unittest.main()
