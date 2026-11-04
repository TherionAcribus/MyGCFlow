"""Bilan d'import « Mes Géocaches » remonté dans le résultat de la tâche.

uploadBdd construit un résumé (importées, sans date de trouvaille, sans
position exploitable, logs fusionnés) que run_import_task pose dans
status.result — le frontend l'affiche dans la note/toast de fin d'import
(gpxImportReportMessage + emitBddReport, bdd.js).
"""

import io
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import blueprints.gpx as gpx_mod
from app import create_app
from bdd import TASK_TYPE_IMPORT
from extensions import db
from task_manager import task_manager

WPT = (
    '<wpt{coords}><time>2025-01-01T00:00:00Z</time><name>{code}</name>'
    '<groundspeak:cache><groundspeak:name>{code}</groundspeak:name>'
    '<groundspeak:type>{ctype}</groundspeak:type>'
    '<groundspeak:logs>{logs}</groundspeak:logs>'
    '</groundspeak:cache></wpt>'
)

LOG = (
    '<groundspeak:log{id_attr}><groundspeak:date>{date}</groundspeak:date>'
    '<groundspeak:type>{ltype}</groundspeak:type>'
    '<groundspeak:finder id="42">Testeur</groundspeak:finder></groundspeak:log>'
)


def _wpt(code, logs, lat=48.10, lon=-1.60, ctype='Traditional Cache'):
    coords = f' lat="{lat}" lon="{lon}"' if lat is not None else ''
    return WPT.format(coords=coords, code=code, ctype=ctype, logs=logs)


def _log(log_id, ltype='Found it', date='2025-01-02T10:00:00Z'):
    id_attr = f' id="{log_id}"' if log_id is not None else ''
    return LOG.format(id_attr=id_attr, ltype=ltype, date=date)


def gpx_myfinds(*waypoints):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.0" creator="Groundspeak Pocket Query" '
        'xmlns="http://www.topografix.com/GPX/1/0" '
        'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
        '<name>My Finds Pocket Query - test</name><desc>Groundspeak test fixture</desc>'
        '<author>Groundspeak</author>'
        + ''.join(waypoints) + '</gpx>')


class GpxImportSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{db_path}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()

        # Jetons d'aperçu et arbre pays/régions isolés dans le tmpdir.
        patcher = mock.patch.object(
            gpx_mod, 'PENDING_ROOT', Path(self.tmpdir.name) / 'pending_gpx')
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch('paths.country_state_path',
                             return_value=Path(self.tmpdir.name) / 'country_state.json')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._wait_for_idle_imports)

    @staticmethod
    def _wait_for_idle_imports(timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if task_manager.get_active(TASK_TYPE_IMPORT) is None:
                return
            time.sleep(0.02)

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _import_via_commit(self, gpx_text, name='my-finds.gpx'):
        """Preview puis commit : même tâche de fond que /upload."""
        rv = self.client.post('/api/geocaches/import/preview',
                              data={'file': (io.BytesIO(gpx_text.encode('utf-8')), name)},
                              content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 200, rv.get_json())
        token = rv.get_json()['import_token']
        rv2 = self.client.post('/api/geocaches/import/commit',
                               json={'import_token': token})
        self.assertEqual(rv2.status_code, 202, rv2.get_json())
        task_id = rv2.get_json()['task_id']
        deadline = time.time() + 15
        while time.time() < deadline:
            st = task_manager.get(task_id)
            if st is not None and st.state in ('finished', 'failed'):
                self.assertEqual(st.state, 'finished', getattr(st, 'error', ''))
                return st
            time.sleep(0.05)
        self.fail(f"tâche {task_id} toujours en cours après 15s")

    # ------------------------------------------------------------------
    # Résumé remonté dans task.result['summary']
    # ------------------------------------------------------------------
    def test_summary_counts_for_mixed_gpx(self):
        # GCOK001 : trouvaille classique.
        # GCDNF01 : pas de log « Found it » → importée non trouvée, sans date
        #           de trouvaille ; un de ses logs est sans id → rejeté.
        # GCZERO1 : position sentinelle (0,0) → sans position exploitable.
        # GCLOC01 : « locationless » — position du fichier fictive → sans
        #           position exploitable même si lat/lon sont présentes.
        # GCNOPOS : waypoint sans attributs lat/lon → sans position.
        gpx = gpx_myfinds(
            _wpt('GCOK001', _log(1001)),
            _wpt('GCDNF01',
                 _log(1002, "Didn't find it") + _log(None, 'Write note')),
            _wpt('GCZERO1', _log(1003), lat=0.0, lon=0.0),
            _wpt('GCLOC01', _log(1004), ctype='Locationless (Reverse) Cache'),
            _wpt('GCNOPOS', _log(1005), lat=None),
        )
        st = self._import_via_commit(gpx)
        summary = st.result['summary']
        self.assertEqual(summary['imported'], 5)
        self.assertEqual(summary['without_find_date'], 1)
        self.assertEqual(summary['without_coords'], 3)
        self.assertEqual(summary['logs'], {
            'added': 5, 'updated': 0, 'unchanged': 0, 'rejected': 1})

    def test_summary_logs_none_when_no_usable_log(self):
        # Aucun log avec identité (comme les fixtures e2e) : la fusion est
        # sautée (« no_logs ») et le bilan n'a pas de partie logs.
        gpx = gpx_myfinds(
            _wpt('GCA0001', _log(None)),
            _wpt('GCA0002', _log(None)),
        )
        st = self._import_via_commit(gpx)
        summary = st.result['summary']
        self.assertEqual(summary['imported'], 2)
        self.assertEqual(summary['without_find_date'], 0)
        self.assertEqual(summary['without_coords'], 0)
        self.assertIsNone(summary['logs'])


if __name__ == '__main__':
    unittest.main()
