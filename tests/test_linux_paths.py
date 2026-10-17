import contextlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from unittest import mock

import paths
import settings_manager

# Ces tests simulent un système POSIX en patchant os.name et sys.platform,
# mais les chemins restent construits par pathlib, qui instancie un PosixPath
# — impossible sous Windows (NotImplementedError). Le comportement XDG qu'ils
# vérifient ne s'exécute de toute façon que sur Linux et macOS, où la CI les
# fait tourner. Sans cette garde, ils faisaient échouer le job Windows.
if os.name != "posix":
    raise unittest.SkipTest(
        "chemins POSIX : ces tests instancient des PosixPath, indisponibles sous Windows"
    )


def _plateforme_posix(home, platform="linux"):
    """Empile les patchs simulant Linux/macOS : os.name, sys.platform, home.

    Path.home() est patché plutôt que la variable $HOME : les tests restent
    déterministes quel que soit l'environnement qui les lance.
    """
    stack = contextlib.ExitStack()
    stack.enter_context(mock.patch.object(paths.os, "name", "posix"))
    stack.enter_context(mock.patch.object(paths.sys, "platform", platform))
    stack.enter_context(mock.patch.object(Path, "home", return_value=home))
    return stack


class UserDirTests(unittest.TestCase):
    """Base utilisateur par plateforme : XDG, Application Support, %APPDATA%."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="mygcflow-userdir-"))
        self.addCleanup(shutil.rmtree, self.home, True)

    def test_xdg_data_home_absolu_est_honore(self):
        xdg = self.home / "xdg-data"
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(xdg)}, clear=False):
            self.assertEqual(paths.user_dir("data"), xdg)

    def test_xdg_config_home_absolu_est_honore(self):
        xdg = self.home / "xdg-config"
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}, clear=False):
            self.assertEqual(paths.user_dir("config"), xdg)

    def test_xdg_relatif_est_ignore(self):
        """La spec XDG exige un chemin absolu : un relatif retombe au défaut."""
        env = {"XDG_DATA_HOME": "relatif/data", "XDG_CONFIG_HOME": "relatif/config"}
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ, env, clear=False):
            self.assertEqual(paths.user_dir("data"), self.home / ".local" / "share")
            self.assertEqual(paths.user_dir("config"), self.home / ".config")

    def test_xdg_absent_repli_sur_les_defauts(self):
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("XDG_DATA_HOME", None)
            os.environ.pop("XDG_CONFIG_HOME", None)
            self.assertEqual(paths.user_dir("data"), self.home / ".local" / "share")
            self.assertEqual(paths.user_dir("config"), self.home / ".config")

    def test_macos_application_support(self):
        """macOS : ~/Library/Application Support pour données comme config."""
        with _plateforme_posix(self.home, platform="darwin"):
            attendu = self.home / "Library" / "Application Support"
            self.assertEqual(paths.user_dir("data"), attendu)
            self.assertEqual(paths.user_dir("config"), attendu)

    def test_windows_variables_historiques_inchangees(self):
        """Windows : %LOCALAPPDATA% pour les données, %APPDATA% pour la config.

        Sous un os.name simulé à "nt", Path() produit des WindowsPath : ils se
        comparent à des PureWindowsPath (une arithmétique de chemins, elle,
        lèverait UnsupportedOperation hors Windows).
        """
        env = {"LOCALAPPDATA": str(self.home / "local"),
               "APPDATA": str(self.home / "roaming")}
        with mock.patch.object(paths.os, "name", "nt"), \
                mock.patch.object(Path, "home", return_value=self.home), \
                mock.patch.dict(os.environ, env, clear=False):
            self.assertEqual(paths.user_dir("data"), PureWindowsPath(self.home / "local"))
            self.assertEqual(paths.user_dir("config"), PureWindowsPath(self.home / "roaming"))

    def test_windows_repli_sur_home(self):
        """Variables absentes : repli sur le dossier personnel, comme avant."""
        with mock.patch.object(paths.os, "name", "nt"), \
                mock.patch.object(Path, "home", return_value=self.home), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LOCALAPPDATA", None)
            os.environ.pop("APPDATA", None)
            self.assertEqual(paths.user_dir("data"), PureWindowsPath(self.home))
            self.assertEqual(paths.user_dir("config"), PureWindowsPath(self.home))


class LinuxDataDirTests(unittest.TestCase):
    """data_dir() de l'application installée sous Linux : XDG et reprises."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="mygcflow-xdg-data-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        paths._legacy_data_checked = False
        self.addCleanup(setattr, paths, "_legacy_data_checked", False)

    def _data_dir(self, env=None):
        """data_dir() gelée, variables de redirection et XDG sous contrôle."""
        with _plateforme_posix(self.home), \
                mock.patch.object(paths, "is_frozen", return_value=True), \
                mock.patch.dict(os.environ, {}, clear=False):
            for var in ("MYGCFLOW_DATA_DIR", "MYGCFLOW_RUNTIME_DIR",
                        "GCMAP_DATA_DIR", "GCMAP_RUNTIME_DIR",
                        "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
                os.environ.pop(var, None)
            os.environ.update(env or {})
            return paths.data_dir()

    def test_xdg_data_home_est_honore(self):
        xdg = self.home / "xdg-data"
        self.assertEqual(
            self._data_dir({"XDG_DATA_HOME": str(xdg)}),
            xdg / "MyGCFlow",
        )

    def test_sans_xdg_repli_sur_local_share(self):
        self.assertEqual(
            self._data_dir(),
            self.home / ".local" / "share" / "MyGCFlow",
        )

    def test_reprend_le_dossier_davant_xdg_dans_home(self):
        """Les builds d'avant XDG écrivaient dans ~/MyGCFlow : reprise au XDG."""
        (self.home / "MyGCFlow" / "instance").mkdir(parents=True)
        xdg = self.home / "xdg-data"
        result = self._data_dir({"XDG_DATA_HOME": str(xdg)})
        self.assertEqual(result, xdg / "MyGCFlow")
        self.assertTrue((result / "instance").is_dir())
        self.assertFalse((self.home / "MyGCFlow").exists())

    def test_reprend_lancien_nom_dans_home(self):
        """~/GCMap (ancien nom d'avant XDG) est également repris."""
        (self.home / "GCMap" / "instance").mkdir(parents=True)
        xdg = self.home / "xdg-data"
        result = self._data_dir({"XDG_DATA_HOME": str(xdg)})
        self.assertEqual(result, xdg / "MyGCFlow")
        self.assertTrue((result / "instance").is_dir())
        self.assertFalse((self.home / "GCMap").exists())

    def test_lancien_nom_sous_xdg_prime_sur_home(self):
        """Premier candidat existant gagne : base/GCMap avant ~/MyGCFlow."""
        legacy_xdg = self.home / "xdg-data" / "GCMap"
        legacy_xdg.mkdir(parents=True)
        (legacy_xdg / "marqueur").write_text("x", encoding="utf-8")
        (self.home / "MyGCFlow").mkdir()
        result = self._data_dir({"XDG_DATA_HOME": str(self.home / "xdg-data")})
        self.assertEqual(result, self.home / "xdg-data" / "MyGCFlow")
        self.assertTrue((result / "marqueur").exists())
        self.assertTrue((self.home / "MyGCFlow").exists())


class LinuxConfigDirTests(unittest.TestCase):
    """app_config_dir() sous Linux : $XDG_CONFIG_HOME et reprises."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="mygcflow-xdg-config-"))
        self.addCleanup(shutil.rmtree, self.home, True)

    def _config_dir(self, env=None):
        """app_config_dir() variables de redirection et XDG sous contrôle."""
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ, {}, clear=False):
            for var in ("MYGCFLOW_CONFIG_DIR", "GCMAP_CONFIG_DIR",
                        "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
                os.environ.pop(var, None)
            os.environ.update(env or {})
            return settings_manager.app_config_dir()

    def test_variable_de_redirection_prioritaire(self):
        """MYGCFLOW_CONFIG_DIR reste prioritaire sur toute base de plateforme."""
        choisi = self.home / "choisi"
        with mock.patch.dict(os.environ, {"MYGCFLOW_CONFIG_DIR": str(choisi)}, clear=False):
            self.assertEqual(settings_manager.app_config_dir(), choisi)

    def test_xdg_config_home_est_honore(self):
        xdg = self.home / "xdg-config"
        self.assertEqual(
            self._config_dir({"XDG_CONFIG_HOME": str(xdg)}),
            xdg / "MyGCFlow",
        )

    def test_sans_xdg_repli_sur_dot_config(self):
        self.assertEqual(self._config_dir(), self.home / ".config" / "MyGCFlow")

    def test_reprend_le_dossier_davant_xdg_dans_home(self):
        """Config d'avant XDG dans ~/MyGCFlow : déplacée vers le dossier XDG."""
        (self.home / "MyGCFlow" / "profiles").mkdir(parents=True)
        xdg = self.home / "xdg-config"
        result = self._config_dir({"XDG_CONFIG_HOME": str(xdg)})
        self.assertEqual(result, xdg / "MyGCFlow")
        self.assertTrue((result / "profiles").is_dir())
        self.assertFalse((self.home / "MyGCFlow").exists())

    def test_reprend_lancien_nom_dans_home(self):
        """~/GCMap (ancien nom d'avant XDG) est également repris."""
        (self.home / "GCMap").mkdir()
        (self.home / "GCMap" / "settings.json").write_text("{}", encoding="utf-8")
        xdg = self.home / "xdg-config"
        result = self._config_dir({"XDG_CONFIG_HOME": str(xdg)})
        self.assertEqual(result, xdg / "MyGCFlow")
        self.assertTrue((result / "settings.json").exists())
        self.assertFalse((self.home / "GCMap").exists())


class XdgVideosDirTests(unittest.TestCase):
    """Lecture de XDG_VIDEOS_DIR dans user-dirs.dirs (dossier localisé)."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="mygcflow-xdg-videos-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        self.config_home = self.home / "xdg-config"

    def _ecrire_user_dirs(self, contenu):
        self.config_home.mkdir(parents=True, exist_ok=True)
        (self.config_home / "user-dirs.dirs").write_text(contenu, encoding="utf-8")

    def _videos_dir(self):
        with _plateforme_posix(self.home), \
                mock.patch.dict(os.environ,
                                {"XDG_CONFIG_HOME": str(self.config_home)},
                                clear=False):
            return paths._xdg_videos_dir()

    def test_dossier_videos_localise(self):
        self._ecrire_user_dirs('XDG_VIDEOS_DIR="$HOME/Vidéos"\n')
        self.assertEqual(self._videos_dir(), self.home / "Vidéos")

    def test_valeur_relative_rejetee(self):
        """user-dirs.dirs ne supporte que des absolus ou $HOME/... ; sinon None."""
        self._ecrire_user_dirs('XDG_VIDEOS_DIR="Videos"\n')
        self.assertIsNone(self._videos_dir())

    def test_fichier_absent(self):
        self.assertIsNone(self._videos_dir())

    def test_cle_absente_du_fichier(self):
        self._ecrire_user_dirs('XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n')
        self.assertIsNone(self._videos_dir())


class DefaultVideoDirTests(unittest.TestCase):
    """default_video_dir() gelée sous Linux : dossier « Vidéos » localisé."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="mygcflow-videos-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        self.config_home = self.home / "xdg-config"

    def _default_video_dir(self):
        with _plateforme_posix(self.home), \
                mock.patch.object(paths, "is_frozen", return_value=True), \
                mock.patch.object(paths, "configured_video_dir", return_value=None), \
                mock.patch.dict(os.environ,
                                {"XDG_CONFIG_HOME": str(self.config_home)},
                                clear=False):
            for var in ("MYGCFLOW_DATA_DIR", "MYGCFLOW_RUNTIME_DIR",
                        "GCMAP_DATA_DIR", "GCMAP_RUNTIME_DIR"):
                os.environ.pop(var, None)
            return paths.default_video_dir()

    def test_dossier_videos_xdg_localise(self):
        """~/Vidéos/MyGCFlow quand user-dirs.dirs localise le dossier."""
        self.config_home.mkdir(parents=True)
        (self.config_home / "user-dirs.dirs").write_text(
            'XDG_VIDEOS_DIR="$HOME/Vidéos"\n', encoding="utf-8")
        self.assertEqual(
            self._default_video_dir(),
            self.home / "Vidéos" / "MyGCFlow",
        )

    def test_sans_user_dirs_repli_sur_videos(self):
        self.assertEqual(
            self._default_video_dir(),
            self.home / "Videos" / "MyGCFlow",
        )


if __name__ == "__main__":
    unittest.main()
