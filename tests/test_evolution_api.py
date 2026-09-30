import io
import os
import tempfile
import time
import unittest

from app import create_app
from extensions import db
from task_manager import task_manager
from tests.test_evolution_csv import HEADER, row


def _csv(*rows):
    return ('\n'.join([HEADER, *rows]) + '\n').encode('utf-8')


class EvolutionApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.main_db = os.path.join(self.tmp.name, 'g.db')
        self.app = create_app({
            'SQLALCHEMY_DATABASE_URI': f"sqlite:///{self.main_db}",
            'EVOLUTION_DB_PATH': os.path.join(self.tmp.name, 'evolution.db'),
        })
        with self.app.app_context():
            db.engine.dispose()
        self.client = self.app.test_client()

    def create(self, name='Zone'):
        response = self.client.post('/api/evolution/datasets', json={'name': name})
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()['dataset']

    def upload(self, dataset_id, *files):
        data = {'files': [(io.BytesIO(content), name) for name, content in files]}
        return self.client.post(f'/api/evolution/datasets/{dataset_id}/import', data=data,
                                content_type='multipart/form-data')

    def wait(self, task_id, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = task_manager.get(task_id)
            if status.state in ('finished', 'failed'):
                return status
            time.sleep(0.02)
        self.fail('tâche d\'import non terminée')

    def test_pages_carry_their_mode(self):
        main = self.client.get('/').get_data(as_text=True)
        self.assertIn('data-mode="main"', main)
        self.assertIn('href="/evolution"', main)
        evolution = self.client.get('/evolution').get_data(as_text=True)
        self.assertIn('data-mode="evolution"', evolution)

    def test_crud(self):
        dataset = self.create('Alsace')
        self.assertEqual(self.client.post('/api/evolution/datasets', json={'name': 'alsace'}).status_code, 409)
        self.assertEqual(self.client.post('/api/evolution/datasets', json={}).status_code, 400)
        renamed = self.client.patch(f"/api/evolution/datasets/{dataset['id']}", json={'name': 'Vosges'})
        self.assertEqual(renamed.get_json()['dataset']['name'], 'Vosges')
        listing = self.client.get('/api/evolution/datasets').get_json()
        self.assertEqual([d['name'] for d in listing['datasets']], ['Vosges'])
        self.assertEqual(self.client.delete(f"/api/evolution/datasets/{dataset['id']}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/evolution/datasets/{dataset['id']}").status_code, 404)

    def test_import_merges_files_and_serves_columns(self):
        dataset = self.create()
        mtime = os.path.getmtime(self.main_db)
        response = self.upload(
            dataset['id'],
            ('a.csv', _csv(row('GC1', placed='2001-01-01'),
                           row('GC2', placed='2001-01-03', added='2026-01-01 00:00:00'))),
            ('b.csv', _csv(row('GC2', placed='2001-01-03', archived='true', archived_on='2001-02-01'),
                           row('GC3', placed='2001-01-02', archived='true'))),
        )
        self.assertEqual(response.status_code, 202, response.get_json())
        status = self.wait(response.get_json()['task_id'])
        self.assertEqual(status.state, 'finished', status.error)
        files = status.result['files']
        self.assertEqual([f['rows_new'] for f in files], [2, 1])
        self.assertEqual(files[1]['rows_updated'], 1)
        self.assertEqual(files[1]['archived_without_date'], 1)
        self.assertEqual(status.result['dataset']['stats']['total'], 3)

        data = self.client.get(f"/api/evolution/datasets/{dataset['id']}/data")
        self.assertEqual(data.status_code, 200)
        payload = data.get_json()
        self.assertEqual(payload['code'], ['GC1', 'GC3', 'GC2'])
        self.assertEqual(payload['archived'], [-1, -1, 31])
        etag = data.headers['ETag']
        again = self.client.get(f"/api/evolution/datasets/{dataset['id']}/data",
                                headers={'If-None-Match': etag})
        self.assertEqual(again.status_code, 304)

        details = self.client.get(f"/api/evolution/datasets/{dataset['id']}/caches/GC2").get_json()
        self.assertEqual(details['cache']['archived_on'], '2001-02-01')

        # La base des trouvailles n'est pas touchée par l'import.
        self.assertEqual(os.path.getmtime(self.main_db), mtime)

    def test_invalid_uploads_are_rejected_immediately(self):
        dataset = self.create()
        self.assertEqual(self.upload(dataset['id']).status_code, 400)
        response = self.upload(dataset['id'], ('export.gpx', b'<gpx/>'))
        self.assertEqual(response.get_json()['error'], 'extension')
        response = self.upload(dataset['id'], ('export.csv', b'"GC code",Nom\nGC1,x\n'))
        self.assertEqual(response.status_code, 400)
        self.assertIn('Latitude', response.get_json()['message'])
        self.assertEqual(self.upload(999, ('a.csv', _csv(row()))).status_code, 404)

    def test_foreign_origin_is_rejected(self):
        response = self.client.post('/api/evolution/datasets', json={'name': 'x'},
                                    headers={'Origin': 'https://evil.example'})
        self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    unittest.main()
