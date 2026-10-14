import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from werkzeug.datastructures import FileStorage

import capture
from blueprints.media import DEFAULT_FPS, _parse_fps


class MediaSettingsTests(unittest.TestCase):
    def test_default_fps_matches_standard_profile(self):
        self.assertEqual(DEFAULT_FPS, 30)
        self.assertEqual(_parse_fps(None), 30)

    def test_fps_is_bounded_for_direct_api_calls(self):
        self.assertEqual(_parse_fps(300), 60)
        self.assertEqual(_parse_fps(-10), 1)
        self.assertEqual(_parse_fps(29.6), 30)


if __name__ == "__main__":
    unittest.main()


class ColorFidelityEncodingTests(unittest.TestCase):
    """Traduction du réglage « Couleurs » en arguments ffmpeg.

    Le 4:4:4 corrige les couleurs mais exige un profil H.264 que certains
    lecteurs refusent : une valeur inconnue ne doit jamais y mener.
    """

    def test_the_compatible_setting_keeps_the_widely_readable_format(self):
        args = capture._h264_output_args("compatible")
        self.assertIn("yuv420p", args)
        self.assertNotIn("yuv444p", args)

    def test_the_faithful_setting_asks_for_full_colour_resolution(self):
        self.assertIn("yuv444p", capture._h264_output_args("fidele"))

    def test_an_unknown_setting_falls_back_to_the_compatible_format(self):
        for value in (None, "", "yuv444p", "FIDELE"):
            self.assertIn("yuv420p", capture._h264_output_args(value))

    def test_the_default_is_the_compatible_format(self):
        self.assertIn("yuv420p", capture._h264_output_args())
        self.assertEqual(capture.coerce_color_fidelity("inconnu"), "compatible")
        self.assertEqual(capture.coerce_color_fidelity("fidele"), "fidele")


class AudioFadeOutFilterTests(unittest.TestCase):
    """Fondu de sortie de la musique, quand elle dépasse la durée de la vidéo."""

    def test_no_fade_is_requested_by_default(self):
        self.assertEqual(capture._audio_filter_chain(0.5, 60.0), "volume=0.5,apad")

    def test_the_fade_ends_exactly_at_the_end_of_the_video(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 180.0, 3.0),
            "volume=1.0,afade=t=out:st=177.000:d=3.000,apad",
        )

    def test_the_fade_never_lasts_longer_than_the_video(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 2.0, 3.0),
            "volume=1.0,afade=t=out:st=0.000:d=2.000,apad",
        )

    def test_no_fade_without_a_known_output_duration(self):
        # Sans durée de sortie, impossible de placer le fondu : on ne pose rien
        # plutôt qu'un fondu au mauvais endroit.
        self.assertEqual(capture._audio_filter_chain(1.0, None, 3.0, pad=False), "volume=1.0")

    def test_the_requested_duration_is_sanitised(self):
        self.assertEqual(capture._safe_fade_out("3"), 3.0)
        self.assertEqual(capture._safe_fade_out(9999), capture.MAX_AUDIO_FADE_OUT_SECONDS)
        for value in (None, "", "abc", -2, 0, float("nan"), float("inf")):
            self.assertEqual(capture._safe_fade_out(value), 0.0)


class AudioLoopFilterTests(unittest.TestCase):
    """Répétition de la musique quand elle est plus courte que la vidéo."""

    def test_the_whole_track_is_looped_before_the_final_padding(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, loop=True),
            "volume=1.0,aloop=loop=-1:size=2147483647,apad",
        )

    def test_the_loop_stops_before_an_ignored_trailing_silence(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, loop=True, loop_end=42.5),
            "volume=1.0,atrim=end=42.500,aloop=loop=-1:size=2147483647,apad",
        )

    def test_a_looped_track_can_still_fade_out_at_the_end_of_the_video(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, 3.0, loop=True),
            "volume=1.0,aloop=loop=-1:size=2147483647,afade=t=out:st=57.000:d=3.000,apad",
        )

    def test_no_endless_loop_without_a_known_output_duration(self):
        self.assertEqual(capture._audio_filter_chain(1.0, None, loop=True, pad=False), "volume=1.0")

    def test_client_values_are_sanitised(self):
        for value in (True, 1, "1", "true", "on"):
            self.assertTrue(capture._truthy(value))
        for value in (False, 0, None, "", "0", "false"):
            self.assertFalse(capture._truthy(value))
        self.assertEqual(capture._safe_loop_end("12.5"), 12.5)
        for value in (None, "abc", -1, 0, float("nan"), float("inf")):
            self.assertEqual(capture._safe_loop_end(value), 0.0)


