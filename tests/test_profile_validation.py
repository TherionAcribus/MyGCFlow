import shutil
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import MapProfile, SettingsManager, coerce_profile


class CoerceProfileTests(unittest.TestCase):
    """Un thème ne peut porter que des valeurs que l'interface sait rendre.

    Avant, seuls le titre et le CSS étaient contrôlés : un thème importé ou
    édité à la main pouvait contenir une forme inconnue, une taille de 99999 ou
    une couleur illisible, stockées telles quelles puis appliquées à la carte.
    """

    def test_every_example_theme_survives_validation_unchanged(self):
        for name, prof in SettingsManager._example_profile_definitions().items():
            with self.subTest(name=name):
                coerced = coerce_profile(asdict(prof))
                self.assertEqual(coerced.map, prof.map)
                self.assertEqual(coerced.points, prof.points)
                self.assertEqual(coerced.flash, prof.flash)

    def test_invalid_values_fall_back_to_the_defaults(self):
        defaults = MapProfile()
        prof = coerce_profile({
            "map": {
                "tile_provider": "GoogleEarth",
                "vector_options": {"stroke_color": "red", "stroke_width": "épais"},
                "toner_options": {"variant": "sepia"},
            },
            "points": {
                "shape": "hexagon", "mode": "3d", "icon_set": "emoji",
                "color": 12, "border_color": "#12345", "fill_color_type": "rainbow",
            },
            "flash": {"mode": "explosion", "color": None, "color_type": "x"},
        })
        self.assertEqual(prof.map.tile_provider, defaults.map.tile_provider)
        self.assertEqual(prof.map.vector_options, defaults.map.vector_options)
        self.assertEqual(prof.map.toner_options, defaults.map.toner_options)
        self.assertEqual(prof.points.shape, defaults.points.shape)
        self.assertEqual(prof.points.mode, defaults.points.mode)
        self.assertEqual(prof.points.icon_set, defaults.points.icon_set)
        self.assertEqual(prof.points.color, defaults.points.color)
        self.assertEqual(prof.points.border_color, defaults.points.border_color)
        self.assertEqual(prof.points.fill_color_type, defaults.points.fill_color_type)
        self.assertEqual(prof.flash, defaults.flash)

    def test_sizes_are_clamped_to_the_ranges_of_the_controls(self):
        prof = coerce_profile({
            "map": {"vector_options": {"stroke_width": 50}},
            "points": {"size": 99999, "border_size": -3, "icon_size": 2, "recent_glow_days": 10_000},
            "flash": {"size": 0},
        })
        self.assertEqual(prof.map.vector_options.stroke_width, 5.0)
        self.assertEqual(prof.points.size, 10)
        self.assertEqual(prof.points.border_size, 0)
        self.assertEqual(prof.points.icon_size, 12)
        self.assertEqual(prof.points.recent_glow_days, 365)
        self.assertEqual(prof.flash.size, 5)

    def test_short_and_upper_case_hex_colors_are_accepted(self):
        prof = coerce_profile({"points": {"color": "#ABC"}, "flash": {"color": "#A1B2C3"}})
        self.assertEqual(prof.points.color, "#ABC")
        self.assertEqual(prof.flash.color, "#A1B2C3")

    def test_invalid_values_keep_the_base_theme_values(self):
        base = MapProfile()
        base.points.shape = "triangle"
        base.flash.size = 80
        prof = coerce_profile({"points": {"shape": "hexagon"}, "flash": {"size": "énorme"}}, base=base)
        self.assertEqual(prof.points.shape, "triangle")
        self.assertEqual(prof.flash.size, 80)
        # La base n'est pas modifiée en place.
        self.assertEqual(base.points.shape, "triangle")

    def test_flash_duration_is_a_theme_setting_clamped_to_the_field_bounds(self):
        # Bornes du champ inputTimeFlash (Style > Flash) : 100–10 000 ms.
        self.assertEqual(coerce_profile({"flash": {"duration": 30}}).flash.duration, 100)
        self.assertEqual(coerce_profile({"flash": {"duration": 99_999}}).flash.duration, 10_000)
        # Valeur illisible ou absente : la valeur courante sert de repli —
        # les thèmes écrits avant le déplacement du champ n'ont pas de
        # `duration` et ne doivent rien casser.
        base = MapProfile()
        base.flash.duration = 2500
        self.assertEqual(coerce_profile({"flash": {"duration": "long"}}, base=base).flash.duration, 2500)
        self.assertEqual(coerce_profile({"flash": {}}, base=base).flash.duration, 2500)
        self.assertEqual(coerce_profile({}, base=base).flash.duration, 2500)


