"""Aperçu diff d'un réimport « Mes Géocaches » (preview + commit).

Sur une base déjà chargée, l'interface montre le diff avant de remplacer
« Mes Géocaches » : /api/geocaches/import/preview conserve le GPX sous un
jeton à durée limitée et renvoie {added, removed, unchanged,
removed_sample} ; /api/geocaches/import/commit lance alors exactement la
même tâche de fond que /upload. Un aperçu refermé sans validation n'importe
rien ; un jeton inconnu ou expiré est refusé.
"""

import io
import os
import tempfile
import time
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import blueprints.gpx as gpx_mod
from app import create_app
from bdd import TASK_TYPE_IMPORT
from extensions import db
from models import Geocache
from task_manager import task_manager

WPT = (
    '<wpt lat="{lat}" lon="{lon}"><time>2025-01-01T00:00:00Z</time><name>{code}</name>'
    '<groundspeak:cache><groundspeak:name>{code}</groundspeak:name>'
    '<groundspeak:type>Traditional Cache</groundspeak:type>'
    '<groundspeak:country>France</groundspeak:country>'
    '<groundspeak:state>Bretagne</groundspeak:state>'
    '<groundspeak:logs>{logs}</groundspeak:logs>'
    '</groundspeak:cache></wpt>'
)

LOG = (
    '<groundspeak:log><groundspeak:date>2025-01-01T10:00:00Z</groundspeak:date>'
    '<groundspeak:type>Found it</groundspeak:type></groundspeak:log>'
)


def gpx_myfinds(*codes):
    """Un « My Finds » minimal mais valide pour les codes demandés."""
    waypoints = ''.join(
        WPT.format(lat=48.10 + i * 0.01, lon=-1.60 - i * 0.01,
                   code=code, logs=LOG)
        for i, code in enumerate(codes))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.0" creator="Groundspeak Pocket Query" '
        'xmlns="http://www.topografix.com/GPX/1/0" '
        'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
        '<name>My Finds Pocket Query - test</name><desc>Groundspeak test fixture</desc>'
        '<author>Groundspeak</author>'
        + waypoints + '</gpx>')


