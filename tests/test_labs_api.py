import io
import json
import os
import shutil
import tempfile
import time
import unittest
import urllib.error
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import lab_coords_provider as lcp
import lab_store
import settings_manager
from app import create_app
from extensions import db
from models import Geocache, LabDiscovery
from task_manager import task_manager

FIXTURES = Path(__file__).parent / "fixtures" / "labs"
HISTORY = FIXTURES / "lab-finds-valid.json"
COORDS = FIXTURES / "lab2gpx-stages.gpx"
BAD_JSON = FIXTURES / "lab-finds-invalid.json"
DOCTYPE = FIXTURES / "lab2gpx-doctype.gpx"

STAGE_1 = "57a9e000-0000-4000-8000-000000000101"
STAGE_REMOVED = "57a9e000-0000-4000-8000-000000000401"
ADVENTURE_REMOVED = "fa1e0000-0000-4000-8000-000000000004"


class LabsApiTests(unittest.TestCase):
    """Endpoints /api/labs/* : preview, commit en tâche, lectures, corrections."""

    def setUp(self):
        # ignore_cleanup_errors : les tâches d'import en thread peuvent relâcher
        # le SQLite/WAL une fraction de seconde après la fin observée.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{self.db_path}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _preview(self, *files):
        data = {'files': [(io.BytesIO(p.read_bytes()), p.name) for p in files]}
        return self.client.post('/api/labs/import/preview',
                                data=data, content_type='multipart/form-data')

    def _commit(self, token):
        return self.client.post('/api/labs/import/commit',
                                json={'import_token': token})

    def _wait_task(self, task_id, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = task_manager.get(task_id)
            if st is not None and st.state in ("finished", "failed"):
                return st
            time.sleep(0.05)
        self.fail(f"tâche {task_id} toujours en cours après {timeout}s")

    def _import_history(self):
        """Preview + commit de l'historique fixture ; retourne le résultat de tâche."""
        rv = self._preview(HISTORY)
        assert rv.status_code == 200, rv.get_json()
        rv2 = self._commit(rv.get_json()["import_token"])
        assert rv2.status_code == 202, rv2.get_json()
        st = self._wait_task(rv2.get_json()["task_id"])
        assert st.state == "finished", st.error
        return st.result

    def _import_coords(self):
        rv = self._preview(COORDS)
        assert rv.status_code == 200, rv.get_json()
        rv2 = self._commit(rv.get_json()["import_token"])
        assert rv2.status_code == 202, rv2.get_json()
        st = self._wait_task(rv2.get_json()["task_id"])
        assert st.state == "finished", st.error
        return st.result

    # --- preview / commit --------------------------------------------------

    def test_preview_history_then_commit(self):
        rv = self._preview(HISTORY)
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body["success"])
        self.assertEqual(body["totals"]["added"], 12)
        self.assertEqual(body["totals"]["rejected"], 0)
        self.assertTrue(body["import_token"])
        self.assertEqual(body["collection_revision"], 0)
        # l'aperçu n'a rien écrit
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)

        rv2 = self._commit(body["import_token"])
        self.assertEqual(rv2.status_code, 202)
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["added"], 12)
        self.assertEqual(st.result["ready_total"], 0)
        self.assertEqual(st.result["unresolved"], 12)
        self.assertEqual(db.session.query(LabDiscovery).count(), 12)

    def test_preview_combined_lot(self):
        """Historique + coordonnées dans le même aperçu : l'enrichissement
        du GPX doit se projeter sur l'historique du même lot."""
        rv = self._preview(HISTORY, COORDS)
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertEqual(body["totals"]["added"], 12)
        self.assertEqual(body["totals"]["resolved"], 8)
        self.assertEqual(body["projected"]["ready"], 8)
        self.assertEqual(body["projected"]["unresolved"], 4)
        # rien d'écrit : l'aperçu reste sans effet
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)

        rv2 = self._commit(body["import_token"])
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(st.result["resolved"], 8)
        self.assertEqual(st.result["ready_total"], 8)

    def test_full_pipeline_history_then_coords(self):
        self._import_history()
        result = self._import_coords()
        self.assertEqual(result["resolved"], 8)
        self.assertEqual(result["ready_total"], 8)
        self.assertEqual(result["unresolved"], 4)
        d = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertAlmostEqual(d.latitude, 47.21510)

    def test_token_consumed_once(self):
        rv = self._preview(HISTORY)
        token = rv.get_json()["import_token"]
        self.assertEqual(self._commit(token).status_code, 202)
        self.assertEqual(self._commit(token).status_code, 400)

    def test_commit_bad_token(self):
        for token in (None, "", "n'existe-pas", "../etc"):
            rv = self._commit(token)
            self.assertEqual(rv.status_code, 400, token)

    def test_preview_rejects_unknown_files(self):
        data = {'files': (io.BytesIO(b'<html>login</html>'), 'page.html')}
        rv = self.client.post('/api/labs/import/preview',
                              data=data, content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 400)

    def test_preview_doctype_rejected(self):
        rv = self._preview(DOCTYPE)
        self.assertEqual(rv.status_code, 400)
        self.assertIn("error", rv.get_json()["files"][0])

    def test_preview_mixed_valid_and_invalid(self):
        rv = self._preview(HISTORY, DOCTYPE)
        self.assertEqual(rv.status_code, 200)
        files = {f["name"]: f for f in rv.get_json()["files"]}
        self.assertEqual(files["lab-finds-valid.json"]["status"], "ok")
        self.assertEqual(files["lab2gpx-doctype.gpx"]["status"], "error")
        # le manifeste ne conserve que les fichiers valides
        rv2 = self._commit(rv.get_json()["import_token"])
        st = self._wait_task(rv2.get_json()["task_id"])
        self.assertEqual(len(st.result["files"]), 1)

    def test_preview_no_file(self):
        rv = self.client.post('/api/labs/import/preview', data={},
                              content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 400)

    def test_task_status_endpoint(self):
        rv = self._preview(HISTORY)
        rv2 = self._commit(rv.get_json()["import_token"])
        task_id = rv2.get_json()["task_id"]
        st = self._wait_task(task_id)
        rv3 = self.client.get(f'/tasks/{task_id}?include_result=true')
        self.assertEqual(rv3.status_code, 200)
        self.assertEqual(rv3.get_json()["result"]["added"], 12)

    # --- lectures -----------------------------------------------------------

    def test_status_empty_then_populated(self):
        rv = self.client.get('/api/labs/status')
        self.assertEqual(rv.status_code, 200)
        self.assertIsNone(rv.get_json()["collection"])

        self._import_history()
        self._import_coords()
        body = self.client.get('/api/labs/status').get_json()
        self.assertEqual(body["total"], 12)
        self.assertEqual(body["ready"], 8)
        self.assertEqual(body["unresolved"], 4)
        self.assertEqual(body["collection"]["revision"], 2)

    def test_unresolved_listing(self):
        self._import_history()
        self._import_coords()
        rv = self.client.get('/api/labs/unresolved?limit=10&offset=0')
        body = rv.get_json()
        self.assertEqual(body["count"], 4)
        self.assertTrue(all("missing_coordinates" in i["reasons"] for i in body["items"]))
        self.assertIn(STAGE_REMOVED, {i["stage_uuid"] for i in body["items"]})

    # --- résolution manuelle -------------------------------------------------

    def test_resolve_coordinates_and_date(self):
        self._import_history()
        self._import_coords()
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_REMOVED}/resolve',
                              json={"latitude": 45.5, "longitude": 3.25})
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertEqual(body["discovery"]["coordinate_status"], "resolved")
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertAlmostEqual(row.latitude, 45.5)
        self.assertEqual(row.coordinate_source, "user_correction")
        self.assertEqual(body["ready"], 9)

    def test_resolve_rejects_invalid(self):
        self._import_history()
        self.assertEqual(self.client.post(
            f'/api/labs/discoveries/{STAGE_1}/resolve', json={}).status_code, 400)
        self.assertEqual(self.client.post(
            f'/api/labs/discoveries/{STAGE_1}/resolve',
            json={"latitude": 95, "longitude": 0}).status_code, 400)
        self.assertEqual(self.client.post(
            '/api/labs/discoveries/inconnu/resolve',
            json={"latitude": 45, "longitude": 3}).status_code, 404)

    def test_user_correction_survives_reimport(self):
        self._import_history()
        self._import_coords()
        self.client.post(f'/api/labs/discoveries/{STAGE_1}/resolve',
                         json={"latitude": 45.5, "longitude": 3.25})
        self._import_coords()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertAlmostEqual(row.latitude, 45.5)  # correction conservée

    def test_user_date_correction_survives_reimport(self):
        self._import_history()
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_1}/resolve',
                              json={"found_date": "2024-06-01"})
        self.assertEqual(rv.status_code, 200)
        self._import_history()
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertEqual(row.found_date.isoformat(), "2024-06-01")
        self.assertEqual(row.date_basis, "user_correction")
        self.assertEqual(row.date_precision, "day")
        self.assertIsNone(row.found_at_utc)

    # --- clear / export ------------------------------------------------------

    def test_clear_only_labs(self):
        db.session.add(Geocache(latitude=48.8, longitude=2.3, gc_code="GC0001"))
        db.session.commit()
        self._import_history()
        rv = self.client.post('/api/labs/clear')
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["deleted"], 12)
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)
        self.assertEqual(db.session.query(Geocache).count(), 1)

    def test_export_enriched(self):
        self._import_history()
        self._import_coords()
        rv = self.client.get('/api/labs/export')
        self.assertEqual(rv.status_code, 200)
        payload = json.loads(rv.data)
        self.assertEqual(payload["format"], "mygcflow-lab-finds")
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(len(payload["discoveries"]), 12)
        resolved = [d for d in payload["discoveries"] if d["latitude"] is not None]
        self.assertEqual(len(resolved), 8)
        self.assertTrue(all(d["coordinate_source"] == "lab2gpx-gpx" for d in resolved))
        # réimportable tel quel par le parseur
        import lab_formats as lf
        reparsed = lf.parse_lab_finds(rv.data)
        self.assertTrue(reparsed.ok)
        self.assertEqual(len(reparsed.drafts), 12)

    def test_export_empty_collection(self):
        self.assertEqual(self.client.get('/api/labs/export').status_code, 404)


