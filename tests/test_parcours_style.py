"""Apparence des étapes et du trait de la page Parcours (parcours_style.py).

Écrit aussi tests/fixtures/parcours/parcours_style.json, que le test JS
(tests/js/parcours_style.test.mjs) compare à sa copie des défauts, choix et
bornes.
"""

import json
import unittest
from pathlib import Path

import parcours_style as ps
from settings_manager import MapProfile, coerce_profile

FIXTURE = Path(__file__).parent / "fixtures" / "parcours" / "parcours_style.json"


class ParcoursStyleTests(unittest.TestCase):
    def test_table_fixture_is_up_to_date(self):
        table = ps.parcours_style_table()
        expected = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None
        if current != expected:
            FIXTURE.write_text(expected, encoding="utf-8")
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), table)

    def test_defaults_keep_the_previous_look(self):
        defaults = ps.parcours_style_defaults()
        self.assertEqual(defaults["size"], 11)
        self.assertEqual(defaults["numbers"], "trip")
        self.assertEqual(defaults["plan_line"], "dashed")
        self.assertEqual(defaults["colors"]["find"], "#0072c6")
        self.assertEqual(ps.coerce_parcours_style(None), defaults)

    def test_coercion_bounds_and_choices(self):
        out = ps.coerce_parcours_style({
            "size": 40, "numbers": "everywhere", "plan_line": "solid",
            "trail_color": "#ABCDEF", "trail_width": 0, "trail_opacity": "55",
            "colors": {"lab": "#FFFFFF", "dnf": "red", "unknown": "#000000"},
        })
        self.assertEqual(out["size"], 18)
        self.assertEqual(out["numbers"], "trip")
        self.assertEqual(out["plan_line"], "solid")
        self.assertEqual(out["trail_color"], "#abcdef")
        self.assertEqual(out["trail_width"], 1)
        self.assertEqual(out["trail_opacity"], 55)
        self.assertEqual(out["colors"]["lab"], "#ffffff")
        self.assertEqual(out["colors"]["dnf"], "#868e96")
        self.assertNotIn("unknown", out["colors"])
        self.assertEqual(ps.coerce_parcours_style({"size": True})["size"], 11)
        self.assertEqual(ps.coerce_parcours_style({"size": float("nan")})["size"], 11)
        # Couleur par journée / type, trait aux couleurs des journées.
        self.assertEqual(ps.coerce_parcours_style({"color_by": "day"})["color_by"], "day")
        self.assertEqual(ps.coerce_parcours_style({"color_by": "rainbow"})["color_by"], "kind")
        self.assertIs(ps.coerce_parcours_style({"trail_by_day": True})["trail_by_day"], True)
        self.assertIs(ps.coerce_parcours_style({"trail_by_day": "yes"})["trail_by_day"], False)
        self.assertIs(ps.coerce_parcours_style({}, {"trail_by_day": True})["trail_by_day"], True)

    def test_absent_fields_keep_the_current_value(self):
        current = ps.coerce_parcours_style({"numbers": "day", "colors": {"find": "#112233"}})
        out = ps.coerce_parcours_style({"size": 9}, current)
        self.assertEqual(out["numbers"], "day")
        self.assertEqual(out["colors"]["find"], "#112233")
        self.assertEqual(out["size"], 9)
        # Bloc courant incomplet (version antérieure) : complété.
        self.assertEqual(ps.coerce_parcours_style({}, {"size": 8})["trail_width"], 3)

    def test_profile_round_trip(self):
        self.assertEqual(MapProfile().points.parcours_style, ps.parcours_style_defaults())
        legacy = coerce_profile({"name": "Ancien", "points": {"size": 5}})
        self.assertEqual(legacy.points.parcours_style, ps.parcours_style_defaults())
        profile = coerce_profile({"name": "Étapes", "points": {"parcours_style": {
            "numbers": "none", "trail_color": "#ff0000",
        }}})
        self.assertEqual(profile.points.parcours_style["numbers"], "none")
        self.assertEqual(profile.points.parcours_style["trail_color"], "#ff0000")
        # Un thème modifié sans le bloc garde ses réglages.
        again = coerce_profile({"points": {"size": 6}}, base=profile)
        self.assertEqual(again.points.parcours_style["numbers"], "none")


if __name__ == "__main__":
    unittest.main()
