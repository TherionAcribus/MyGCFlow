import json
import shutil
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest import mock

from flask import Flask

import settings_manager
from settings_manager import SettingsManager, coerce_settings
from stats_settings import (
    STATS_MAX_PANELS,
    StatsSettings,
    coerce_stats_panel,
    coerce_stats_settings,
)

CASES_PATH = Path(__file__).resolve().parent / "fixtures" / "stats" / "settings_cases.json"


class SharedVectorsTests(unittest.TestCase):
    """Vecteurs partagés avec test_stats_model.mjs (normalizeStatsSettings).

    Le client normalise ce qu'il lit et ce qu'il envoie, le serveur ce qu'il
    reçoit et relit : une règle qui divergerait ferait réécrire au client des
    panneaux que le serveur corrigerait ensuite, à chaque sauvegarde."""

    def test_every_case_gives_the_expected_settings(self):
        cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case["name"]):
                self.assertEqual(asdict(coerce_stats_settings(case["input"])), case["expected"])


class PanelIdentityTests(unittest.TestCase):
    def test_missing_invalid_and_duplicate_ids_are_regenerated(self):
        stats = coerce_stats_settings({"panels": [
            {"kind": "grid", "metric": "dt"},
            {"id": "PAS-HEX!", "kind": "grid", "metric": "dt"},
            {"id": "abcdef12", "kind": "bar", "metric": "year"},
            {"id": "abcdef12", "kind": "bar", "metric": "terrain"},
        ]})

        ids = [panel["id"] for panel in stats.panels]
        self.assertEqual(len(ids), 4)
        self.assertEqual(len(set(ids)), 4)
        # Le premier porteur d'un identifiant le garde : c'est le doublon qui change.
        self.assertEqual(ids[2], "abcdef12")
        for panel_id in ids:
            self.assertRegex(panel_id, r"^[0-9a-f]{6,32}$")

    def test_a_valid_id_is_kept(self):
        panel = coerce_stats_panel({"id": "0123456789ab", "kind": "grid", "metric": "dt"})
        self.assertEqual(panel["id"], "0123456789ab")

    def test_only_valid_panels_count_towards_the_limit(self):
        # Des panneaux invalides en tête ne doivent pas évincer des valides.
        raw = [{"kind": "pie", "metric": "x"}] * 4 + [
            {"kind": "bar", "metric": "terrain"} for _ in range(STATS_MAX_PANELS)
        ]
        self.assertEqual(len(coerce_stats_settings({"panels": raw}).panels), STATS_MAX_PANELS)


class PositionHeightTests(unittest.TestCase):
    """Hauteur optionnelle : None = automatique, sinon bornée — miroir du
    coercer `height` de POSITION_COERCERS (stats_model.mjs)."""

    def height_of(self, position):
        panel = coerce_stats_panel({"kind": "bar", "metric": "year", "position": position})
        return panel["position"]["height"]

    def test_nullable_and_bounded(self):
        self.assertIsNone(self.height_of({}))
        self.assertIsNone(self.height_of({"height": None}))
        self.assertEqual(self.height_of({"height": 90}), 90)
        self.assertEqual(self.height_of({"height": "300"}), 300)
        # Non numérique → None (automatique), comme intIn côté client.
        self.assertIsNone(self.height_of({"height": "abc"}))
        self.assertEqual(self.height_of({"height": 5000}), 1200)
        # Sous le plancher : bornée comme la largeur (0 → 60), pas annulée.
        self.assertEqual(self.height_of({"height": 0}), 60)


class StatsPatchTests(unittest.TestCase):
    def test_absent_keys_keep_the_current_value(self):
        current = coerce_stats_settings({"panels": [{"id": "aaaaaa01", "kind": "grid", "metric": "dt"}]})

        patched = coerce_stats_settings({"enabled": False}, current)

        self.assertFalse(patched.enabled)
        self.assertEqual([p["id"] for p in patched.panels], ["aaaaaa01"])

    def test_sent_panels_replace_the_list(self):
        current = coerce_stats_settings({"panels": [{"id": "aaaaaa01", "kind": "grid", "metric": "dt"}]})

        patched = coerce_stats_settings({"panels": []}, current)

        self.assertTrue(patched.enabled)
        self.assertEqual(patched.panels, [])

    def test_a_non_object_keeps_the_current_value(self):
        current = StatsSettings(enabled=False, panels=[])
        self.assertEqual(coerce_stats_settings("nimporte", current), current)


