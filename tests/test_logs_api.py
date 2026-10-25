import io
import json
import os
import tempfile
import time
import unittest
import zipfile

from app import create_app
from extensions import db
from models import LogEvent
from task_manager import task_manager

from tests.test_log_formats import CONTRACT, MY_FINDS


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


if __name__ == "__main__":
    unittest.main()
