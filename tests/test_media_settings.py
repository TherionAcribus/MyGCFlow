import unittest

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
