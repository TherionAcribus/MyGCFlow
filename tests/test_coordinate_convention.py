import unittest

from settings_manager import (
    COORDINATE_ORDER_VERSION,
    AppSettings,
    MapOptions,
    MapProfile,
    coerce_profile,
    coerce_settings,
)


class CoordinateConventionTests(unittest.TestCase):
    def test_new_defaults_use_lon_lat_and_current_schema(self):
        self.assertEqual(AppSettings().version, COORDINATE_ORDER_VERSION)
        self.assertEqual(MapProfile().version, COORDINATE_ORDER_VERSION)
        self.assertEqual(MapOptions().default_center, (2.3522, 48.8566))

    def test_legacy_settings_center_is_migrated_from_lat_lon(self):
        settings = coerce_settings({
            "version": 1,
            "map_default_center": [45.7640, 4.8357],
        })

        self.assertEqual(settings.version, COORDINATE_ORDER_VERSION)
        self.assertEqual(settings.map_default_center, (4.8357, 45.7640))

    def test_legacy_profile_center_is_migrated_from_lat_lon(self):
        profile = coerce_profile({
            "version": 1,
            "map": {"default_center": [48.8566, 2.3522]},
        })

        self.assertEqual(profile.version, COORDINATE_ORDER_VERSION)
        self.assertEqual(profile.map.default_center, (2.3522, 48.8566))

    def test_current_schema_preserves_lon_lat(self):
        profile = coerce_profile({
            "version": COORDINATE_ORDER_VERSION,
            "map": {"default_center": [4.8357, 45.7640]},
        })

        self.assertEqual(profile.map.default_center, (4.8357, 45.7640))

    def test_missing_legacy_center_keeps_current_default(self):
        profile = coerce_profile({"version": 1, "map": {}})

        self.assertEqual(profile.map.default_center, (2.3522, 48.8566))


if __name__ == "__main__":
    unittest.main()
