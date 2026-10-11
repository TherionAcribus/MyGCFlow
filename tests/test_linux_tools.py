"""Outils de bureau hors Windows : sélecteur de dossier et Corbeille.

Sous Windows, rien de tout cela ne s'exécute (la branche `os.name == "nt"`
reste sur ctypes) : ces tests tournent la branche réelle et simulent les
outils externes — zenity, kdialog, gio, kioclient — en patchant shutil.which
et subprocess.run. Aucun vrai processus requis.

os.name est forcé à "posix" : lancés sous Windows sans cela, ces tests
ouvriraient de vrais sélecteurs de dossier bloquants et passeraient par la
vraie Corbeille.
"""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import folder_picker
import recycle_bin


def _which(*available):
    """shutil.which factice : ne « trouve » que les outils nommés."""
    return lambda name: f"/usr/bin/{name}" if name in available else None


def _completed(returncode, stdout=b""):
    """CompletedProcess factice : seuls returncode et stdout sont lus."""
    return mock.Mock(returncode=returncode, stdout=stdout)


def _hors_windows(test):
    """Force os.name à "posix" pour la durée du test.

    À appeler après avoir construit les Path du test : sous Windows, Path()
    refuse de s'instancier tant que os.name vaut "posix".
    """
    patcher = mock.patch.object(os, "name", "posix")
    patcher.start()
    test.addCleanup(patcher.stop)


class PickFolderLinuxTests(unittest.TestCase):
    """Cascade zenity → kdialog de pick_folder hors Windows."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="mygcflow-picker-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        _hors_windows(self)

    def test_zenity_renvoie_le_dossier_choisi(self):
        with mock.patch.object(folder_picker.shutil, "which", _which("zenity")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  return_value=_completed(0, b"/chemin/choisi\n")) as run:
            self.assertEqual(
                folder_picker.pick_folder("Choisir"),
                (folder_picker.PICKED, "/chemin/choisi"),
            )
        args = run.call_args[0][0]
        self.assertEqual(args[0], "zenity")
        self.assertIn("--file-selection", args)
        self.assertIn("--directory", args)
        self.assertIn("--title=Choisir", args)

    def test_zenity_annulation(self):
        """Code retour 1 (ou 5, délai) : l'utilisateur a refermé sans choisir."""
        for code in (1, 5):
            with mock.patch.object(folder_picker.shutil, "which", _which("zenity")), \
                    mock.patch.object(folder_picker.subprocess, "run",
                                      return_value=_completed(code)):
                self.assertEqual(
                    folder_picker.pick_folder(),
                    (folder_picker.CANCELLED, None),
                )

    def test_kdialog_quand_zenity_absent(self):
        with mock.patch.object(folder_picker.shutil, "which", _which("kdialog")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  return_value=_completed(0, b"/choix/kde\n")) as run:
            self.assertEqual(
                folder_picker.pick_folder(),
                (folder_picker.PICKED, "/choix/kde"),
            )
        args = run.call_args[0][0]
        self.assertEqual(args[0], "kdialog")
        self.assertIn("--getexistingdirectory", args)

    def test_kdialog_prend_le_relais_si_zenity_echoue(self):
        """Outil présent mais code inattendu : on essaie le suivant."""
        with mock.patch.object(folder_picker.shutil, "which", _which("zenity", "kdialog")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  side_effect=[_completed(2),
                                               _completed(0, b"/choix/kde\n")]) as run:
            self.assertEqual(
                folder_picker.pick_folder(),
                (folder_picker.PICKED, "/choix/kde"),
            )
        self.assertEqual(run.call_args[0][0][0], "kdialog")

    def test_outil_inutilisable_fait_essayer_le_suivant(self):
        with mock.patch.object(folder_picker.shutil, "which", _which("zenity", "kdialog")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  side_effect=[OSError("pas d'affichage"),
                                               _completed(1)]) as run:
            self.assertEqual(
                folder_picker.pick_folder(),
                (folder_picker.CANCELLED, None),
            )
        self.assertEqual(run.call_args[0][0][0], "kdialog")

    def test_aucun_outil_unavailable(self):
        """Sans zenity ni kdialog : l'interface repasse en saisie manuelle."""
        with mock.patch.object(folder_picker.shutil, "which", _which()), \
                mock.patch.object(folder_picker.subprocess, "run") as run:
            self.assertEqual(
                folder_picker.pick_folder(),
                (folder_picker.UNAVAILABLE, None),
            )
        run.assert_not_called()

    def test_filename_seulement_pour_un_dossier_reel(self):
        base = self.base
        with mock.patch.object(folder_picker.shutil, "which", _which("zenity")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  return_value=_completed(1)) as run:
            folder_picker.pick_folder(initial_dir=str(base))
        # zenity n'ouvre un dossier que si le chemin finit par le séparateur.
        self.assertIn(f"--filename={base}{os.sep}", run.call_args[0][0])

        with mock.patch.object(folder_picker.shutil, "which", _which("zenity")), \
                mock.patch.object(folder_picker.subprocess, "run",
                                  return_value=_completed(1)) as run:
            folder_picker.pick_folder(initial_dir=str(base / "inexistant"))
        self.assertFalse(
            any(arg.startswith("--filename") for arg in run.call_args[0][0])
        )

    def test_dialogue_deja_ouvert_busy(self):
        """Une seule boîte à la fois, toutes plateformes confondues."""
        self.assertTrue(folder_picker._dialog_lock.acquire(blocking=False))
        try:
            with mock.patch.object(folder_picker.subprocess, "run") as run:
                self.assertEqual(
                    folder_picker.pick_folder(),
                    (folder_picker.BUSY, None),
                )
            run.assert_not_called()
        finally:
            folder_picker._dialog_lock.release()


