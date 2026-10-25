import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest import mock

import settings_manager
from app import create_app
from extensions import db
from models import CacheRef, LogEvent
from task_manager import task_manager

from tests.test_log_formats import CONTRACT, MY_FINDS

NODE = shutil.which("node")
BOOKMARKLET_HARNESS = Path(__file__).parent / "fixtures" / "gc_logs" / "bookmarklet_harness.cjs"


class LogsApiTests(unittest.TestCase):
    """Endpoints /api/logs/* : aperçu, validation en tâche, statut, export, suppression."""

    def setUp(self):
        # ignore_cleanup_errors : la tâche d'import en thread peut relâcher le
        # SQLite/WAL une fraction de seconde après la fin observée.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, "geocaching.db")
        self.app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{self.db_path}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()
        self.addCleanup(self._wait_for_idle)
        # Les jetons d'aperçu vivent dans un tempdir partagé : l'isoler,
        # sinon les dépôts `received` d'un test traînent dans le suivant.
        import blueprints.gc_logs as gc_logs_mod
        pending_dir = Path(self.tmpdir.name) / "pending"
        patcher = mock.patch.object(gc_logs_mod, "PENDING_ROOT", pending_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _wait_for_idle(timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline and task_manager.get_active("log_import"):
            time.sleep(0.02)

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _preview(self, data: bytes, name="logs.json"):
        return self.client.post("/api/logs/import/preview",
                                data={"file": (io.BytesIO(data), name)},
                                content_type="multipart/form-data")

    def _wait_task(self, task_id, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = task_manager.get(task_id)
            if st is not None and st.state in ("finished", "failed"):
                return st
            time.sleep(0.05)
        self.fail(f"tâche {task_id} toujours en cours après {timeout}s")

    def _import(self, data: bytes, name="logs.json"):
        rv = self._preview(data, name)
        self.assertEqual(rv.status_code, 200, rv.get_json())
        rv2 = self.client.post("/api/logs/import/commit",
                               json={"import_token": rv.get_json()["import_token"]})
        self.assertEqual(rv2.status_code, 202, rv2.get_json())
        return self._wait_task(rv2.get_json()["task_id"])

    def test_preview_then_commit(self):
        rv = self._preview(CONTRACT.read_bytes())
        body = rv.get_json()
        self.assertEqual(rv.status_code, 200, body)
        self.assertEqual(body["format"], "mygcflow-logs")
        self.assertEqual(body["summary"]["added"], 7)
        self.assertEqual(db.session.query(LogEvent).count(), 0)   # l'aperçu n'écrit rien

        rv2 = self.client.post("/api/logs/import/commit", json={"import_token": body["import_token"]})
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["added"], 7)
        self.assertEqual(st.result["status"]["logs"], 7)

        status = self.client.get("/api/logs/status").get_json()
        self.assertEqual((status["logs"], status["mine"]), (7, 4))

    def test_token_is_consumed_once(self):
        token = self._preview(CONTRACT.read_bytes()).get_json()["import_token"]
        rv = self.client.post("/api/logs/import/commit", json={"import_token": token})
        self._wait_task(rv.get_json()["task_id"])
        again = self.client.post("/api/logs/import/commit", json={"import_token": token})
        self.assertEqual(again.status_code, 400)
        bad = self.client.post("/api/logs/import/commit", json={"import_token": "../x"})
        self.assertEqual(bad.status_code, 400)

    def test_preview_is_refused_when_logs_changed_before_commit(self):
        token = self._preview(CONTRACT.read_bytes()).get_json()["import_token"]
        self._import(CONTRACT.read_bytes())          # révision 0 → 1 entre-temps
        rv = self.client.post("/api/logs/import/commit", json={"import_token": token})
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "failed")
        self.assertIn("aperçu", st.error)

    def test_other_account_is_refused_at_preview(self):
        self._import(CONTRACT.read_bytes())
        doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
        doc["account"] = {"user_id": 999}
        rv = self._preview(json.dumps(doc).encode())
        self.assertEqual(rv.status_code, 409)
        self.assertIn("999", rv.get_json()["message"])

    def test_unreadable_files(self):
        rv = self._preview(b"bonjour", "notes.txt")
        self.assertEqual(rv.status_code, 400)
        rv = self._preview(b'{"format": "mygcflow-logs", "schema_version": 9}')
        self.assertEqual(rv.status_code, 400)
        self.assertIn("version", rv.get_json()["message"])
        self.assertEqual(self.client.post("/api/logs/import/preview").status_code, 400)

    def test_gpx_in_zip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("lisez-moi.txt", "rien")
            archive.writestr("my-finds.gpx", MY_FINDS.read_bytes())
        rv = self._preview(buf.getvalue(), "pq.zip")
        self.assertEqual(rv.status_code, 200, rv.get_json())
        self.assertEqual(rv.get_json()["summary"]["added"], 4)

    # GPX de waypoints additionnels d'une Pocket Query : même espace de noms
    # Groundspeak (donc « reconnu ») mais aucune fiche ni log — il ne doit
    # jamais être choisi à la place du vrai fichier, même en premier.
    WPTS_GPX = b'''<?xml version="1.0" encoding="utf-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1"
     creator="Test" version="1.0">
  <name>Waypoints</name>
  <wpt lat="48.8584" lon="2.2945"><name>PK2PR3N</name></wpt>
</gpx>'''

    def test_zip_prefers_the_real_member(self):
        # Ordre défavorable : -wpts en tête, un .json non-logs entre les deux.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("12345_pq-wpts.gpx", self.WPTS_GPX)
            archive.writestr("notes.json", b'{"remarque": "pas un export"}')
            archive.writestr("12345_pq.gpx", MY_FINDS.read_bytes())
        rv = self._preview(buf.getvalue(), "pq.zip")
        self.assertEqual(rv.status_code, 200, rv.get_json())
        self.assertEqual(rv.get_json()["summary"]["added"], 4)

    def test_zip_prefers_a_mygcflow_logs_json(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("my-finds.gpx", MY_FINDS.read_bytes())
            archive.writestr("export/logs.json", CONTRACT.read_bytes())
        rv = self._preview(buf.getvalue(), "lot.zip")
        body = rv.get_json()
        self.assertEqual(rv.status_code, 200, body)
        self.assertEqual(body["format"], "mygcflow-logs")
        self.assertEqual(body["summary"]["added"], 7)

    def test_zip_without_usable_member(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("lisez-moi.txt", "rien")
            archive.writestr("notes.json", b'{"remarque": "pas un export"}')
        rv = self._preview(buf.getvalue(), "vide.zip")
        self.assertEqual(rv.status_code, 400)
        self.assertIn("archive", rv.get_json()["message"])

    def test_preview_reports_the_file_date(self):
        body = self._preview(CONTRACT.read_bytes()).get_json()
        self.assertEqual(body["summary"]["exported_at"], "2026-10-24T09:12:00")
        undated = json.loads(CONTRACT.read_text(encoding="utf-8"))
        del undated["exported_at"]
        body = self._preview(json.dumps(undated).encode()).get_json()
        self.assertIsNone(body["summary"]["exported_at"])

    def test_export_round_trip(self):
        self.assertEqual(self.client.get("/api/logs/export").status_code, 404)
        self._import(CONTRACT.read_bytes())
        rv = self.client.get("/api/logs/export")
        self.assertIn("mygcflow-logs-export-", rv.headers["Content-Disposition"])
        doc = rv.get_json()
        self.assertEqual((len(doc["logs"]), len(doc["caches"]), doc["coverage"]), (7, 2, []))
        # Daté comme ses données, pas comme l'export.
        self.assertEqual(doc["exported_at"], "2026-10-24T09:12:00Z")
        corrected = next(c for c in doc["caches"] if c["gc_code"] == "GC9ZZZZ")["corrected"]
        self.assertEqual(corrected, {"latitude": 48.01, "longitude": 7.01})
        st = self._import(json.dumps(doc).encode())
        self.assertEqual((st.result["added"], st.result["updated"], st.result["unchanged"]), (0, 0, 7))

    def test_clear(self):
        self._import(CONTRACT.read_bytes())
        rv = self.client.post("/api/logs/clear")
        self.assertEqual(rv.get_json()["removed_logs"], 7)
        self.assertFalse(self.client.get("/api/logs/status").get_json()["exists"])

    def test_pending_caches_and_resolve(self):
        self._import(CONTRACT.read_bytes())
        page = self.client.get("/api/logs/pending_caches").get_json()
        self.assertEqual(page["total"], 1)
        item = page["items"][0]
        self.assertEqual((item["gc_code"], item["dnf"], item["logs"]), ("GC2PR3N", 1, 2))

        # Saisie au format geocaching.com, code en minuscules accepté.
        rv = self.client.post("/api/logs/caches/gc2pr3n/resolve",
                              json={"coordinates": "N 48° 51.504 E 002° 17.670"})
        self.assertEqual(rv.status_code, 200, rv.get_json())
        self.assertAlmostEqual(rv.get_json()["latitude"], 48.8584, places=3)
        self.assertEqual(
            self.client.get("/api/logs/status").get_json()["pending_coordinates"], 0)
        self.assertEqual(
            self.client.get("/api/logs/pending_caches").get_json()["total"], 0)
        ref = db.session.query(CacheRef).filter_by(gc_code="GC2PR3N").one()
        self.assertEqual(ref.coordinate_source, "user_correction")

    def test_pending_resolve_errors(self):
        self._import(CONTRACT.read_bytes())
        self.assertEqual(self.client.post(
            "/api/logs/caches/GC2PR3N/resolve", json={}).status_code, 400)
        bad = self.client.post("/api/logs/caches/GC2PR3N/resolve",
                               json={"coordinates": "n'importe quoi"})
        self.assertEqual(bad.status_code, 400)
        self.assertIn("invalides", bad.get_json()["message"].lower())
        unknown = self.client.post("/api/logs/caches/GC00000/resolve",
                                   json={"coordinates": "48.5, 2.3"})
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(self.client.get("/api/logs/pending_caches?offset=x").status_code, 400)


class LogsAutomationTests(LogsApiTests):
    """Automatisation : /api/logs/receive (CORS+jeton, aperçu en attente),
    /api/logs/bookmarklet (favori « Envoyer vers MyGCFlow »)."""

    def setUp(self):
        super().setUp()
        # Réglages isolés : le jeton ne doit pas écrire dans la configuration
        # réelle de l'utilisateur (même pattern que LabsAutomationTests).
        cfg = Path(tempfile.mkdtemp(prefix="mygcflow-logs-cfg-"))
        self.addCleanup(shutil.rmtree, cfg, True)
        for name, value in {
            "CONFIG_DIR": cfg,
            "PROFILES_DIR": cfg / "profiles",
            "SETTINGS_PATH": cfg / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {})
        self.manager = settings_manager.SettingsManager()

        import blueprints.gc_logs as gc_logs_mod
        patcher = mock.patch.object(gc_logs_mod, "get_settings_manager",
                                    lambda: self.manager)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _set_token(self, value="tok-receive"):
        self.manager.update_app_settings(
            lambda s: replace(s, logs_receive_token=value))

    def _receive(self, data: bytes, token="tok-receive", **kw):
        return self.client.post('/api/logs/receive', data=data,
                                content_type='application/json',
                                headers={"X-MyGCFlow-Token": token}, **kw)

    # --- /api/logs/bookmarklet ---------------------------------------------

    def test_bookmarklet_generates_stable_token_and_link(self):
        rv = self.client.get('/api/logs/bookmarklet')
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body["success"])
        js = body["bookmarklet"]
        self.assertTrue(js.startswith("javascript:"))
        token = self.manager.get_app_settings().logs_receive_token
        self.assertTrue(token)
        self.assertIn(json.dumps(token), js)
        # L'origine locale réelle est celle de la requête.
        self.assertIn("/api/logs/receive", js)
        # Tous les placeholders de traduction sont remplacés.
        self.assertNotIn("__T_", js)
        # Idempotent : le jeton n'est pas régénéré (le favori resterait valide).
        self.assertEqual(
            self.client.get('/api/logs/bookmarklet').status_code, 200)
        self.assertEqual(
            self.manager.get_app_settings().logs_receive_token, token)

    def test_bookmarklet_is_a_single_comment_free_line(self):
        """Le navigateur retire les sauts de ligne d'un lien javascript: —
        un commentaire `//` resté dans le code avalerait toute la suite."""
        js = self.client.get('/api/logs/bookmarklet').get_json()["bookmarklet"]
        self.assertNotIn("\n", js)
        self.assertNotIn("//", js.replace("://", ""))
        self.assertNotIn("@include", js)
        self.assertNotIn("__ORIGIN__", js)
        self.assertNotIn("__TOKEN__", js)
        # Le cœur partagé est bien inclus.
        self.assertIn("mygcflowCollectGcLogs", js)

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_is_valid_javascript(self):
        js = self.client.get('/api/logs/bookmarklet').get_json()["bookmarklet"]
        folder = Path(tempfile.mkdtemp(prefix="mygcflow-logs-bookmarklet-"))
        self.addCleanup(shutil.rmtree, folder, True)
        # Le corps du lien est un programme JS valide (expression IIFE).
        script = folder / "bookmarklet.cjs"
        script.write_text(js[len("javascript:"):], encoding="utf-8")
        done = subprocess.run([NODE, "--check", str(script)],
                              capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))

    def test_bookmarklet_regenerate_is_post_only(self):
        self.assertEqual(
            self.client.get('/api/logs/bookmarklet/regenerate').status_code,
            405)

    def test_bookmarklet_regenerate_replaces_token_and_invalidates_old(self):
        self.client.get('/api/logs/bookmarklet')
        old_token = self.manager.get_app_settings().logs_receive_token
        self.assertTrue(old_token)

        rv = self.client.post('/api/logs/bookmarklet/regenerate')
        self.assertEqual(rv.status_code, 200)
        new_js = rv.get_json()["bookmarklet"]
        new_token = self.manager.get_app_settings().logs_receive_token
        self.assertTrue(new_token)
        self.assertNotEqual(new_token, old_token)
        self.assertIn(json.dumps(new_token), new_js)
        self.assertNotIn(json.dumps(old_token), new_js)
        # Le GET suivant ne régénère pas : le lien servi reste celui-ci.
        again = self.client.get('/api/logs/bookmarklet').get_json()["bookmarklet"]
        self.assertEqual(again, new_js)

        # L'ancien favori est mort (403 jeton) ; le nouveau passe la porte
        # jeton (le payload non-logs échoue ensuite en 400).
        for token, expected in ((old_token, 403), (new_token, 400)):
            rv = self.client.post('/api/logs/receive',
                                  data=b'<html>page</html>',
                                  content_type='application/json',
                                  headers={"X-MyGCFlow-Token": token})
            self.assertEqual(rv.status_code, expected, token)

    # --- /api/logs/receive --------------------------------------------------

    def test_receive_rejects_missing_or_wrong_token(self):
        self._set_token()
        for headers in ({}, {"X-MyGCFlow-Token": "mauvais"}):
            rv = self.client.post('/api/logs/receive',
                                  data=CONTRACT.read_bytes(),
                                  content_type='application/json',
                                  headers=headers)
            self.assertEqual(rv.status_code, 403, headers)
        # Sans jeton configuré du tout : refusé aussi (pas de bypass).
        self.manager.update_app_settings(
            lambda s: replace(s, logs_receive_token=""))
        rv = self._receive(CONTRACT.read_bytes())
        self.assertEqual(rv.status_code, 403)

    def test_receive_cors_is_scoped_to_geocaching(self):
        # Preflight : les en-têtes ne partent que pour l'origine officielle.
        for origin, allowed in (("https://www.geocaching.com", True),
                                ("https://geocaching.com", True),
                                ("https://malveillant.example", False),
                                (None, False)):
            headers = {"Origin": origin} if origin else {}
            rv = self.client.open('/api/logs/receive', method='OPTIONS',
                                  headers=headers)
            has_cors = "Access-Control-Allow-Origin" in rv.headers
            self.assertEqual(has_cors, allowed, origin)
            if allowed:
                self.assertEqual(
                    rv.headers["Access-Control-Allow-Origin"], origin)
                self.assertEqual(
                    rv.headers["Access-Control-Allow-Private-Network"], "true")

    def test_receive_rejects_bad_format(self):
        self._set_token()
        rv = self._receive(b'<html>page</html>')
        self.assertEqual(rv.status_code, 400)
        self.assertFalse(rv.get_json()["success"])

    def test_receive_stores_a_pending_preview(self):
        """Pas d'import d'office : la couverture complète peut retirer des
        logs — l'aperçu reste à valider. Le statut remonte le dépôt."""
        self._set_token()
        rv = self._receive(CONTRACT.read_bytes())
        self.assertEqual(rv.status_code, 202)
        body = rv.get_json()
        self.assertTrue(body["success"])
        self.assertIn("import_token", body)
        # Rien n'est écrit : seul l'aperçu est conservé.
        self.assertEqual(db.session.query(LogEvent).count(), 0)

        status = self.client.get("/api/logs/status").get_json()
        pending = status["pending_import"]
        self.assertIsNotNone(pending)
        self.assertEqual(pending["import_token"], body["import_token"])
        self.assertEqual(pending["summary"]["added"], 7)

        # La validation suit le parcours habituel : jeton → tâche d'import.
        rv2 = self.client.post("/api/logs/import/commit",
                               json={"import_token": pending["import_token"]})
        self.assertEqual(rv2.status_code, 202, rv2.get_json())
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["added"], 7)
        # Consommé : plus de dépôt en attente.
        self.assertIsNone(
            self.client.get("/api/logs/status").get_json()["pending_import"])

    def test_receive_of_another_account_is_refused(self):
        self._set_token()
        self._import(CONTRACT.read_bytes())
        doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
        doc["account"] = {"user_id": 999}
        rv = self._receive(json.dumps(doc).encode())
        self.assertEqual(rv.status_code, 409)
        self.assertIsNone(
            self.client.get("/api/logs/status").get_json()["pending_import"])

    def test_bookmarklet_strings_follow_ui_language(self):
        from flask_babel import force_locale
        from blueprints.gc_logs import _bookmarklet_strings
        # Langue par défaut (fr) : messages en français.
        self.assertEqual(
            _bookmarklet_strings()['__T_START__'], "MyGCFlow : démarrage…")
        # Locale en : le favori généré parle anglais (messages traduits
        # côté serveur, injectés dans le javascript:).
        with force_locale('en'):
            strings_en = _bookmarklet_strings()
        self.assertEqual(strings_en['__T_START__'], "MyGCFlow: starting…")

    # --- exécution du favori sur un faux geocaching.com (harnais Node) ----

    def _run_bookmarklet(self, **scenario):
        js = self.client.get('/api/logs/bookmarklet').get_json()["bookmarklet"]
        folder = Path(tempfile.mkdtemp(prefix="mygcflow-logs-favori-"))
        self.addCleanup(shutil.rmtree, folder, True)
        link = folder / "bookmarklet.txt"
        link.write_text(js, encoding="utf-8")
        done = subprocess.run(
            [NODE, str(BOOKMARKLET_HARNESS), str(link), json.dumps(scenario)],
            capture_output=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))
        return json.loads(done.stdout.decode("utf-8"))

    @staticmethod
    def _entry(log_id, type_id, visited, name, account_id, fav=None):
        return {"LogID": log_id, "LogTypeID": type_id,
                "LogType": "Didn't find it" if type_id == 3 else "Found it",
                "Visited": visited, "AccountID": account_id, "UserName": name,
                "FavoritePointUsed": fav}

    @staticmethod
    def _gc(code, token, name="Cache", placed="13/05/2010", **kw):
        return {"token": token, "name": name, "placed": placed,
                "lat": 49.2, "lng": 6.2, "owner": "Testeur", **kw}

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_collects_everything_and_posts_the_export(self):
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "dnfPages": [{"codes": ["GC1AAA", "GC2BBB"], "next": True},
                         {"codes": ["GC3CCC"], "guids": ["11111111-2222-3333-4444-555555555555"]}],
            "ownedPages": [{"codes": ["GC9OWN"]}],
            "caches": {
                "GC1AAA": self._gc("GC1AAA", "t1"),
                "GC2BBB": self._gc("GC2BBB", "t2"),
                "GC3CCC": self._gc("GC3CCC", "t3"),
                "11111111-2222-3333-4444-555555555555": self._gc("GC4DDD", "t4", title="GC4DDD - guid"),
                "GC9OWN": self._gc("GC9OWN", "t5", favs=42),
            },
            "books": {
                # Les carnets des DNF ne gardent que MES logs (ownOnly) :
                # la ligne d'un autre joueur est écartée.
                "t1": [[self._entry(11, 3, "13/05/2024", "Testeur", 42),
                        self._entry(12, 2, "14/05/2024", "Autre", 7)]],
                "t2": [[self._entry(13, 3, "02/Jun/2024", "Testeur", 42)]],
                "t3": [[self._entry(14, 3, "2024-06-03", "Testeur", 42)]],
                "t4": [[self._entry(15, 2, "10/06/2024", "Testeur", 42)]],
                # Carnet paginé d'une cache posée : tout le monde est lu.
                "t5": [[self._entry(16, 46, "13/05/2010", "Testeur", 42)],
                       [self._entry(17, 2, "20/06/2024", "Promeneur", 9, "true")]],
            },
        }
        out = self._run_bookmarklet(**scenario)

        received = out["received"]
        self.assertIsNotNone(received, out["said"])
        # Le favori scelle sa collecte sur /receive/fragment (reprise
        # possible), pas sur /receive directement.
        self.assertTrue(received["url"].endswith("/api/logs/receive/fragment"))
        self.assertEqual(received["headers"]["X-MyGCFlow-Final"], "1")
        self.assertTrue(received["headers"]["X-MyGCFlow-Run-Id"])
        self.assertEqual(received["credentials"], "omit")
        token = self.manager.get_app_settings().logs_receive_token
        self.assertEqual(received["headers"]["X-MyGCFlow-Token"], token)

        body = received["body"]
        self.assertEqual(body["format"], "mygcflow-logs")
        self.assertEqual(body["account"]["username"], "Testeur")
        self.assertEqual(body["account"]["user_id"], 42)
        # 5 logs à moi (4 DNF/found + Enable Listing), 1 d'un autre joueur.
        self.assertEqual(len(body["logs"]), 6)
        others = [l for l in body["logs"] if l["author"]["id"] != 42]
        self.assertEqual([l["log_id"] for l in others], [17])
        self.assertTrue(others[0]["favorite"])
        self.assertEqual(sorted(c["gc_code"] for c in body["caches"]),
                         ["GC1AAA", "GC2BBB", "GC3CCC", "GC4DDD", "GC9OWN"])
        kinds = {(c["kind"], tuple(sorted(c.get("gc_codes", []))),
                  tuple(c.get("type_ids", []))) for c in body["coverage"]}
        self.assertIn(("author", (), (3,)), kinds)
        self.assertIn(("caches", ("GC9OWN",), ()), kinds)
        # Postback de la liste DNF + carnet paginé : la pagination tourne.
        dnf_calls = [u for u in out["requests"] if "/my/logs.aspx" in u]
        self.assertEqual(len(dnf_calls), 2)
        book_calls = [u for u in out["requests"] if "geocache.logbook" in u
                      and "tkn=t5" in u]
        self.assertEqual(len(book_calls), 2)

        # Le fichier produit est bien celui que l'import accepte.
        import log_formats as lf
        parsed = lf.parse_logs_file(json.dumps(body).encode())
        self.assertTrue(parsed.ok, parsed.errors)

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_ambiguous_dates_wait_for_a_console_call(self):
        # 05/06/2024 : DMY et MDY restent possibles → le favori s'arrête
        # sans envoyer et explique mygcflowLogsFinish ; l'appel finit l'envoi.
        scenario = {
            "username": "Testeur",
            "prefOrder": None,
            "dnfPages": [{"codes": ["GC1AAA"]}],
            "ownedPages": [{}],
            "caches": {"GC1AAA": self._gc("GC1AAA", "t1", placed="05/06/2011")},
            "books": {"t1": [[self._entry(11, 3, "05/06/2024", "Testeur", 42)]]},
            "finish": "DMY",
        }
        out = self._run_bookmarklet(**scenario)
        self.assertTrue(any("ordre des dates indéterminé" in s for s in out["said"]),
                        out["said"])
        self.assertIsNotNone(out["received"], out["said"])
        dates = {l["log_id"]: l["date"] for l in out["received"]["body"]["logs"]}
        self.assertEqual(dates[11], "2024-06-05")

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_retries_then_keeps_going(self):
        # 429 deux fois puis OK : le retry couvre la fiche ; collecte complète.
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "dnfPages": [{"codes": ["GC1AAA", "GC2BBB"]}],
            "ownedPages": [{}],
            "caches": {
                "GC1AAA": self._gc("GC1AAA", "t1"),
                "GC2BBB": self._gc("GC2BBB", "t2", failStatus=429, failTimes=2),
            },
            "books": {
                "t1": [[self._entry(11, 3, "13/05/2024", "Testeur", 42)]],
                "t2": [[self._entry(12, 3, "14/05/2024", "Testeur", 42)]],
            },
        }
        out = self._run_bookmarklet(**scenario)
        self.assertIsNotNone(out["received"], out["said"])
        body = out["received"]["body"]
        self.assertEqual(len(body["logs"]), 2)
        gc2 = [u for u in out["requests"] if "/geocache/GC2BBB" in u]
        self.assertEqual(len(gc2), 3)

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_persistent_failures_send_the_partial_export(self):
        # Cinq caches posées illisibles d'affilée : arrêt après le seuil,
        # mais l'export partiel part quand même (couverture incomplète
        # signalée — l'import ne retirera rien).
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "dnfPages": [{"codes": ["GC1AAA"]}],
            "ownedPages": [{"codes": [f"GC9O{i}" for i in range(6)]}],
            "caches": {
                "GC1AAA": self._gc("GC1AAA", "t1"),
                **{f"GC9O{i}": self._gc(f"GC9O{i}", f"o{i}", failStatus=500)
                   for i in range(6)},
            },
            "books": {"t1": [[self._entry(11, 3, "13/05/2024", "Testeur", 42)]]},
        }
        out = self._run_bookmarklet(**scenario)
        self.assertTrue(any("arrêt" in s for s in out["said"]), out["said"])
        self.assertIsNotNone(out["received"], out["said"])
        body = out["received"]["body"]
        self.assertEqual(len(body["logs"]), 1)
        self.assertEqual(body["coverage"], [])

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_off_geocaching_does_nothing(self):
        out = self._run_bookmarklet(hostname="www.example.com")
        self.assertIsNone(out["received"])
        self.assertTrue(any("geocaching.com" in s for s in out["said"]), out["said"])

    # --- /api/logs/receive/state + collecte incrémentale ---------------------

    def _state(self, token="tok-receive", **kw):
        return self.client.get('/api/logs/receive/state',
                               headers={"X-MyGCFlow-Token": token}, **kw)

    def test_receive_state_requires_token_and_cors(self):
        self._set_token()
        self.assertEqual(self.client.get('/api/logs/receive/state').status_code, 403)
        self.assertEqual(self._state("mauvais").status_code, 403)
        # Preflight : mêmes origines que /receive.
        for origin, allowed in (("https://www.geocaching.com", True),
                                ("https://malveillant.example", False)):
            rv = self.client.open('/api/logs/receive/state', method='OPTIONS',
                                  headers={"Origin": origin})
            self.assertEqual("Access-Control-Allow-Origin" in rv.headers,
                             allowed, origin)

    def test_receive_state_reports_since_pending_and_full_once(self):
        self._set_token()
        body = self._state().get_json()
        self.assertIsNone(body["since"])          # rien d'importé → tout relire
        self.assertIsNone(body["pending"])

        self._import(CONTRACT.read_bytes())       # exported_at = 2026-10-24
        self.assertEqual(self._state().get_json()["since"], "2026-10-24")

        # Un export reçu non validé est signalé au favori.
        self._receive(CONTRACT.read_bytes())
        self.assertIsNotNone(self._state().get_json()["pending"])

        # « Forcer la prochaine collecte complète » : consommé à la lecture.
        rv = self.client.post('/api/logs/bookmarklet/full-next')
        self.assertTrue(rv.get_json()["success"])
        self.assertTrue(self.client.get("/api/logs/status")
                        .get_json()["full_collect_planned"])
        self.assertIsNone(self._state().get_json()["since"])
        self.assertFalse(self.client.get("/api/logs/status")
                         .get_json()["full_collect_planned"])
        self.assertEqual(self._state().get_json()["since"], "2026-10-24")

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_incremental_collects_only_the_recent_window(self):
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "state": {"since": "2024-06-10"},
            "dnfPages": [
                {"rows": [{"code": "GC1NEW", "date": "15/06/2024"},
                          {"code": "GC2BOR", "date": "10/06/2024"}], "next": True},
                {"rows": [{"code": "GC3OLD", "date": "05/06/2024"},
                          {"code": "GC4OLD", "date": "01/06/2024"}]}],
            "ownedPages": [{"codes": ["GC9OWN"]}],
            "caches": {
                "GC1NEW": self._gc("GC1NEW", "n1"),
                "GC2BOR": self._gc("GC2BOR", "n2"),
                "GC3OLD": self._gc("GC3OLD", "n3"),
                "GC4OLD": self._gc("GC4OLD", "n4"),
                "GC9OWN": self._gc("GC9OWN", "t5"),
            },
            "books": {
                "n1": [[self._entry(21, 3, "15/06/2024", "Testeur", 42)]],
                "n2": [[self._entry(22, 3, "10/06/2024", "Testeur", 42)]],
                "n3": [[self._entry(23, 3, "05/06/2024", "Testeur", 42)]],
                "n4": [[self._entry(24, 3, "01/06/2024", "Testeur", 42)]],
                "t5": [[self._entry(25, 46, "13/05/2010", "Testeur", 42)]],
            },
        }
        out = self._run_bookmarklet(**scenario)
        self.assertTrue(any("depuis le 2024-06-10" in s for s in out["said"]),
                        out["said"])
        received = out["received"]
        self.assertIsNotNone(received, out["said"])
        body = received["body"]
        # Les caches hors fenêtre ne sont même pas demandées.
        fetched = [u for u in out["requests"] if u.startswith("/geocache/")]
        self.assertNotIn("/geocache/GC3OLD", fetched)
        self.assertNotIn("/geocache/GC4OLD", fetched)
        self.assertIn("/geocache/GC2BOR", fetched)   # borne incluse
        self.assertEqual(sorted(c["gc_code"] for c in body["caches"]),
                         ["GC1NEW", "GC2BOR", "GC9OWN"])
        # Couverture bornée à la fenêtre : les vieux DNF supprimés du site
        # ne seront pas retirés — la collecte complète sert à ça.
        dnf_scope = next(c for c in body["coverage"] if c["kind"] == "author")
        self.assertEqual(dnf_scope["since"], "2024-06-10")
        # Deux pages de journal lues, pas une de plus.
        journal_calls = [u for u in out["requests"] if "/my/logs.aspx" in u]
        self.assertEqual(len(journal_calls), 2)

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_skips_collect_when_an_export_is_pending(self):
        scenario = {
            "username": "Testeur",
            "state": {"pending": {"name": "export du favori",
                                  "received_at": "2026-10-25T08:00:00Z"}},
            "confirmPending": False,
        }
        out = self._run_bookmarklet(**scenario)
        self.assertIsNone(out["received"])
        self.assertEqual(out["requests"], [])
        self.assertTrue(any("annulée" in s for s in out["said"]), out["said"])

    # --- /api/logs/receive/fragment : collecte reprenable -------------------

    def _fragment(self, doc, run_id="run-test-1", token="tok-receive",
                  final=False):
        headers = {"X-MyGCFlow-Token": token, "X-MyGCFlow-Run-Id": run_id}
        if final:
            headers["X-MyGCFlow-Final"] = "1"
        return self.client.post('/api/logs/receive/fragment',
                                data=doc, content_type='application/json',
                                headers=headers)

    def test_fragment_rejects_bad_inputs(self):
        self._set_token()
        doc = CONTRACT.read_bytes()
        self.assertEqual(self._fragment(doc, run_id="").status_code, 400)
        self.assertEqual(self._fragment(doc, run_id="x").status_code, 400)
        self.assertEqual(self._fragment(doc, token="mauvais").status_code, 403)
        self.assertEqual(self._fragment(b"<html>").status_code, 400)
        self.assertEqual(self._fragment(b'{"format": "autre"}').status_code, 400)
        # Preflight : même garde CORS que /receive.
        rv = self.client.open('/api/logs/receive/fragment', method='OPTIONS',
                              headers={"Origin": "https://www.geocaching.com"})
        self.assertIn("Access-Control-Allow-Origin", rv.headers)
        rv = self.client.open('/api/logs/receive/fragment', method='OPTIONS',
                              headers={"Origin": "https://malveillant.example"})
        self.assertNotIn("Access-Control-Allow-Origin", rv.headers)

    def test_fragment_merges_then_seals_into_a_pending_preview(self):
        """Chaque fragment est fusionné sous `frag-<run>` ; le dernier
        (`Final`) scelle : l'aperçu du document complet devient un import
        en attente — le parcours de validation est celui de /receive."""
        self._set_token()
        doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
        first = dict(doc, logs=doc["logs"][:4], caches=doc["caches"][:2],
                     coverage=doc["coverage"][:1])
        # Recouvrement volontaire : le dernier fragment re-verrouille un
        # log déjà envoyé — dédoublonné par log_id dans le document scellé.
        second = dict(doc, logs=doc["logs"][3:], caches=doc["caches"][2:],
                      coverage=doc["coverage"][1:])

        rv = self._fragment(json.dumps(first).encode())
        self.assertEqual(rv.status_code, 202, rv.get_json())
        body = rv.get_json()
        self.assertEqual(body["received"], "fragment")
        self.assertEqual((body["logs"], body["caches"]), (4, 2))
        # Pas d'aperçu déposé tant que la collecte n'est pas scellée.
        self.assertIsNone(
            self.client.get("/api/logs/status").get_json()["pending_import"])

        rv = self._fragment(json.dumps(second).encode(), final=True)
        self.assertEqual(rv.status_code, 202, rv.get_json())
        self.assertIn("import_token", rv.get_json())
        pending = self.client.get("/api/logs/status").get_json()["pending_import"]
        self.assertIsNotNone(pending)
        self.assertEqual(pending["summary"]["added"], 7)   # 7 logs, pas 8
        # Le dossier de fragments est consommé au scellement.
        import blueprints.gc_logs as gc_logs_mod
        self.assertFalse((gc_logs_mod.PENDING_ROOT / "frag-run-test-1").exists())

        rv2 = self.client.post("/api/logs/import/commit",
                               json={"import_token": pending["import_token"]})
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["added"], 7)

    def test_fragment_rejects_a_second_account_mid_run(self):
        self._set_token()
        doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
        rv = self._fragment(json.dumps(dict(
            doc, account={"user_id": 42, "username": "Testeur"})).encode())
        self.assertEqual(rv.status_code, 202, rv.get_json())
        rv = self._fragment(json.dumps(dict(
            doc, account={"user_id": 999, "username": "Autre"})).encode())
        self.assertEqual(rv.status_code, 409)

    # --- reprise de collecte côté favori (harnais) --------------------------

    @staticmethod
    def _saved_plan(run_id="run-sauve", done=1, queue=None, **kw):
        return json.dumps({
            "v": 1, "runId": run_id, "created": 9999999999999,
            "since": None, "order": "DMY",
            "me": {"name": "Testeur", "id": 42},
            "dnfComplete": True, "queue": queue or [],
            "done": done, "read": [], "failed": {"d": [], "o": []}, **kw})

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_checkpoints_and_drops_the_plan_once_sent(self):
        # 16 caches : au-delà du pas de sauvegarde (15) — un fragment part
        # avant la fin, puis le scellement emporte plan et drapeau Final.
        codes = [f"GC8{i:04d}" for i in range(16)]
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "dnfPages": [{"codes": codes}],
            "ownedPages": [{}],
            "caches": {c: self._gc(c, f"t{i}") for i, c in enumerate(codes)},
            "books": {f"t{i}": [[self._entry(100 + i, 3, "13/05/2024",
                                             "Testeur", 42)]]
                      for i in range(16)},
        }
        out = self._run_bookmarklet(**scenario)
        non_final = [f for f in out["fragments"]
                     if f["headers"].get("X-MyGCFlow-Final") != "1"]
        self.assertTrue(non_final)
        self.assertTrue(all(f["headers"].get("X-MyGCFlow-Run-Id")
                            for f in out["fragments"]))
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(out["received"]["headers"]["X-MyGCFlow-Final"], "1")
        # Collecte bouclée et reçue : plus rien à reprendre.
        self.assertNotIn("mygcflowLogsRun", out["storage"])

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_resumes_a_saved_plan(self):
        # Plan en place (2/3 caches lues) → la reprise ne relit que la
        # dernière, sans repasser par les listes, et scelle sous le même
        # identifiant de collecte.
        queue = [{"u": "/geocache/GC1AAA", "o": 1},
                 {"u": "/geocache/GC2BBB", "o": 1},
                 {"u": "/geocache/GC3CCC", "o": 1}]
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "savedStorage": {"mygcflowLogsRun": self._saved_plan(
                done=2, queue=queue, read=["GC1AAA", "GC2BBB"])},
            "dnfPages": [{"codes": ["GC1AAA", "GC2BBB", "GC3CCC"]}],
            "ownedPages": [{}],
            "caches": {c: self._gc(c, f"t{i}")
                       for i, c in enumerate(["GC1AAA", "GC2BBB", "GC3CCC"])},
            "books": {f"t{i}": [[self._entry(10 + i, 3, "13/05/2024",
                                             "Testeur", 42)]]
                      for i in range(3)},
        }
        out = self._run_bookmarklet(**scenario)
        self.assertTrue(any("reprise" in s for s in out["said"]), out["said"])
        fetched = [u for u in out["requests"] if u.startswith("/geocache/")]
        self.assertEqual(fetched, ["/geocache/GC3CCC"])
        journal = [u for u in out["requests"] if "/my/logs.aspx" in u]
        self.assertEqual(journal, [])
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(
            out["received"]["headers"]["X-MyGCFlow-Run-Id"], "run-sauve")
        self.assertNotIn("mygcflowLogsRun", out["storage"])

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_declining_resume_starts_a_fresh_run(self):
        queue = [{"u": "/geocache/GC1AAA", "o": 1}]
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "confirms": [False],   # « reprendre ? » → non : collecte neuve
            "savedStorage": {"mygcflowLogsRun": self._saved_plan(
                done=0, queue=queue)},
            "dnfPages": [{"codes": ["GC1AAA"]}],
            "ownedPages": [{}],
            "caches": {"GC1AAA": self._gc("GC1AAA", "t1")},
            "books": {"t1": [[self._entry(11, 3, "13/05/2024", "Testeur", 42)]]},
        }
        out = self._run_bookmarklet(**scenario)
        journal = [u for u in out["requests"] if "/my/logs.aspx" in u]
        self.assertTrue(journal)   # les listes sont relues — pas de reprise
        self.assertIsNotNone(out["received"], out["said"])
        # Un nouvel identifiant de collecte — pas celui du plan refusé.
        self.assertNotEqual(
            out["received"]["headers"]["X-MyGCFlow-Run-Id"], "run-sauve")

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_keeps_its_plan_when_the_send_fails(self):
        # Application injoignable : la collecte est bouclée mais l'envoi
        # a échoué — le plan reste (done = file entière) pour un renvoi
        # immédiat au prochain clic, sans rien relire.
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "receiveStatus": 500,
            "dnfPages": [{"codes": ["GC1AAA"]}],
            "ownedPages": [{}],
            "caches": {"GC1AAA": self._gc("GC1AAA", "t1")},
            "books": {"t1": [[self._entry(11, 3, "13/05/2024", "Testeur", 42)]]},
        }
        out = self._run_bookmarklet(**scenario)
        plan = json.loads(out["storage"].get("mygcflowLogsRun") or "null")
        self.assertIsNotNone(plan, out["storage"])
        self.assertEqual(plan["done"], len(plan["queue"]))

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_finished_plan_resends_without_recollection(self):
        # Collecte bouclée, envoi raté : la reprise ne touche pas le site
        # et re-scelle directement.
        queue = [{"u": "/geocache/GC1AAA", "o": 1}]
        scenario = {
            "username": "Testeur",
            "prefOrder": "DMY",
            "savedStorage": {"mygcflowLogsRun": self._saved_plan(
                done=1, queue=queue, read=["GC1AAA"])},
            "caches": {},
            "books": {},
        }
        out = self._run_bookmarklet(**scenario)
        self.assertEqual(out["requests"], [])
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(
            out["received"]["headers"]["X-MyGCFlow-Final"], "1")
        self.assertNotIn("mygcflowLogsRun", out["storage"])


if __name__ == "__main__":
    unittest.main()
