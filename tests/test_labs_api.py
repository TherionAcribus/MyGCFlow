import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import urllib.error
import zipfile
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import lab_coords_provider as lcp
import lab_formats as lf
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
BOOKMARKLET_HARNESS = FIXTURES / "bookmarklet_harness.cjs"
NODE = shutil.which("node")
PLAYER_GUID = "11111111-1111-4111-8111-111111111111"


def _lab_logs_page(adventure, *log_ids):
    """Une Adventure de l'historique /logs, telle que le site la renvoie."""
    return {"adventureId": adventure, "adventureTitle": f"Adventure {adventure}",
            "isArchived": False,
            "playerLogs": [{"id": i, "stageId": f"stage-{i}", "stageTitle": f"Étape {i}",
                            "dateLogged": "2024-05-14T10:00:00+02:00",
                            "isArchived": False} for i in log_ids]}
ADVENTURE_REMOVED = "fa1e0000-0000-4000-8000-000000000004"
ADVENTURE_PARTIAL = "fa1e0000-0000-4000-8000-000000000002"
ADVENTURE_ARCHIVED = "fa1e0000-0000-4000-8000-000000000003"


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

        # Aucun test ne doit joindre le vrai service lab2gpx : la récupération
        # automatique, activée par défaut, est coupée ici (LabsAutomationTests
        # branche ses propres réglages) et la primitive réseau est condamnée.
        import blueprints.labs as labs_mod
        quiet = SimpleNamespace(get_app_settings=lambda: SimpleNamespace(
            labs_auto_fetch_coords=False, labs_receive_token=""))
        for target, attr, value in (
            (labs_mod, "get_settings_manager", lambda: quiet),
            (lcp, "post_download", mock.Mock(
                side_effect=AssertionError("accès réseau interdit dans les tests"))),
        ):
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Enregistré après les substitutions, donc exécuté avant leur retrait :
        # une tâche qu'un test n'attend pas ne doit pas finir sur les vrais
        # réglages ni déborder sur le test suivant.
        self.addCleanup(self._wait_for_idle_lab_tasks)

    @staticmethod
    def _wait_for_idle_lab_tasks(timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not any(task_manager.get_active(kind)
                       for kind in ("lab_import", "lab_fetch_coords")):
                return
            time.sleep(0.02)

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

    def _preview_bytes(self, name, raw):
        return self.client.post(
            '/api/labs/import/preview',
            data={'files': [(io.BytesIO(raw), name)]},
            content_type='multipart/form-data')

    def _moved_gpx(self):
        # STAGE_1 déplacée dans le GPX : 47.21510 → 47.30000.
        raw = COORDS.read_bytes()
        self.assertEqual(raw.count(b'lat="47.21510"'), 1)
        return raw.replace(b'lat="47.21510"', b'lat="47.30000"')

    def test_preview_conflict_kept_by_default_then_replaced_on_choice(self):
        self._import_history()
        self._import_coords()

        body = self._preview_bytes("moved.gpx", self._moved_gpx()).get_json()
        self.assertEqual(body["totals"]["conflicts"], 1)
        conflict = body["conflicts_detail"][0]
        self.assertEqual(conflict["local_uid"], STAGE_1)
        self.assertEqual(conflict["stage_title"], "Le Moulin Rouge")
        self.assertEqual(conflict["field"], "coordinates")

        # Sans choix : la valeur existante est conservée.
        rv = self._commit(body["import_token"])
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.result["conflicts"], 1)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertAlmostEqual(row.latitude, 47.21510)

        # « Remplacer » : le choix renvoyé tel que reçu de l'aperçu.
        body = self._preview_bytes("moved.gpx", self._moved_gpx()).get_json()
        conflict = body["conflicts_detail"][0]
        rv = self.client.post('/api/labs/import/commit', json={
            'import_token': body["import_token"],
            'overrides': [{k: conflict[k] for k in ("local_uid", "field", "incoming")}],
        })
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["conflicts"], 0)
        self.assertEqual(st.result["updated"], 1)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertAlmostEqual(row.latitude, 47.3)

    def test_commit_ignores_malformed_overrides(self):
        self._import_history()
        self._import_coords()
        body = self._preview_bytes("moved.gpx", self._moved_gpx()).get_json()
        rv = self.client.post('/api/labs/import/commit', json={
            'import_token': body["import_token"],
            'overrides': ["x", {"local_uid": STAGE_1, "field": "stage_uuid", "incoming": "y"},
                          {"local_uid": STAGE_1, "field": "coordinates", "incoming": "nope"},
                          {"local_uid": 3, "field": "coordinates", "incoming": [1, 2]}],
        })
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["conflicts"], 1)   # rien de tranché

    # --- archives zip ---------------------------------------------------------

    def _zip(self, members):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        return buffer.getvalue()

    def _split_coords(self):
        """La fixture GPX coupée en deux fichiers valides (7 étapes chacun)."""
        text = COORDS.read_text("utf-8")
        head, *waypoints = text.split("<wpt ")
        tail = "</gpx>"
        waypoints = ["<wpt " + w.replace(tail, "") for w in waypoints]
        self.assertEqual(len(waypoints), 14)
        return [(head + "".join(part) + tail).encode("utf-8")
                for part in (waypoints[:7], waypoints[7:])]

    def test_zip_with_several_gpx_imports_them_all(self):
        """Seul le premier GPX d'une archive était lu, sans le dire."""
        self._import_history()
        first, second = self._split_coords()
        archive = self._zip({"lot-1.gpx": first, "sous-dossier/lot-2.gpx": second,
                             "__MACOSX/._lot-1.gpx": b"bruit", "lisez-moi.txt": b"-"})
        body = self._preview_bytes("lab2gpx.zip", archive).get_json()
        self.assertTrue(body["success"], body)
        self.assertEqual([f["name"] for f in body["files"]],
                         ["lab2gpx.zip › lot-1.gpx",
                          "lab2gpx.zip › sous-dossier/lot-2.gpx"])
        # Même résultat que le GPX entier : 8 étapes résolues.
        self.assertEqual(body["totals"]["resolved"], 8)
        rv = self._commit(body["import_token"])
        st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        self.assertEqual(st.result["ready_total"], 8)

    def test_zip_with_single_gpx_keeps_the_archive_name(self):
        self._import_history()
        archive = self._zip({"export.gpx": COORDS.read_bytes()})
        body = self._preview_bytes("lab2gpx.zip", archive).get_json()
        self.assertEqual([f["name"] for f in body["files"]], ["lab2gpx.zip"])
        self.assertEqual(body["totals"]["resolved"], 8)

    def test_zip_without_gpx_is_reported_as_unrecognised(self):
        rv = self._preview_bytes("photos.zip", self._zip({"a.txt": b"x"}))
        self.assertEqual(rv.status_code, 400)
        report = rv.get_json()["files"][0]
        self.assertEqual(report["status"], "error")
        self.assertIn("Format non reconnu", report["error"])

    def test_zip_bounds_apply_to_decompressed_size(self):
        import blueprints.labs as labs_mod
        archive = self._zip({"gros.gpx": b"<gpx>" + b" " * 4096 + b"</gpx>"})
        with mock.patch.object(labs_mod, "MAX_LAB_FILE_BYTES", 1024):
            rv = self._preview_bytes("bombe.zip", archive)
        self.assertEqual(rv.status_code, 400)
        self.assertEqual(rv.get_json()["files"][0]["error"], "Fichier trop volumineux")

    def test_token_errors_are_translated(self):
        """Ces messages passaient par une variable : jamais extraits, ils
        restaient en français dans l'interface anglaise."""
        from flask_babel import force_locale
        import blueprints.labs as labs_mod
        with self.app.test_request_context():
            self.assertEqual(labs_mod._load_pending("???")[2], "Jeton d'import invalide")
            with force_locale('en'):
                self.assertEqual(labs_mod._load_pending("???")[2], "Invalid import token")
                self.assertEqual(labs_mod._load_pending("abc123")[2],
                                 "Unknown or already used import token")

    def test_preview_runs_under_mutation_lock(self):
        """L'aperçu écrit dans sa transaction avant de l'annuler : il doit
        tenir le verrou des mutations, puis le rendre."""
        import blueprints.labs as labs_mod
        held = []

        def spy(apply):
            def wrapper(*args, **kwargs):
                held.append(lab_store.LAB_MUTATION_LOCK.locked())
                return apply(*args, **kwargs)
            return wrapper

        spied = {fmt: spy(fn) for fmt, fn in labs_mod._APPLY_BY_FORMAT.items()}
        with mock.patch.dict(labs_mod._APPLY_BY_FORMAT, spied):
            rv = self._preview(HISTORY, COORDS)
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(held, [True, True])
        self.assertFalse(lab_store.LAB_MUTATION_LOCK.locked())

    def test_preview_error_releases_lock_and_writes_nothing(self):
        import blueprints.labs as labs_mod

        def boom(*_args, **_kwargs):
            raise RuntimeError("boom")

        with mock.patch.dict(labs_mod._APPLY_BY_FORMAT,
                             {fmt: boom for fmt in labs_mod._APPLY_BY_FORMAT}):
            rv = self._preview(HISTORY)
        self.assertEqual(rv.status_code, 500)
        self.assertFalse(lab_store.LAB_MUTATION_LOCK.locked())
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)

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

    def test_suggestion_is_listed_then_cleared_once_resolved(self):
        self._import_history()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        row.suggested_latitude, row.suggested_longitude = 47.2301, -1.5702
        db.session.commit()

        items = self.client.get('/api/labs/unresolved').get_json()["items"]
        item = next(i for i in items if i["stage_uuid"] == STAGE_REMOVED)
        self.assertEqual(item["suggestion"], {"latitude": 47.2301, "longitude": -1.5702})

        rv = self.client.post(f'/api/labs/discoveries/{STAGE_REMOVED}/resolve',
                              json=item["suggestion"])
        self.assertEqual(rv.status_code, 200)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        self.assertAlmostEqual(row.latitude, 47.2301)
        self.assertEqual(row.coordinate_source, "user_correction")
        self.assertIsNone(row.suggested_latitude)

    def test_resolve_accepts_geocaching_coordinate_text(self):
        self._import_history()
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_REMOVED}/resolve',
                              json={"coordinates": "N 47° 13.806 W 001° 34.212"})
        self.assertEqual(rv.status_code, 200, rv.get_json())
        body = rv.get_json()["discovery"]
        self.assertAlmostEqual(body["latitude"], 47.2301, places=5)
        self.assertAlmostEqual(body["longitude"], -1.5702, places=5)

        rv = self.client.post(f'/api/labs/discoveries/{STAGE_1}/resolve',
                              json={"coordinates": "48,8584,2,2945"})
        self.assertEqual(rv.status_code, 400)
        self.assertIn("format de coordonnées non reconnu", rv.get_json()["message"])

    def test_unresolved_grouped_by_adventure(self):
        self._import_history()
        self._import_coords()
        body = self.client.get('/api/labs/unresolved/adventures').get_json()
        self.assertTrue(body["success"])
        # 4 étapes en attente, 3 Adventures : l'archivée en compte 2.
        self.assertEqual(body["total"], 3)
        by_adv = {g["adventure_uuid"]: g for g in body["items"]}
        archived = by_adv[ADVENTURE_ARCHIVED]
        self.assertEqual(len(archived["stages"]), 2)
        self.assertEqual(archived["missing_coordinates"], 2)
        self.assertTrue(archived["is_archived"])
        self.assertEqual(archived["adventure_title"], "Labyrinthe du Port")
        self.assertEqual(sum(len(g["stages"]) for g in body["items"]), 4)

        first = self.client.get('/api/labs/unresolved/adventures?limit=2').get_json()
        rest = self.client.get(
            '/api/labs/unresolved/adventures?limit=2&offset=2').get_json()
        self.assertEqual([g["key"] for g in first["items"] + rest["items"]],
                         [g["key"] for g in body["items"]])

    def test_place_adventure_places_every_missing_stage(self):
        self._import_history()
        self._import_coords()
        rv = self.client.post(f'/api/labs/adventures/{ADVENTURE_ARCHIVED}/place',
                              json={"coordinates": "N 47° 12.000 W 001° 33.000"})
        self.assertEqual(rv.status_code, 200, rv.get_json())
        body = rv.get_json()
        self.assertEqual(body["placed"], 2)
        self.assertEqual(body["ready"], 10)
        rows = db.session.query(LabDiscovery).filter_by(
            adventure_uuid=ADVENTURE_ARCHIVED).all()
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertAlmostEqual(row.latitude, 47.2)
            self.assertAlmostEqual(row.longitude, -1.55)
            self.assertEqual(row.coordinate_scope, "adventure")
            self.assertEqual(row.coordinate_source, "user_correction")

        # Plus rien à placer : refus explicite, sans mutation.
        again = self.client.post(f'/api/labs/adventures/{ADVENTURE_ARCHIVED}/place',
                                 json={"latitude": 1, "longitude": 1})
        self.assertEqual(again.status_code, 404)
        self.assertEqual(self.client.post(
            f'/api/labs/adventures/{ADVENTURE_ARCHIVED}/place', json={}).status_code, 400)

    def test_place_adventure_leaves_placed_stages_alone(self):
        """L'Adventure partielle `…0002` : ses étapes placées par le GPX ne
        bougent pas — et il n'en reste aucune à placer."""
        self._import_history()
        self._import_coords()
        before = {r.stage_uuid: (r.latitude, r.longitude) for r in
                  db.session.query(LabDiscovery).filter_by(adventure_uuid=ADVENTURE_PARTIAL)}
        rv = self.client.post(f'/api/labs/adventures/{ADVENTURE_PARTIAL}/place',
                              json={"coordinates": "45, 3"})
        self.assertEqual(rv.status_code, 404)
        db.session.expire_all()
        after = {r.stage_uuid: (r.latitude, r.longitude) for r in
                 db.session.query(LabDiscovery).filter_by(adventure_uuid=ADVENTURE_PARTIAL)}
        self.assertEqual(before, after)

    def test_resolve_invalid_date_applies_nothing(self):
        """Coordonnées valides + date invalide : refus entier, la ligne
        ne garde pas les coordonnées."""
        self._import_history()
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_1}/resolve',
                              json={"latitude": 45.5, "longitude": 3.25,
                                    "found_date": "14/05/2024"})
        self.assertEqual(rv.status_code, 400)
        self.assertFalse(lab_store.LAB_MUTATION_LOCK.locked())
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertIsNone(row.latitude)
        self.assertEqual(row.coordinate_status, LabDiscovery.COORD_MISSING)

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

    def test_clear_refused_while_a_lab_task_runs(self):
        """Un « Vider » entre deux fichiers d'un import (ou deux lots d'un
        fetch) supprimerait la collection que le lot suivant recrée :
        refusé tant qu'une tâche Labs est active."""
        self._import_history()
        busy = SimpleNamespace(id="tâche-factice", state="running")
        with mock.patch.object(task_manager, "get_active", return_value=busy):
            rv = self.client.post('/api/labs/clear')
        self.assertEqual(rv.status_code, 409)
        self.assertFalse(rv.get_json()["success"])
        self.assertEqual(db.session.query(LabDiscovery).count(), 12)
        # La tâche terminée, le même appel vide bien la collection.
        rv = self.client.post('/api/labs/clear')
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)

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

    def test_export_round_trip_keeps_popup_fields(self):
        """Rang, nombre d'étapes et images survivent à « Exporter » puis à un
        réimport dans une collection vidée."""
        self._import_history()
        self._import_coords()
        exported = self.client.get('/api/labs/export').data
        first = next(d for d in json.loads(exported)["discoveries"]
                     if d["stage_id"] == STAGE_1)
        self.assertEqual((first["stage_number"], first["stages_total"]), (1, 5))
        self.assertTrue(first["stage_image_url"].endswith("000000000101"))

        self.assertEqual(self.client.post('/api/labs/clear').status_code, 200)
        import lab_formats as lf
        lab_store.commit_history(db.session, lf.parse_lab_finds(exported))
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertEqual((row.stage_number, row.stages_total), (1, 5))
        self.assertTrue(row.stage_image_url.endswith("000000000101"))
        self.assertTrue(row.adventure_image_url.endswith("000000000001"))

    def test_export_empty_collection(self):
        self.assertEqual(self.client.get('/api/labs/export').status_code, 404)

    def test_export_survives_a_correction_round_trip(self):
        """Export → vidage → réimport : une correction manuelle (date et
        coordonnées) et les champs du GPX (owner, publication) ne se
        perdent pas — le found_at réémis décrivait autrefois l'ancienne
        date, le réimport la faisait alors gagner sur la correction."""
        self._import_history()
        self._import_coords()
        rv = self.client.post(f'/api/labs/discoveries/{STAGE_1}/resolve',
                              json={"found_date": "2024-06-01",
                                    "latitude": 45.5, "longitude": 3.25})
        self.assertEqual(rv.status_code, 200)
        # owner/published_date sont portés par le GPX Lab2Gpx : posés en
        # base ici, comme le ferait l'enrichissement.
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        row.owner, row.published_date = "Testeur_Fictif", date(2020, 3, 10)
        db.session.commit()

        payload = json.loads(self.client.get('/api/labs/export').data)
        exported = next(d for d in payload["discoveries"]
                        if d["stage_id"] == STAGE_1)
        self.assertEqual(exported["found_at"], "2024-06-01")
        self.assertEqual(exported["date_basis"], "user_correction")
        self.assertEqual(exported["coordinate_source"], "user_correction")
        self.assertEqual(exported["owner"], "Testeur_Fictif")
        self.assertEqual(exported["published_date"], "2020-03-10")

        rv = self.client.post('/api/labs/clear')
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(db.session.query(LabDiscovery).count(), 0)

        parsed = lf.parse_lab_finds(json.dumps(payload))
        self.assertTrue(parsed.ok, parsed.errors)
        lab_store.commit_history(db.session, parsed)

        self.assertEqual(db.session.query(LabDiscovery).count(), 12)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        # La date corrigée a survécu — pas l'ancien instant du 2024-05-14.
        self.assertEqual(row.found_date, date(2024, 6, 1))
        self.assertEqual(row.date_basis, "user_correction")
        self.assertAlmostEqual(row.latitude, 45.5)
        self.assertAlmostEqual(row.longitude, 3.25)
        self.assertEqual(row.coordinate_source, "user_correction")
        self.assertEqual(row.owner, "Testeur_Fictif")
        self.assertEqual(row.published_date, date(2020, 3, 10))


