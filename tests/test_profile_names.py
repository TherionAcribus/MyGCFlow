import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import settings_manager
from settings_manager import InvalidProfileNameError, SettingsManager


class ProfileFileKeyTests(unittest.TestCase):
    """Règle de nommage de fichier, miroir de profileNameKey() dans profiles.js.

    Ces cas servent de corpus commun aux deux implémentations : toute évolution
    ici doit être répercutée côté JS, sans quoi la modale annoncerait une
    collision différente de celle que le serveur applique réellement.
    """

    def test_key_drops_separators_but_keeps_unicode_letters_and_digits(self):
        key = SettingsManager._profile_file_key
        self.assertEqual(key("Mon Profil"), "MonProfil")
        # Le point de départ du problème : deux noms distincts, un seul fichier.
        self.assertEqual(key("MonProfil"), key("Mon Profil"))
        self.assertEqual(key("a-b_c"), "a-b_c")
        self.assertEqual(key("Été 2026"), "Été2026")
        self.assertEqual(key("東京 1"), "東京1")
        self.assertEqual(key("Nuit d'été !"), "Nuitdété")

    def test_key_is_empty_when_nothing_usable_remains(self):
        self.assertEqual(SettingsManager._profile_file_key("!!! ???"), "")
        self.assertEqual(SettingsManager._profile_file_key("  "), "")


class ProfileNameValidationTests(unittest.TestCase):
    def setUp(self):
        # Les profils réels vivent dans %APPDATA%\MyGCFlow : sans redirection des
        # constantes de module, ce test créerait et supprimerait des profils de
        # l'utilisateur. SettingsManager n'est instancié qu'une fois redirigé.
        tmp = Path(tempfile.mkdtemp(prefix="mygcflow-profile-names-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, value in {
            "CONFIG_DIR": tmp,
            "PROFILES_DIR": tmp / "profiles",
            "SETTINGS_PATH": tmp / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Flag de seeding posé d'avance : chaque test part d'un dossier vide, sans
        # la dizaine de profils d'exemple que le premier lancement installerait.
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            # Lot d'exemples à jour : sinon la migration installerait les
            # exemples ajoutés depuis (cf. EXAMPLES_VERSION).
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = SettingsManager()

    def test_create_refuses_a_name_colliding_only_after_sanitization(self):
        self.manager.create_profile("Mon Profil")
        with self.assertRaises(ValueError):
            self.manager.create_profile("MonProfil")
        self.assertEqual(self.manager.list_profiles(), ["Mon Profil"])

    def test_create_refuses_a_name_without_any_usable_character(self):
        # Sans ce refus, le nom retombait sur "Default.json" et écrasait
        # silencieusement un profil existant portant ce nom.
        self.manager.create_profile("Default")
        with self.assertRaises(InvalidProfileNameError):
            self.manager.create_profile("!!! ???")
        self.assertEqual(self.manager.list_profiles(), ["Default"])

    def test_rename_refuses_an_unusable_name_and_keeps_the_profile(self):
        self.manager.create_profile("Alpha")
        with self.assertRaises(InvalidProfileNameError):
            self.manager.rename_profile("Alpha", "***")
        self.assertEqual(self.manager.list_profiles(), ["Alpha"])

    def test_rename_allows_a_cosmetic_change_landing_on_the_same_file(self):
        self.manager.create_profile("MonProfil")
        prof = self.manager.rename_profile("MonProfil", "Mon Profil")
        self.assertEqual(prof.name, "Mon Profil")
        self.assertEqual(self.manager.list_profiles(), ["Mon Profil"])

    def test_duplicate_refuses_an_unusable_name(self):
        self.manager.create_profile("Alpha")
        with self.assertRaises(InvalidProfileNameError):
            self.manager.duplicate_profile("Alpha", "  ")
        self.assertEqual(self.manager.list_profiles(), ["Alpha"])

    def test_duplicate_resolves_a_sanitization_collision_with_a_suffix(self):
        self.manager.create_profile("Alpha")
        self.manager.create_profile("Alpha copy")
        prof = self.manager.duplicate_profile("Alpha", "Alphacopy")
        self.assertEqual(prof.name, "Alphacopy (1)")


if __name__ == "__main__":
    unittest.main()
