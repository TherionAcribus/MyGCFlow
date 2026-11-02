"""Pseudos flottants de Mes poses (poses_names.py).

Écrit aussi tests/fixtures/poses/poses_names.json, que le test JS
(tests/js/poses_names.test.mjs) compare à sa propre table : les deux copies
(Python, JS) ne doivent pas dériver.
"""

import json
import unittest
from pathlib import Path

import poses_names as pn
from settings_manager import AppSettings, MapProfile, coerce_profile, coerce_settings

FIXTURE = Path(__file__).parent / "fixtures" / "poses" / "poses_names.json"


class PosesNamesTests(unittest.TestCase):
    def test_table_fixture_is_up_to_date(self):
        table = pn.poses_names_table()
        expected = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None
        if current != expected:
            FIXTURE.write_text(expected, encoding="utf-8")
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), table)

    def test_defaults_are_disabled_and_valid(self):
        defaults = pn.poses_names_defaults()
        self.assertFalse(defaults["enabled"])
        self.assertEqual(pn.coerce_poses_names(defaults), defaults)

    def test_presets_only_use_known_values(self):
        for name, style in pn.PRESETS.items():
            self.assertEqual(set(style), set(pn.PRESET_KEYS), name)
            coerced = pn.coerce_poses_names(style)
            for key in pn.PRESET_KEYS:
                self.assertEqual(coerced[key], style[key], f"{name}.{key}")

    def test_with_preset_keeps_the_players_choices(self):
        names = pn.coerce_poses_names({"enabled": True, "max_visible": 5, "kinds": {"dnf": True},
                                       "kind_colors": {"ftf": "#123456"}, "font": "serif"})
        burst = pn.with_preset(names, "burst")
        self.assertEqual(burst["direction"], "radial")
        self.assertEqual(burst["font"], "sans")            # style du préréglage
        self.assertEqual(burst["max_visible"], 5)          # densité gardée
        self.assertTrue(burst["kinds"]["dnf"])             # quels logs gardés
        self.assertEqual(burst["kind_colors"]["ftf"], "#123456")
        self.assertEqual(pn.with_preset(names, "inconnu"), names)

    def test_coercion_bounds_and_choices(self):
        names = pn.coerce_poses_names({
            "size": 999, "distance": -5, "emphasis": "1.75", "direction": "nord",
            "color": "rouge", "outline_color": "#ABCDEF", "bold": "oui",
            "template": "{pseudo}\n{code}" + "x" * 200, "kinds": {"note": True, "find": 1},
            "kind_colors": {"dnf": "#FF0000", "loyal": "bleu"},
        })
        self.assertEqual(names["size"], 64)
        self.assertEqual(names["distance"], 0)
        self.assertEqual(names["emphasis"], 1.75)
        self.assertEqual(names["direction"], "up")
        self.assertEqual(names["color"], "#ffffff")
        self.assertEqual(names["outline_color"], "#abcdef")
        self.assertTrue(names["bold"])                       # non booléen refusé
        self.assertNotIn("\n", names["template"])
        self.assertEqual(len(names["template"]), pn.TEMPLATE_MAX)
        self.assertEqual(names["kinds"], {"find": True, "dnf": False, "note": True})
        self.assertEqual(names["kind_colors"]["dnf"], "#ff0000")
        self.assertEqual(names["kind_colors"]["loyal"], "#4fc3f7")

    def test_absent_fields_keep_the_current_value(self):
        current = pn.coerce_poses_names({"enabled": True, "exit": "scatter", "kinds": {"dnf": True}})
        updated = pn.coerce_poses_names({"size": 20}, current)
        self.assertTrue(updated["enabled"])
        self.assertEqual(updated["exit"], "scatter")
        self.assertTrue(updated["kinds"]["dnf"])
        self.assertEqual(updated["size"], 20)
        # Bloc courant incomplet (thème d'une version antérieure) : complété.
        partial = pn.coerce_poses_names({}, {"enabled": True})
        self.assertTrue(partial["enabled"])
        self.assertEqual(partial["path"], "away")

    def test_privacy_coercion(self):
        self.assertEqual(pn.coerce_names_privacy(None), {"mode": "show", "exclude": []})
        privacy = pn.coerce_names_privacy({"mode": "initials", "exclude": "Toto, toto;Titi\n  \nTata"})
        self.assertEqual(privacy, {"mode": "initials", "exclude": ["Toto", "Titi", "Tata"]})
        # Patch partiel : le champ absent garde sa valeur.
        kept = pn.coerce_names_privacy({"mode": "hidden"}, privacy)
        self.assertEqual(kept["exclude"], ["Toto", "Titi", "Tata"])
        self.assertEqual(pn.coerce_names_privacy({"mode": "bof"}, kept)["mode"], "hidden")
        many = pn.coerce_names_privacy({"exclude": [f"p{i}" for i in range(500)] + [3, None]})
        self.assertEqual(len(many["exclude"]), pn.EXCLUDE_MAX)
        long_name = pn.coerce_names_privacy({"exclude": ["x" * 100]})
        self.assertEqual(len(long_name["exclude"][0]), pn.PSEUDO_MAX)

    def test_profile_round_trip(self):
        self.assertEqual(MapProfile().points.poses_names, pn.poses_names_defaults())
        legacy = coerce_profile({"name": "Ancien", "points": {"size": 5}})
        self.assertEqual(legacy.points.poses_names, pn.poses_names_defaults())
        profile = coerce_profile({"name": "Pseudos", "points": {"poses_names": {
            "enabled": True, "path": "toward", "background": "bubble",
        }}})
        self.assertTrue(profile.points.poses_names["enabled"])
        self.assertEqual(profile.points.poses_names["path"], "toward")
        # Un thème modifié sans le bloc garde ses pseudos.
        again = coerce_profile({"points": {"size": 6}}, base=profile)
        self.assertEqual(again.points.poses_names["background"], "bubble")

    def test_global_preference_defaults(self):
        self.assertEqual(AppSettings().poses_names_privacy, pn.privacy_defaults())
        settings = coerce_settings({"poses_names_privacy": {"mode": "hidden", "exclude": ["A"]}})
        self.assertEqual(settings.poses_names_privacy, {"mode": "hidden", "exclude": ["A"]})


if __name__ == "__main__":
    unittest.main()
