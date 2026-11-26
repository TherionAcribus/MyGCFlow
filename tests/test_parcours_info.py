"""Fiche des caches de la page Parcours (parcours_info.py).

Écrit aussi tests/fixtures/parcours/parcours_info.json, que le test JS
(tests/js/parcours_info.test.mjs) compare à sa copie des défauts, choix et
bornes.
"""

import json
import unittest
from pathlib import Path

import parcours_info as pi
from settings_manager import MapProfile, coerce_profile

FIXTURE = Path(__file__).parent / "fixtures" / "parcours" / "parcours_info.json"


class ParcoursInfoTests(unittest.TestCase):
    def test_table_fixture_is_up_to_date(self):
        table = pi.parcours_info_table()
        expected = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None
        if current != expected:
            FIXTURE.write_text(expected, encoding="utf-8")
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), table)

    def test_defaults_keep_the_card_off(self):
        defaults = pi.parcours_info_defaults()
        self.assertEqual(defaults["near"], "none")
        self.assertEqual(defaults["fixed"], "none")
        self.assertTrue(defaults["name"])
        self.assertFalse(defaults["owner"])
        self.assertEqual(pi.coerce_parcours_info(None), defaults)

    def test_coercion_bounds_and_choices(self):
        out = pi.coerce_parcours_info({
            "near": "all", "fixed": "middle", "duration": 99, "size": "4",
            "design": "banner", "font": "comic", "accent": "fixed",
            "text_color": "#ABCDEF", "background_color": "white", "background_opacity": -5,
            "owner": True, "dt": "yes",
        })
        self.assertEqual(out["near"], "all")
        self.assertEqual(out["fixed"], "none")
        self.assertEqual(out["duration"], 15)
        self.assertEqual(out["size"], 9)
        self.assertEqual(out["design"], "banner")
        self.assertEqual(out["font"], "sans")
        self.assertEqual(out["accent"], "fixed")
        self.assertEqual(out["text_color"], "#abcdef")
        self.assertEqual(out["background_color"], "#ffffff")
        self.assertEqual(out["background_opacity"], 0)
        self.assertIs(out["owner"], True)
        self.assertIs(out["dt"], True)
        self.assertEqual(pi.coerce_parcours_info({"size": True})["size"], 13)
        self.assertEqual(pi.coerce_parcours_info({"size": float("nan")})["size"], 13)

    def test_absent_fields_keep_the_current_value(self):
        current = pi.coerce_parcours_info({"near": "current", "fixed": "bottom", "name": False})
        out = pi.coerce_parcours_info({"size": 20}, current)
        self.assertEqual(out["near"], "current")
        self.assertEqual(out["fixed"], "bottom")
        self.assertIs(out["name"], False)
        self.assertEqual(out["size"], 20)
        self.assertNotIn("unknown", pi.coerce_parcours_info({"unknown": 1}))

    def test_profile_round_trip(self):
        profile = coerce_profile({"points": {"parcours_info": {"near": "all", "design": "tag", "size": 40}}})
        self.assertIsInstance(profile, MapProfile)
        self.assertEqual(profile.points.parcours_info["near"], "all")
        self.assertEqual(profile.points.parcours_info["design"], "tag")
        self.assertEqual(profile.points.parcours_info["size"], 28)
        # Thème antérieur : bloc absent → défauts.
        self.assertEqual(coerce_profile({"points": {}}).points.parcours_info, pi.parcours_info_defaults())


if __name__ == "__main__":
    unittest.main()
