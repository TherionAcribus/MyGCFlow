#!/usr/bin/env python3
"""Vérification des mises à jour : lecture des Releases GitHub et périodicité.

Ce fichier vivait à la racine du dépôt, hors du dossier scruté par la CI
(`python -m unittest discover -s tests`) : il n'était donc jamais exécuté.
"""

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import requests

import options
from options import fetch_version_info, should_check


def _release(tag, *, body="", published="2026-01-01T10:00:00Z", assets=None,
             draft=False, prerelease=False, html_url=None):
    return {
        "tag_name": tag,
        "body": body,
        "published_at": published,
        "draft": draft,
        "prerelease": prerelease,
        "html_url": html_url or f"https://github.com/TherionAcribus/MyGCFlow/releases/tag/{tag}",
        "assets": assets if assets is not None else [],
    }


def _asset(name, url=None):
    return {
        "name": name,
        "browser_download_url": url or (
            f"https://github.com/TherionAcribus/MyGCFlow/releases/download/v1.1.0/{name}"
        ),
    }


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
        mock_get.return_value = _fake_response([_release("v1.0.0")])

        result = fetch_version_info("1.0.0")

        self.assertFalse(result["error"])
        self.assertTrue(result["checked"])
        self.assertFalse(result["update_available"])
        self.assertEqual(result["current_version"], "1.0.0")
        self.assertIsNone(result["latest_version"])
        self.assertEqual(result["versions"], [])

    @patch("options.requests.get")
    def test_update_available_picks_latest(self, mock_get):
        mock_get.return_value = _fake_response([
            _release("v1.1.0"),
            _release("v1.3.0", assets=[_asset("MyGCFlow-Setup-1.3.0.exe")]),
            _release("v1.2.0"),
        ])

        result = fetch_version_info("1.0.0")

        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest_version"]["version"], "1.3.0")
        self.assertEqual(
            result["latest_version"]["download_url"],
            "https://github.com/TherionAcribus/MyGCFlow/releases/download/v1.1.0/MyGCFlow-Setup-1.3.0.exe",
        )
        # Les 3 versions supérieures doivent être renvoyées, triées décroissant.
        self.assertEqual([v["version"] for v in result["versions"]], ["1.3.0", "1.2.0", "1.1.0"])

    @patch("options.requests.get")
    def test_version_comparison_is_semantic_not_lexical(self, mock_get):
        """1.10.0 est postérieure à 1.9.0, alors que la chaîne est « plus petite »."""
        mock_get.return_value = _fake_response([_release("v1.10.0")])

        self.assertTrue(fetch_version_info("1.9.0")["update_available"])
        self.assertFalse(fetch_version_info("1.10.0")["update_available"])

    @patch("options.requests.get")
    def test_changelog_extracted_from_markdown_body(self, mock_get):
        body = (
            "## What's Changed\n"
            "* Correction du compteur de caches\n"
            "- Ajout du suivi de caméra\n"
            "\n"
            "**Full Changelog**: https://github.com/TherionAcribus/MyGCFlow/compare/v1.0.0...v1.1.0\n"
        )
        mock_get.return_value = _fake_response([_release("v1.1.0", body=body)])

        changelog = fetch_version_info("1.0.0")["versions"][0]["changelog"]

        # Titre et lien de comparaison écartés, puces débarrassées de leur marqueur.
        self.assertEqual(changelog, ["Correction du compteur de caches", "Ajout du suivi de caméra"])

    @patch("options.requests.get")
    def test_changelog_drops_underline_rules(self, mock_get):
        """Notes en reStructuredText : le soulignement d'un titre n'est pas une puce."""
        mock_get.return_value = _fake_response([
            _release("v1.1.0", body="1.1.0 (2026-09-30)\n------------------\n\n- Correction\n")
        ])

        self.assertEqual(
            fetch_version_info("1.0.0")["versions"][0]["changelog"],
            ["1.1.0 (2026-09-30)", "Correction"],
        )

    @patch("options.requests.get")
    def test_changelog_is_escaped(self, mock_get):
        mock_get.return_value = _fake_response([
            _release("v1.1.0", body="* <img src=x onerror=alert(1)>")
        ])

        changelog = fetch_version_info("1.0.0")["versions"][0]["changelog"]

        self.assertNotIn("<img", changelog[0])
        self.assertIn("&lt;img", changelog[0])

    @patch("options.requests.get")
    def test_release_date_is_the_day_only(self, mock_get):
        mock_get.return_value = _fake_response([
            _release("v1.1.0", published="2026-09-30T08:12:45Z")
        ])

        self.assertEqual(fetch_version_info("1.0.0")["latest_version"]["date"], "2026-09-30")

    @patch("options.requests.get")
    def test_ignores_malformed_entries(self, mock_get):
        mock_get.return_value = _fake_response([
            _release("v1.5.0"),
            _release("pas-une-version"),  # tag illisible -> ignorée
            {"body": "sans tag"},         # pas de clé 'tag_name' -> ignorée
            "not-a-dict",                 # ignorée
        ])

        result = fetch_version_info("1.0.0")

        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest_version"]["version"], "1.5.0")
        self.assertEqual(len(result["versions"]), 1)

    @patch("options.requests.get")
    def test_draft_release_is_ignored(self, mock_get):
        mock_get.return_value = _fake_response([_release("v2.0.0", draft=True)])

        self.assertFalse(fetch_version_info("1.0.0")["update_available"])

    @patch("options.requests.get")
    def test_falls_back_to_release_page_without_installer_asset(self, mock_get):
        mock_get.return_value = _fake_response([
            _release("v1.1.0", assets=[_asset("MyGCFlow-1.1.0-portable.zip")])
        ])

        latest = fetch_version_info("1.0.0")["latest_version"]

        self.assertEqual(
            latest["download_url"],
            "https://github.com/TherionAcribus/MyGCFlow/releases/tag/v1.1.0",
        )

    @patch("options.requests.get")
    def test_download_url_outside_github_is_dropped(self, mock_get):
        """Un lien qui ne vient pas de GitHub ne doit pas atteindre l'interface :
        l'utilisateur clique dessus pour exécuter un binaire."""
        mock_get.return_value = _fake_response([
            _release(
                "v1.1.0",
                assets=[_asset("MyGCFlow-Setup-1.1.0.exe", "https://evil.example.com/setup.exe")],
                html_url="https://evil.example.com/release",
            )
        ])

        latest = fetch_version_info("1.0.0")["latest_version"]

        self.assertEqual(latest["download_url"], "")
        self.assertEqual(latest["release_url"], "")

    @patch("options.requests.get")
    def test_plain_http_download_url_is_dropped(self, mock_get):
        mock_get.return_value = _fake_response([
            _release(
                "v1.1.0",
                assets=[_asset(
                    "MyGCFlow-Setup-1.1.0.exe",
                    "http://github.com/TherionAcribus/MyGCFlow/releases/download/v1.1.0/x.exe",
                )],
            )
        ])

        self.assertEqual(
            fetch_version_info("1.0.0")["latest_version"]["download_url"],
            "https://github.com/TherionAcribus/MyGCFlow/releases/tag/v1.1.0",
        )

    @patch("options.requests.get")
    def test_unreadable_installed_version_proposes_nothing(self, mock_get):
        mock_get.return_value = _fake_response([_release("v1.1.0")])

        result = fetch_version_info("version-de-dev")

        self.assertTrue(result["error"])
        self.assertFalse(result["update_available"])

    @patch("options.requests.get")
    def test_network_error_returns_error_payload(self, mock_get):
        mock_get.side_effect = requests.ConnectionError("boom")

        result = fetch_version_info("1.0.0")

        self.assertTrue(result["error"])
        self.assertFalse(result["checked"])
        self.assertFalse(result["update_available"])
        self.assertEqual(result["current_version"], "1.0.0")
        self.assertIsNone(result["latest_version"])

    @patch("options.requests.get")
    def test_error_payload_leaks_no_detail_to_the_interface(self, mock_get):
        mock_get.side_effect = requests.ConnectionError("https://interne.example/secret a échoué")

        self.assertNotIn("secret", json.dumps(fetch_version_info("1.0.0")))

    @patch("options.requests.get")
    def test_invalid_json_returns_error_payload(self, mock_get):
        response = MagicMock()
        response.raise_for_status = MagicMock()
        response.json.side_effect = json.JSONDecodeError("Expecting value", "", 0)
        mock_get.return_value = response

        self.assertTrue(fetch_version_info("1.0.0")["error"])

    @patch("options.requests.get")
    def test_http_error_status_returns_error_payload(self, mock_get):
        mock_get.return_value = _fake_response([], status_code=500)

        self.assertTrue(fetch_version_info("1.0.0")["error"])

    @patch("options.requests.get")
    def test_unexpected_shape_returns_error_payload(self, mock_get):
        """Le dépôt privé répond un objet d'erreur, pas une liste de Releases."""
        mock_get.return_value = _fake_response({"message": "Not Found"})

        self.assertTrue(fetch_version_info("1.0.0")["error"])


