"""Animation des points de Mes poses (poses_effects.py).

Écrit aussi tests/fixtures/poses/poses_effects.json, que le test JS
(tests/js/poses_effects.test.mjs) compare à sa propre table : les deux
copies (Python, JS) ne doivent pas dériver.
"""

import json
import unittest
from pathlib import Path

import poses_effects as pe
from settings_manager import MapProfile, coerce_profile

FIXTURE = Path(__file__).parent / "fixtures" / "poses" / "poses_effects.json"


class PosesEffectsTests(unittest.TestCase):
    def test_table_fixture_is_up_to_date(self):
        table = pe.poses_effects_table()
        expected = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None
        if current != expected:
            FIXTURE.write_text(expected, encoding="utf-8")
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), table)

    def test_defaults_are_sober(self):
        defaults = pe.poses_effects_defaults()
        self.assertEqual(defaults["level"], "sober")
        self.assertEqual(pe.level_of(defaults), "sober")

    def test_coercion_bounds_and_choices(self):
        effects = pe.coerce_poses_effects({
            "popularity": {"enabled": True, "scale": "bogus", "max_scale": 99},
            "activity": {"color": "rouge", "half_life_days": 0, "intensity": "50"},
            "freshness": {"after_days": 1, "strength": True},
            "archived_style": "ghost",
            "disabled_pulse": "oui",
        })
        self.assertTrue(effects["popularity"]["enabled"])
        self.assertEqual(effects["popularity"]["scale"], "relative")
        self.assertEqual(effects["popularity"]["max_scale"], 4.0)
        self.assertEqual(effects["activity"]["color"], "#ffb300")
        self.assertEqual(effects["activity"]["half_life_days"], 1)
        self.assertEqual(effects["activity"]["intensity"], 50)
        self.assertEqual(effects["freshness"]["after_days"], 7)
        self.assertEqual(effects["freshness"]["strength"], 70)      # booléen refusé
        self.assertEqual(effects["archived_style"], "ghost")
        self.assertFalse(effects["disabled_pulse"])                  # non booléen refusé

    def test_level_follows_the_toggles(self):
        balanced = pe.coerce_poses_effects({
            "level": "rich",  # contredit les cases : jamais retenu
            "popularity": {"enabled": True}, "freshness": {"enabled": True}, "milestone_flash": True,
        })
        self.assertEqual(balanced["level"], "balanced")
        custom = pe.coerce_poses_effects({"activity": {"enabled": True}})
        self.assertEqual(custom["level"], "custom")

    def test_absent_fields_keep_the_current_value(self):
        current = pe.coerce_poses_effects({"activity": {"enabled": True, "half_life_days": 30}})
        updated = pe.coerce_poses_effects({"activity": {"color": "#00FF00"}}, current)
        self.assertTrue(updated["activity"]["enabled"])
        self.assertEqual(updated["activity"]["half_life_days"], 30)
        self.assertEqual(updated["activity"]["color"], "#00ff00")

    def test_profile_round_trip(self):
        self.assertEqual(MapProfile().points.poses_effects, pe.poses_effects_defaults())
        legacy = coerce_profile({"name": "Ancien", "points": {"size": 5}})
        self.assertEqual(legacy.points.poses_effects, pe.poses_effects_defaults())
        profile = coerce_profile({"name": "Riche", "points": {"poses_effects": {
            "popularity": {"enabled": True, "scale": "fixed"}, "activity": {"enabled": True},
            "freshness": {"enabled": True}, "milestone_flash": True, "disabled_pulse": True,
        }}})
        self.assertEqual(profile.points.poses_effects["level"], "rich")
        self.assertEqual(profile.points.poses_effects["popularity"]["scale"], "fixed")
        # Un thème modifié sans le bloc garde ses effets.
        again = coerce_profile({"points": {"size": 6}}, base=profile)
        self.assertEqual(again.points.poses_effects["level"], "rich")


if __name__ == "__main__":
    unittest.main()
