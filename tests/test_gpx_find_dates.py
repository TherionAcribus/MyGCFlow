"""Dates « Found it » des GPX My Finds : tous les formats du terrain comptent.

La détection d'une trouvaille lit la date du log « Found it » dans
<groundspeak:date>. Le parseur historique n'acceptait que le format
« 2026-01-04T10:00:00Z » en dur : toute variante rencontrée sur le terrain
(fractions de seconde « .000Z », absence du « Z », date seule sans heure)
était silencieusement ignorée et la cache restait found=False. Le parseur
tolérant parse_gpx_time doit être utilisé.
"""

import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from app import create_app
from bdd import uploadBdd
from extensions import db
from models import Geocache

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
    '<groundspeak:log><groundspeak:date>{date}</groundspeak:date>'
    '<groundspeak:type>{type}</groundspeak:type></groundspeak:log>'
)


class GpxImportFindDatesTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{db_path}"})
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self._dispose)
        # L'import reconstruit l'arbre pays/régions : hors du dossier du projet.
        patcher = mock.patch('paths.country_state_path',
                             return_value=Path(self.tmpdir.name) / 'country_state.json')
        patcher.start()
        self.addCleanup(patcher.stop)

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def test_found_log_date_variants_are_parsed(self):
        gpx = Path(self.tmpdir.name) / 'finds.gpx'
        gpx.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<gpx version="1.0" creator="Groundspeak Pocket Query" '
            'xmlns="http://www.topografix.com/GPX/1/0" '
            'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
            '<name>My Finds Pocket Query - test</name><desc>Groundspeak test fixture</desc>'
            '<author>Groundspeak</author>'
            # Fractions de seconde : fréquent dans les exports réels.
            + WPT.format(lat=48.10, lon=-1.60, code="GCFRAC",
                         logs=LOG.format(date="2026-01-01T10:00:00.000Z", type="Found it"))
            # Instant ISO sans « Z » terminal.
            + WPT.format(lat=48.11, lon=-1.61, code="GCNOZ",
                         logs=LOG.format(date="2026-01-02T10:30:00", type="Found it"))
            # Date civile seule, sans heure.
            + WPT.format(lat=48.12, lon=-1.62, code="GCDATE",
                         logs=LOG.format(date="2026-01-03", type="Found it"))
            # Format de référence, déjà accepté avant le correctif.
            + WPT.format(lat=48.13, lon=-1.63, code="GCREF",
                         logs=LOG.format(date="2026-01-04T10:00:00Z", type="Found it"))
            # Aucun log « Found it » : la cache reste non trouvée.
            + WPT.format(lat=48.14, lon=-1.64, code="GCNONE",
                         logs=LOG.format(date="2026-01-05T10:00:00Z", type="Didn't find it"))
            + '</gpx>', 'utf-8')

        uploadBdd(str(gpx), Geocache, db)

        caches = {g.gc_code: g for g in db.session.query(Geocache)}
        self.assertEqual(set(caches), {"GCFRAC", "GCNOZ", "GCDATE", "GCREF", "GCNONE"})

        attendus = {
            "GCFRAC": (datetime(2026, 1, 1, 10, 0, 0), '10:00:00'),
            "GCNOZ":  (datetime(2026, 1, 2, 10, 30, 0), '10:30:00'),
            "GCDATE": (datetime(2026, 1, 3, 0, 0, 0), '00:00:00'),
            "GCREF":  (datetime(2026, 1, 4, 10, 0, 0), '10:00:00'),
        }
        for code, (date_find, time_find) in attendus.items():
            cache = caches[code]
            self.assertTrue(cache.found, code)
            self.assertEqual(cache.date_find, date_find, code)
            self.assertEqual(cache.time_find, time_find, code)

        non_trouvee = caches["GCNONE"]
        self.assertFalse(non_trouvee.found)
        self.assertIsNone(non_trouvee.date_find)
        self.assertIsNone(non_trouvee.time_find)


if __name__ == "__main__":
    unittest.main()