def _fake_fetch(fail_after=None, failed_before=(), failed_after=()):
    """Double de `fetch_gpx_batches` : livre le GPX de test via `on_payload`
    comme le vrai provider, puis abandonne si `fail_after` est fourni.
    `failed_before`/`failed_after` : UUID signalés irrécupérables avant/après
    ce lot."""
    def fake(uuids, user_guid=None, progress=None, on_payload=None,
             on_failed=None, **_kw):
        for u in failed_before:
            on_failed(u)
        on_payload("auto-001.gpx", COORDS.read_bytes())
        for u in failed_after:
            on_failed(u)
        if fail_after is not None:
            raise fail_after
        return lcp.FetchResult(fetched_adventures=3)
    return fake


class LabsAutomationTests(LabsApiTests):
    """Automatisation : /api/labs/fetch-coordinates (provider mocké),
    /api/labs/receive (CORS+jeton) et /api/labs/bookmarklet."""

    def setUp(self):
        super().setUp()
        # Réglages isolés : ni l'opt-in ni le jeton ne doivent écrire dans la
        # configuration réelle de l'utilisateur (même pattern que
        # SettingsApiTests — les constantes du module sont redirigées).
        cfg = Path(tempfile.mkdtemp(prefix="mygcflow-labs-cfg-"))
        self.addCleanup(shutil.rmtree, cfg, True)
        for name, value in {
            "CONFIG_DIR": cfg,
            "PROFILES_DIR": cfg / "profiles",
            "SETTINGS_PATH": cfg / "settings.json",
        }.items():
            patcher = mock.patch.object(settings_manager, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings_manager.write_json(settings_manager.SETTINGS_PATH, {
            "examples_seeded": True,
            "examples_version": settings_manager.EXAMPLES_VERSION,
        })
        self.manager = settings_manager.SettingsManager()

        import blueprints.labs as labs_mod
        import blueprints.profiles as profiles_mod

        for target, value in (
            (labs_mod, self.manager),          # get_settings_manager()
            (profiles_mod, self.manager),      # alias de module `settings_manager`
        ):
            attr = "get_settings_manager" if target is labs_mod else "settings_manager"
            patcher = mock.patch.object(target, attr,
                                        (lambda m: (lambda: m))(self.manager)
                                        if attr == "get_settings_manager" else value)
            patcher.start()
            self.addCleanup(patcher.stop)

    # --- /api/labs/bookmarklet ---------------------------------------------

    def test_bookmarklet_generates_stable_token_and_link(self):
        rv = self.client.get('/api/labs/bookmarklet')
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body["success"])
        js = body["bookmarklet"]
        self.assertTrue(js.startswith("javascript:"))
        token = self.manager.get_app_settings().labs_receive_token
        self.assertTrue(token)
        self.assertIn(json.dumps(token), js)
        # L'origine locale réelle est celle de la requête.
        self.assertIn("/api/labs/receive", js)
        # Tous les placeholders de traduction sont remplacés.
        self.assertNotIn("__T_", js)
        # Idempotent : le jeton n'est pas régénéré (le favori resterait valide).
        self.assertEqual(
            self.client.get('/api/labs/bookmarklet').status_code, 200)
        self.assertEqual(
            self.manager.get_app_settings().labs_receive_token, token)

    def test_bookmarklet_strings_follow_ui_language(self):
        from flask_babel import force_locale
        from blueprints.labs import _bookmarklet_strings
        # Langue par défaut (fr) : messages en français.
        self.assertEqual(
            _bookmarklet_strings()['__T_START__'], "MyGCFlow : démarrage…")
        # Locale en : le favori généré parle anglais (messages traduits
        # côté serveur, injectés dans le javascript:).
        with force_locale('en'):
            strings_en = _bookmarklet_strings()
        self.assertEqual(strings_en['__T_START__'], "MyGCFlow: starting…")
        self.assertEqual(strings_en['__T_CANCELLED__'], "Cancelled.")

    # --- /api/labs/receive --------------------------------------------------

    def _set_token(self, value="tok-receive"):
        self.manager.update_app_settings(
            lambda s: replace(s, labs_receive_token=value))

    def test_receive_rejects_missing_or_wrong_token(self):
        self._set_token()
        for headers in ({}, {"X-MyGCFlow-Token": "mauvais"}):
            rv = self.client.post('/api/labs/receive',
                                  data=HISTORY.read_bytes(),
                                  content_type='application/json',
                                  headers=headers)
            self.assertEqual(rv.status_code, 403, headers)
        # Sans jeton configuré du tout : refusé aussi (pas de bypass).
        self.manager.update_app_settings(
            lambda s: replace(s, labs_receive_token=""))
        rv = self.client.post('/api/labs/receive',
                              data=HISTORY.read_bytes(),
                              content_type='application/json',
                              headers={"X-MyGCFlow-Token": "x"})
        self.assertEqual(rv.status_code, 403)

    def test_receive_imports_history_and_is_cors_scoped(self):
        self._set_token()
        rv = self.client.post('/api/labs/receive',
                              data=HISTORY.read_bytes(),
                              content_type='application/json',
                              headers={"X-MyGCFlow-Token": "tok-receive",
                                       "Origin": "https://labs.geocaching.com"})
        self.assertEqual(rv.status_code, 202, rv.get_json())
        self.assertEqual(rv.headers.get("Access-Control-Allow-Origin"),
                         "https://labs.geocaching.com")
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["added"], 12)
        self.assertEqual(db.session.query(LabDiscovery).count(), 12)

    def test_receive_rejects_non_lab_payload(self):
        self._set_token()
        rv = self.client.post('/api/labs/receive',
                              data=b'<html>page</html>',
                              content_type='application/json',
                              headers={"X-MyGCFlow-Token": "tok-receive"})
        self.assertEqual(rv.status_code, 400)

    def test_receive_options_grants_only_labs_origin(self):
        rv = self.client.options('/api/labs/receive',
                                 headers={"Origin": "https://labs.geocaching.com"})
        self.assertEqual(rv.status_code, 204)
        self.assertEqual(rv.headers.get("Access-Control-Allow-Origin"),
                         "https://labs.geocaching.com")
        self.assertEqual(rv.headers.get("Access-Control-Allow-Private-Network"),
                         "true")
        rv = self.client.options('/api/labs/receive',
                                 headers={"Origin": "https://evil.example"})
        self.assertIsNone(rv.headers.get("Access-Control-Allow-Origin"))

    # --- /api/labs/fetch-coordinates ---------------------------------------

    def test_fetch_coordinates_needs_pending(self):
        rv = self.client.post('/api/labs/fetch-coordinates')
        self.assertEqual(rv.status_code, 400)

    def test_fetch_coordinates_task_resolves_discoveries(self):
        self._import_history()
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=_fake_fetch()) as m:
            rv = self.client.post('/api/labs/fetch-coordinates')
            self.assertEqual(rv.status_code, 202, rv.get_json())
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["resolved"], 8)
        self.assertEqual(st.result["ready_total"], 8)
        # Le provider a reçu les UUID d'Adventures des étapes en attente.
        requested = m.call_args[0][0]
        self.assertTrue(requested)
        self.assertTrue(all(u for u in requested))

    def test_fetch_interrupted_keeps_downloaded_batches(self):
        """Le service lâche après un lot : ce lot reste enregistré et la
        tâche rend un bilan partiel au lieu d'échouer."""
        self._import_history()
        boom = urllib.error.URLError("down")
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=_fake_fetch(fail_after=boom)):
            rv = self.client.post('/api/labs/fetch-coordinates')
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertTrue(st.result["interrupted"])
        self.assertIn("down", st.result["error"])
        self.assertEqual(st.result["resolved"], 8)
        db.session.expire_all()
        self.assertEqual(lab_store.collection_status(db.session)["ready"], 8)

    def test_fetch_failing_before_any_batch_fails_the_task(self):
        self._import_history()
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=urllib.error.URLError("down")):
            rv = self.client.post('/api/labs/fetch-coordinates')
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "failed")
        db.session.expire_all()
        self.assertEqual(lab_store.collection_status(db.session)["ready"], 0)

    def _fetch(self, **fake_kwargs):
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=_fake_fetch(**fake_kwargs)):
            rv = self.client.post('/api/labs/fetch-coordinates')
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        db.session.expire_all()
        return st.result

    def test_unrecoverable_adventure_is_remembered(self):
        """Une Adventure refusée par lab2gpx n'est plus redemandée par
        l'auto-fetch avant le délai ; la récupération manuelle la retente."""
        import blueprints.labs as labs_mod
        self._import_history()
        result = self._fetch(failed_after=[ADVENTURE_REMOVED])
        self.assertEqual(result["failed_uuids"], [ADVENTURE_REMOVED])

        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertIsNotNone(row.coord_fetch_failed_at)
        # Les étapes résolues ne portent jamais la marque.
        self.assertIsNone(db.session.query(LabDiscovery).filter_by(
            stage_uuid=STAGE_1).one().coord_fetch_failed_at)

        self.assertIn(ADVENTURE_REMOVED, labs_mod._unresolved_coord_uuids(db.session))
        self.assertNotIn(ADVENTURE_REMOVED, labs_mod._unresolved_coord_uuids(
            db.session, skip_recent_failures=True))

        items = self.client.get('/api/labs/unresolved').get_json()["items"]
        reasons = next(i["reasons"] for i in items if i["stage_uuid"] == STAGE_REMOVED)
        self.assertIn("coordinates_unavailable", reasons)

        # Délai écoulé : l'auto-fetch la redemande.
        row.coord_fetch_failed_at -= timedelta(days=labs_mod.FETCH_RETRY_AFTER_DAYS + 1)
        db.session.commit()
        self.assertIn(ADVENTURE_REMOVED, labs_mod._unresolved_coord_uuids(
            db.session, skip_recent_failures=True))

    def test_failures_before_an_abort_are_not_remembered(self):
        """Des échecs suivis d'un abandon tiennent plus de la panne que de
        la donnée : ils ne sont ni rapportés ni mémorisés."""
        self._import_history()
        result = self._fetch(failed_after=[ADVENTURE_REMOVED],
                             fail_after=urllib.error.URLError("down"))
        self.assertTrue(result["interrupted"])
        self.assertEqual(result["failed_uuids"], [])
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertIsNone(row.coord_fetch_failed_at)

    def test_confirmed_failures_survive_an_interruption(self):
        self._import_history()
        result = self._fetch(failed_before=[ADVENTURE_REMOVED],
                             fail_after=urllib.error.URLError("down"))
        self.assertTrue(result["interrupted"])
        self.assertEqual(result["failed_uuids"], [ADVENTURE_REMOVED])
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertIsNotNone(row.coord_fetch_failed_at)

    def test_manual_coordinates_clear_the_failure_mark(self):
        self._import_history()
        self._fetch(failed_after=[ADVENTURE_REMOVED])
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_REMOVED}/resolve',
                              json={"latitude": 45.5, "longitude": 3.25})
        self.assertEqual(rv.status_code, 200)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertIsNone(row.coord_fetch_failed_at)

    def test_autofetch_chains_after_import_when_enabled(self):
        self.client.put('/api/settings', json={"labs_auto_fetch_coords": True})
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=_fake_fetch()) as m:
            import_result = self._import_history()
            self.assertEqual(import_result["added"], 12)
            # La tâche de fetch a été soumise par _maybe_autofetch.
            fetch_task = None
            deadline = time.time() + 10
            while time.time() < deadline:
                fetch_task = task_manager.get_last("lab_fetch_coords")
                if fetch_task is not None:
                    break
                time.sleep(0.05)
            self.assertIsNotNone(fetch_task, "auto-fetch non soumis")
            st = self._wait_task(fetch_task.id)
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["resolved"], 8)
        self.assertTrue(m.called)

    def test_no_autofetch_when_opt_in_off(self):
        # task_manager est un singleton : un fetch d'un test précédent reste
        # enregistré — on compare l'identité, pas la présence.
        before = task_manager.get_last("lab_fetch_coords")
        with mock.patch.object(lcp, "fetch_gpx_batches") as m:
            self._import_history()
            time.sleep(0.3)   # laisser le temps à un éventuel enchaînement
            self.assertFalse(m.called)
            self.assertIs(task_manager.get_last("lab_fetch_coords"), before)


if __name__ == "__main__":
    unittest.main()
