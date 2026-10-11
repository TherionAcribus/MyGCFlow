"""Replis Linux des dialogues système et de l'icône de notification.

Sous Windows, rien de tout cela ne s'exécute (la branche `os.name == "nt"`
reste sur ctypes) : ces tests tournent la branche réelle et simulent les
outils externes — zenity, kdialog, gdbus, dbus-send — en patchant
shutil.which et subprocess.run. Aucun vrai processus ni bus D-Bus requis.
"""
import os
import unittest
from unittest import mock

import capture
import launcher


def _which(*available):
    """shutil.which factice : ne « trouve » que les outils nommés."""
    return lambda name: f"/usr/bin/{name}" if name in available else None


class MessageBoxLinuxTests(unittest.TestCase):
    """Cascade zenity → kdialog → journal de _message_box hors Windows."""

    def test_zenity_question_confirmee(self):
        with mock.patch.object(launcher.shutil, "which", _which("zenity")), \
                mock.patch.object(launcher.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(launcher._message_box("Texte", "Titre", question=True))
        args = run.call_args[0][0]
        self.assertEqual(args[0], "zenity")
        self.assertIn("--question", args)
        self.assertIn("--title=Titre", args)
        self.assertIn("--text=Texte", args)

    def test_zenity_question_annulee(self):
        """Code retour 1 = Annuler : la réponse vaut « non »."""
        with mock.patch.object(launcher.shutil, "which", _which("zenity")), \
                mock.patch.object(launcher.subprocess, "run",
                                  return_value=mock.Mock(returncode=1)):
            self.assertFalse(launcher._message_box("Texte", question=True))

    def test_zenity_erreur_sans_question(self):
        with mock.patch.object(launcher.shutil, "which", _which("zenity")), \
                mock.patch.object(launcher.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(launcher._message_box("Texte"))
        self.assertIn("--error", run.call_args[0][0])

    def test_kdialog_quand_zenity_absent(self):
        with mock.patch.object(launcher.shutil, "which", _which("kdialog")), \
                mock.patch.object(launcher.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(launcher._message_box("Texte", "Titre", question=True))
        args = run.call_args[0][0]
        self.assertEqual(args[0], "kdialog")
        self.assertIn("--title=Titre", args)
        self.assertTrue(any(arg.startswith("--yesno=") for arg in args))

    def test_kdialog_erreur_sans_question(self):
        with mock.patch.object(launcher.shutil, "which", _which("kdialog")), \
                mock.patch.object(launcher.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(launcher._message_box("Texte"))
        self.assertTrue(any(arg.startswith("--error=") for arg in run.call_args[0][0]))

    def test_zenity_inutilisable_kdialog_prend_le_relais(self):
        """Outil présent mais sans affichage joignable : on essaie le suivant."""
        with mock.patch.object(launcher.shutil, "which", _which("zenity", "kdialog")), \
                mock.patch.object(launcher.subprocess, "run",
                                  side_effect=[OSError("pas d'affichage"),
                                               mock.Mock(returncode=1)]) as run:
            self.assertFalse(launcher._message_box("Texte", question=True))
        self.assertEqual(run.call_args[0][0][0], "kdialog")

    def test_aucun_outil_renvoie_vrai_et_avertit(self):
        """Le seul appelant qui teste le retour est « Quitter » de l'icône :
        l'utilisateur a déjà choisi de quitter, bloquer serait pire."""
        with mock.patch.object(launcher.shutil, "which", _which()), \
                mock.patch.object(launcher.logger, "warning") as warning:
            self.assertTrue(launcher._message_box("Texte", question=True))
        warning.assert_called_once()


class DisplayAvailableTests(unittest.TestCase):
    """_display_available : sans DISPLAY ni WAYLAND_DISPLAY, pas de tray."""

    def test_display_present(self):
        with mock.patch.dict(os.environ, {"DISPLAY": ":0"}, clear=False):
            os.environ.pop("WAYLAND_DISPLAY", None)
            self.assertTrue(launcher._display_available())

    def test_wayland_display_present(self):
        with mock.patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-0"}, clear=False):
            os.environ.pop("DISPLAY", None)
            self.assertTrue(launcher._display_available())

    def test_sans_affichage(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DISPLAY", None)
            os.environ.pop("WAYLAND_DISPLAY", None)
            self.assertFalse(launcher._display_available())


class RevealInFileManagerTests(unittest.TestCase):
    """capture._reveal_in_file_manager : sélection via FileManager1 (D-Bus)."""

    def test_gdbus_show_items_avec_uri(self):
        with mock.patch.object(capture.shutil, "which", _which("gdbus")), \
                mock.patch.object(capture.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(capture._reveal_in_file_manager("/tmp/videos/ma video.mp4"))
        args = run.call_args[0][0]
        self.assertEqual(args[0], "gdbus")
        self.assertIn("org.freedesktop.FileManager1.ShowItems", args)
        self.assertIn("['file:///tmp/videos/ma%20video.mp4']", args)

    def test_dbus_send_quand_gdbus_absent(self):
        with mock.patch.object(capture.shutil, "which", _which("dbus-send")), \
                mock.patch.object(capture.subprocess, "run",
                                  return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(capture._reveal_in_file_manager("/tmp/videos/video.mp4"))
        args = run.call_args[0][0]
        self.assertEqual(args[0], "dbus-send")
        self.assertIn("array:string:file:///tmp/videos/video.mp4", args)

    def test_aucun_client_dbus_renvoie_faux(self):
        with mock.patch.object(capture.shutil, "which", _which()), \
                mock.patch.object(capture.subprocess, "run") as run:
            self.assertFalse(capture._reveal_in_file_manager("/tmp/videos/video.mp4"))
        run.assert_not_called()

    def test_appel_echoue_renvoie_faux(self):
        """Code retour non nul ou outil inutilisable : repli sur le dossier."""
        with mock.patch.object(capture.shutil, "which", _which("gdbus")), \
                mock.patch.object(capture.subprocess, "run",
                                  return_value=mock.Mock(returncode=1)):
            self.assertFalse(capture._reveal_in_file_manager("/tmp/videos/video.mp4"))
        with mock.patch.object(capture.shutil, "which", _which("gdbus")), \
                mock.patch.object(capture.subprocess, "run", side_effect=OSError):
            self.assertFalse(capture._reveal_in_file_manager("/tmp/videos/video.mp4"))


if __name__ == "__main__":
    unittest.main()
