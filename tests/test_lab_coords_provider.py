import unittest
import urllib.error
from unittest.mock import patch

import lab_coords_provider as lcp


def _http_error(code):
    return urllib.error.HTTPError(
        lcp.API_URL, code, "err", hdrs=None, fp=None)


class BuildPayloadTests(unittest.TestCase):

    def test_uuid_mode_payload(self):
        p = lcp.build_payload(["aaa", "bbb"], user_guid="guid-1")
        self.assertEqual(p["uuidsToFetch"], "aaa,bbb")
        self.assertEqual(p["outputFormat"], "gpx")
        self.assertEqual(p["cacheType"], "Lab Cache")
        self.assertEqual(p["userGuid"], "guid-1")
        # Champs requis par le service, inertes en mode UUID.
        self.assertIn("coordinates", p)
        self.assertIn("radius", p)
        # Descriptions désactivées : GPX plus léger.
        self.assertFalse(p["includeCacheDescription"])


class FetchBatchesTests(unittest.TestCase):

    def _run(self, uuids, side_effect, **kw):
        calls = []

        def fake_post(payload, retry_server_errors=True):
            calls.append(payload["uuidsToFetch"])
            self.retry_flags.append(retry_server_errors)
            return side_effect(payload)

        self.retry_flags = []

        with patch.object(lcp, "post_download", side_effect=fake_post):
            result = lcp.fetch_gpx_batches(uuids, delay=0, sleep=lambda s: None, **kw)
        return result, calls

    def test_batches_and_dedup(self):
        uuids = [f"u{i}" for i in range(7)] + ["u0"]
        result, calls = self._run(uuids, lambda p: b"<gpx/>", batch_size=3)
        self.assertEqual(len(result.payloads), 3)
        self.assertEqual(calls, ["u0,u1,u2", "u3,u4,u5", "u6"])
        self.assertEqual(result.fetched_adventures, 7)
        self.assertEqual(result.failed_uuids, [])

    def test_progress_reports_counts(self):
        seen = []
        uuids = [f"u{i}" for i in range(5)]
        self._run(uuids, lambda p: b"<gpx/>", batch_size=2,
                  progress=lambda done, total: seen.append((done, total)))
        # 2 + 2 + 1 sur un total de 5
        self.assertEqual([d for d, _ in seen], [2, 4, 5])
        self.assertTrue(all(t == 5 for _, t in seen))

    def test_on_payload_receives_batches_before_abort(self):
        """Chaque GPX est remis dès son téléchargement : un abandon au lot
        suivant ne reprend pas ce qui a déjà été livré."""
        got = []

        def side_effect(payload):
            if "u2" in payload["uuidsToFetch"]:
                raise urllib.error.URLError("down")
            return b"<gpx/>"

        with self.assertRaises(urllib.error.URLError):
            self._run(["u0", "u1", "u2", "u3"], side_effect, batch_size=2,
                      on_payload=lambda name, data: got.append((name, data)))
        self.assertEqual(got, [("lab2gpx-auto-001.gpx", b"<gpx/>")])

    def test_on_payload_replaces_accumulation(self):
        got = []
        result, _ = self._run(["u0", "u1", "u2"], lambda p: b"<gpx/>",
                              batch_size=2, on_payload=lambda n, d: got.append(n))
        self.assertEqual(len(got), 2)
        self.assertEqual(result.payloads, [])
        self.assertEqual(result.fetched_adventures, 3)

    def test_bisection_isolates_bad_uuid(self):
        def side_effect(payload):
            if "bad" in payload["uuidsToFetch"]:
                raise _http_error(500)
            return b"<gpx/>"

        result, calls = self._run(["a", "bad", "c", "d"], side_effect,
                                  batch_size=4)
        self.assertEqual(result.failed_uuids, ["bad"])
        self.assertEqual(result.fetched_adventures, 3)
        # Lot entier (500) → moitiés → singletons : le fautif isolé.
        self.assertIn("a,bad", calls)
        self.assertIn("c,d", calls)
        self.assertIn("bad", calls)
        # Un 500 n'est retenté sur place que pour l'UUID seul : pour un lot
        # divisible, la bissection est déjà la reprise.
        self.assertEqual(self.retry_flags,
                         [len(c.split(",")) == 1 for c in calls])

    def test_on_failed_reports_isolated_uuid(self):
        def side_effect(payload):
            if "bad" in payload["uuidsToFetch"]:
                raise _http_error(500)
            return b"<gpx/>"

        failed = []
        self._run(["a", "bad", "c", "d"], side_effect, batch_size=4,
                  on_failed=failed.append)
        self.assertEqual(failed, ["bad"])

    def test_single_uuid_error_marked_failed(self):
        """Un UUID seul en échec (4xx comme 500 : les Adventures cassées
        échouent en 500) est classé en échec, jamais remonté."""
        for code in (400, 500):
            result, _ = self._run(
                ["x"], lambda p: (_ for _ in ()).throw(_http_error(code)),
                batch_size=50)
            self.assertEqual(result.failed_uuids, ["x"], code)
            self.assertEqual(result.fetched_adventures, 0, code)
            self.assertEqual(result.payloads, [], code)

    def test_persistent_5xx_aborts_on_budget(self):
        """5xx sur tous les lots = panne de service, pas des données cassées :
        le budget d'échecs consécutifs arrête la bissection."""
        def side_effect(payload):
            raise _http_error(500)

        with self.assertRaises(urllib.error.HTTPError):
            self._run([f"u{i}" for i in range(64)], side_effect, batch_size=8)

    def test_network_error_aborts_immediately(self):
        """Erreur réseau épuisée : pas de bissection — rien à isoler."""
        def side_effect(payload):
            raise urllib.error.URLError("down")

        with self.assertRaises(urllib.error.URLError):
            self._run(["a", "b"], side_effect, batch_size=2)


