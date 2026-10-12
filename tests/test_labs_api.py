import io
import json
import os
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path

import lab_store
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


if __name__ == "__main__":
    unittest.main()
