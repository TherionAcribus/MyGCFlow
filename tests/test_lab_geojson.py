import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

import lab_formats as lf
import lab_geojson
import lab_store
from app import create_app
from bdd import create_geojson, db_infos, filter_session
from extensions import db
from geojson_cache import build_metadata_from_features
from models import Geocache, LabDiscovery

FIXTURES = Path(__file__).parent / "fixtures" / "labs"
HISTORY = FIXTURES / "lab-finds-valid.json"
COORDS = FIXTURES / "lab2gpx-stages.gpx"

STAGE_1 = "57a9e000-0000-4000-8000-000000000101"
STAGE_REMOVED = "57a9e000-0000-4000-8000-000000000401"


class LabGeojsonTests(unittest.TestCase):
    """Projection GeoJSON commune : features lab, fusion, filtrage, db_infos."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{self.db_path}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _import_all(self):
        lab_store.commit_history(db.session, lf.parse_lab_finds(HISTORY.read_bytes()))
        lab_store.commit_coordinates(db.session, lf.parse_lab2gpx_gpx(COORDS.read_bytes()))

    def _add_geocache(self, country=None, state=None, gc_code="GC0001"):
        db.session.add(Geocache(latitude=48.8, longitude=2.3, gc_code=gc_code,
                                cache_name="Cache test", date_find=date(2024, 5, 14),
                                cache_type="Traditional Cache",
                                country=country, state=state))
        db.session.commit()

    # --- features -------------------------------------------------------------

    def test_lab_feature_shape(self):
        self._import_all()
        features = lab_geojson.build_lab_features(db.session)
        self.assertEqual(len(features), 8)
        f = next(x for x in features
                 if x["properties"]["stage_id"] == STAGE_1)
        self.assertEqual(f["geometry"]["type"], "Point")
        self.assertEqual(f["geometry"]["coordinates"], [-1.55420, 47.21510])
        p = f["properties"]
        self.assertEqual(p["source_kind"], "lab")
        self.assertEqual(p["cache_type"], "Adventure Lab")
        self.assertEqual(p["gc_code"], None)
        self.assertEqual(p["record_uid"], f"lab:default:{STAGE_1}")
        self.assertEqual(f["id"], p["record_uid"])
        self.assertEqual(p["date_find"], "2024-05-14")
        self.assertEqual(p["found"], True)
        self.assertEqual(p["difficulty"], None)
        # Lus dans le GPX : publication de l'Adventure et propriétaire.
        self.assertEqual(p["published_date"], "2020-03-10")
        self.assertEqual(p["owner"], "Testeur_Fictif")
        self.assertEqual(p["adventure_url"],
                         "https://labs.geocaching.com/goto/fa1e0000-0000-4000-8000-000000000001")

    def test_popup_fields(self):
        """Rang, nombre d'étapes, avancement de l'Adventure et image."""
        self._import_all()
        props = {f["properties"]["stage_id"]: f["properties"]
                 for f in lab_geojson.build_lab_features(db.session)}
        first = props[STAGE_1]
        self.assertEqual((first["stage_number"], first["stages_total"]), (1, 5))
        self.assertEqual(first["adventure_found_stages"], 5)          # complète
        self.assertTrue(first["image_url"].endswith("000000000101"))  # image d'étape
        # Adventure partielle : 3 étapes trouvées sur 5.
        partial = props["57a9e000-0000-4000-8000-000000000201"]
        self.assertEqual((partial["adventure_found_stages"], partial["stages_total"]), (3, 5))
        # Image refusée à l'import et pas d'image d'Adventure : aucune.
        self.assertIsNone(props["57a9e000-0000-4000-8000-000000000102"]["image_url"])

    def test_found_local_time_is_the_source_wall_clock(self):
        """L'heure de /logs est lue telle quelle (heure locale du joueur sous
        une étiquette du Pacifique) : 09:12:33, pas 16:12 UTC."""
        self._import_all()
        f = next(x for x in lab_geojson.build_lab_features(db.session)
                 if x["properties"]["stage_id"] == STAGE_1)
        self.assertEqual(f["properties"]["found_local_time"], "09:12:33")
        # Le champ factice des géocaches reste vide : ce n'est pas lui qui sert.
        self.assertIsNone(f["properties"]["time_find"])

    def test_found_local_time_absent_without_a_real_instant(self):
        self._import_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        self.assertEqual(lab_geojson.found_local_time(row), "09:12:33")
        # Date corrigée à la main : plus d'heure de source qui tienne.
        row.date_basis, row.date_precision = "user_correction", "day"
        self.assertIsNone(lab_geojson.found_local_time(row))
        # Texte source d'une autre journée que la date retenue : ignoré.
        row.date_basis, row.date_precision = "source_offset", "instant"
        row.found_date = date(2024, 5, 15)
        self.assertIsNone(lab_geojson.found_local_time(row))
        # Date seule : pas d'heure.
        row.found_date = date(2024, 5, 14)
        row.source_date_text = "2024-05-14"
        self.assertIsNone(lab_geojson.found_local_time(row))
        db.session.rollback()

    def test_unresolved_emit_no_feature(self):
        self._import_all()
        ids = {f["properties"]["stage_id"]
               for f in lab_geojson.build_lab_features(db.session)}
        self.assertNotIn(STAGE_REMOVED, ids)
        self.assertNotIn(None, ids)

    def test_record_uid_falls_back_to_local(self):
        self._import_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        row.stage_uuid = None
        row.latitude, row.longitude = 45.0, 3.0
        row.coordinate_status = LabDiscovery.COORD_RESOLVED
        row.coordinate_source = "user_correction"
        db.session.commit()
        f = next(x for x in lab_geojson.build_lab_features(db.session)
                 if x["properties"]["stage_id"] is None)
        # repli sur local_uid (qui vaut l'ancien stage_id ici), jamais
        # d'identifiant fabriqué
        self.assertEqual(f["properties"]["record_uid"],
                         f"lab:default:{db.session.query(LabDiscovery).filter_by(stage_uuid=None).one().local_uid}")

    # --- fusion et tri ---------------------------------------------------------

    def test_merge_sorted_deterministic(self):
        cache_f = {"properties": {"source_kind": "geocache", "gc_code": "GC1",
                                  "date_find": "2024-05-14"}}
        lab_f = {"properties": {"source_kind": "lab", "record_uid": "lab:d:abc",
                                "date_find": "2024-05-14"}}
        later = {"properties": {"source_kind": "lab", "record_uid": "lab:d:zzz",
                                "date_find": "2024-06-01"}}
        merged = lab_geojson.merge_sorted([cache_f], [later, lab_f])
        self.assertEqual([m["properties"].get("record_uid") or m["properties"]["gc_code"]
                          for m in merged], ["GC1", "lab:d:abc", "lab:d:zzz"])

    def test_create_geojson_combines_sources(self):
        self._import_all()
        self._add_geocache()
        geojson = create_geojson(
            db.session.query(Geocache), Geocache, persist=False,
            extra_features=lab_geojson.build_lab_features(db.session))
        kinds = [f["properties"]["source_kind"] for f in geojson["features"]]
        self.assertEqual(kinds.count("geocache"), 1)
        self.assertEqual(kinds.count("lab"), 8)
        dates = [f["properties"]["date_find"] for f in geojson["features"]]
        self.assertEqual(dates, sorted(dates))

    def test_metadata_counts_by_source(self):
        self._import_all()
        self._add_geocache()
        geojson = create_geojson(
            db.session.query(Geocache), Geocache, persist=False,
            extra_features=lab_geojson.build_lab_features(db.session))
        meta = build_metadata_from_features(geojson["features"])
        self.assertEqual(meta["numberOfCaches"], 9)
        self.assertEqual(meta["countBySource"], {"geocache": 1, "lab": 8})

    # --- filtrage (repli SQL) ----------------------------------------------------

    def test_filter_session_includes_labs(self):
        self._import_all()
        self._add_geocache()
        result = filter_session(db, Geocache,
                                {"type": ["Traditional Cache", "Adventure Lab"]})
        kinds = [f["properties"]["source_kind"] for f in result["features"]]
        self.assertEqual(kinds.count("lab"), 8)
        self.assertEqual(kinds.count("geocache"), 1)

    def test_filter_session_lab_type_only(self):
        self._import_all()
        self._add_geocache()
        result = filter_session(db, Geocache, {"type": ["Adventure Lab"]})
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"lab"})

    def test_filter_session_excludes_labs_by_region(self):
        """Sélection géographique réelle : les Labs (pays inconnu) sont exclus."""
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        self._add_geocache(country="Allemagne", gc_code="GC0002")
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab", "Traditional Cache"], "countries": ["France"]})
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"geocache"})
        self.assertEqual(len(result["features"]), 1)

    def test_filter_session_neutral_region_includes_labs(self):
        """État neutre « tous » (toutes options offertes, sentinelle incluse) :
        les Labs passent."""
        from geojson_cache import UNKNOWN_GEO
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        self._add_geocache(country="Allemagne", gc_code="GC0002")
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", "Allemagne", UNKNOWN_GEO]})
        kinds = [f["properties"]["source_kind"] for f in result["features"]]
        self.assertEqual(kinds.count("lab"), 8)
        self.assertEqual(kinds.count("geocache"), 2)

    def test_filter_session_named_without_unknown_excludes_labs(self):
        """Tous les pays nommés mais « Non renseigné » décoché : les Labs
        (valeur inconnue) sont exclus — sélection géographique réelle."""
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        self._add_geocache(country="Allemagne", gc_code="GC0002")
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", "Allemagne"]})
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"geocache"})

    def test_filter_session_unknown_sentinel_includes_labs(self):
        """Sélection partielle + « Non renseigné » : les Labs repassent."""
        from geojson_cache import UNKNOWN_GEO
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        self._add_geocache(country="Allemagne", gc_code="GC0002")
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", UNKNOWN_GEO]})
        kinds = [f["properties"]["source_kind"] for f in result["features"]]
        self.assertEqual(kinds.count("lab"), 8)
        self.assertEqual(kinds.count("geocache"), 1)

    def test_filter_session_aucun_country_returns_nothing(self):
        """« Aucun » pays (liste vide, options existantes) : aucun résultat."""
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab", "Traditional Cache"], "countries": []})
        self.assertEqual(result["features"], [])

    def test_filter_session_dt_filters_do_not_exclude_labs(self):
        """Difficulté/terrain/taille : non applicables aux Labs (plan §9.2)."""
        self._import_all()
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab"], "difficulty": ["3"],
             "terrain": ["4"], "container": ["Small"]})
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"lab"})
        self.assertEqual(len(result["features"]), 8)

    def test_published_range_filters_labs_with_known_publication(self):
        """Période de pose : appliquée aux Labs dont la publication est
        connue (5 des 8 étapes affichables sont de 2020 dans la fixture)."""
        self._import_all()
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab"],
             "published_dates": {"startDate": "2020-01-01", "endDate": "2020-12-31"}})
        published = {f["properties"]["published_date"] for f in result["features"]}
        self.assertEqual(published, {"2020-03-10"})
        self.assertEqual(len(result["features"]), 5)

    def test_published_range_keeps_labs_with_unknown_publication(self):
        """Publication inconnue (coordonnées saisies à la main, hors GPX) :
        la période de pose ne retire pas l'étape."""
        self._import_all()
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_REMOVED).one()
        row.latitude, row.longitude = 45.5, 3.25
        row.coordinate_status = LabDiscovery.COORD_RESOLVED
        row.coordinate_source = lab_store.USER_CORRECTION
        db.session.commit()
        self.assertIsNone(row.published_date)
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab"],
             "published_dates": {"startDate": "1990-01-01", "endDate": "1990-12-31"}})
        self.assertEqual([f["properties"]["stage_id"] for f in result["features"]],
                         [STAGE_REMOVED])

    def test_filter_session_sources_restriction(self):
        """sources explicite : « lab » seul, « geocache » seul, vide = rien."""
        self._import_all()
        self._add_geocache()
        sel = {"type": ["Adventure Lab", "Traditional Cache"],
               "sources": ["lab"]}
        result = filter_session(db, Geocache, sel)
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"lab"})

        sel["sources"] = ["geocache"]
        result = filter_session(db, Geocache, sel)
        kinds = {f["properties"]["source_kind"] for f in result["features"]}
        self.assertEqual(kinds, {"geocache"})

        sel["sources"] = []
        result = filter_session(db, Geocache, sel)
        self.assertEqual(result["features"], [])

    def test_index_path_matches_sql(self):
        """Parité des trois moteurs : index mémoire vs repli SQL (plan §9.3)."""
        from bdd import geojson_cache
        from geojson_cache import UNKNOWN_GEO
        self._import_all()
        self._add_geocache(country="France", gc_code="GC0001")
        self._add_geocache(country="Allemagne", gc_code="GC0002")
        base = create_geojson(
            db.session.query(Geocache), Geocache, persist=False,
            extra_features=lab_geojson.build_lab_features(db.session))
        geojson_cache.set_base_dataset(base, {}, None)

        def ids_of(result):
            gj = result[0] if isinstance(result, tuple) else result
            return sorted(
                f["properties"].get("record_uid")
                or f["properties"]["gc_code"]
                for f in gj["features"])

        selections = [
            {"type": ["Adventure Lab", "Traditional Cache"]},
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", "Allemagne", UNKNOWN_GEO]},  # neutre
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", "Allemagne"]},          # inconnu décoché
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France"]},                        # strict
            {"type": ["Adventure Lab", "Traditional Cache"],
             "countries": ["France", UNKNOWN_GEO]},          # sentinelle
            {"type": ["Adventure Lab"], "difficulty": ["3"],
             "container": ["Small"]},                        # non applicables
            {"type": ["Adventure Lab", "Traditional Cache"],
             "sources": ["lab"]},                            # sources
            {"type": ["Adventure Lab", "Traditional Cache"],
             "dates": {"startDate": "2024-05-14", "endDate": "2024-05-14"}},
            {"type": ["Adventure Lab", "Traditional Cache"],    # période de pose
             "published_dates": {"startDate": "2020-01-01", "endDate": "2020-12-31"}},
            {"type": ["Adventure Lab"],
             "published_dates": {"startDate": "2021-01-01", "endDate": "2022-12-31"}},
        ]
        try:
            for sel in selections:
                via_index = geojson_cache.filter_with_indexes(sel, db_mtime=None)
                self.assertIsNotNone(via_index, f"index path returned None: {sel}")
                via_sql = filter_session(db, Geocache, dict(sel))
                self.assertEqual(ids_of(via_index), ids_of(via_sql),
                                 f"divergence index/SQL pour {sel}")
        finally:
            geojson_cache._reset(None)

    # --- pays et région empruntés à la géocache la plus proche -----------------

    def _setup_borrowed_geo(self):
        """8 étapes à Nantes, une géocache nantaise, une parisienne, une
        allemande ; STAGE_1 déplacée loin de toute géocache."""
        self._import_all()
        for code, lat, lon, country, state in (
                ("GCNANT", 47.2180, -1.5560, "France", "Pays de la Loire"),
                ("GCPARI", 48.8566, 2.3522, "France", "Île-de-France"),
                ("GCBERL", 52.5200, 13.4050, "Germany", "Berlin")):
            db.session.add(Geocache(latitude=lat, longitude=lon, gc_code=code,
                                    cache_name=code, date_find=date(2024, 5, 14),
                                    cache_type="Traditional Cache",
                                    country=country, state=state))
        row = db.session.query(LabDiscovery).filter_by(stage_uuid=STAGE_1).one()
        row.latitude, row.longitude = 44.0, 7.0          # Alpes, aucune géocache
        db.session.commit()

    def _labs_geo(self):
        return {f["properties"]["stage_id"]: (f["properties"]["country"],
                                              f["properties"]["state"])
                for f in lab_geojson.build_lab_features(db.session)}

    def _lab_ids(self, selection):
        result = filter_session(db, Geocache, selection)
        return sorted(f["properties"]["stage_id"] for f in result["features"]
                      if f["properties"]["source_kind"] == "lab")

    def test_labs_borrow_country_and_state_from_nearest_geocache(self):
        self._setup_borrowed_geo()
        geo = self._labs_geo()
        self.assertEqual(geo.pop(STAGE_1), (None, None))     # > 10 km de tout
        self.assertEqual(len(geo), 7)
        self.assertEqual(set(geo.values()), {("France", "Pays de la Loire")})

    def test_borrowed_geo_follows_geocache_changes(self):
        """Mémorisé, mais recalculé quand les géocaches changent — même sans
        changer leur nombre (un import remplace toute la table)."""
        self._setup_borrowed_geo()
        self.assertIn(("France", "Pays de la Loire"), set(self._labs_geo().values()))
        gc = db.session.query(Geocache).filter_by(gc_code="GCNANT").one()
        gc.country, gc.state = "Belgium", "Namur"
        db.session.commit()
        self.assertEqual(set(self._labs_geo().values()) - {(None, None)},
                         {("Belgium", "Namur")})

    def test_filter_session_by_country_and_state_includes_borrowed_labs(self):
        from geojson_cache import UNKNOWN_GEO
        self._setup_borrowed_geo()
        types = ["Adventure Lab", "Traditional Cache"]
        nantes = sorted(k for k in self._labs_geo() if k != STAGE_1)
        self.assertEqual(self._lab_ids({"type": types, "countries": ["France"]}), nantes)
        self.assertEqual(self._lab_ids({"type": types, "countries": ["Germany"]}), [])
        self.assertEqual(self._lab_ids({"type": types, "countries": [UNKNOWN_GEO]}),
                         [STAGE_1])
        self.assertEqual(self._lab_ids({"type": types, "countries": ["France"],
                                        "states": ["Pays de la Loire"]}), nantes)
        self.assertEqual(self._lab_ids({"type": types, "countries": ["France"],
                                        "states": ["Île-de-France"]}), [])
        # Neutre (toutes les options, sentinelle comprise) : tout passe.
        self.assertEqual(len(self._lab_ids(
            {"type": types, "countries": ["France", "Germany", UNKNOWN_GEO]})), 8)

    def test_country_tree_lists_borrowed_geo(self):
        from unittest import mock
        from bdd import build_country_state_tree
        from geojson_cache import UNKNOWN_GEO
        self._setup_borrowed_geo()
        out = Path(self.tmpdir.name) / "country_state.json"
        with mock.patch("paths.country_state_path", return_value=out):
            build_country_state_tree(db, Geocache)
        tree = json.loads(out.read_text("utf-8"))
        self.assertIn("Pays de la Loire", tree["France"])
        # STAGE_1 sans géocache proche : l'option « Non renseigné » reste offerte.
        self.assertEqual(tree[UNKNOWN_GEO], [UNKNOWN_GEO])

    def test_index_path_matches_sql_with_borrowed_geo(self):
        from bdd import geojson_cache
        from geojson_cache import UNKNOWN_GEO
        self._setup_borrowed_geo()
        base = create_geojson(
            db.session.query(Geocache), Geocache, persist=False,
            extra_features=lab_geojson.build_lab_features(db.session))
        geojson_cache.set_base_dataset(base, {}, None)

        def ids_of(result):
            gj = result[0] if isinstance(result, tuple) else result
            return sorted(f["properties"].get("record_uid") or f["properties"]["gc_code"]
                          for f in gj["features"])

        types = ["Adventure Lab", "Traditional Cache"]
        selections = [
            {"type": types, "countries": ["France"]},
            {"type": types, "countries": ["Germany", UNKNOWN_GEO]},
            {"type": types, "countries": ["France"], "states": ["Pays de la Loire"]},
            {"type": types, "countries": ["France"], "states": ["Île-de-France"]},
            {"type": types, "countries": ["France", "Germany", UNKNOWN_GEO]},
        ]
        try:
            for sel in selections:
                via_index = geojson_cache.filter_with_indexes(sel, db_mtime=None)
                self.assertIsNotNone(via_index, f"index path returned None: {sel}")
                self.assertEqual(ids_of(via_index), ids_of(filter_session(db, Geocache, dict(sel))),
                                 f"divergence index/SQL pour {sel}")
        finally:
            geojson_cache._reset(None)

    def test_filter_session_labs_date_range(self):
        self._import_all()
        result = filter_session(
            db, Geocache,
            {"type": ["Adventure Lab"],
             "dates": {"startDate": "2024-05-14", "endDate": "2024-05-14"}})
        dates = {f["properties"]["date_find"] for f in result["features"]}
        self.assertTrue(result["features"])
        self.assertEqual(dates, {"2024-05-14"})

    def test_filter_session_no_type_no_labs(self):
        self._import_all()
        result = filter_session(db, Geocache, {"type": []})
        self.assertEqual(result["features"], [])

    # --- db_infos ----------------------------------------------------------------

    def test_db_infos_labs_only_not_empty(self):
        self._import_all()
        with self.app.test_request_context():
            data = json.loads(db_infos(Geocache).data)
        self.assertFalse(data["isEmpty"])
        self.assertEqual(data["totalPoints"], 8)
        self.assertEqual(data["sources"]["geocaches"], 0)
        self.assertEqual(data["sources"]["labs"], {"ready": 8, "pending": 4})
        self.assertIn("2024", data["startDate"])   # sérialisé RFC HTTP date

    def test_db_infos_mixed_sources(self):
        self._import_all()
        self._add_geocache()
        with self.app.test_request_context():
            data = json.loads(db_infos(Geocache).data)
        self.assertEqual(data["totalPoints"], 9)
        self.assertEqual(data["sources"]["geocaches"], 1)
        self.assertEqual(data["sources"]["labs"]["ready"], 8)

    def test_db_infos_pending_labs_stay_empty(self):
        lab_store.commit_history(db.session, lf.parse_lab_finds(HISTORY.read_bytes()))
        with self.app.test_request_context():
            data = json.loads(db_infos(Geocache).data)
        self.assertTrue(data["isEmpty"])
        self.assertEqual(data["sources"]["labs"], {"ready": 0, "pending": 12})


if __name__ == "__main__":
    unittest.main()
