#!/usr/bin/env python3
"""
Tests unitaires pour la logique de vérification des mises à jour (options.py).
Utilisation: python -m unittest test_check_version -v
"""

import json
import unittest
from unittest.mock import patch, MagicMock

import requests

from options import fetch_version_info


def _fake_response(payload, status_code=200):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = payload
    response.raise_for_status = MagicMock()
    if status_code >= 400:
        response.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status_code}")
    return response


class FetchVersionInfoTests(unittest.TestCase):

    @patch("options.requests.get")
    def test_up_to_date(self, mock_get):
        mock_get.return_value = _fake_response({
            "versions": [
                {"version": "1.0", "release_date": "2024-01-01", "changelog": ["Initial"]}
            ]
        })

        result = fetch_version_info("1.0")

        self.assertFalse(result["error"])
        self.assertFalse(result["update_available"])
        self.assertEqual(result["current_version"], "1.0")
        self.assertIsNone(result["latest_version"])
        self.assertEqual(result["versions"], [])

    @patch("options.requests.get")
    def test_update_available_picks_latest(self, mock_get):
        mock_get.return_value = _fake_response({
            "versions": [
                {"version": "1.1", "release_date": "2024-02-01", "changelog": ["Fix A"]},
                {"version": "1.3", "release_date": "2024-04-01", "changelog": ["Fix C"], "download_url": "http://example.com/1.3"},
                {"version": "1.2", "release_date": "2024-03-01", "changelog": ["Fix B"]},
            ]
        })

        result = fetch_version_info("1.0")

        self.assertFalse(result["error"])
        self.assertTrue(result["update_available"])
        self.assertEqual(result["current_version"], "1.0")
        self.assertEqual(result["latest_version"]["version"], "1.3")
        self.assertEqual(result["latest_version"]["download_url"], "http://example.com/1.3")
        # Les 3 versions supérieures à 1.0 doivent être renvoyées, triées par version décroissante
        self.assertEqual([v["version"] for v in result["versions"]], ["1.3", "1.2", "1.1"])

    @patch("options.requests.get")
    def test_changelog_translation_applied(self, mock_get):
        mock_get.return_value = _fake_response({
            "versions": [
                {
                    "version": "2.0",
                    "release_date": "2024-05-01",
                    "changelog": ["Default changelog"],
                    "changelog_translations": {
                        "en": ["English changelog"],
                        "fr": ["Changelog francais"]
                    }
                }
            ]
        })

        result_en = fetch_version_info("1.0", user_language="en")
        result_fr = fetch_version_info("1.0", user_language="fr")

        self.assertEqual(result_en["versions"][0]["changelog"], ["English changelog"])
        self.assertEqual(result_fr["versions"][0]["changelog"], ["Changelog francais"])

    @patch("options.requests.get")
    def test_ignores_malformed_entries(self, mock_get):
        mock_get.return_value = _fake_response({
            "versions": [
                {"version": "1.5", "release_date": "2024-06-01"},
                {"release_date": "2024-06-02"},  # pas de clé 'version' -> ignorée
                "not-a-dict",  # ignorée
            ]
        })

        result = fetch_version_info("1.0")

        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest_version"]["version"], "1.5")

    @patch("options.requests.get")
    def test_network_error_returns_error_payload(self, mock_get):
        mock_get.side_effect = requests.ConnectionError("boom")

        result = fetch_version_info("1.0")

        self.assertTrue(result["error"])
        self.assertFalse(result["update_available"])
        self.assertEqual(result["current_version"], "1.0")
        self.assertIsNone(result["latest_version"])

    @patch("options.requests.get")
    def test_invalid_json_returns_error_payload(self, mock_get):
        response = MagicMock()
        response.raise_for_status = MagicMock()
        response.json.side_effect = json.JSONDecodeError("Expecting value", "", 0)
        mock_get.return_value = response

        result = fetch_version_info("1.0")

        self.assertTrue(result["error"])
        self.assertEqual(result["current_version"], "1.0")

    @patch("options.requests.get")
    def test_http_error_status_returns_error_payload(self, mock_get):
        mock_get.return_value = _fake_response({}, status_code=500)

        result = fetch_version_info("1.0")

        self.assertTrue(result["error"])
        self.assertEqual(result["current_version"], "1.0")


if __name__ == "__main__":
    unittest.main()
