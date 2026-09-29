import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import settings_manager
from settings_manager import SettingsManager, atomic_write, backup_path


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mygcflow-atomic-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = self.tmp / "x.json"

    def _leftover_tmp_files(self):
        return list(self.tmp.glob("*.tmp"))

    def test_concurrent_writes_of_the_same_file_all_succeed(self):
        # Avec un temporaire au nom fixe, deux écritures simultanées se
        # déplaçaient mutuellement leur fichier (FileNotFoundError).
        errors = []

        def write(i):
            try:
                for _ in range(20):
                    atomic_write(self.path, f'{{"i": {i}}}')
            except Exception as exc:  # pragma: no cover - rapporté ci-dessous
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertEqual(self._leftover_tmp_files(), [])
        self.assertIn('"i":', self.path.read_text(encoding="utf-8"))

    def test_a_transient_permission_error_is_retried(self):
        real_replace = settings_manager.os.replace
        calls = []

        def flaky_replace(src, dst):
            calls.append(dst)
            if len(calls) < 3:
                raise PermissionError("fichier ouvert ailleurs")
            return real_replace(src, dst)

        with mock.patch.object(settings_manager.os, "replace", flaky_replace), \
                mock.patch.object(settings_manager, "_REPLACE_RETRY_DELAY_S", 0):
            atomic_write(self.path, "{}")

        self.assertEqual(len(calls), 3)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{}")
        self.assertEqual(self._leftover_tmp_files(), [])

    def test_a_failed_write_leaves_no_temporary_file(self):
        with mock.patch.object(settings_manager.os, "replace", side_effect=PermissionError("verrouillé")), \
                mock.patch.object(settings_manager, "_REPLACE_RETRY_DELAY_S", 0):
            with self.assertRaises(PermissionError):
                atomic_write(self.path, "{}")
        self.assertEqual(self._leftover_tmp_files(), [])


class ProfileFilesCleanupTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-profile-storage-"))
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
        self.profiles_dir = tmp / "profiles"

    def _saved_twice(self, name):
        # Deux écritures : la seconde laisse un .bak de la première.
        prof = self.manager.create_profile(name)
        self.manager.save_profile(prof)
        path = self.profiles_dir / f"{name}.json"
        self.assertTrue(backup_path(path).exists())
        return path

    def test_delete_removes_the_backup_too(self):
        path = self._saved_twice("Alpha")
        self.manager.delete_profile("Alpha")
        self.assertFalse(path.exists())
        self.assertFalse(backup_path(path).exists())

    def test_rename_removes_the_backup_of_the_old_file(self):
        old = self._saved_twice("Alpha")
        self.manager.rename_profile("Alpha", "Beta")
        self.assertFalse(old.exists())
        self.assertFalse(backup_path(old).exists())
        self.assertTrue((self.profiles_dir / "Beta.json").exists())

    def test_concurrent_creations_of_the_same_name_create_a_single_profile(self):
        # Vérifier que le nom est libre puis écrire se fait verrou tenu : sans
        # cela, les deux requêtes voyaient le nom libre et la seconde écrasait
        # la première (uid différent, même fichier).
        results, errors = [], []

        def create():
            try:
                results.append(self.manager.create_profile("Gamma"))
            except ValueError as exc:
                errors.append(exc)

        threads = [threading.Thread(target=create) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(results), 1)
        self.assertEqual(len(errors), 5)
        self.assertEqual(self.manager.load_profile("Gamma").uid, results[0].uid)


if __name__ == "__main__":
    unittest.main()
