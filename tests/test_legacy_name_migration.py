import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import paths
import settings_manager


class AdoptLegacyConfigDirTests(unittest.TestCase):
    """Reprise du dossier %APPDATA%/GCMap après le changement de nom.

    Sans elle, un utilisateur de la version précédente retrouverait une
    configuration vierge : ses profils resteraient dans le dossier de l'ancien
    nom, que plus personne ne lit.
    """

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="mygcflow-legacy-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.legacy = self.base / "GCMap"
        self.current = self.base / "MyGCFlow"

    def _seed_legacy(self):
        (self.legacy / "profiles").mkdir(parents=True)
        (self.legacy / "settings.json").write_text('{"theme": "dark"}', encoding="utf-8")

    def test_reprend_le_dossier_de_lancien_nom(self):
        self._seed_legacy()
        settings_manager.adopt_legacy_dir(self.current, self.legacy)
        self.assertFalse(self.legacy.exists(), "l'ancien dossier doit avoir été déplacé")
        self.assertEqual(
            (self.current / "settings.json").read_text(encoding="utf-8"),
            '{"theme": "dark"}',
        )

    def test_ne_touche_a_rien_si_le_nouveau_dossier_existe(self):
        """Déjà passé à la nouvelle version : l'ancien dossier est laissé tel quel."""
        self._seed_legacy()
        self.current.mkdir()
        (self.current / "settings.json").write_text('{"theme": "light"}', encoding="utf-8")
        settings_manager.adopt_legacy_dir(self.current, self.legacy)
        self.assertTrue(self.legacy.exists())
        self.assertEqual(
            (self.current / "settings.json").read_text(encoding="utf-8"),
            '{"theme": "light"}',
        )

    def test_sans_ancien_dossier_rien_nest_cree(self):
        settings_manager.adopt_legacy_dir(self.current, self.legacy)
        self.assertFalse(self.current.exists())

    def test_app_config_dir_reprend_lancien_dossier(self):
        self._seed_legacy()
        with mock.patch.dict(os.environ, {"APPDATA": str(self.base)}, clear=False):
            for var in ("MYGCFLOW_CONFIG_DIR", "GCMAP_CONFIG_DIR"):
                os.environ.pop(var, None)
            self.assertEqual(settings_manager.app_config_dir(), self.current)
        self.assertTrue((self.current / "profiles").is_dir())

    def test_ancienne_variable_denvironnement_encore_acceptee(self):
        """GCMAP_CONFIG_DIR : harnais et scripts d'avant le changement de nom."""
        with mock.patch.dict(os.environ, {"GCMAP_CONFIG_DIR": str(self.current)}, clear=False):
            os.environ.pop("MYGCFLOW_CONFIG_DIR", None)
            self.assertEqual(settings_manager.app_config_dir(), self.current)


class LegacyDataDirTests(unittest.TestCase):
    """Mêmes règles pour les données (%LOCALAPPDATA%), application installée."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="mygcflow-legacy-data-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        paths._legacy_data_checked = False
        self.addCleanup(setattr, paths, "_legacy_data_checked", False)

    def test_data_dir_reprend_lancien_dossier(self):
        (self.base / "GCMap" / "instance").mkdir(parents=True)
        env = {"LOCALAPPDATA": str(self.base)}
        with mock.patch.object(paths, "is_frozen", return_value=True), \
                mock.patch.dict(os.environ, env, clear=False):
            for var in ("MYGCFLOW_DATA_DIR", "MYGCFLOW_RUNTIME_DIR",
                        "GCMAP_DATA_DIR", "GCMAP_RUNTIME_DIR"):
                os.environ.pop(var, None)
            self.assertEqual(paths.data_dir(), self.base / "MyGCFlow")
        self.assertTrue((self.base / "MyGCFlow" / "instance").is_dir())
        self.assertFalse((self.base / "GCMap").exists())

    def test_ancienne_variable_denvironnement_encore_acceptee(self):
        with mock.patch.dict(os.environ, {"GCMAP_DATA_DIR": str(self.base)}, clear=False):
            for var in ("MYGCFLOW_DATA_DIR", "MYGCFLOW_RUNTIME_DIR"):
                os.environ.pop(var, None)
            self.assertEqual(paths.data_dir(), self.base.resolve())


class LegacyProfileSchemaTests(unittest.TestCase):
    """Les profils exportés sous l'ancien nom restent importables."""

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-legacy-profile-"))
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
        self.manager = settings_manager.SettingsManager()

    def _payload(self, schema):
        self.manager.create_profile("Source")
        exported = self.manager.export_profile_payload("Source", "1.0.0")
        exported["$schema"] = schema
        exported["profile"]["name"] = "Profil importé"
        return exported

    def test_schema_de_lancien_nom_accepte(self):
        prof = self.manager.import_profile_payload(self._payload("gcmap.profile.v1"))
        self.assertTrue(prof.name.startswith("Profil importé"))

    def test_schema_courant_accepte(self):
        prof = self.manager.import_profile_payload(self._payload("mygcflow.profile.v1"))
        self.assertTrue(prof.name.startswith("Profil importé"))

    def test_schema_inconnu_refuse(self):
        with self.assertRaises(ValueError):
            self.manager.import_profile_payload(self._payload("autre.profile.v1"))


if __name__ == "__main__":
    unittest.main()
