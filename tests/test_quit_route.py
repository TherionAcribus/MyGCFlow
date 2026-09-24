"""Route /api/quit : seconde sortie de l'application.

L'icône de la zone de notification était la seule façon de fermer MyGCFlow, et
Windows 11 la range par défaut dans le débordement masqué : un utilisateur qui
ne la trouve pas se retrouvait avec un processus qu'il ne pouvait plus arrêter.
"""

import unittest
from unittest import mock

from flask import Flask

import security
from task_manager import task_manager


class QuitRouteTests(unittest.TestCase):

    def setUp(self):
        from blueprints import core as core_bp_module

        self.quit_hook = mock.MagicMock()
        self.app = Flask(__name__)
        self.app.config['APP_VERSION'] = '1.0.0'
        self.app.config['QUIT_HOOK'] = self.quit_hook
        self.app.register_blueprint(core_bp_module.core_bp)
        self.client = self.app.test_client()

    def test_quit_calls_the_launcher_hook(self):
        response = self.client.post('/api/quit', json={})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['quitting'])
        self.quit_hook.assert_called_once()

    def test_get_is_refused(self):
        """Une image ou un lien ne doit pas pouvoir éteindre l'application."""
        self.assertEqual(self.client.get('/api/quit').status_code, 405)

    def test_cross_origin_post_is_refused(self):
        """Un formulaire d'une autre page vise 127.0.0.1 sans pré-vol CORS."""
        security.init_app(self.app)

        response = self.client.post(
            '/api/quit', json={}, headers={'Origin': 'https://evil.example.com'}
        )

        self.assertEqual(response.status_code, 403)
        self.quit_hook.assert_not_called()

    def test_running_task_blocks_the_first_attempt(self):
        with mock.patch.object(task_manager, 'active_tasks') as active:
            active.return_value = [mock.Mock(id='abc', type='video')]

            response = self.client.post('/api/quit', json={})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['reason'], 'busy')
        self.quit_hook.assert_not_called()

    def test_forced_quit_interrupts_a_running_task(self):
        with mock.patch.object(task_manager, 'active_tasks') as active:
            active.return_value = [mock.Mock(id='abc', type='video')]

            response = self.client.post('/api/quit', json={'force': True})

        self.assertEqual(response.status_code, 200)
        self.quit_hook.assert_called_once()

    def test_without_launcher_the_route_says_so(self):
        """`python app.py` n'a pas de lanceur à arrêter : pas de bouton non plus."""
        self.app.config['QUIT_HOOK'] = None

        response = self.client.post('/api/quit', json={})

        self.assertEqual(response.status_code, 501)
        self.assertEqual(response.get_json()['reason'], 'unavailable')


if __name__ == "__main__":
    unittest.main()
