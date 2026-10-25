"""Flashs par événement de Mes poses (event_flash.py).

Écrit aussi tests/fixtures/flash/event_flash_kinds.json, que le test JS
(tests/js/event_flash.test.mjs) compare à sa propre table : les deux copies
(Python, JS) ne doivent pas dériver.
"""

import json
import unittest
from pathlib import Path

import event_flash as ef
from settings_manager import MapProfile, coerce_profile

FIXTURE = Path(__file__).parent / "fixtures" / "flash" / "event_flash_kinds.json"


class EventFlashTests(unittest.TestCase):
    def test_table_fixture_is_up_to_date(self):
        table = ef.event_flash_table()
        expected = json.dumps(table, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None
        if current != expected:
            FIXTURE.write_text(expected, encoding="utf-8")
        self.assertEqual(json.loads(FIXTURE.read_text(encoding="utf-8")), table)

    def test_priority_order(self):
        self.assertEqual(ef.EVENT_FLASH_KEYS[:4], ("archive", "disable", "enable", "publish"))
        self.assertLess(ef.EVENT_FLASH_KEYS.index("favorite"), ef.EVENT_FLASH_KEYS.index("find"))

    def test_coercion(self):
        events = ef.coerce_event_flashes({
            "find": {"mode": "bogus", "size": 999, "color": "rouge"},
            "favorite": {"mode": "fireworks", "color": "#ABCDEF"},
            "inconnu": {"mode": "star"},
        })
        self.assertEqual(set(events), set(ef.EVENT_FLASH_KEYS))
        self.assertEqual(events["find"]["mode"], "circle")
        self.assertEqual(events["find"]["size"], 200)
        self.assertEqual(events["find"]["color"], "#ffffff")
        self.assertEqual(events["favorite"]["mode"], "fireworks")
        self.assertEqual(events["favorite"]["color"], "#abcdef")

    def test_absent_fields_keep_the_current_value(self):
        current = ef.coerce_event_flashes({"dnf": {"mode": "star", "size": 50}})
        updated = ef.coerce_event_flashes({"dnf": {"color": "#000000"}}, current)
        self.assertEqual(updated["dnf"]["mode"], "star")
        self.assertEqual(updated["dnf"]["size"], 50)
        self.assertEqual(updated["dnf"]["color"], "#000000")

    def test_legacy_theme_gets_the_defaults(self):
        profile = coerce_profile({"name": "Ancien", "flash": {"mode": "circle"}})
        self.assertEqual(profile.flash.events, ef.event_flash_defaults())
        self.assertEqual(MapProfile().flash.events["publish"]["mode"], "same")

    def test_sizes_scale_between_modes(self):
        scaled = ef.scale_event_flash_sizes(ef.event_flash_defaults(), 0.5)
        self.assertEqual(scaled["archive"]["size"], 20)
        self.assertEqual(scaled["note"]["size"], 8)


if __name__ == "__main__":
    unittest.main()
