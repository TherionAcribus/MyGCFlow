"""Contrôles génériques des données de zones (static/geo, geo/match).

Ils parcourent TOUS les pays : une nouvelle recette est vérifiée sans test
à écrire, sauf ses points témoins (« samples » de geo/recipes/<CC>.json).
Procédure : docs/zones-ajouter-un-pays.md.
"""
import gzip
import hashlib
import json
import re
import unittest
from pathlib import Path

import zones

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static" / "geo"
MATCH = ROOT / "geo" / "match"
RECIPES = ROOT / "geo" / "recipes"
NOTICES = ROOT / "installer" / "licenses" / "THIRD_PARTY_NOTICES.txt"

# Budgets par fichier (docs/zones-ajouter-un-pays.md › Poids).
DISPLAY_MAX_BYTES = 1600 * 1024
MATCH_MAX_BYTES = 2048 * 1024
ACCEPTED_LICENCES = {"public-domain", "cc0", "cc-by-4.0", "etalab-2.0", "dl-de-by-2.0"}

# Noms de régions relevés dans de vraies trouvailles (country_state.json) :
# ils doivent être reconnus par leur nom, sans la position.
GC_NAMES = {
    ("France", "Grand-Est"): ("FR", "FR-GES"),
    ("France", "Centre-Val-de-Loire"): ("FR", "FR-CVL"),
    ("France", "Provence-Alpes-Côte d'Azur"): ("FR", "FR-PAC"),
    ("France", "Corse"): ("FR", "FR-20R"),
    ("Réunion", None): ("FR", "FR-974"),
    ("Mayotte", None): ("FR", "FR-976"),
    ("Germany", "Bayern"): ("DE", "DE-BY"),
    ("Germany", "Nordrhein-Westfalen"): ("DE", "DE-NW"),
    ("United States", "Washington"): ("US", "US-WA"),
    ("Belgium", "Limburg"): ("BE", "BE-VLI"),
    ("Netherlands", "Limburg"): ("NL", "NL-LI"),
    ("Belgium", "Brabant wallon"): ("BE", "BE-WBR"),
    ("Czechia", "Hlavní město Praha"): ("CZ", "CZ-PR"),
    ("Spain", "Catalunya"): ("ES", "ES-cataluna"),
    ("Spain", "Cataluña"): ("ES", "ES-cataluna"),
    ("Italy", "Friuli–Venezia Giulia"): ("IT", "IT-friuliveneziagiulia"),
    ("Italy", "Sicilia"): ("IT", "IT-sicily"),
    ("Switzerland", "Basel Stadt"): ("CH", "CH-BS"),
    ("Austria", "Steiermark"): ("AT", "AT-6"),
    ("Denmark", "Region Syddanmark"): ("DK", "DK-83"),
}


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _match(name):
    with gzip.open(MATCH / name, "rt", encoding="utf-8") as fh:
        return json.load(fh)


class GeoDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = _load(STATIC / "index.json")
        cls.recipes = {p.stem: _load(p) for p in RECIPES.glob("*.json")}
        cls.zone_index = zones.ZoneIndex(MATCH)

    def _display(self, rel):
        return _load(STATIC / rel)

    def test_index_lists_existing_files_with_their_revision(self):
        self.assertEqual(self.index["v"], zones.FORMAT_VERSION)
        entries = [self.index["countries"]] + [lvl for c in self.index["by_country"].values()
                                               for key, lvl in c.items() if key in ("region", "subregion")]
        for entry in entries:
            blob = (STATIC / entry["file"]).read_bytes()
            self.assertEqual(entry["rev"], hashlib.sha1(blob).hexdigest()[:10], entry["file"])
            self.assertEqual(entry["bytes"], len(blob), entry["file"])
            self.assertLessEqual(len(blob), DISPLAY_MAX_BYTES, entry["file"])
        listed = {e["file"] for e in entries} | {"index.json"}
        on_disk = {p.relative_to(STATIC).as_posix() for p in STATIC.rglob("*.json")}
        self.assertEqual(on_disk, listed, "fichiers non listés dans index.json")

    def test_display_zones_are_complete_and_linked(self):
        countries = self._display("countries.json")["features"]
        country_ids = [f["properties"]["id"] for f in countries]
        self.assertEqual(len(country_ids), len(set(country_ids)))
        for cc, entry in self.index["by_country"].items():
            self.assertIn(cc, country_ids)
            regions = self._display(entry["region"]["file"])["features"]
            region_ids = {f["properties"]["id"] for f in regions}
            self.assertEqual(len(region_ids), len(regions), f"{cc} : ids de région en double")
            levels = [(regions, {cc})]
            if "subregion" in entry:
                subs = self._display(entry["subregion"]["file"])["features"]
                self.assertEqual(len({f["properties"]["id"] for f in subs}), len(subs), f"{cc} : ids en double")
                levels.append((subs, region_ids))
                self.assertTrue(entry["subregion"]["label"].get("fr"), f"{cc} : nom du niveau 2 manquant")
            for features, parents in levels:
                for f in features:
                    p = f["properties"]
                    for key in ("id", "name", "name_fr", "name_en"):
                        self.assertTrue(p.get(key), f"{cc} : {key} vide ({p.get('id')})")
                    self.assertIn(p["parent"], parents, f"{cc} : parent inconnu pour {p['id']}")
                    self.assertGreater(p["area_km2"], 0, p["id"])
                    self.assertIn(f["geometry"]["type"], ("Polygon", "MultiPolygon"), p["id"])

    def test_match_files_mirror_display_files(self):
        world = _match("countries.json.gz")
        self.assertEqual(sorted(world["files"]), sorted(self.index["by_country"]))
        self.assertLessEqual((MATCH / "countries.json.gz").stat().st_size, MATCH_MAX_BYTES)
        for cc, entry in self.index["by_country"].items():
            path = MATCH / f"{cc}.json.gz"
            self.assertLessEqual(path.stat().st_size, MATCH_MAX_BYTES, cc)
            data = _match(path.name)
            self.assertEqual(data["v"], zones.FORMAT_VERSION)
            for level in ("region", "subregion"):
                if level not in entry:
                    self.assertNotIn(level, data["levels"], cc)
                    continue
                shown = {f["properties"]["id"] for f in self._display(entry[level]["file"])["features"]}
                self.assertEqual({r["id"] for r in data["levels"][level]}, shown, f"{cc} {level}")
                for ids in data["names"][level].values():
                    self.assertTrue(set(ids) <= shown, f"{cc} : alias vers une zone inconnue")

    def test_recipes_are_well_formed(self):
        self.assertIn("world", self.recipes)
        for name, recipe in self.recipes.items():
            for sid, src in recipe.get("sources", {}).items():
                self.assertIn(src["licence"], ACCEPTED_LICENCES, sid)
                self.assertRegex(src["sha256"], r"^[0-9a-f]{64}$", sid)
            if recipe["kind"] != "country":
                continue
            self.assertEqual(name, recipe["country"])
            self.assertGreaterEqual(len(recipe.get("samples", [])), 5, f"{name} : 5 points témoins au moins")
            entry = self.index["by_country"][name]
            ids = set()
            for level in ("region", "subregion"):
                if level in entry:
                    ids |= {f["properties"]["id"] for f in self._display(entry[level]["file"])["features"]}
            for inset in recipe.get("insets", []):
                self.assertTrue(set(inset["zones"]) <= ids, f"{name} : encart {inset['name']}")

    def test_every_source_is_credited(self):
        notices = NOTICES.read_text(encoding="utf-8")
        for sid, src in self.index["sources"].items():
            self.assertIn(src["title"], notices, sid)
            self.assertIn(src["attribution"], notices, sid)

    def test_samples_are_found_by_position(self):
        for name, recipe in self.recipes.items():
            for s in recipe.get("samples", []):
                with self.subTest(pays=name, point=s["label"]):
                    a = self.zone_index.assign(lat=s["lat"], lon=s["lon"])
                    self.assertEqual((a.country, a.region, a.subregion),
                                     (recipe["country"], s["region"], s.get("subregion")))

    def test_geocaching_names_are_recognised(self):
        for (country, state), expected in GC_NAMES.items():
            with self.subTest(pays=country, region=state):
                a = self.zone_index.assign(country=country, state=state)
                self.assertEqual((a.country, a.region), expected)
                self.assertEqual(a.via[0], "name")

    def test_dissolved_ids_follow_the_documented_rule(self):
        # « IT-sicily » = pays + nom normalisé (docs/zones-ajouter-un-pays.md).
        for f in self._display(self.index["by_country"]["IT"]["region"]["file"])["features"]:
            p = f["properties"]
            self.assertEqual(p["id"], "IT-" + zones.normalize_name(p["name"]))
            self.assertTrue(re.match(r"^IT-[0-9a-z]+$", p["id"]))


if __name__ == "__main__":
    unittest.main()
