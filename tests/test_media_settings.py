import unittest

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
