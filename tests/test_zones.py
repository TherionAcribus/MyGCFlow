"""Rattachement des caches aux zones (zones.py) sur des données synthétiques.

Les vraies données (static/geo, geo/match) sont testées par test_geo_zones.py.
"""
import gzip
import json
import shutil
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import zones


def square(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def record(zone_id, *rings, parent=None):
    out = {"id": zone_id, "rings": [zones.encode_ring(r) for r in rings]}
    if parent:
        out["parent"] = parent
    return out


ISLET = square(-0.4, 2, -0.3, 2.1)


def write(path, data):
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(data, fh)


class NormalizeTests(unittest.TestCase):
    def test_spelling_variants_meet(self):
        same = [("Grand-Est", "Grand Est"), ("Centre-Val-de-Loire", "Centre-Val de Loire"),
                ("Friuli–Venezia Giulia", "Friuli-Venezia Giulia"), ("Île-de-France", "ILE DE FRANCE"),
                ("Baden-Württemberg", "baden wurttemberg"), ("Provence-Alpes-Côte d'Azur", "Provence Alpes Cote dAzur")]
        for a, b in same:
            self.assertEqual(zones.normalize_name(a), zones.normalize_name(b), (a, b))

    def test_different_names_stay_apart(self):
        self.assertNotEqual(zones.normalize_name("Catalunya"), zones.normalize_name("Cataluña"))
        self.assertEqual(zones.normalize_name(None), "")
        self.assertEqual(zones.normalize_name(" - "), "")


class GeometryTests(unittest.TestCase):
    def test_ring_round_trip(self):
        ring = [[2.3522, 48.8566], [-1.5536, 47.2184], [7.7521, 48.5734]]
        flat = zones.decode_ring(zones.encode_ring(ring))
        for (x, y), i in zip(ring, range(0, len(flat), 2)):
            self.assertAlmostEqual(flat[i], x, places=4)
            self.assertAlmostEqual(flat[i + 1], y, places=4)

    def test_contains_with_hole_and_multipolygon(self):
        outer = zones.decode_ring(zones.encode_ring(square(0, 0, 10, 10)))
        hole = zones.decode_ring(zones.encode_ring(square(4, 4, 6, 6)))
        island = zones.decode_ring(zones.encode_ring(square(20, 0, 21, 1)))
        zone = zones.Zone("Z", None, [outer, hole, island])
        self.assertTrue(zone.contains(1, 1))
        self.assertFalse(zone.contains(5, 5))      # dans le trou
        self.assertTrue(zone.contains(20.5, 0.5))  # île
        self.assertFalse(zone.contains(15, 5))
        self.assertFalse(zone.contains(-1, 5))

    def test_distance_in_meters(self):
        zone = zones.Zone("Z", None, [zones.decode_ring(zones.encode_ring(square(0, 0, 1, 1)))])
        # 0,01° de latitude au nord du bord haut ≈ 1,1 km.
        self.assertAlmostEqual(zone.distance_m(0.5, 1.01), 1113, delta=5)


class IndexTests(unittest.TestCase):
    """Deux pays côte à côte : AA (x 0→10) découpé en régions et
    sous-régions, BB (x 10→20) sans niveau 2. Un îlot de AA, à ~35 km de
    sa côte, n'existe pas dans le contour du pays : comme les îles gommées
    par la simplification (Helgoland, île de Sein)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="mygcflow-zones-"))
        write(cls.dir / "countries.json.gz", {
            "v": zones.FORMAT_VERSION,
            "zones": [record("AA", square(0, 0, 10, 10)), record("BB", square(10, 0, 20, 10))],
            "names": {"alpha": ["AA"], "bravo": ["BB"], "commun": ["AA", "BB"]},
            "as_region": {"ilealpha": ["AA", "AA-W"]},
            "files": ["AA", "BB"],
        })
        write(cls.dir / "AA.json.gz", {
            "v": zones.FORMAT_VERSION, "country": "AA",
            "levels": {
                "region": [record("AA-W", square(0, 0, 5, 10), ISLET, parent="AA"),
                           record("AA-E", square(5, 0, 10, 10), parent="AA")],
                "subregion": [record("AA-W1", square(0, 0, 5, 5), ISLET, parent="AA-W"),
                              record("AA-W2", square(0, 5, 5, 10), parent="AA-W"),
                              record("AA-E1", square(5, 0, 10, 10), parent="AA-E")],
            },
            "names": {"region": {"ouest": ["AA-W"], "est": ["AA-E"]},
                      "subregion": {"nord": ["AA-W2"], "sud": ["AA-W1"], "washington": ["AA-W1", "AA-E1"]}},
        })
        write(cls.dir / "BB.json.gz", {
            "v": zones.FORMAT_VERSION, "country": "BB",
            "levels": {"region": [record("BB-1", square(10, 0, 20, 10), parent="BB")]},
            "names": {"region": {"un": ["BB-1"]}},
        })

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.index = zones.ZoneIndex(self.dir)

    def test_names_first(self):
        a = self.index.assign(country="Alpha", state="Ouest", lat=8, lon=8)
        # Le nom de la région l'emporte sur la position (AA-E) : comme les filtres.
        self.assertEqual((a.country, a.region), ("AA", "AA-W"))
        self.assertEqual(a.via[:2], ("name", "name"))

    def test_position_when_names_are_unknown(self):
        a = self.index.assign(country="Inconnu", state="?", lat=2, lon=2)
        self.assertEqual(a, zones.Assignment("AA", "AA-W", "AA-W1", ("position", "position", "position")))

    def test_ambiguous_country_name_falls_back_to_position(self):
        a = self.index.assign(country="Commun", lat=5, lon=15)
        self.assertEqual((a.country, a.region, a.subregion), ("BB", "BB-1", None))

    def test_country_that_is_a_region(self):
        a = self.index.assign(country="Île Alpha", lat=7, lon=2)
        self.assertEqual((a.country, a.region, a.subregion), ("AA", "AA-W", "AA-W2"))

    def test_nearest_within_five_km(self):
        a = self.index.assign(lat=5.5, lon=-0.02)     # ~2,2 km à l'ouest de AA
        self.assertEqual((a.country, a.via[0]), ("AA", "nearest"))
        far = self.index.assign(lat=5.5, lon=-0.2)    # ~22 km
        self.assertEqual(far, zones.Assignment(None, None, None, (None, None, None)))

    def test_islet_found_in_finer_levels(self):
        a = self.index.assign(lat=2.05, lon=-0.35)
        self.assertEqual((a.country, a.region, a.subregion), ("AA", "AA-W", "AA-W1"))

    def test_subregion_stays_inside_the_named_region(self):
        # GC dit « Est », la position est à l'ouest (coordonnées corrigées) :
        # pas de sous-région de l'ouest sous une région de l'est.
        a = self.index.assign(country="Alpha", state="Est", lat=2, lon=2)
        self.assertEqual((a.region, a.subregion), ("AA-E", None))
        # À 1,1 km de la frontière : la sous-région voisine de la bonne région.
        a = self.index.assign(country="Alpha", state="Est", lat=2, lon=4.99)
        self.assertEqual((a.region, a.subregion, a.via[2]), ("AA-E", "AA-E1", "nearest"))

    def test_county_name_scoped_by_region(self):
        a = self.index.assign(country="Alpha", state="Est", county="Washington")
        self.assertEqual(a.subregion, "AA-E1")
        a = self.index.assign(country="Alpha", county="Washington")
        self.assertIsNone(a.subregion)                 # ambigu sans région
        a = self.index.assign(country="Alpha", county="Nord")
        self.assertEqual((a.region, a.subregion, a.via[1]), ("AA-W", "AA-W2", "parent"))
        a = self.index.assign(country="Alpha", state="Est", county="Nord")
        self.assertIsNone(a.subregion)                 # contredit la région

    def test_country_without_finer_levels(self):
        a = self.index.assign(country="Bravo", state="Un", lat=5, lon=15)
        self.assertEqual(a, zones.Assignment("BB", "BB-1", None, ("name", "name", None)))

    def test_bad_positions_are_ignored(self):
        for lat, lon in ((0, 0), (95, 2), (None, 2), (2, None)):
            self.assertIsNone(self.index.assign(lat=lat, lon=lon).country)

    def test_annotate_features(self):
        features = [
            {"geometry": {"type": "Point", "coordinates": [2, 2]}, "properties": {"country": "Alpha"}},
            {"geometry": None, "properties": {"country": "Bravo", "state": "Un"}},
            {"geometry": {"type": "Point", "coordinates": ["x", 2]}, "properties": {}},
        ]
        self.assertTrue(zones.annotate_features(features, self.index))
        self.assertEqual([f["properties"]["zone_subregion"] for f in features], ["AA-W1", None, None])
        self.assertEqual(features[1]["properties"]["zone_region"], "BB-1")
        self.assertIsNone(features[2]["properties"]["zone_country"])
        empty = zones.ZoneIndex(self.dir / "absent")
        self.assertFalse(zones.annotate_features([{"properties": {}}], empty))

    def test_locationless_caches_are_never_placed(self):
        # Position et pays fictifs (siège de Geocaching.com) : hors carte,
        # même avec un nom et une position que l'index reconnaîtrait.
        features = [{"geometry": {"type": "Point", "coordinates": [2, 2]},
                     "properties": {"country": "Alpha", "cache_type": zones.LOCATIONLESS_CACHE_TYPE}}]
        self.assertTrue(zones.annotate_features(features, self.index))
        props = features[0]["properties"]
        self.assertEqual((props["zone_country"], props["zone_region"], props["zone_subregion"]), (None, None, None))

    def test_signature_carries_the_rules_version(self):
        # Changer les règles fait recalculer les rattachements stockés.
        before = zones.data_signature(self.dir)
        with unittest.mock.patch.object(zones, "RULES_VERSION", zones.RULES_VERSION + 1):
            self.assertNotEqual(zones.data_signature(self.dir), before)

    def test_missing_data_is_never_an_error(self):
        empty = zones.ZoneIndex(self.dir / "absent")
        self.assertFalse(empty.available())
        self.assertEqual(empty.assign(country="Alpha", lat=2, lon=2).country, None)


if __name__ == "__main__":
    unittest.main()
