import json
import os
import sqlite3
import tempfile
import unittest

import evolution_store as store
from evolution_csv import FileReport
from tests.test_evolution_csv import HEADER, row


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, 'evolution.db')
        self.dataset = store.create_dataset(self.db, 'Zone test')

    def csv(self, rows, name='export.csv'):
        path = os.path.join(self.tmp.name, name)
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write('\n'.join([HEADER] + rows) + '\n')
        return path

    def import_rows(self, rows, name='export.csv'):
        report = FileReport(filename=name)
        store.import_file(self.db, self.dataset['id'], self.csv(rows, name), report)
        return report

    def caches(self):
        conn = sqlite3.connect(self.db)
        try:
            return {r[0]: r[1:] for r in conn.execute(
                'SELECT gc_code, archived_on, is_archived, exported_at, name FROM caches')}
        finally:
            conn.close()


class DatasetTests(StoreTestCase):
    def test_schema_version(self):
        conn = sqlite3.connect(self.db)
        try:
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], store.SCHEMA_VERSION)
        finally:
            conn.close()

    def test_names_are_unique_case_insensitively(self):
        with self.assertRaises(store.EvolutionStoreError) as ctx:
            store.create_dataset(self.db, '  zone   TEST ')
        self.assertEqual(ctx.exception.code, 'name-taken')
        for bad, code in (('', 'name-empty'), ('x' * 101, 'name-too-long')):
            with self.assertRaises(store.EvolutionStoreError) as ctx:
                store.create_dataset(self.db, bad)
            self.assertEqual(ctx.exception.code, code)

    def test_rename_and_list(self):
        other = store.create_dataset(self.db, 'Alsace')
        store.rename_dataset(self.db, self.dataset['id'], 'Bretagne')
        self.assertEqual([d['name'] for d in store.list_datasets(self.db)], ['Alsace', 'Bretagne'])
        with self.assertRaises(store.EvolutionStoreError):
            store.rename_dataset(self.db, other['id'], 'bretagne')

    def test_delete_cascades(self):
        self.import_rows([row('GC1'), row('GC2')])
        store.delete_dataset(self.db, self.dataset['id'])
        conn = sqlite3.connect(self.db)
        try:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM caches').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM imports').fetchone()[0], 0)
        finally:
            conn.close()
        with self.assertRaises(store.EvolutionStoreError):
            store.get_dataset(self.db, self.dataset['id'])


class MergeTests(StoreTestCase):
    def test_newer_export_wins_and_older_is_ignored(self):
        self.import_rows([row('GC1', added='2026-01-01 10:00:00'),
                          row('GC2', added='2026-01-01 10:00:00')], 'a.csv')
        report = self.import_rows([
            row('GC1', archived='true', archived_on='2026-03-01', added='2026-06-01 10:00:00'),
            row('GC2', name='Ancien nom', added='2025-01-01 10:00:00'),
            row('GC3', added='2026-06-01 10:00:00'),
        ], 'b.csv')
        self.assertEqual((report.rows_new, report.rows_updated, report.rows_older), (1, 1, 1))
        self.assertEqual(report.rows_newly_archived, 1)
        caches = self.caches()
        self.assertEqual(caches['GC1'][:2], ('2026-03-01', 1))
        self.assertEqual(caches['GC2'][3], 'Go France Go')

    def test_tie_goes_to_the_last_imported_file(self):
        self.import_rows([row('GC1', name='Premier')], 'a.csv')
        report = self.import_rows([row('GC1', name='Second')], 'b.csv')
        self.assertEqual(report.rows_updated, 1)
        self.assertEqual(self.caches()['GC1'][3], 'Second')

    def test_reimport_is_reported_unchanged(self):
        rows = [row('GC1'), row('GC2', archived='true', archived_on='2010-01-01')]
        self.import_rows(rows)
        report = self.import_rows(rows)
        self.assertEqual((report.rows_new, report.rows_updated, report.rows_unchanged), (0, 0, 2))

    def test_duplicates_inside_a_file(self):
        # Doublons dans un même lot et entre deux lots (batch_size par défaut
        # 5000 : on force deux lots via assez de lignes intermédiaires).
        filler = [row(f'GC{i:X}F') for i in range(5001)]
        report = self.import_rows([
            row('GC1', name='v1', added='2026-01-01 00:00:00'),
            row('GC1', name='v2', added='2026-01-02 00:00:00'),
            *filler,
            row('GC1', name='v0', added='2025-01-01 00:00:00'),
        ])
        self.assertEqual(report.rows_duplicate, 2)
        self.assertEqual(report.rows_new, 5002)
        self.assertEqual(self.caches()['GC1'][3], 'v2')

    def test_stats_and_revision(self):
        self.import_rows([
            row('GC1', placed='2005-01-01'),
            row('GC2', placed='2003-01-01', archived='true', archived_on='2010-01-01'),
            row('GC3', placed='2008-01-01', archived='true', archived_on=''),
        ])
        dataset = store.get_dataset(self.db, self.dataset['id'])
        self.assertEqual(dataset['revision'], 1)
        self.assertEqual(dataset['import_count'], 1)
        self.assertEqual(dataset['stats'], {
            'total': 3, 'active': 1, 'archived': 1, 'archived_no_date': 1,
            'min_placed': '2003-01-01', 'max_placed': '2008-01-01',
            'max_archived': '2010-01-01', 'snapshot_date': '2026-09-30',
        })
        history = store.list_imports(self.db, self.dataset['id'])
        self.assertEqual(history[0]['report']['rows_new'], 3)


