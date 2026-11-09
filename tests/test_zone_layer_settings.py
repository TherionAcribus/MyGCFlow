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
             "legendPosition": d.legend_position},
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