class SendToTrashLinuxTests(unittest.TestCase):
    """Cascade gio → kioclient → suppression définitive de send_to_trash."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="mygcflow-trash-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.target = self.base / "video.mp4"
        self.target.write_text("données", encoding="utf-8")
        _hors_windows(self)

    def _fake_trash(self, cmd, **kwargs):
        """subprocess.run factice : l'outil « déplace » vraiment le fichier."""
        self.target.unlink()
        return _completed(0)

    def test_gio_trash_envoie_a_la_corbeille(self):
        with mock.patch.object(recycle_bin.shutil, "which", _which("gio")), \
                mock.patch.object(recycle_bin.subprocess, "run",
                                  side_effect=self._fake_trash) as run:
            self.assertTrue(recycle_bin.send_to_trash(self.target))
        self.assertFalse(self.target.exists())
        args = run.call_args[0][0]
        self.assertEqual(args[:2], ["gio", "trash"])

    def test_kioclient_quand_gio_absent(self):
        """KDE sans gio : kioclient (Frameworks 6) déplace vers trash:/."""
        with mock.patch.object(recycle_bin.shutil, "which", _which("kioclient")), \
                mock.patch.object(recycle_bin.subprocess, "run",
                                  side_effect=self._fake_trash) as run:
            self.assertTrue(recycle_bin.send_to_trash(self.target))
        args = run.call_args[0][0]
        self.assertEqual(args[:2], ["kioclient", "move"])
        self.assertIn("trash:/", args)

    def test_echec_gio_suppression_definitive(self):
        """Outil présent mais la Corbeille refuse : os.remove prend le relais."""
        with mock.patch.object(recycle_bin.shutil, "which", _which("gio")), \
                mock.patch.object(recycle_bin.subprocess, "run",
                                  return_value=_completed(1)):
            self.assertFalse(recycle_bin.send_to_trash(self.target))
        self.assertFalse(self.target.exists())

    def test_sans_outil_suppression_definitive(self):
        with mock.patch.object(recycle_bin.shutil, "which", _which()), \
                mock.patch.object(recycle_bin.subprocess, "run") as run:
            self.assertFalse(recycle_bin.send_to_trash(self.target))
        run.assert_not_called()
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
