"""Route /license : textes de licence servis par l'application.

Le pied de l'onglet Préférences y renvoie plutôt que vers GitHub, pour que la
licence reste lisible hors connexion.
"""

import unittest

from flask import Flask


class LicenseRouteTests(unittest.TestCase):

    def setUp(self):
        from blueprints import core as core_bp_module

        self.app = Flask(__name__)
        self.app.register_blueprint(core_bp_module.core_bp)
        self.client = self.app.test_client()

    def test_license_is_the_mit_text(self):
        response = self.client.get('/license')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'text/plain')
        self.assertIn('MIT License', response.get_data(as_text=True))

    def test_third_party_notices_are_served(self):
        response = self.client.get('/license/third-party')

        self.assertEqual(response.status_code, 200)
        self.assertIn('FFmpeg', response.get_data(as_text=True))

    def test_unknown_name_is_not_found(self):
        """Le nom vient de l'URL : seuls les fichiers prévus sont lisibles."""
        self.assertEqual(self.client.get('/license/app.py').status_code, 404)