class PostDownloadTests(unittest.TestCase):

    def _urlopen_side_effect(self, outcomes):
        calls = {"n": 0}

        def fake(req, timeout=None):
            calls["n"] += 1
            out = outcomes[min(calls["n"] - 1, len(outcomes) - 1)]
            if isinstance(out, Exception):
                raise out
            class R:
                def read(self): return out
                def __enter__(self): return self
                def __exit__(self, *a): return False
            return R()
        return calls, fake

    def test_retry_on_5xx_then_success(self):
        calls, fake = self._urlopen_side_effect(
            [_http_error(502), b"<gpx/>"])
        with patch.object(lcp.urllib.request, "urlopen", side_effect=fake), \
                patch.object(lcp.time, "sleep"):
            data = lcp.post_download({"x": 1}, retries=3)
        self.assertEqual(data, b"<gpx/>")
        self.assertEqual(calls["n"], 2)

    def test_no_retry_on_4xx(self):
        calls, fake = self._urlopen_side_effect([_http_error(400)])
        with patch.object(lcp.urllib.request, "urlopen", side_effect=fake), \
                patch.object(lcp.time, "sleep"), \
                self.assertRaises(urllib.error.HTTPError):
            lcp.post_download({"x": 1}, retries=3)
        self.assertEqual(calls["n"], 1)

    def test_5xx_raised_at_once_when_retries_disabled(self):
        calls, fake = self._urlopen_side_effect([_http_error(500)])
        with patch.object(lcp.urllib.request, "urlopen", side_effect=fake), \
                patch.object(lcp.time, "sleep"), \
                self.assertRaises(urllib.error.HTTPError):
            lcp.post_download({"x": 1}, retries=3, retry_server_errors=False)
        self.assertEqual(calls["n"], 1)

    def test_429_still_retried_when_retries_disabled(self):
        calls, fake = self._urlopen_side_effect([_http_error(429), b"<gpx/>"])
        with patch.object(lcp.urllib.request, "urlopen", side_effect=fake), \
                patch.object(lcp.time, "sleep"):
            data = lcp.post_download({"x": 1}, retries=3,
                                     retry_server_errors=False)
        self.assertEqual(data, b"<gpx/>")
        self.assertEqual(calls["n"], 2)

    def test_network_error_retries_then_raises(self):
        calls, fake = self._urlopen_side_effect(
            [urllib.error.URLError("down")] * 3)
        with patch.object(lcp.urllib.request, "urlopen", side_effect=fake), \
                patch.object(lcp.time, "sleep"), \
                self.assertRaises(urllib.error.URLError):
            lcp.post_download({"x": 1}, retries=3)
        self.assertEqual(calls["n"], 3)


if __name__ == "__main__":
    unittest.main()