class SettingsFileTests(unittest.TestCase):
    def test_a_settings_file_without_stats_gets_the_defaults(self):
        self.assertEqual(coerce_settings({"theme": "dark"}).stats, StatsSettings())

    def test_the_stats_block_is_read_back_from_the_file(self):
        s = coerce_settings({"stats": {"enabled": False, "panels": [
            {"id": "aaaaaa01", "kind": "bar", "metric": "cache_type"},
        ]}})
        self.assertFalse(s.stats.enabled)
        self.assertEqual(s.stats.panels[0]["options"]["sort"], "count")


class StatsApiTests(unittest.TestCase):
    def setUp(self):
        # Préférences redirigées vers un dossier temporaire : sans cela, le
        # test écrirait dans la vraie configuration de l'utilisateur.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-stats-settings-"))
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

    def stats(self):
        return self.client.get('/api/settings').get_json()['stats']

    def test_get_exposes_the_default_block(self):
        self.assertEqual(self.stats(), {"enabled": True, "panels": [], "evolution_panels": [], "poses_panels": [], "configs": []})

    def test_put_stores_normalised_panels(self):
        response = self.client.put('/api/settings', json={'stats': {'panels': [
            {'id': 'aaaaaa01', 'kind': 'grid', 'metric': 'dt', 'position': {'anchor': 'bottom-left', 'width': 5}},
            {'id': 'bbbbbb01', 'kind': 'radar', 'metric': 'cache_type'},
        ]}})

        self.assertEqual(response.status_code, 200)
        panels = self.stats()['panels']
        self.assertEqual([p['id'] for p in panels], ['aaaaaa01'])
        self.assertEqual(panels[0]['position']['anchor'], 'bottom-left')
        self.assertEqual(panels[0]['position']['width'], 120)

    def test_enabled_alone_keeps_the_panels(self):
        self.client.put('/api/settings', json={'stats': {'panels': [
            {'id': 'aaaaaa01', 'kind': 'grid', 'metric': 'dt'}]}})

        self.client.put('/api/settings', json={'stats': {'enabled': False}})

        stats = self.stats()
        self.assertFalse(stats['enabled'])
        self.assertEqual(len(stats['panels']), 1)

    def test_other_preferences_survive_a_stats_write_and_vice_versa(self):
        self.client.put('/api/settings', json={'theme': 'dark', 'infos_template': '{date}'})
        self.client.put('/api/settings', json={'stats': {'panels': [
            {'id': 'aaaaaa01', 'kind': 'bar', 'metric': 'year'}]}})
        self.client.put('/api/settings', json={'theme': 'light'})

        payload = self.client.get('/api/settings').get_json()
        self.assertEqual(payload['theme'], 'light')
        self.assertEqual(payload['infos_template'], '{date}')
        self.assertEqual([p['id'] for p in payload['stats']['panels']], ['aaaaaa01'])

    def test_a_non_object_stats_value_is_ignored(self):
        self.client.put('/api/settings', json={'stats': {'panels': [
            {'id': 'aaaaaa01', 'kind': 'grid', 'metric': 'dt'}]}})

        self.client.put('/api/settings', json={'stats': 'efface-tout'})

        self.assertEqual(len(self.stats()['panels']), 1)

    def test_configs_survive_a_panels_patch(self):
        self.client.put('/api/settings', json={'stats': {'configs': [
            {'name': 'Ma mise en page', 'panels': [
                {'id': 'aaaaaa01', 'kind': 'grid', 'metric': 'dt'}]}]}})

        self.client.put('/api/settings', json={'stats': {'panels': []}})

        stats = self.stats()
        self.assertEqual(len(stats['configs']), 1)
        self.assertEqual(stats['configs'][0]['name'], 'Ma mise en page')
        self.assertEqual(stats['configs'][0]['panels'][0]['id'], 'aaaaaa01')

    def test_reset_restores_the_defaults(self):
        self.client.put('/api/settings', json={'stats': {'enabled': False, 'panels': [
            {'id': 'aaaaaa01', 'kind': 'grid', 'metric': 'dt'}]}})

        self.client.post('/api/settings/reset')

        self.assertEqual(self.stats(), {"enabled": True, "panels": [], "evolution_panels": [], "poses_panels": [], "configs": []})


if __name__ == "__main__":
    unittest.main()
