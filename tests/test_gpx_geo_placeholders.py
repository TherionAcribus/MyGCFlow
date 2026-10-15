"""Région « None » des GPX geocaching.com : une absence, pas une région."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import create_app
from bdd import clean_geo_text, uploadBdd
from extensions import db
from models import Geocache

WPT = (
    '<wpt lat="{lat}" lon="{lon}"><time>2025-01-01T00:00:00Z</time><name>{code}</name>'
    '<groundspeak:cache><groundspeak:name>{code}</groundspeak:name>'
    '<groundspeak:type>Traditional Cache</groundspeak:type>'
    '<groundspeak:country>{country}</groundspeak:country>'
    '<groundspeak:state>{state}</groundspeak:state>'
    '<groundspeak:logs><groundspeak:log><groundspeak:date>2026-01-01T10:00:00Z</groundspeak:date>'
    '<groundspeak:type>Found it</groundspeak:type></groundspeak:log></groundspeak:logs>'
    '</groundspeak:cache></wpt>'
)


class CleanGeoTextTests(unittest.TestCase):
    def test_placeholders_become_none(self):
        for raw in (None, "", "   ", "None", "none", " NONE "):
            self.assertIsNone(clean_geo_text(raw), repr(raw))

    def test_real_values_are_kept_trimmed(self):
        self.assertEqual(clean_geo_text(" Bretagne "), "Bretagne")
        self.assertEqual(clean_geo_text("Nonenberg"), "Nonenberg")


class GpxImportGeoTests(unittest.TestCase):
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

    def test_import_stores_no_region_for_none(self):
        gpx = Path(self.tmpdir.name) / 'finds.gpx'
        gpx.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<gpx version="1.0" creator="Groundspeak Pocket Query" '
            'xmlns="http://www.topografix.com/GPX/1/0" '
            'xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">'
            '<name>My Finds Pocket Query - test</name><desc>Groundspeak test fixture</desc>'
            '<author>Groundspeak</author>'
            + WPT.format(lat=49.61, lon=6.13, code="GCLUX", country="Luxembourg", state="None")
            + WPT.format(lat=48.11, lon=-1.68, code="GCBZH", country="France", state="Bretagne")
            + '</gpx>', 'utf-8')

        uploadBdd(str(gpx), Geocache, db)

        geo = {g.gc_code: (g.country, g.state) for g in db.session.query(Geocache)}
        self.assertEqual(geo, {"GCLUX": ("Luxembourg", None), "GCBZH": ("France", "Bretagne")})


if __name__ == "__main__":
    unittest.main()
