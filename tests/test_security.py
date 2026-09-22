import unittest

from flask import Flask

import security


class LocalServerProtectionTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        security.init_app(app)

        @app.route('/action', methods=['GET', 'POST'])
        def action():
            return 'ok'

        self.client = app.test_client()

    def _post(self, **headers):
        return self.client.post('/action', base_url='http://127.0.0.1:51730', headers=headers)

    def test_same_origin_post_is_accepted(self):
        self.assertEqual(self._post(Origin='http://127.0.0.1:51730').status_code, 200)

    def test_post_without_browser_headers_is_accepted(self):
        self.assertEqual(self._post().status_code, 200)

    def test_cross_site_post_is_rejected(self):
        self.assertEqual(self._post(Origin='https://evil.example').status_code, 403)

    def test_other_local_port_is_rejected(self):
        self.assertEqual(self._post(Origin='http://127.0.0.1:3000').status_code, 403)

    def test_null_origin_is_rejected(self):
        self.assertEqual(self._post(Origin='null').status_code, 403)

    def test_cross_site_fetch_metadata_is_rejected(self):
        self.assertEqual(self._post(**{'Sec-Fetch-Site': 'cross-site'}).status_code, 403)

    def test_cross_site_get_is_allowed(self):
        response = self.client.get('/action', base_url='http://localhost:51730',
                                   headers={'Origin': 'https://evil.example'})
        self.assertEqual(response.status_code, 200)

    def test_dns_rebinding_host_is_rejected(self):
        response = self.client.get('/action', base_url='http://evil.example:51730')
        self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    unittest.main()
