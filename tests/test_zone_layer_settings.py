"""Couche de zones de la carte : préférence globale `zones_display` et bloc
`zones` du thème (ZoneLayerOptions). Doc : docs/carte-zones.md › Couche de
la carte."""
import json
import unittest
from pathlib import Path

import settings_manager as sm

ROOT = Path(__file__).resolve().parents[1]


class ZoneLayerProfileTests(unittest.TestCase):
    def test_defaults_mirror_default_values_json(self):
        js = json.loads((ROOT / "static" / "json" / "defaultValues.json").read_text(encoding="utf-8"))["zones"]
        d = sm.ZoneLayerOptions()
        self.assertEqual(
            {"level": d.level, "measure": d.measure, "scale": d.scale, "classes": d.classes, "color": d.color,
             "opacity": d.opacity, "outline": d.outline, "glow": d.glow, "legend": d.legend,
             "legendPosition": d.legend_position, "gridSize": d.grid_size,
             "shareDataset": d.share_dataset, "shareBase": d.share_base,
             "perKm2": d.per_km2, "compareDate": d.compare_date, "solo": d.solo, "labels": d.labels},
            js)

    def test_older_themes_get_defaults(self):
        self.assertEqual(sm.coerce_profile({}).zones, sm.ZoneLayerOptions())

    def test_values_are_checked(self):
        p = sm.coerce_profile({"zones": {
            "level": "region", "measure": "first_day", "scale": "nope", "classes": 99, "opacity": True,
            "color": "#abc", "outline": "oui", "glow": False, "legend_position": "top-right",
        }})
        z = p.zones
        self.assertEqual((z.level, z.measure, z.scale), ("region", "first_day", "quantile"))
        self.assertEqual(z.classes, sm.ZONE_LAYER_CLASSES_RANGE[1])
        self.assertEqual(z.opacity, sm.ZoneLayerOptions().opacity)   # un booléen n'est pas un nombre
        self.assertEqual(z.color, "#aabbcc")
        self.assertTrue(z.outline)                                    # valeur corrompue : défaut
        self.assertFalse(z.glow)
        self.assertEqual(z.legend_position, "top-right")

    def test_grid_size_is_a_known_size(self):
        self.assertEqual(sm.coerce_profile({"zones": {"level": "grid", "grid_size": 50}}).zones.grid_size, 50)
        self.assertEqual(sm.coerce_profile({"zones": {"grid_size": 7}}).zones.grid_size, 25)
        self.assertEqual(sm.coerce_profile({"zones": {"grid_size": True}}).zones.grid_size, 25)

    def test_found_share_options(self):
        z = sm.coerce_profile({"zones": {"measure": "found_share", "share_dataset": 3, "share_base": "all"}}).zones
        self.assertEqual((z.measure, z.share_dataset, z.share_base), ("found_share", 3, "all"))
        for bad in (True, -1, "3", 1.5):
            self.assertEqual(sm.coerce_profile({"zones": {"share_dataset": bad}}).zones.share_dataset, 0)
        self.assertEqual(sm.coerce_profile({"zones": {"share_base": "x"}}).zones.share_base, "active")

    def test_labels_option(self):
        self.assertFalse(sm.ZoneLayerOptions().labels)
        self.assertTrue(sm.coerce_profile({"zones": {"labels": True}}).zones.labels)
        self.assertFalse(sm.coerce_profile({"zones": {"labels": "oui"}}).zones.labels)

    def test_round_trip_through_the_theme_payload(self):
        manager = sm.SettingsManager.__new__(sm.SettingsManager)
        profile = sm.coerce_profile({"zones": {"level": "country", "color": "#123456"}})
        payload = sm.SettingsManager._profile_to_dict(manager, profile)
        self.assertEqual(payload["zones"]["level"], "country")
        self.assertEqual(sm.coerce_profile(payload).zones, profile.zones)


class ZonesDisplayPreferenceTests(unittest.TestCase):
    def test_default_off_and_strict_boolean(self):
        self.assertFalse(sm.AppSettings().zones_display)
        self.assertTrue(sm.coerce_settings({"zones_display": True}).zones_display)
        self.assertFalse(sm.coerce_settings({"zones_display": "yes"}).zones_display)


if __name__ == "__main__":
    unittest.main()
