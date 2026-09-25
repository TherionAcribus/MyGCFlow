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
        # Le centre/zoom ne sont plus un réglage de thème : état de vue
        # (session) ou préférence globale (map_default_center), jamais un
        # attribut de MapOptions.
        self.assertFalse(hasattr(MapOptions(), "default_center"))
        self.assertFalse(hasattr(MapOptions(), "default_zoom"))

    def test_legacy_settings_center_is_migrated_from_lat_lon(self):
        settings = coerce_settings({
            "version": 1,
            "map_default_center": [45.7640, 4.8357],
        })

        self.assertEqual(settings.version, COORDINATE_ORDER_VERSION)
        self.assertEqual(settings.map_default_center, (4.8357, 45.7640))

    def test_legacy_profile_center_is_ignored(self):
        # Le fichier d'un ancien thème pouvait contenir default_center /
        # default_zoom : ils restent lisibles (pas d'erreur) mais ignorés —
        # appliquer un thème ne doit pas déplacer la vue courante.
        profile = coerce_profile({
            "version": 1,
            "map": {"default_center": [48.8566, 2.3522], "default_zoom": 9},
        })

        self.assertEqual(profile.version, COORDINATE_ORDER_VERSION)
        self.assertFalse(hasattr(profile.map, "default_center"))
        self.assertFalse(hasattr(profile.map, "default_zoom"))


if __name__ == "__main__":
    unittest.main()
