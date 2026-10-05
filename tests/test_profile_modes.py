"""Thèmes séparés par mode (mode principal / mode Évolution).

Chaque page ne liste que ses thèmes et mémorise son propre thème actif : un
thème réglé pour quelques milliers de trouvailles noie la carte en mode
Évolution. Un thème passe d'un mode à l'autre par copie, tailles adaptées.
"""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import (
    EXAMPLE_PROFILE_BATCHES,
    FIRST_LAUNCH_EVOLUTION_PROFILE,
    FIRST_LAUNCH_PROFILE,
    MapProfile,
    SettingsManager,
    coerce_profile,
    convert_profile_for_mode,
)


class _IsolatedConfigTestCase(unittest.TestCase):
    seeded = True

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-profile-modes-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        self.settings_path = tmp / "settings.json"
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": self.settings_path,
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (tmp / "profiles").mkdir(parents=True, exist_ok=True)
        if self.seeded:
            settings_manager.write_json(self.settings_path, {
                "examples_seeded": True,
                "examples_version": settings_manager.EXAMPLES_VERSION,
            })
        self.manager = SettingsManager()


class ProfileModeStorageTests(_IsolatedConfigTestCase):
    def test_a_theme_file_without_mode_belongs_to_the_main_mode(self):
        self.assertEqual(coerce_profile({"name": "Ancien"}).mode, "main")
        self.assertEqual(coerce_profile({"name": "X", "mode": "inconnu"}).mode, "main")
        self.assertEqual(coerce_profile({"name": "X", "mode": "evolution"}).mode, "evolution")

    def test_each_mode_lists_only_its_own_themes(self):
        self.manager.create_profile("Trouvailles")
        self.manager.create_profile("Zone", mode="evolution")

        self.assertEqual(self.manager.list_profiles("main"), ["Trouvailles"])
        self.assertEqual(self.manager.list_profiles("evolution"), ["Zone"])
        self.assertEqual(self.manager.list_profiles(), ["Trouvailles", "Zone"])
        self.assertEqual(self.manager.list_profiles_with_modes(), [
            {"name": "Trouvailles", "mode": "main"},
            {"name": "Zone", "mode": "evolution"},
        ])

    def test_names_stay_unique_across_modes(self):
        self.manager.create_profile("Partagé")
        with self.assertRaises(ValueError):
            self.manager.create_profile("Partagé", mode="evolution")

    def test_a_new_evolution_theme_starts_from_small_points(self):
        prof = self.manager.create_profile("Zone", mode="evolution")
        self.assertLessEqual(prof.points.size, 2)
        self.assertEqual(prof.points.border_size, 0)

    def test_rename_duplicate_and_reset_keep_the_mode(self):
        self.manager.create_profile("Zone", mode="evolution")
        self.assertEqual(self.manager.rename_profile("Zone", "Région").mode, "evolution")
        self.assertEqual(self.manager.duplicate_profile("Région", "Région bis").mode, "evolution")

        reset = self.manager.reset_profile("Région")
        self.assertEqual(reset.mode, "evolution")
        self.assertLessEqual(reset.points.size, 2)

    def test_resetting_a_user_theme_named_like_an_example_of_the_other_mode(self):
        # « Default » est un exemple du mode principal : un thème Évolution de
        # ce nom ne doit ni en reprendre le design, ni changer de mode.
        self.manager.create_profile("Default", mode="evolution")
        reset = self.manager.reset_profile("Default")
        self.assertEqual(reset.mode, "evolution")
        self.assertLessEqual(reset.points.size, 2)

    def test_export_and_import_carry_the_mode(self):
        self.manager.create_profile("Zone", mode="evolution")
        payload = self.manager.export_profile_payload("Zone", "1.0")
        self.assertEqual(payload["profile"]["mode"], "evolution")

        imported = self.manager.import_profile_payload(payload)
        self.assertEqual(imported.mode, "evolution")
        self.assertIn(imported.name, self.manager.list_profiles("evolution"))


