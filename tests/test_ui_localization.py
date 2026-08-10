import gettext
import unittest
from pathlib import Path

from babel.messages.extract import extract_from_file


ROOT = Path(__file__).resolve().parents[1]


class UiLocalizationTests(unittest.TestCase):
    def test_preferences_use_french_canonical_msgids(self):
        template = (ROOT / "templates" / "menu_options.html").read_text(encoding="utf-8")

        for legacy_msgid in (
            "Language Choice",
            "English",
            "Check for a new version at startup",
            "Default profile at startup",
            "Check for a new version",
            "Home",
        ):
            self.assertNotIn(f'_("{legacy_msgid}")', template)

        for canonical_msgid in (
            "Choix de la langue",
            "Anglais",
            "Vérifier les nouvelles versions au démarrage",
            "Profil par défaut au démarrage",
            "Vérifier les mises à jour",
            "Accueil",
        ):
            self.assertIn(f'_("{canonical_msgid}")', template)

    def test_ui_toast_literals_are_marked_for_babel_extraction(self):
        extracted = extract_from_file(
            "javascript",
            ROOT / "static" / "js" / "ui.js",
            keywords={"t": None},
            comment_tags=(),
            options={},
        )
        msgids = {
            message if isinstance(message, str) else message[0]
            for _, message, _, _ in extracted
        }

        for msgid in (
            "Durée de l'animation ajustée selon la musique",
            "Erreur lors de la lecture du fichier audio",
            "Coordonnées invalides. Ex: 48.85, 2.35 ou N 49° 16.029 E 006° 07.512",
            "Coordonnées invalides. Ex: N 49° 16.029 / E 006° 07.512",
            "Cliquez sur la carte pour choisir le centre",
            "Centre par défaut mis à jour depuis la carte",
            "Aucune destination",
            "Impossible d’ouvrir le dossier vidéo",
            "Erreur lors de l’ouverture du dossier vidéo",
            "Assemblage de la vidéo en cours...",
            "Vidéo créée avec succès !",
            "Vidéo prête",
            "Erreur lors de l'assemblage de la vidéo",
        ):
            self.assertIn(msgid, msgids)

    def test_english_catalog_translates_preferences_and_toasts(self):
        catalog = gettext.translation(
            "messages",
            localedir=ROOT / "translations",
            languages=["en"],
        )

        expected = {
            "Choix de la langue": "Language choice",
            "Vérifier les nouvelles versions au démarrage": "Check for new versions at startup",
            "Profil par défaut au démarrage": "Default profile at startup",
            "Accueil": "Home",
            "Format non supporté": "Unsupported format",
            "Erreur lors de la lecture du fichier audio": "Error reading the audio file",
            "Centre par défaut mis à jour depuis la carte": "Default center updated from the map",
            "Aucune destination": "No destination",
            "Impossible d’ouvrir le dossier vidéo": "Unable to open the video folder",
            "Erreur lors de l'assemblage de la vidéo": "Error assembling the video",
        }
        for msgid, translated in expected.items():
            self.assertEqual(catalog.gettext(msgid), translated)


if __name__ == "__main__":
    unittest.main()
