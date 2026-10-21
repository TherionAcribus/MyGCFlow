import json
import shutil
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from image_settings import IMAGES_MAX_ITEMS, ImagesSettings, coerce_images_settings
from settings_manager import SettingsManager, coerce_settings

CASES_PATH = Path(__file__).resolve().parent / "fixtures" / "images" / "settings_cases.json"


class SharedVectorsTests(unittest.TestCase):
    """Vecteurs partagés avec test_images_model.mjs (normalizeImagesSettings) :
    une règle qui divergerait ferait réécrire au client des images que le
    serveur corrigerait ensuite, à chaque sauvegarde."""

    def test_every_case_gives_the_expected_settings(self):
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case["name"]):
                self.assertEqual(asdict(coerce_images_settings(case["input"])), case["expected"])


class ImageItemTests(unittest.TestCase):
    def test_missing_invalid_and_duplicate_ids_are_regenerated(self):
        items = coerce_images_settings({"items": [
            {"file": "0123456789abcdef.png"},
            {"id": "PAS-HEX!"},
            {"id": "abcdef12"},
            {"id": "abcdef12"},
        ]}).items
        ids = [item["id"] for item in items]
        self.assertEqual(len(set(ids)), 4)
        self.assertEqual(ids[2], "abcdef12")
        for item_id in ids:
            self.assertRegex(item_id, r"^[0-9a-f]{6,32}$")

    def test_list_is_truncated(self):
        items = coerce_images_settings({"items": [{} for _ in range(IMAGES_MAX_ITEMS + 3)]}).items
        self.assertEqual(len(items), IMAGES_MAX_ITEMS)

    def test_first_level_patch_keeps_the_current_list(self):
        current = coerce_images_settings({"items": [{"id": "aaaaaa01", "file": "0123456789abcdef.png"}]})
        patched = coerce_images_settings({"enabled": False}, current)
        self.assertFalse(patched.enabled)
        self.assertEqual([item["id"] for item in patched.items], ["aaaaaa01"])
        # Liste envoyée : elle remplace la courante.
        self.assertEqual(coerce_images_settings({"items": []}, current).items, [])

    def test_evolution_items_are_an_independent_list(self):
        # Chaque page a sa liste ; la clé absente normalise à vide — jamais
        # une copie de `items` (sinon retirer une image d'un côté la
        # retirerait aussi de la vue normalisée de l'autre).
        self.assertEqual(coerce_images_settings({"items": [{"id": "aaaaaa01"}]}).evolution_items, [])
        current = coerce_images_settings({
            "items": [{"id": "aaaaaa01", "file": "0123456789abcdef.png"}],
            "evolution_items": [{"id": "bbbbbb01", "file": "fedcba9876543210.jpg"}],
        })
        patched = coerce_images_settings({"items": []}, current)
        self.assertEqual(patched.items, [])
        self.assertEqual([item["id"] for item in patched.evolution_items], ["bbbbbb01"])


class SettingsFileTests(unittest.TestCase):
    def test_a_settings_file_without_images_gets_the_defaults(self):
        self.assertEqual(coerce_settings({"theme": "dark"}).images, ImagesSettings())

    def test_the_images_block_is_read_back_from_the_file(self):
        s = coerce_settings({"images": {"enabled": False, "items": [
            {"id": "aaaaaa01", "file": "0123456789abcdef.png", "style": {"shape": "circle"}},
        ]}})
        self.assertFalse(s.images.enabled)
        self.assertEqual(s.images.items[0]["style"]["shape"], "circle")


class ImagesApiTests(unittest.TestCase):
    def setUp(self):
        # Préférences redirigées vers un dossier temporaire : sans cela, le
        # test écrirait dans la vraie configuration de l'utilisateur.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-image-settings-"))
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

    def images(self):
        return self.client.get('/api/settings').get_json()['images']

    def test_get_exposes_the_default_block(self):
        self.assertEqual(self.images(), {"enabled": True, "items": [], "evolution_items": []})

    def test_put_stores_normalised_items_and_keeps_other_preferences(self):
        self.client.put('/api/settings', json={'stats': {'enabled': False}})
        response = self.client.put('/api/settings', json={'images': {'items': [
            {'id': 'aaaaaa01', 'file': '0123456789abcdef.png', 'position': {'width': 5000}},
            {'id': 'aaaaaa02', 'file': '../../secret.png'},
        ]}})
        self.assertEqual(response.status_code, 200)
        images = self.images()
        self.assertEqual(images['items'][0]['position']['width'], 1200)
        self.assertEqual(images['items'][1]['file'], '')
        # Les autres préférences globales ne bougent pas.
        self.assertFalse(self.client.get('/api/settings').get_json()['stats']['enabled'])
        # Relu depuis le disque par un nouveau gestionnaire.
        self.assertEqual(asdict(SettingsManager().get_app_settings().images)['items'][0]['id'], 'aaaaaa01')

    def test_put_of_enabled_only_keeps_the_items(self):
        self.client.put('/api/settings', json={'images': {'items': [{'id': 'aaaaaa01'}]}})
        self.client.put('/api/settings', json={'images': {'enabled': False}})
        images = self.images()
        self.assertFalse(images['enabled'])
        self.assertEqual([item['id'] for item in images['items']], ['aaaaaa01'])

    def test_put_of_unrelated_preferences_keeps_the_images(self):
        self.client.put('/api/settings', json={'images': {'items': [{'id': 'aaaaaa01'}]}})
        self.client.put('/api/settings', json={'theme': 'dark'})
        self.assertEqual([item['id'] for item in self.images()['items']], ['aaaaaa01'])


if __name__ == '__main__':
    unittest.main()