class ProfileModeConversionTests(_IsolatedConfigTestCase):
    def test_copy_to_evolution_shrinks_points_and_flash_and_keeps_the_original(self):
        source = self.manager.create_profile("Trouvailles")
        source.points.size = 8
        source.points.halo = True
        source.points.border_size = 2
        source.flash.size = 50
        source.flash.duration = 1000
        self.manager.save_profile(source)

        copy = self.manager.copy_profile_to_mode("Trouvailles", "evolution", "Trouvailles zone")

        self.assertEqual(copy.mode, "evolution")
        self.assertNotEqual(copy.uid, source.uid)
        self.assertEqual(copy.points.size, 2)
        self.assertFalse(copy.points.halo)
        self.assertEqual(copy.points.border_size, 0)
        self.assertEqual(copy.flash.size, 20)
        self.assertEqual(copy.flash.duration, 500)
        self.assertEqual(copy.map.tile_provider, source.map.tile_provider)
        self.assertEqual(copy.infos.title_css, source.infos.title_css)

        original = self.manager.load_profile("Trouvailles")
        self.assertEqual(original.mode, "main")
        self.assertEqual(original.points.size, 8)

    def test_an_outline_only_point_keeps_a_visible_colour(self):
        prof = MapProfile()
        prof.points.fill_color_type = "none"
        prof.points.halo = True
        prof.points.border_size = 2
        prof.points.border_color = "#2563eb"
        prof.points.border_color_type = "gc"

        convert_profile_for_mode(prof, "evolution")

        self.assertEqual(prof.points.fill_color_type, "gc")
        self.assertEqual(prof.points.color, "#2563eb")

    def test_icons_become_coloured_dots(self):
        prof = MapProfile()
        prof.points.mode = "icone"

        convert_profile_for_mode(prof, "evolution")

        self.assertEqual(prof.points.mode, "vectoriel")
        self.assertEqual(prof.points.fill_color_type, "gc")

    def test_copy_to_main_enlarges_points_and_flash(self):
        self.manager.create_profile("Zone", mode="evolution")
        copy = self.manager.copy_profile_to_mode("Zone", "main", "Zone trouvailles")

        self.assertEqual(copy.mode, "main")
        self.assertEqual(copy.points.size, 8)
        self.assertEqual(copy.flash.size, 35)

    def test_copy_into_the_same_mode_or_an_unknown_mode_is_refused(self):
        self.manager.create_profile("Trouvailles")
        with self.assertRaises(ValueError):
            self.manager.copy_profile_to_mode("Trouvailles", "main", "Copie")
        with self.assertRaises(ValueError):
            self.manager.copy_profile_to_mode("Trouvailles", "ailleurs", "Copie")
        with self.assertRaises(FileNotFoundError):
            self.manager.copy_profile_to_mode("Fantôme", "evolution", "Copie")

    def test_a_taken_name_is_suffixed_like_a_duplicate(self):
        self.manager.create_profile("Trouvailles")
        copy = self.manager.copy_profile_to_mode("Trouvailles", "evolution", "Trouvailles")
        self.assertEqual(copy.name, "Trouvailles (1)")


class ProfileModeSettingsTests(_IsolatedConfigTestCase):
    def test_each_mode_keeps_its_own_references(self):
        main = self.manager.create_profile("Trouvailles")
        evo = self.manager.create_profile("Zone", mode="evolution")

        def write(current):
            current.last_profile_uid = main.uid
            current.evolution_last_profile_uid = evo.uid
            current.evolution_default_profile_uid = evo.uid
            return current

        self.manager.update_app_settings(write)

        settings = SettingsManager().get_app_settings()
        self.assertEqual(settings.last_profile_uid, main.uid)
        self.assertEqual(settings.evolution_last_profile_uid, evo.uid)
        self.assertEqual(settings.evolution_default_profile_uid, evo.uid)

    def test_a_reference_to_a_theme_of_the_other_mode_is_cleared(self):
        main = self.manager.create_profile("Trouvailles")
        evo = self.manager.create_profile("Zone", mode="evolution")

        def write(current):
            current.last_profile_uid = evo.uid
            current.evolution_last_profile_uid = main.uid
            return current

        self.manager.update_app_settings(write)

        settings = self.manager.get_app_settings()
        self.assertIsNone(settings.last_profile_uid)
        self.assertIsNone(settings.evolution_last_profile_uid)

    def test_a_deleted_evolution_theme_is_forgotten(self):
        evo = self.manager.create_profile("Zone", mode="evolution")

        def write(current):
            current.evolution_default_profile_uid = evo.uid
            return current

        self.manager.update_app_settings(write)
        self.manager.delete_profile("Zone")

        self.assertIsNone(self.manager.get_app_settings().evolution_default_profile_uid)


class EvolutionExampleSeedingTests(_IsolatedConfigTestCase):
    seeded = False

    def test_first_launch_gives_each_mode_its_startup_theme(self):
        settings = self.manager.get_app_settings()
        self.assertEqual(settings.default_profile_uid, self.manager.load_profile(FIRST_LAUNCH_PROFILE).uid)
        self.assertEqual(
            settings.evolution_default_profile_uid,
            self.manager.load_profile(FIRST_LAUNCH_EVOLUTION_PROFILE).uid,
        )
        self.assertEqual(set(self.manager.list_profiles("evolution")), EXAMPLE_PROFILE_BATCHES[4])
        self.assertNotIn("Default", self.manager.list_profiles("evolution"))

    def test_the_evolution_examples_use_tiny_borderless_points(self):
        for name in EXAMPLE_PROFILE_BATCHES[4]:
            prof = self.manager.load_profile(name)
            self.assertEqual(prof.mode, "evolution")
            self.assertLessEqual(prof.points.size, 2)
            self.assertEqual(prof.points.border_size, 0)
            self.assertLessEqual(prof.flash.size, 20)