def _fake_fetch(fail_after=None, failed_before=(), failed_after=()):
    """Double de `fetch_gpx_batches` : livre le GPX de test via `on_payload`
    comme le vrai provider, puis abandonne si `fail_after` est fourni.
    `failed_before`/`failed_after` : UUID signalés irrécupérables avant/après
    ce lot."""
    def fake(uuids, user_guid=None, progress=None, on_payload=None,
             on_failed=None, **_kw):
        for u in failed_before:
            on_failed(u)
        # Le service « répond » pour toutes les Adventures demandées, sauf
        # celles qu'il refuse.
        refused = set(failed_before) | set(failed_after)
        on_payload("auto-001.gpx", COORDS.read_bytes(),
                   [u for u in uuids if u not in refused])
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
            # Point de départ coupé : chaque test l'active explicitement.
            "labs_auto_fetch_coords": False,
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

    def test_bookmarklet_is_a_single_comment_free_line(self):
        """Le navigateur retire les sauts de ligne d'un lien javascript: —
        un commentaire `//` resté dans le code avalerait toute la suite."""
        js = self.client.get('/api/labs/bookmarklet').get_json()["bookmarklet"]
        self.assertNotIn("\n", js)
        self.assertNotIn("//", js.replace("://", ""))
        self.assertNotIn("@include", js)
        self.assertNotIn("__ORIGIN__", js)
        self.assertNotIn("__TOKEN__", js)
        # Le cœur partagé est bien inclus.
        self.assertIn("mygcflowCollectLabLogs", js)

    def test_bookmarklet_regenerate_is_post_only(self):
        self.assertEqual(
            self.client.get('/api/labs/bookmarklet/regenerate').status_code,
            405)

    def test_bookmarklet_regenerate_replaces_token_and_invalidates_old(self):
        old_js = self.client.get('/api/labs/bookmarklet') \
            .get_json()["bookmarklet"]
        old_token = self.manager.get_app_settings().labs_receive_token
        self.assertTrue(old_token)

        rv = self.client.post('/api/labs/bookmarklet/regenerate')
        self.assertEqual(rv.status_code, 200)
        body = rv.get_json()
        self.assertTrue(body["success"])
        new_js = body["bookmarklet"]
        new_token = self.manager.get_app_settings().labs_receive_token
        self.assertTrue(new_token)
        self.assertNotEqual(new_token, old_token)
        self.assertIn(json.dumps(new_token), new_js)
        self.assertNotIn(json.dumps(old_token), new_js)
        # Le GET suivant ne régénère pas : le lien servi reste celui-ci.
        again = self.client.get('/api/labs/bookmarklet') \
            .get_json()["bookmarklet"]
        self.assertEqual(again, new_js)

        # L'ancien favori est mort (403 jeton) ; le nouveau passe la porte
        # jeton (le payload non-Lab échoue ensuite en 400).
        for token, expected in ((old_token, 403), (new_token, 400)):
            rv = self.client.post('/api/labs/receive',
                                  data=b'<html>page</html>',
                                  content_type='application/json',
                                  headers={"X-MyGCFlow-Token": token})
            self.assertEqual(rv.status_code, expected, token)

    def _run_bookmarklet(self, **scenario):
        js = self.client.get('/api/labs/bookmarklet').get_json()["bookmarklet"]
        folder = Path(tempfile.mkdtemp(prefix="mygcflow-bookmarklet-"))
        self.addCleanup(shutil.rmtree, folder, True)
        link = folder / "bookmarklet.txt"
        link.write_text(js, encoding="utf-8")
        done = subprocess.run(
            [NODE, str(BOOKMARKLET_HARNESS), str(link), json.dumps(scenario)],
            capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))
        return json.loads(done.stdout.decode("utf-8"))

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_collects_every_page_and_posts_the_export(self):
        pages = [[_lab_logs_page("adv-1", 1, 2)], [_lab_logs_page("adv-2", 3)]]
        out = self._run_bookmarklet(playerId=None, pages=pages)

        received = out["received"]
        self.assertIsNotNone(received, out["said"])
        self.assertTrue(received["url"].endswith("/api/labs/receive"))
        self.assertEqual(received["credentials"], "omit")
        token = self.manager.get_app_settings().labs_receive_token
        self.assertEqual(received["headers"]["X-MyGCFlow-Token"], token)
        body = received["body"]
        self.assertEqual(body["format"], "mygcflow-lab-finds")
        self.assertEqual([d["log_id"] for d in body["discoveries"]], [1, 2, 3])
        self.assertEqual(body["discoveries"][0]["found_date"], "2024-05-14")
        self.assertEqual(body["discoveries"][2]["adventure_id"], "adv-2")
        # Joueur déduit de la session : rien à mémoriser.
        self.assertIsNone(out["remembered"])
        self.assertTrue(out["fetchRestored"])
        # Le fichier produit est bien celui que l'import accepte.
        parsed = lf.parse_lab_finds(json.dumps(body))
        self.assertTrue(parsed.ok, parsed.errors)
        self.assertEqual(len(parsed.drafts), 3)

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_works_again_with_a_remembered_player(self):
        """Deuxième clic : l'identifiant mémorisé suffit, la détection est
        sautée — le favori plantait alors sur « unhook is not a function »."""
        out = self._run_bookmarklet(remembered=PLAYER_GUID, playerId=PLAYER_GUID,
                                    pages=[[_lab_logs_page("adv-1", 1)]])
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(len(out["received"]["body"]["discoveries"]), 1)
        self.assertEqual(out["remembered"], PLAYER_GUID)
        self.assertFalse(any("unhook" in text for text in out["said"]), out["said"])

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_finds_the_player_guid_in_the_page(self):
        html = f'<a href="/profile?guid={PLAYER_GUID}">moi</a>'
        out = self._run_bookmarklet(playerId=PLAYER_GUID, html=html,
                                    pages=[[_lab_logs_page("adv-1", 1, 2)]])
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(len(out["received"]["body"]["discoveries"]), 2)
        self.assertEqual(out["remembered"], PLAYER_GUID)   # mémorisé pour la suite
        self.assertTrue(out["fetchRestored"])

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_falls_back_to_smaller_pages(self):
        pages = [[_lab_logs_page(f"adv-{i}", i) for i in range(1, 31)]]
        out = self._run_bookmarklet(playerId=None, pages=pages, refuseTakeAbove=25)
        self.assertIsNotNone(out["received"], out["said"])
        self.assertEqual(len(out["received"]["body"]["discoveries"]), 30)
        # 50 refusé, 25 accepté (les sondes d'identifiant prennent 1).
        self.assertEqual({r["take"] for r in out["requests"] if r["take"] > 1},
                         {50, 25})

    @unittest.skipUnless(NODE, "node introuvable")
    def test_bookmarklet_cancelled_prompt_sends_nothing(self):
        # Aucun identifiant ne répond et l'invite est annulée. L'interception
        # de la page n'aboutit pas : le banc d'essai la laisse expirer.
        out = self._run_bookmarklet(playerId="introuvable", pages=[], prompt=None,
                                    expireHook=True)
        self.assertIsNone(out["received"])

    def test_export_script_embeds_the_shared_core(self):
        rv = self.client.get('/api/labs/export-script')
        self.assertEqual(rv.status_code, 200)
        self.assertIn('export_lab_logs.js', rv.headers['Content-Disposition'])
        script = rv.get_data(as_text=True)
        self.assertIn("COLLER_LE_GUID_JOUEUR_ICI", script)
        self.assertIn("async function mygcflowCollectLabLogs", script)
        self.assertNotIn("@include", script)
        if NODE:
            folder = Path(tempfile.mkdtemp(prefix="mygcflow-export-script-"))
            self.addCleanup(shutil.rmtree, folder, True)
            (folder / "export.cjs").write_text(script, encoding="utf-8")
            done = subprocess.run([NODE, "--check", str(folder / "export.cjs")],
                                  capture_output=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))

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
            self.assertEqual(rv.status_code, 202, rv.get_json())
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertEqual(st.state, "finished", st.error)
        db.session.expire_all()
        return st.result

    # --- /tasks/<id>/cancel ------------------------------------------------

    def test_cancel_unknown_task_404(self):
        rv = self.client.post('/tasks/inconnu/cancel')
        self.assertEqual(rv.status_code, 404)

    def test_cancel_wrong_task_type_400(self):
        """Seule `lab_fetch_coords` est annulable — un commit d'import est
        atomique : sa tâche refuse l'annulation même encore en cours."""
        # Tâche non-fetch encore active (le nettoyage l'attend de toute façon).
        st = task_manager.submit("lab_import", lambda s: time.sleep(1))
        rv = self.client.post(f'/tasks/{st.id}/cancel')
        self.assertEqual(rv.status_code, 400)

    def test_cancel_finished_task_409(self):
        self._import_history()
        with mock.patch.object(lcp, "fetch_gpx_batches",
                               side_effect=_fake_fetch()):
            rv = self.client.post('/api/labs/fetch-coordinates')
            st = self._wait_task(rv.get_json()["task_id"])
        rv = self.client.post(f'/tasks/{st.id}/cancel')
        self.assertEqual(rv.status_code, 409)

    def test_cancel_fetch_keeps_committed_and_reports(self):
        """Annulation demandée pendant le parcours : la tâche s'arrête au
        point de contrôle, les lots déjà enregistrés survivent et le bilan
        porte `cancelled` — pas un échec."""
        self._import_history()
        committed = {"n": 0}

        def fake(uuids, is_cancelled=None, on_payload=None, **_kw):
            # Premier lot livré, puis l'attente du drapeau comme le vrai
            # provider le ferait à son point de contrôle.
            on_payload("auto-001.gpx", COORDS.read_bytes(), list(uuids))
            committed["n"] += 1
            deadline = time.time() + 10
            while not (is_cancelled and is_cancelled()):
                self.assertLess(time.time(), deadline,
                                "annulation jamais prise en compte")
                time.sleep(0.02)
            raise lcp.FetchCancelled()

        with mock.patch.object(lcp, "fetch_gpx_batches", side_effect=fake):
            rv = self.client.post('/api/labs/fetch-coordinates')
            self.assertEqual(rv.status_code, 202, rv.get_json())
            task_id = rv.get_json()["task_id"]
            # Attendre que le premier lot soit committé avant d'annuler.
            deadline = time.time() + 10
            while not committed["n"] and time.time() < deadline:
                time.sleep(0.02)
            rv2 = self.client.post(f'/tasks/{task_id}/cancel')
            self.assertEqual(rv2.status_code, 200, rv2.get_json())
            self.assertTrue(rv2.get_json()["success"])
            st = self._wait_task(task_id)

        self.assertEqual(st.state, "finished", st.error)
        self.assertTrue(st.result["cancelled"])
        self.assertFalse(st.result["interrupted"])
        self.assertEqual(st.result["resolved"], 8)  # le lot livré est gardé
        db.session.expire_all()
        self.assertEqual(lab_store.collection_status(db.session)["ready"], 8)

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

    def test_stage_missing_from_the_answer_is_not_offered_again(self):
        """Adventure servie, mais sans l'étape trouvée (remaniée depuis) :
        une nouvelle demande ne la donnerait pas — elle n'est plus proposée."""
        self._import_history()
        before = self.client.get('/api/labs/status').get_json()
        self.assertEqual(before["unresolved"], 12)
        self.assertGreater(before["fetchable_adventures"], 0)

        self._fetch()          # tout est servi ; 4 étapes absentes de la réponse

        after = self.client.get('/api/labs/status').get_json()
        self.assertEqual(after["unresolved"], 4)
        self.assertEqual(after["fetchable_adventures"], 0)
        import blueprints.labs as labs_mod
        self.assertEqual(
            labs_mod._unresolved_coord_uuids(db.session, skip_recent_failures=True), [])
        # La relance explicite reste possible : elle retente tout.
        self.assertTrue(labs_mod._unresolved_coord_uuids(db.session))
        items = self.client.get('/api/labs/unresolved').get_json()["items"]
        self.assertTrue(all("coordinates_unavailable" in i["reasons"] for i in items))

    def test_interrupted_fetch_leaves_unanswered_adventures_offered(self):
        """Service tombé avant d'avoir répondu : rien n'est conclu pour les
        Adventures non servies, la récupération reste proposée."""
        self._import_history()

        def fake(uuids, user_guid=None, progress=None, on_payload=None, **_kw):
            on_payload("auto-001.gpx", COORDS.read_bytes(), uuids[:1])
            raise urllib.error.URLError("down")

        with mock.patch.object(lcp, "fetch_gpx_batches", side_effect=fake):
            rv = self.client.post('/api/labs/fetch-coordinates')
            st = self._wait_task(rv.get_json()["task_id"])
        self.assertTrue(st.result["interrupted"])
        db.session.expire_all()
        status = self.client.get('/api/labs/status').get_json()
        self.assertEqual(status["unresolved"], 4)
        self.assertGreater(status["fetchable_adventures"], 0)

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
        # Le bilan d'import annonce la tâche : l'interface enchaîne son suivi.
        self.assertEqual(import_result["fetch_task_id"], fetch_task.id)

    def test_no_autofetch_when_opt_in_off(self):
        # task_manager est un singleton : un fetch d'un test précédent reste
        # enregistré — on compare l'identité, pas la présence.
        before = task_manager.get_last("lab_fetch_coords")
        with mock.patch.object(lcp, "fetch_gpx_batches") as m:
            import_result = self._import_history()
            time.sleep(0.3)   # laisser le temps à un éventuel enchaînement
            self.assertFalse(m.called)
            self.assertIsNone(import_result["fetch_task_id"])
            self.assertIs(task_manager.get_last("lab_fetch_coords"), before)


if __name__ == "__main__":
    unittest.main()
