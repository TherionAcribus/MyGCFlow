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
