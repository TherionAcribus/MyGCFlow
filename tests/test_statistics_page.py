"""Page « Statistiques » (/stats, blueprints/statistics.py) et en-tête partagé.

Plan : MyGCFlow_Plan_Statistiques.md. Les ressources hors ligne (ECharts
vendoré) sont couvertes par test_offline_assets.py, qui parcourt tous les
gabarits.
"""

import os
import tempfile
import unittest

from app import create_app
from extensions import db


class StatisticsPageTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def test_page_is_served_without_the_map(self):
        response = self.client.get("/stats")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-page="stats"', html)
        self.assertIn('static/vendor/echarts/echarts.min.js', html)
        self.assertIn('static/vendor/echarts/langFR.js', html)
        self.assertIn('static/js/stats_page.js', html)
        # Ni carte ni graphe de la page carte.
        self.assertNotIn('vendor/ol/ol.js', html)
        self.assertNotIn('static/js/index.js', html)

    def test_stats_link_is_active_on_its_page_only(self):
        stats = self.client.get("/stats").get_data(as_text=True)
        self.assertIn('id="linkStatsMode" class="app-mode-link active"', stats)
        self.assertIn('id="linkMainMode" class="app-mode-link "', stats)

        for path in ("/", "/evolution", "/poses"):
            html = self.client.get(path).get_data(as_text=True)
            self.assertIn('id="linkStatsMode"', html, path)
            self.assertIn('id="linkStatsMode" class="app-mode-link "', html, path)

    def test_header_keeps_theme_selector_on_every_page(self):
        for path in ("/", "/stats"):
            html = self.client.get(path).get_data(as_text=True)
            self.assertIn('id="appHeaderTheme"', html, path)

    def test_quit_button_follows_the_launcher(self):
        self.assertNotIn('id="buttonQuitAppHeader"', self.client.get("/stats").get_data(as_text=True))
        self.app.config['QUIT_HOOK'] = lambda: None
        self.assertIn('id="buttonQuitAppHeader"', self.client.get("/stats").get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
