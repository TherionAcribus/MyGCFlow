import json
import shutil
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import (
    AnimationPrefs,
    SettingsManager,
    TrailOptions,
    coerce_animation_settings,
    coerce_profile,
)


class TrailCoercionTests(unittest.TestCase):
    """Traits de déplacement : seules des valeurs que l'interface sait rendre."""

    def test_defaults(self):
        trail = coerce_profile({}).trail
        self.assertFalse(trail.enabled)
        self.assertEqual(trail, TrailOptions())

    def test_invalid_values_keep_the_previous_ones(self):
        base = coerce_profile({"trail": {"routing": "day", "color": "#123456", "persist_days": 90}})
        trail = coerce_profile({"trail": {
            "routing": "teleport",
            "jump_style": "zigzag",
            "color": "javascript:alert(1)",
            "persist_days": 12,
            "line_style": None,
        }}, base=base).trail
        self.assertEqual(trail.routing, "day")
        self.assertEqual(trail.jump_style, "arc")
        self.assertEqual(trail.color, "#123456")
        self.assertEqual(trail.persist_days, 90)
        self.assertEqual(trail.line_style, "solid")

    def test_bounds(self):
        trail = coerce_profile({"trail": {
            "cluster_km": 0, "jump_km": 999999, "width": 100, "opacity": 1,
        }}).trail
        self.assertEqual(trail.cluster_km, 0.1)
        self.assertEqual(trail.jump_km, 5000)
        self.assertEqual(trail.width, 20)
        self.assertEqual(trail.opacity, 10)

    def test_whole_route_is_a_valid_persistence_but_false_is_not(self):
        self.assertEqual(coerce_profile({"trail": {"persist_days": 0}}).trail.persist_days, 0)
        self.assertEqual(coerce_profile({"trail": {"persist_days": "365"}}).trail.persist_days, 365)
        # False vaudrait 0 (« tout le parcours ») : un booléen n'est pas une durée.
        self.assertEqual(coerce_profile({"trail": {"persist_days": False}}).trail.persist_days, 30)

    def test_trail_duration_is_a_bounded_global_preference(self):
        self.assertEqual(AnimationPrefs().trail_duration_ms, 800)
        self.assertEqual(coerce_animation_settings({"trail_duration_ms": 5}).trail_duration_ms, 100)
        self.assertEqual(coerce_animation_settings({"trail_duration_ms": 1500}).trail_duration_ms, 1500)
        # Jamais dans le thème : c'est un réglage temporel.
        self.assertNotIn("duration", asdict(TrailOptions()))


class TrailDefaultsMatchTheClientTests(unittest.TestCase):
    """Même précaution que pour l'enregistrement : le client démarre sur
    static/json/defaultValues.json avant qu'un thème soit appliqué."""

    def test_the_trail_defaults_are_the_same_on_both_sides(self):
        path = Path(__file__).resolve().parents[1] / "static" / "json" / "defaultValues.json"
        client = json.loads(path.read_text(encoding="utf-8"))["trail"]
        server = TrailOptions()
        self.assertEqual(client, {
            "enabled": server.enabled,
            "routing": server.routing,
            "clusterKm": server.cluster_km,
            "jumpKm": server.jump_km,
            "jumpStyle": server.jump_style,
            "curve": server.curve,
            "color": server.color,
            "width": server.width,
            "opacity": server.opacity,
            "lineStyle": server.line_style,
            "effect": server.effect,
            "head": server.head,
            "persistDays": server.persist_days,
            "duration": AnimationPrefs().trail_duration_ms,
        })


class TrailProfileStorageTests(unittest.TestCase):
    def setUp(self):
        # Même isolation que test_point_appear_profile : jamais le %APPDATA% réel.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-trail-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

    def test_disabled_by_default(self):
        self.manager.create_profile("Neuf")
        self.assertFalse(self.manager.load_profile("Neuf").trail.enabled)

    def test_round_trip(self):
        self.manager.create_profile("Trajet")
        profile = self.manager.load_profile("Trajet")
        profile.trail.enabled = True
        profile.trail.routing = "all"
        profile.trail.persist_days = 0
        profile.trail.color = "#abcdef"
        self.manager.save_profile(profile)

        loaded = self.manager.load_profile("Trajet").trail
        self.assertTrue(loaded.enabled)
        self.assertEqual(loaded.routing, "all")
        self.assertEqual(loaded.persist_days, 0)
        self.assertEqual(loaded.color, "#abcdef")
        exported = self.manager._profile_to_dict(self.manager.load_profile("Trajet"))
        self.assertEqual(exported["trail"], asdict(loaded))

    def test_profile_saved_before_the_trail_existed_loads_disabled(self):
        self.manager.create_profile("Ancien")
        path = next(settings_manager.PROFILES_DIR.glob("*.json"))
        data = json.loads(path.read_text(encoding="utf-8"))
        data.pop("trail", None)
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.manager.load_profile("Ancien").trail, TrailOptions())


class TrailProfileApiTests(unittest.TestCase):
    """PUT /api/profiles : la section `trail` est fusionnée comme les autres.

    Sans son entrée dans le tuple des sections du blueprint, elle serait
    ignorée sans erreur et le trait ne serait jamais sauvegardé.
    """

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-trail-api-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = Flask(__name__)
        app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = app.test_client()

        prof = self.manager.create_profile("Alpha")
        prof.trail.width = 7
        self.manager.save_profile(prof)

    def test_partial_patch_saves_the_trail(self):
        resp = self.client.put("/api/profiles/Alpha", json={
            "name": "Alpha",
            "trail": {"enabled": True, "head": "pulse", "width": 999, "duration": 5000},
        })
        self.assertEqual(resp.status_code, 200)
        trail = self.manager.load_profile("Alpha").trail
        self.assertTrue(trail.enabled)
        self.assertEqual(trail.head, "pulse")
        self.assertEqual(trail.width, 20)
        saved = settings_manager.read_json(settings_manager.PROFILES_DIR / "Alpha.json")
        self.assertNotIn("duration", saved["trail"])

    def test_patch_without_trail_keeps_it(self):
        self.client.put("/api/profiles/Alpha", json={"name": "Alpha", "points": {"size": 4}})
        self.assertEqual(self.manager.load_profile("Alpha").trail.width, 7)


if __name__ == "__main__":
    unittest.main()