class ProfileSaveAndImportValidationTests(unittest.TestCase):
    def setUp(self):
        # Constantes redirigées : sans cela le test écrirait dans les profils
        # réels de l'utilisateur (%APPDATA%\MyGCFlow).
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-profile-validation-"))
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

        # Import tardif, sous les constantes redirigées : le blueprint construit
        # un SettingsManager au moment de son import.
        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = Flask(__name__)
        app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = app.test_client()

        prof = self.manager.create_profile("Alpha")
        prof.points.shape = "triangle"
        prof.points.size = 6
        prof.flash.color = "#00ff00"
        self.manager.save_profile(prof)
        self.uid = prof.uid

    def _put(self, body):
        return self.client.put("/api/profiles/Alpha", json={"name": "Alpha", **body})

    def test_save_rejects_invalid_values_and_keeps_the_saved_ones(self):
        resp = self._put({
            "map": {"tile_provider": "<script>"},
            "points": {"shape": "hexagon", "size": 99999},
            "flash": {"color": "javascript:alert(1)"},
        })
        self.assertEqual(resp.status_code, 200)
        prof = self.manager.load_profile("Alpha")
        self.assertEqual(prof.map.tile_provider, "OSM")
        self.assertEqual(prof.points.shape, "triangle")
        self.assertEqual(prof.points.size, 10)
        self.assertEqual(prof.flash.color, "#00ff00")

    def test_save_is_a_partial_patch(self):
        self._put({"points": {"color": "#112233"}, "infos": {"title": {"text": "Mon titre"}}})
        prof = self.manager.load_profile("Alpha")
        self.assertEqual(prof.points.color, "#112233")
        self.assertEqual(prof.infos.title.text, "Mon titre")
        self.assertEqual(prof.points.shape, "triangle")
        self.assertEqual(prof.flash.color, "#00ff00")

    def test_save_ignores_the_uid_and_unknown_keys_sent_by_the_client(self):
        self._put({
            "uid": "pirate",
            "map": {"default_center": [1, 2], "vectorOptions": {"strokeColor": "#fff"}},
            "animation": {"speed": 3},
            "flash": {"duration": 5000, "bogus": 1},
        })
        saved = settings_manager.read_json(settings_manager.PROFILES_DIR / "Alpha.json")
        self.assertEqual(saved["uid"], self.uid)
        self.assertNotIn("default_center", saved["map"])
        self.assertNotIn("vectorOptions", saved["map"])
        self.assertNotIn("animation", saved)
        # La durée du flash est un réglage de thème : clé connue, conservée
        # bornée ; les clés réellement inconnues restent ignorées.
        self.assertEqual(saved["flash"]["duration"], 5000)
        self.assertNotIn("bogus", saved["flash"])

    def test_import_validates_the_values(self):
        payload = self.manager.export_profile_payload("Alpha", "test")
        payload["profile"]["name"] = "Importé"
        payload["profile"]["points"]["size"] = 500
        payload["profile"]["flash"]["mode"] = "explosion"
        prof = self.manager.import_profile_payload(payload)
        self.assertEqual(prof.points.size, 10)
        self.assertEqual(prof.flash.mode, MapProfile().flash.mode)

    def test_import_of_a_name_without_usable_characters_gets_a_neutral_name(self):
        payload = self.manager.export_profile_payload("Alpha", "test")
        payload["profile"]["name"] = "!!!"
        prof = self.manager.import_profile_payload(payload)
        self.assertEqual(prof.name, "Imported")
        self.assertFalse((settings_manager.PROFILES_DIR / "Default.json").exists())
    def test_a_partial_patch_merges_into_the_disappear_flash(self):
        self._put({"flash": {"disappear": {"mode": "star"}}})
        self._put({"flash": {"disappear": {"color": "#112233"}}})
        saved = settings_manager.read_json(settings_manager.PROFILES_DIR / "Alpha.json")
        self.assertEqual(saved["flash"]["disappear"], {
            "mode": "star", "size": 30, "color": "#112233", "color_type": "fix",
            "border_color": "#000000", "border_color_type": "auto",
        })
        # Les réglages du flash d'apparition sont intacts.
        self.assertEqual(saved["flash"]["color"], "#00ff00")

    def test_export_and_import_keep_the_disappear_flash(self):
        prof = self.manager.load_profile("Alpha")
        prof.flash.disappear.mode = "circle"
        self.manager.save_profile(prof)
        payload = self.manager.export_profile_payload("Alpha", "test")
        self.assertEqual(payload["profile"]["flash"]["disappear"]["mode"], "circle")
        payload["profile"]["name"] = "Copie"
        imported = self.manager.import_profile_payload(payload)
        self.assertEqual(imported.flash.disappear.mode, "circle")


class DisappearFlashTests(unittest.TestCase):
    """Flash de disparition du mode Évolution, porté par le thème."""

    def test_a_legacy_theme_gets_the_default_disappear_flash(self):
        prof = coerce_profile({"flash": {"mode": "star", "size": 40}})
        self.assertEqual(prof.flash.disappear, settings_manager.DisappearFlashOptions())
        self.assertEqual(prof.flash.disappear.mode, "implode")

    def test_disappear_values_are_validated(self):
        prof = coerce_profile({"flash": {"disappear": {
            "mode": "impulse", "size": 999, "color": "rouge", "color_type": "gc",
            "border_color": "rouge", "border_color_type": "arc-en-ciel",
        }}})
        self.assertEqual(prof.flash.disappear.mode, "implode")
        self.assertEqual(prof.flash.disappear.size, 200)
        self.assertEqual(prof.flash.disappear.color, "#9E9E9E")
        self.assertEqual(prof.flash.disappear.color_type, "gc")
        self.assertEqual(prof.flash.disappear.border_color, "#000000")
        self.assertEqual(prof.flash.disappear.border_color_type, "auto")

    def test_flash_border_color_is_validated(self):
        prof = coerce_profile({"flash": {
            "border_color": "#123456", "border_color_type": "fix",
        }})
        self.assertEqual(prof.flash.border_color, "#123456")
        self.assertEqual(prof.flash.border_color_type, "fix")
        prof = coerce_profile({"flash": {
            "border_color": "bleu", "border_color_type": "arc-en-ciel",
        }})
        self.assertEqual(prof.flash.border_color, "#000000")
        self.assertEqual(prof.flash.border_color_type, "auto")

    def test_garbage_disappear_block_keeps_the_defaults(self):
        prof = coerce_profile({"flash": {"disappear": "star"}})
        self.assertEqual(prof.flash.disappear, settings_manager.DisappearFlashOptions())


if __name__ == "__main__":
    unittest.main()
