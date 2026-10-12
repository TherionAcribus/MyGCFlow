import os
import sqlite3
import tempfile
import unittest
from contextlib import closing

import migrations
from app import create_app
from extensions import db


class SchemaMigrationTests(unittest.TestCase):
    """Une base créée par une ancienne version doit rester utilisable."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, 'geocaching.db')

    def _create_app(self):
        app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{self.db_path}"})
        # Libère le fichier SQLite tout de suite : Windows refuse sinon de le
        # lire, le copier ou supprimer le dossier temporaire.
        with app.app_context():
            db.engine.dispose()
        return app

    def _connect(self):
        # sqlite3 en `with` valide la transaction mais ne ferme pas la connexion.
        return closing(sqlite3.connect(self.db_path, isolation_level=None))

    def _columns(self, table='geocache'):
        with self._connect() as conn:
            return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}

    def _tables(self):
        with self._connect() as conn:
            return {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}

    def _user_version(self):
        with self._connect() as conn:
            return conn.execute("PRAGMA user_version").fetchone()[0]

    def test_old_schema_gains_missing_columns(self):
        # Schéma des premières versions : ni gc_code, ni pays, ni attributs.
        with self._connect() as conn:
            conn.execute(
                "CREATE TABLE geocache (id INTEGER PRIMARY KEY, latitude FLOAT, "
                "longitude FLOAT, date_find DATETIME, cache_type VARCHAR(50), "
                "terrain FLOAT, difficulty FLOAT, container VARCHAR(50))"
            )
            conn.execute("INSERT INTO geocache (latitude, longitude) VALUES (48.8, 2.3)")

        self._create_app()

        self.assertTrue({'gc_code', 'country', 'state', 'attributes', 'found'} <= self._columns())
        self.assertEqual(self._user_version(), migrations.LATEST_VERSION)
        self.assertTrue(os.path.exists(self.db_path + '.v0.bak'))

    def test_new_database_is_versioned_without_backup(self):
        self._create_app()

        self.assertEqual(self._user_version(), migrations.LATEST_VERSION)
        self.assertFalse(os.path.exists(self.db_path + '.v0.bak'))

    def test_migrations_run_once(self):
        self._create_app()
        with self._connect() as conn:
            conn.execute("INSERT INTO geocache (latitude, longitude) VALUES (1, 2)")

        self._create_app()

        # Déjà à jour : aucune sauvegarde, aucune migration rejouée.
        self.assertFalse(os.path.exists(self.db_path + f'.v{migrations.LATEST_VERSION}.bak'))

    def test_old_database_gains_lab_tables(self):
        # Base d'avant la fonctionnalité Labs (user_version=1, schéma complet
        # des géocaches mais aucune table lab_*).
        self._create_app()
        with self._connect() as conn:
            conn.execute("DROP TABLE lab_collection")
            conn.execute("DROP TABLE lab_discovery")
            conn.execute("PRAGMA user_version = 1")

        self._create_app()

        self.assertIn('lab_collection', self._tables())
        self.assertIn('lab_discovery', self._tables())
        self.assertIn('local_uid', self._columns('lab_discovery'))
        self.assertIn('coordinate_status', self._columns('lab_discovery'))
        self.assertEqual(self._user_version(), migrations.LATEST_VERSION)

    def test_lab_table_gains_fetch_failure_column(self):
        # Base v2 : tables Labs présentes, sans la mémoire des échecs lab2gpx.
        self._create_app()
        with self._connect() as conn:
            conn.execute("ALTER TABLE lab_discovery DROP COLUMN coord_fetch_failed_at")
            conn.execute("PRAGMA user_version = 2")
        self.assertNotIn('coord_fetch_failed_at', self._columns('lab_discovery'))

        self._create_app()

        self.assertIn('coord_fetch_failed_at', self._columns('lab_discovery'))
        self.assertEqual(self._user_version(), migrations.LATEST_VERSION)

    def test_new_database_has_lab_tables(self):
        self._create_app()

        self.assertIn('lab_collection', self._tables())
        self.assertIn('lab_discovery', self._tables())
        self.assertEqual(self._user_version(), migrations.LATEST_VERSION)


if __name__ == '__main__':
    unittest.main()