class EvolutionExampleUpgradeTests(_IsolatedConfigTestCase):
    seeded = False

    def setUp(self):
        super().setUp()
        # Installation d'avant les thèmes Évolution : exemples supprimés, un
        # thème à soi, aucun thème par défaut.
        for name in self.manager.list_profiles():
            self.manager.delete_profile(name)
        self.manager.create_profile("Mon Profil")
        settings_manager.write_json(self.settings_path, {"examples_seeded": True, "examples_version": 3})

    def test_an_existing_installation_receives_the_evolution_themes_and_their_default(self):
        manager = SettingsManager()

        self.assertEqual(manager.list_profiles("main"), ["Mon Profil"])
        self.assertEqual(set(manager.list_profiles("evolution")), EXAMPLE_PROFILE_BATCHES[4])
        settings = manager.get_app_settings()
        self.assertIsNone(settings.default_profile_uid)
        self.assertEqual(
            settings.evolution_default_profile_uid,
            manager.load_profile(FIRST_LAUNCH_EVOLUTION_PROFILE).uid,
        )


class ProfileModeApiTests(_IsolatedConfigTestCase):
    def setUp(self):
        super().setUp()
        from blueprints import profiles as profiles_bp_module

        patcher = mock.patch.object(profiles_bp_module, 'settings_manager', self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

        app = Flask(__name__)
        app.register_blueprint(profiles_bp_module.profiles_bp)
        self.client = app.test_client()

    def test_listing_by_mode_and_with_details(self):
        self.client.post('/api/profiles', json={'name': 'Trouvailles'})
        self.client.post('/api/profiles', json={'name': 'Zone', 'mode': 'evolution'})

        self.assertEqual(self.client.get('/api/profiles').get_json(), ['Trouvailles', 'Zone'])
        self.assertEqual(self.client.get('/api/profiles?mode=evolution').get_json(), ['Zone'])
        self.assertEqual(self.client.get('/api/profiles?details=1').get_json(), [
            {'name': 'Trouvailles', 'mode': 'main'},
            {'name': 'Zone', 'mode': 'evolution'},
        ])
        self.assertEqual(self.client.get('/api/profiles/Zone').get_json()['mode'], 'evolution')

    def test_saving_a_theme_cannot_change_its_mode(self):
        self.client.post('/api/profiles', json={'name': 'Zone', 'mode': 'evolution'})
        response = self.client.put('/api/profiles/Zone', json={'name': 'Zone', 'mode': 'main', 'points': {'size': 3}})

        self.assertTrue(response.get_json()['success'])
        saved = self.manager.load_profile('Zone')
        self.assertEqual(saved.mode, 'evolution')
        self.assertEqual(saved.points.size, 3)

    def test_transfer_copies_the_theme_into_the_other_mode(self):
        self.client.post('/api/profiles', json={'name': 'Trouvailles'})

        response = self.client.post(
            '/api/profiles/Trouvailles/transfer', json={'mode': 'evolution', 'new_name': 'Trouvailles zone'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['mode'], 'evolution')
        self.assertEqual(self.client.get('/api/profiles?mode=main').get_json(), ['Trouvailles'])
        self.assertEqual(self.client.get('/api/profiles?mode=evolution').get_json(), ['Trouvailles zone'])

    def test_transfer_errors(self):
        self.client.post('/api/profiles', json={'name': 'Trouvailles'})

        self.assertEqual(self.client.post('/api/profiles/Fantome/transfer', json={'mode': 'evolution'}).status_code, 404)
        self.assertEqual(self.client.post('/api/profiles/Trouvailles/transfer', json={'mode': 'main'}).status_code, 400)

    def test_settings_expose_and_accept_the_evolution_references(self):
        uid = self.client.post('/api/profiles', json={'name': 'Zone', 'mode': 'evolution'}).get_json()['uid']
        self.client.put('/api/settings', json={
            'evolution_last_profile_uid': uid, 'evolution_default_profile_uid': uid})
        # Une écriture sans rapport ne les efface pas.
        self.client.put('/api/settings', json={'theme': 'dark'})

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['evolution_last_profile_uid'], uid)
        self.assertEqual(payload['evolution_default_profile_uid'], uid)
        self.assertEqual(payload['evolution_default_profile_name'], 'Zone')
        self.assertIsNone(payload['last_profile_uid'])


if __name__ == "__main__":
    unittest.main()
