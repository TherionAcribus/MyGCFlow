"""Cache GeoJSON persisté : il porte les ids de zones, calculés avec les
données de rattachement livrées avec l'app. Une mise à jour de ces données
(nouvelle recette de pays) doit le faire recalculer."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import geojson_cache
import zones


class PersistedCacheFollowsZoneDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db = root / "geocaching.db"
        self.db.write_bytes(b"")
        self.persist = root / "geojson_indexes.json"
        self.base = root / "geojson_data.json"
        geojson = {"type": "FeatureCollection", "features": [{
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [-0.128, 51.508]},
            "properties": {"gc_code": "GC1", "date_find": "2020-01-01", "zone_region": "GB-london"}}]}
        self.base.write_text(json.dumps(geojson), encoding="utf-8")
        self.cache = self._open()
        self.cache.set_base_dataset(geojson)

    def tearDown(self):
        self.tmp.cleanup()

    def _open(self):
        return geojson_cache.GeojsonIndexCache(str(self.db), str(self.persist), str(self.base))

    def _reloaded(self):
        return self._open().get_base_dataset_if_current(None) is not None

    def test_reloaded_while_zone_data_is_unchanged(self):
        self.assertEqual(json.loads(self.persist.read_text(encoding="utf-8"))["zones"], zones.data_signature())
        self.assertTrue(self._reloaded())

    def test_dropped_when_zone_data_changed(self):
        with mock.patch.object(zones, "data_signature", return_value="autre"):
            self.assertFalse(self._reloaded())

    def test_file_written_before_the_signature_is_dropped(self):
        data = json.loads(self.persist.read_text(encoding="utf-8"))
        del data["zones"]
        self.persist.write_text(json.dumps(data), encoding="utf-8")
        with mock.patch.object(zones, "data_signature", return_value="abc"):
            self.assertFalse(self._reloaded())


if __name__ == "__main__":
    unittest.main()