class PayloadTests(StoreTestCase):
    def test_payload_version_is_exposed(self):
        # Entre dans l'ETag de /data (blueprints/evolution.py) : à incrémenter
        # quand le format de load_payload change.
        self.assertIsInstance(store.PAYLOAD_VERSION, int)

    def test_columnar_payload(self):
        self.import_rows([
            row('GC2', placed='2001-01-11', archived='true', archived_on='2001-02-01',
                region='Bretagne', size='Micro', d='2.5', t='3'),
            row('GC1', placed='2001-01-01', type_='Cache Mystère'),
            row('GC3', placed='2001-01-05', archived='true', archived_on='', d=''),
        ])
        dataset, body = store.load_payload(self.db, self.dataset['id'])
        data = json.loads(body)
        self.assertEqual(data['origin'], '2001-01-01')
        self.assertEqual(data['code'], ['GC1', 'GC3', 'GC2'])
        self.assertEqual(data['placed'], [0, 4, 10])
        self.assertEqual(data['archived'], [-1, -1, 31])
        self.assertEqual(data['status'], [0, 2, 1])
        self.assertEqual([data['types'][i] for i in data['type']],
                         ['Unknown Cache', 'Traditional Cache', 'Traditional Cache'])
        self.assertEqual([data['regions'][i] for i in data['region']],
                         ['Île-de-France', 'Île-de-France', 'Bretagne'])
        # Taille et département : libellés texte ; difficulté/terrain : format
        # des options du filtre (« 1 », « 1.5 »…) et « » pour une valeur NULL.
        self.assertEqual([data['sizes'][i] for i in data['size']],
                         ['Small', 'Small', 'Micro'])
        self.assertEqual([data['difficulties'][i] for i in data['difficulty']],
                         ['1', '', '2.5'])
        self.assertEqual([data['terrains'][i] for i in data['terrain']],
                         ['1.5', '1.5', '3'])
        self.assertEqual([data['counties'][i] for i in data['county']],
                         ['Essonne', 'Essonne', 'Essonne'])
        self.assertEqual(data['meta']['snapshotDate'], '2026-09-30')
        self.assertEqual(data['dataset']['revision'], dataset['revision'])

        # Nouvelle révision après un import : la charge utile est reconstruite.
        self.import_rows([row('GC4', placed='2001-01-02')])
        _, body = store.load_payload(self.db, self.dataset['id'])
        self.assertEqual(json.loads(body)['count'], 4)

    def test_cache_details(self):
        self.import_rows([row('GC1')])
        cache = store.get_cache(self.db, self.dataset['id'], 'gc1')
        self.assertEqual((cache['name'], cache['owner'], cache['county']), ('Go France Go', 'owner', 'Essonne'))
        with self.assertRaises(store.EvolutionStoreError):
            store.get_cache(self.db, self.dataset['id'], 'GC404')


if __name__ == '__main__':
    unittest.main()