class ShouldCheckTests(unittest.TestCase):

    def setUp(self):
        self.now = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)

    def test_first_launch_checks(self):
        self.assertTrue(should_check(None, now=self.now))

    def test_recent_check_is_postponed(self):
        last = (self.now - timedelta(hours=2)).isoformat()
        self.assertFalse(should_check(last, now=self.now))

    def test_old_check_runs_again(self):
        last = (self.now - options.CHECK_INTERVAL - timedelta(minutes=1)).isoformat()
        self.assertTrue(should_check(last, now=self.now))

    def test_manual_check_ignores_the_interval(self):
        last = (self.now - timedelta(minutes=1)).isoformat()
        self.assertTrue(should_check(last, force=True, now=self.now))

    def test_unreadable_timestamp_checks(self):
        self.assertTrue(should_check("hier après-midi", now=self.now))

    def test_timestamp_in_the_future_checks(self):
        """Horloge reculée : sans ce repli, l'utilisateur ne serait plus jamais averti."""
        last = (self.now + timedelta(days=400)).isoformat()
        self.assertTrue(should_check(last, now=self.now))

    def test_naive_timestamp_is_read_as_utc(self):
        last = (self.now - timedelta(hours=2)).replace(tzinfo=None).isoformat()
        self.assertFalse(should_check(last, now=self.now))

    def test_now_iso_is_reread_as_recent(self):
        self.assertFalse(should_check(options.now_iso()))


if __name__ == "__main__":
    unittest.main()