class GpxImportPreviewTests(unittest.TestCase):
    def setUp(self):
        # ignore_cleanup_errors : les tâches d'import en thread peuvent relâcher
        # le SQLite/WAL une fraction de seconde après la fin observée.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{db_path}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        self.client = self.app.test_client()

        # Jetons d'aperçu isolés : sinon les dépôts d'un test traînent dans
        # les données réelles (même racine que l'app — piège AGENTS.md).
        patcher = mock.patch.object(
            gpx_mod, 'PENDING_ROOT', Path(self.tmpdir.name) / 'pending_gpx')
        patcher.start()
        self.addCleanup(patcher.stop)
        # L'import reconstruit l'arbre pays/régions : hors du dossier du projet.
        patcher = mock.patch('paths.country_state_path',
                             return_value=Path(self.tmpdir.name) / 'country_state.json')
        patcher.start()
        self.addCleanup(patcher.stop)
        # Une tâche qu'un test n'attend pas ne doit pas déborder sur le
        # suivant (exécuté avant le retrait des substitutions).
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
    def _preview(self, gpx_text, name='my-finds.gpx'):
        data = {'file': (io.BytesIO(gpx_text.encode('utf-8')), name)}
        return self.client.post('/api/geocaches/import/preview',
                                data=data, content_type='multipart/form-data')

    def _commit(self, token):
        return self.client.post('/api/geocaches/import/commit',
                                json={'import_token': token})

    def _wait_task(self, task_id, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = task_manager.get(task_id)
            if st is not None and st.state in ('finished', 'failed'):
                return st
            time.sleep(0.05)
        self.fail(f"tâche {task_id} toujours en cours après {timeout}s")

    def _seed(self, *codes):
        for code in codes:
            db.session.add(Geocache(
                gc_code=code, cache_name=code, latitude=48.0, longitude=-1.0,
                found=True, date_find=datetime(2025, 1, 1), time_find='10:00:00',
                cache_type='Traditional Cache', country='France', state=''))
        db.session.commit()

    # ------------------------------------------------------------------
    # /api/geocaches/import/preview
    # ------------------------------------------------------------------
    def test_preview_requires_a_file(self):
        self.assertEqual(
            self.client.post('/api/geocaches/import/preview').status_code, 400)
        rv = self.client.post('/api/geocaches/import/preview',
                              data={'file': (io.BytesIO(b''), '')},
                              content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 400)

    def test_preview_empty_base_all_added(self):
        rv = self._preview(gpx_myfinds('GCAAA01', 'GCAAA02', 'GCAAA03'))
        self.assertEqual(rv.status_code, 200, rv.get_json())
        data = rv.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(data['import_token'])
        self.assertEqual(data['expires_in_seconds'], 1800)
        self.assertEqual(data['name'], 'my-finds.gpx')
        self.assertEqual(data['summary'], {
            'total': 3, 'added': 3, 'removed': 0, 'unchanged': 0,
            'removed_sample': []})
        # L'aperçu seul n'importe rien.
        self.assertEqual(db.session.query(Geocache).count(), 0)

    def test_preview_diff_on_loaded_base(self):
        # GCKEEP figure dans le fichier (inchangée), GCABSENT est absente
        # (retirée), GCNEW est nouvelle (ajoutée).
        self._seed('GCKEEP', 'GCABSENT')
        rv = self._preview(gpx_myfinds('GCKEEP', 'GCNEW'))
        self.assertEqual(rv.status_code, 200, rv.get_json())
        summary = rv.get_json()['summary']
        self.assertEqual(summary['total'], 2)
        self.assertEqual(summary['added'], 1)
        self.assertEqual(summary['removed'], 1)
        self.assertEqual(summary['unchanged'], 1)
        self.assertEqual(summary['removed_sample'], ['GCABSENT'])

    def test_preview_rejects_non_myfinds(self):
        # Pocket Query classique : Groundspeak mais pas « My Finds ».
        not_myfinds = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<gpx version="1.0" creator="Groundspeak Pocket Query" '
            'xmlns="http://www.topografix.com/GPX/1/0" '
            'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
            '<name>Quelconque Pocket Query</name><desc>Groundspeak data</desc>'
            '<author>Groundspeak</author>'
            + WPT.format(lat=48.1, lon=-1.6, code='GCPQ001', logs=LOG) + '</gpx>')
        rv = self._preview(not_myfinds)
        self.assertEqual(rv.status_code, 400)
        self.assertIn('My Finds', rv.get_json()['message'])

    def test_preview_rejects_non_groundspeak(self):
        rv = self._preview(
            '<?xml version="1.0"?><gpx version="1.0" creator="Autre" '
            'xmlns="http://www.topografix.com/GPX/1/0" '
            'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
            '<name>Export</name><desc>Autre source</desc><author>Moi</author>'
            + WPT.format(lat=48.1, lon=-1.6, code='GCX0001', logs=LOG) + '</gpx>')
        self.assertEqual(rv.status_code, 400)
        self.assertIn('Groundspeak', rv.get_json()['message'])

    def test_preview_rejects_invalid_xml(self):
        rv = self._preview('pas du xml <gpx')
        self.assertEqual(rv.status_code, 400)

    def test_preview_supports_pocket_query_zip(self):
        # Le .zip « Pocket Query » est accepté, comme pour /upload.
        zip_path = Path(self.tmpdir.name) / 'pq.zip'
        with zipfile.ZipFile(zip_path, 'w') as zf:
            zf.writestr('pq-wpts.gpx',
                        gpx_myfinds('GCWPT01').replace(
                            '<name>My Finds Pocket Query - test</name>',
                            '<name>Waypoints additionnels</name>'))
            zf.writestr('pq.gpx', gpx_myfinds('GCZIP01', 'GCZIP02'))
        data = {'file': (io.BytesIO(zip_path.read_bytes()), 'pq.zip')}
        rv = self.client.post('/api/geocaches/import/preview',
                              data=data, content_type='multipart/form-data')
        self.assertEqual(rv.status_code, 200, rv.get_json())
        summary = rv.get_json()['summary']
        self.assertEqual(summary['total'], 2)
        self.assertEqual(summary['added'], 2)

    # ------------------------------------------------------------------
    # /api/geocaches/import/commit
    # ------------------------------------------------------------------
    def test_commit_rejects_unknown_or_empty_token(self):
        self.assertEqual(self._commit('inconnu').status_code, 400)
        rv = self.client.post('/api/geocaches/import/commit', json={})
        self.assertEqual(rv.status_code, 400)

    def test_commit_runs_the_real_import(self):
        self._seed('GCKEEP', 'GCABSENT')
        rv = self._preview(gpx_myfinds('GCKEEP', 'GCNEW'))
        token = rv.get_json()['import_token']

        rv2 = self._commit(token)
        self.assertEqual(rv2.status_code, 202, rv2.get_json())
        st = self._wait_task(rv2.get_json()['task_id'])
        self.assertEqual(st.state, 'finished', getattr(st, 'error', ''))

        codes = {g.gc_code for g in db.session.query(Geocache)}
        self.assertEqual(codes, {'GCKEEP', 'GCNEW'})

        # Le jeton est consommé : un second commit est refusé.
        self.assertEqual(self._commit(token).status_code, 400)

    def test_commit_expired_token_rejected(self):
        rv = self._preview(gpx_myfinds('GCAAA01'))
        token = rv.get_json()['import_token']
        # Vieillir le manifest au-delà du TTL : le commit refuse le jeton.
        manifest_path = gpx_mod._pending_root() / token / 'manifest.json'
        manifest = manifest_path.read_text('utf-8')
        old = (datetime.now(timezone.utc) - timedelta(seconds=1900)).isoformat()
        import json as _json
        data = _json.loads(manifest)
        data['created_at'] = old
        manifest_path.write_text(_json.dumps(data), 'utf-8')
        self.assertEqual(self._commit(token).status_code, 400)


if __name__ == '__main__':
    unittest.main()