class AudioFadeInFilterTests(unittest.TestCase):
    """Fondu d'entrée de la musique, au début de la vidéo."""

    def test_the_music_rises_at_the_start_of_the_video(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, fade_in=2.0),
            "volume=1.0,afade=t=in:st=0:d=2.000,apad",
        )

    def test_the_fade_in_follows_the_loop_so_it_is_played_once(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, 3.0, loop=True, start=1.0, fade_in=2.0),
            "volume=1.0,atrim=start=1.000,asetpts=PTS-STARTPTS,aloop=loop=-1:size=2147483647,"
            "afade=t=in:st=0:d=2.000,afade=t=out:st=57.000:d=3.000,apad",
        )

    def test_the_fade_in_never_lasts_longer_than_the_video(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 1.5, fade_in=2.0),
            "volume=1.0,afade=t=in:st=0:d=1.500,apad",
        )


class AudioStartFilterTests(unittest.TestCase):
    """Point de départ dans la musique (intro sautée)."""

    def test_the_intro_is_skipped_and_the_track_restarts_at_zero(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, start=12.5),
            "volume=1.0,atrim=start=12.500,asetpts=PTS-STARTPTS,apad",
        )

    def test_the_loop_repeats_from_the_start_point_to_the_loop_end(self):
        # loop_end est une position dans le fichier : 42,5 s − 12,5 s de départ.
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, 3.0, loop=True, loop_end=42.5, start=12.5),
            "volume=1.0,atrim=start=12.500,asetpts=PTS-STARTPTS,atrim=end=30.000,"
            "aloop=loop=-1:size=2147483647,afade=t=out:st=57.000:d=3.000,apad",
        )

    def test_a_loop_end_before_the_start_is_ignored(self):
        self.assertEqual(
            capture._audio_filter_chain(1.0, 60.0, loop=True, loop_end=5.0, start=12.5),
            "volume=1.0,atrim=start=12.500,asetpts=PTS-STARTPTS,aloop=loop=-1:size=2147483647,apad",
        )

    def test_client_values_are_sanitised(self):
        self.assertEqual(capture._safe_start("12.5"), 12.5)
        for value in (None, "abc", -1, 0, float("nan"), float("inf")):
            self.assertEqual(capture._safe_start(value), 0.0)


class UploadedAudioStorageTests(unittest.TestCase):
    """Musiques reçues : rangées dans audio/ sous un nom tiré de leur contenu."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "audio"
        patcher = mock.patch.object(capture.paths, "audio_dir", return_value=self.folder)
        patcher.start()
        self.addCleanup(patcher.stop)

    def save(self, filename, content):
        return capture._save_uploaded_audio(FileStorage(stream=io.BytesIO(content), filename=filename))

    def test_the_saved_file_keeps_the_content_and_a_readable_name(self):
        name = self.save("Ma musique.MP3", b"son")
        self.assertRegex(name, r"^Ma_musique-[0-9a-f]{16}\.mp3$")
        self.assertEqual((self.folder / name).read_bytes(), b"son")

    def test_two_different_tracks_with_the_same_name_do_not_overwrite_each_other(self):
        first = self.save("music.mp3", b"premier")
        second = self.save("music.mp3", b"second")
        self.assertNotEqual(first, second)
        self.assertEqual((self.folder / first).read_bytes(), b"premier")
        self.assertEqual((self.folder / second).read_bytes(), b"second")

    def test_sending_the_same_track_again_reuses_the_stored_file(self):
        self.assertEqual(self.save("music.mp3", b"son"), self.save("music.mp3", b"son"))
        self.assertEqual(len(list(self.folder.iterdir())), 1)

    def test_a_name_emptied_by_sanitising_still_gives_a_usable_file(self):
        # secure_filename vide ces noms : la sauvegarde visait alors le dossier.
        for filename in ("音楽.mp3", "...", "", "<>.wav"):
            with self.subTest(filename=filename):
                name = self.save(filename, filename.encode() or b"x")
                self.assertTrue(name.startswith("music-"), name)
                self.assertTrue((self.folder / name).is_file())
        self.assertTrue(self.save("音楽.mp3", b"y").endswith(".mp3"))

    def test_an_unusual_extension_is_dropped(self):
        self.assertRegex(self.save("piste.mp3;rm", b"son"), r"^piste-[0-9a-f]{16}$")

    def test_a_stored_track_is_served_back_by_its_name(self):
        from app import create_app
        name = self.save("music.mp3", b"son")
        app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{self.folder.parent / 'test.db'}"})
        client = app.test_client()
        response = client.get(f"/audio/{name}")
        self.assertEqual((response.status_code, response.data), (200, b"son"))
        response.close()
        for missing in ("absent.mp3", "..%2F..%2Fsettings.json"):
            with self.subTest(missing=missing):
                self.assertEqual(client.get(f"/audio/{missing}").status_code, 404)
        with app.app_context():
            from extensions import db
            db.engine.dispose()

    def test_no_temporary_file_is_left_behind(self):
        self.save("music.mp3", b"son")
        self.save("music.mp3", b"son")
        self.assertEqual([p.name for p in self.folder.iterdir() if p.name.startswith(".upload-")], [])
