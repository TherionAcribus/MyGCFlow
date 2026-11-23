"""Page Parcours : parcours enregistrés et entrées de la reconstruction
(parcours_store.py, parcours_dataset.py, blueprints/parcours.py)."""

import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

import migrations
from app import create_app
from extensions import db
from models import CacheRef, CacheWaypoint, Geocache, LabCollection, LabDiscovery, LogCollection, LogEvent

ME = 1234567
OTHER = 7654321
HOST = "http://127.0.0.1:51730"


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    # Requêtes modifiantes : même origine que l'app (security.py).
    def post(self, url, json):
        return self.client.post(url, json=json, headers={"Origin": HOST}, base_url=HOST)

    def patch(self, url, json):
        return self.client.patch(url, json=json, headers={"Origin": HOST}, base_url=HOST)

    def delete(self, url):
        return self.client.delete(url, headers={"Origin": HOST}, base_url=HOST)

    def get(self, url):
        return self.client.get(url, base_url=HOST)

    def create(self, **data):
        body = {"name": "Vacances", "date_start": "2025-07-12", "date_end": "2025-07-13", **data}
        response = self.post("/api/parcours", body)
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()["parcours"]

    @staticmethod
    def find(code, day, lat=45.0, lon=5.0, cache_type="Traditional Cache"):
        db.session.add(Geocache(gc_code=code, cache_name=f"Cache {code}", latitude=lat, longitude=lon,
                                found=True, cache_type=cache_type,
                                # Heure factice des GPX : jamais servie.
                                date_find=datetime.fromisoformat(f"{day}T19:00:00"), time_find="19:00:00"))

    @staticmethod
    def logs(*events, account=ME):
        collection = LogCollection(uid="default", account_user_id=account, revision=1)
        db.session.add(collection)
        db.session.flush()
        for log_id, code, day, type_id, author in events:
            db.session.add(LogEvent(collection_id=collection.id, log_id=log_id, gc_code=code,
                                    type_id=type_id, log_date=date.fromisoformat(day), author_id=author))


class CrudTests(_Base):
    def test_create_list_update_delete(self):
        created = self.create()
        self.assertEqual(created["name"], "Vacances")
        self.assertEqual((created["date_start"], created["date_end"]), ("2025-07-12", "2025-07-13"))
        self.assertTrue(created["include_labs"])
        self.assertTrue(created["include_dnf"])

        listing = self.get("/api/parcours").get_json()
        self.assertEqual([p["id"] for p in listing["parcours"]], [created["id"]])
        self.assertEqual(listing["maxDays"], 92)

        updated = self.patch(f"/api/parcours/{created['id']}", {"name": "  Croatie  ", "include_dnf": False})
        self.assertEqual(updated.status_code, 200)
        body = updated.get_json()["parcours"]
        self.assertEqual(body["name"], "Croatie")
        self.assertFalse(body["include_dnf"])
        self.assertEqual(body["date_end"], "2025-07-13")  # clé absente : inchangée

        self.assertEqual(self.delete(f"/api/parcours/{created['id']}").status_code, 200)
        self.assertEqual(self.get(f"/api/parcours/{created['id']}").status_code, 404)
        self.assertEqual(self.get("/api/parcours").get_json()["parcours"], [])

    def test_playback_overrides(self):
        # Réglages de lecture propres au parcours : JSON épars, les clés
        # inconnues ou invalides tombent, le défaut global sert pour le reste.
        pid = self.create()["id"]
        self.assertEqual(self.get(f"/api/parcours/{pid}").get_json()["parcours"]["playback"], {})

        body = self.patch(f"/api/parcours/{pid}", {"playback": {
            "camera": "fixed", "pace": "proportional", "day_cards": False,
            "head": "casque", "hours": 12, "unknown": "x", "title": "theme"}})
        self.assertEqual(body.status_code, 200)
        self.assertEqual(body.get_json()["parcours"]["playback"],
                         {"camera": "fixed", "pace": "proportional", "day_cards": False, "title": "theme"})
        listing = self.get("/api/parcours").get_json()
        self.assertEqual(listing["parcours"][0]["playback"]["camera"], "fixed")

        # La copie et le couple export/import gardent les réglages du voyage.
        copy = self.post(f"/api/parcours/{pid}/duplicate", {}).get_json()["parcours"]
        self.assertEqual(copy["playback"]["pace"], "proportional")
        exported = self.get(f"/api/parcours/{pid}/export").get_json()
        self.assertEqual(exported["parcours"]["playback"]["camera"], "fixed")
        imported = self.post("/api/parcours/import", exported).get_json()["parcours"]
        self.assertFalse(imported["playback"]["day_cards"])

        # Patch vide ou valeur non dict : toutes les surcharges tombent.
        for payload in ({"playback": {}}, {"playback": "rien"}):
            body = self.patch(f"/api/parcours/{pid}", payload)
            self.assertEqual(body.get_json()["parcours"]["playback"], {})

    def test_photo_display_overrides(self):
        # Affichage des photos propre au parcours : comme `playback`, JSON
        # épars validé avec les domaines de la préférence globale.
        pid = self.create()["id"]
        self.assertEqual(self.get(f"/api/parcours/{pid}").get_json()["parcours"]["photo_display"], {})

        body = self.patch(f"/api/parcours/{pid}", {"photo_display": {
            "layout": "strip", "frame": "cadre", "size": 9999, "duration": 2.04,
            "pin": True, "stack": "oui", "caption": "  {etape}   · {heure} ", "unknown": 1}})
        self.assertEqual(body.status_code, 200)
        self.assertEqual(body.get_json()["parcours"]["photo_display"], {
            "layout": "strip", "size": 600, "duration": 2.0, "pin": True, "caption": "{etape} · {heure}"})
        # Les réglages de lecture n'en sont pas touchés, et inversement.
        self.assertEqual(body.get_json()["parcours"]["playback"], {})
        body = self.patch(f"/api/parcours/{pid}", {"playback": {"camera": "fixed"}})
        self.assertEqual(body.get_json()["parcours"]["photo_display"]["layout"], "strip")

        copy = self.post(f"/api/parcours/{pid}/duplicate", {}).get_json()["parcours"]
        self.assertEqual(copy["photo_display"]["size"], 600)
        exported = self.get(f"/api/parcours/{pid}/export").get_json()
        self.assertTrue(exported["parcours"]["photo_display"]["pin"])
        imported = self.post("/api/parcours/import", exported).get_json()["parcours"]
        self.assertEqual(imported["photo_display"]["layout"], "strip")

        for payload in ({"photo_display": {}}, {"photo_display": None}):
            body = self.patch(f"/api/parcours/{pid}", payload)
            self.assertEqual(body.get_json()["parcours"]["photo_display"], {})

    def test_listing_counts(self):
        """Pastilles de la liste : étapes (trouvailles + Labs + DNF, sources
        du parcours comprises) et objets rattachés."""
        self.find("GC1", "2025-07-12")
        self.find("GC2", "2025-07-13")
        self.find("GC3", "2025-08-01")          # hors plage des deux parcours
        collection = LabCollection(uid="default", revision=1)
        db.session.add(collection)
        db.session.flush()
        db.session.add(LabDiscovery(
            collection_id=collection.id, local_uid="l1", stage_uuid="u1",
            coordinate_status=LabDiscovery.COORD_RESOLVED, latitude=45.3, longitude=5.3,
            found_date=date(2025, 7, 13)))
        self.logs((10, "GC1", "2025-07-12", 3, ME),    # écarté : trouvée le jour même
                  (11, "GCX", "2025-07-13", 3, ME))
        db.session.commit()
        a = self.create()
        b = self.create(name="Journée", date_start="2025-07-12", date_end="2025-07-12",
                        include_labs=False, include_dnf=False)
        self.patch(f"/api/parcours/{a['id']}/overrides",
                   {"overrides": [{"key": "GC1", "rank": 1}]})
        self.assertEqual(self.post(f"/api/parcours/{a['id']}/places",
                         {"kind": "place", "lat": 45.9, "lon": 6.1,
                          "date": "2025-07-12"}).status_code, 201)

        listing = {p["id"]: p for p in self.get("/api/parcours").get_json()["parcours"]}
        self.assertEqual(listing[a["id"]]["counts"],
                         {"stops": 4, "overrides": 1, "places": 1, "photos": 0, "tracks": 0})
        self.assertEqual(listing[b["id"]]["counts"],
                         {"stops": 1, "overrides": 0, "places": 0, "photos": 0, "tracks": 0})

    def test_single_day_when_end_is_missing(self):
        response = self.post("/api/parcours", {"name": "Journée", "date_start": "2025-07-12"})
        self.assertEqual(response.get_json()["parcours"]["date_end"], "2025-07-12")

    def test_invalid_input_is_refused_with_a_code(self):
        cases = [
            ({"name": " ", "date_start": "2025-07-12"}, "name-empty"),
            ({"name": "x" * 81, "date_start": "2025-07-12"}, "name-too-long"),
            ({"name": "A", "date_start": "12/07/2025"}, "date-invalid"),
            ({"name": "A", "date_start": None}, "date-invalid"),
            ({"name": "A", "date_start": "2025-07-12", "date_end": "2025-07-11"}, "range-reversed"),
            ({"name": "A", "date_start": "2025-01-01", "date_end": "2025-04-03"}, "range-too-long"),
        ]
        for body, code in cases:
            response = self.post("/api/parcours", body)
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.get_json()["error"], code, body)
            self.assertTrue(response.get_json()["message"])
        # 92 jours (du 1er janvier au 2 avril) : la limite elle-même est acceptée.
        ok = self.post("/api/parcours", {"name": "A", "date_start": "2025-01-01", "date_end": "2025-04-02"})
        self.assertEqual(ok.status_code, 201)

    def test_failed_update_leaves_the_parcours_unchanged(self):
        created = self.create()
        response = self.patch(f"/api/parcours/{created['id']}", {"name": "Autre", "date_end": "2025-07-01"})
        self.assertEqual(response.get_json()["error"], "range-reversed")
        self.assertEqual(self.get(f"/api/parcours/{created['id']}").get_json()["parcours"]["name"], "Vacances")

    def test_cross_site_writes_are_refused(self):
        response = self.client.post("/api/parcours", json={"name": "A", "date_start": "2025-07-12"},
                                    headers={"Origin": "https://evil.example"}, base_url=HOST)
        self.assertEqual(response.status_code, 403)

    def test_page_is_served_in_parcours_mode(self):
        response = self.get("/parcours")
        self.assertEqual(response.status_code, 200)
        self.assertIn('data-mode="parcours"', response.get_data(as_text=True))


class InputsTests(_Base):
    def inputs(self, parcours_id):
        response = self.get(f"/api/parcours/{parcours_id}/inputs")
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_finds_of_the_range_by_day_with_their_log_ids(self):
        self.find("GC1", "2025-07-12", lat=45.1)
        self.find("GC2", "2025-07-12", lat=45.2)
        self.find("GC3", "2025-07-13")
        self.find("GC0", "2025-07-11")          # hors plage
        self.find("GC4", "2025-07-14")          # hors plage (lendemain de la fin)
        # Logs saisis dans le désordre : GC2 avant GC1.
        self.logs((501, "GC2", "2025-07-12", 2, ME), (502, "GC1", "2025-07-12", 2, ME),
                  (499, "GC1", "2025-07-12", 4, ME),      # note : pas une trouvaille
                  (400, "GC3", "2025-07-13", 2, OTHER))   # log d'un autre joueur
        db.session.commit()
        parcours = self.create()
        payload = self.inputs(parcours["id"])

        self.assertTrue(payload["logsAvailable"])
        self.assertEqual([d["date"] for d in payload["days"]], ["2025-07-12", "2025-07-13"])
        first, second = payload["days"]
        self.assertEqual([(s["key"], s["logId"]) for s in first["stops"]], [("GC2", 501), ("GC1", 502)])
        self.assertEqual([(s["key"], s["logId"]) for s in second["stops"]], [("GC3", None)])
        stop = first["stops"][1]
        self.assertEqual((stop["kind"], stop["name"], stop["type"], stop["lat"]),
                         ("find", "Cache GC1", "Traditional Cache", 45.1))
        self.assertIsNone(stop["localTime"])     # l'heure des GPX n'est jamais servie
        self.assertEqual(payload["counts"], {"finds": 3, "labs": 0, "dnf": 0, "missing_position": 0})

    def test_empty_days_are_kept(self):
        self.find("GC1", "2025-07-12")
        db.session.commit()
        payload = self.inputs(self.create(date_end="2025-07-14")["id"])
        self.assertEqual([len(d["stops"]) for d in payload["days"]], [1, 0, 0])
        self.assertFalse(payload["logsAvailable"])

    def test_dnf_stops_unless_found_the_same_day(self):
        self.find("GC1", "2025-07-12")
        self.find("GC2", "2025-07-20", lat=46.0)   # trouvée plus tard : position du My Finds
        self.logs((10, "GC1", "2025-07-12", 3, ME),   # DNF puis trouvaille le même jour
                  (11, "GC1", "2025-07-12", 2, ME),
                  (12, "GC2", "2025-07-12", 3, ME))
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        stops = self.inputs(parcours["id"])["days"][0]["stops"]
        self.assertEqual([(s["key"], s["kind"]) for s in stops], [("GC1", "find"), ("dnf:12", "dnf")])
        self.assertEqual(stops[1]["code"], "GC2")
        self.assertEqual(stops[1]["lat"], 46.0)

        self.patch(f"/api/parcours/{parcours['id']}", {"include_dnf": False})
        stops = self.inputs(parcours["id"])["days"][0]["stops"]
        self.assertEqual([s["key"] for s in stops], ["GC1"])

    def test_lab_stops_carry_their_local_time(self):
        collection = LabCollection(uid="default", revision=1)
        db.session.add(collection)
        db.session.flush()
        common = dict(collection_id=collection.id, coordinate_status=LabDiscovery.COORD_RESOLVED,
                      latitude=45.3, longitude=5.3, adventure_title="Aventure")
        db.session.add(LabDiscovery(local_uid="l1", stage_uuid="u1", stage_title="Étape 1",
                                    found_date=date(2025, 7, 12), date_basis="source_offset",
                                    date_precision="instant", source_date_text="2025-07-12T10:42:00-07:00",
                                    **common))
        db.session.add(LabDiscovery(local_uid="l2", stage_title="Étape 2", found_date=date(2025, 7, 12),
                                    **common))
        db.session.add(LabDiscovery(local_uid="l3", stage_title="Hors plage", found_date=date(2025, 8, 1),
                                    **common))
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        stops = self.inputs(parcours["id"])["days"][0]["stops"]
        self.assertEqual([(s["key"], s["kind"], s["localTime"]) for s in stops],
                         [("lab:l2", "lab", None), ("lab:u1", "lab", "10:42:00")])
        self.assertEqual(stops[1]["adventure"], "Aventure")

        self.patch(f"/api/parcours/{parcours['id']}", {"include_labs": False})
        self.assertEqual(self.inputs(parcours["id"])["days"][0]["stops"], [])

    def test_stop_positions_follow_cache_position(self):
        # Fiches lues par le favori : publiées + corrigées (mystery résolue),
        # publiées seules, position saisie à la main.
        self.find("GC1", "2025-07-12", lat=45.01, lon=5.01, cache_type="Unknown Cache")
        self.find("GC3", "2025-07-20", lat=45.03, lon=5.03)   # DNF trouvée plus tard
        self.logs((10, "GC2", "2025-07-12", 3, ME),
                  (11, "GC3", "2025-07-12", 3, ME),
                  (12, "GC4", "2025-07-12", 3, ME))
        collection = db.session.query(LogCollection).one()
        common = dict(collection_id=collection.id, cache_type="Unknown Cache")
        db.session.add_all([
            CacheRef(gc_code="GC1", latitude=45.0, longitude=5.0,
                     corrected_latitude=45.01, corrected_longitude=5.01, **common),
            CacheRef(gc_code="GC2", latitude=45.0, longitude=5.0,
                     corrected_latitude=45.02, corrected_longitude=5.02, **common),
            CacheRef(gc_code="GC3", latitude=45.0, longitude=5.0, **common),
            CacheRef(gc_code="GC4", latitude=45.04, longitude=5.04,
                     coordinate_source="user_correction", **common),
        ])
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        stops = {s["key"]: s for s in self.inputs(parcours["id"])["days"][0]["stops"]}
        self.assertEqual({key: (s["lat"], s["posSource"]) for key, s in stops.items()}, {
            "GC1": (45.01, "corrected"),
            "dnf:10": (45.02, "corrected"),
            # Le My Finds passe avant les publiées de la fiche.
            "dnf:11": (45.03, None),
            "dnf:12": (45.04, "manual"),
        })

    def test_favorite_and_cache_facts(self):
        # PF donné : log de trouvaille du jour ; total de PF et trouvailles
        # de la fiche, datés de l'export qui les porte.
        self.find("GC1", "2025-07-12")
        self.find("GC2", "2025-07-12")
        self.logs((10, "GC1", "2025-07-12", 2, ME), (11, "GC2", "2025-07-12", 2, ME),
                  (12, "GC3", "2025-07-12", 3, ME))
        db.session.query(LogEvent).filter_by(log_id=10).one().favorite = True
        collection = db.session.query(LogCollection).one()
        db.session.add_all([
            CacheRef(collection_id=collection.id, gc_code="GC1", favorite_points=87, found_count=1505,
                     source_exported_at=datetime(2026, 11, 21, 8, 30)),
            CacheRef(collection_id=collection.id, gc_code="GC3", latitude=45.0, longitude=5.0,
                     found_count=4, updated_at=datetime(2026, 11, 20)),
        ])
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        stops = {s["key"]: s for s in self.inputs(parcours["id"])["days"][0]["stops"]}
        facts = {key: (s["favorite"], s["favoritePoints"], s["foundCount"], s["factsAt"])
                 for key, s in stops.items()}
        self.assertEqual(facts, {
            "GC1": (True, 87, 1505, "2026-11-21"),
            "GC2": (False, None, None, None),
            "dnf:12": (False, None, 4, "2026-11-20"),
        })

    def test_parkings_of_the_parcours_caches(self):
        self.find("GC1", "2025-07-12")
        self.find("GC9", "2025-08-01")      # hors du parcours
        self.logs((10, "GC1", "2025-07-12", 2, ME))
        collection = db.session.query(LogCollection).one()
        db.session.add_all([
            CacheWaypoint(collection_id=collection.id, gc_code="GC1", kind="parking", name="P1",
                          latitude=45.1, longitude=5.1),
            CacheWaypoint(collection_id=collection.id, gc_code="GC9", kind="parking", name="P9",
                          latitude=45.9, longitude=5.9),
        ])
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        self.assertEqual(self.inputs(parcours["id"])["parkings"],
                         [{"code": "GC1", "name": "P1", "lat": 45.1, "lon": 5.1}])

    def test_finds_extent_for_the_creation_form(self):
        self.assertEqual(self.get("/api/parcours").get_json()["finds"], {"first": None, "last": None})
        self.find("GC1", "2024-03-02")
        self.find("GC2", "2025-07-13")
        db.session.commit()
        self.assertEqual(self.get("/api/parcours").get_json()["finds"],
                         {"first": "2024-03-02", "last": "2025-07-13"})

    def test_unknown_parcours(self):
        self.assertEqual(self.get("/api/parcours/999/inputs").status_code, 404)


class CollectRequestTests(_Base):
    """Compléter depuis geocaching.com : demande de collecte limitée aux
    caches du parcours (§ 15.3 du plan)."""

    def setUp(self):
        super().setUp()
        import blueprints.gc_logs as gc_logs_mod
        patcher = mock.patch.object(gc_logs_mod, "PENDING_ROOT", Path(self.tmpdir.name) / "pending")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.gc_logs = gc_logs_mod

    def collect(self, parcours_id):
        response = self.get(f"/api/parcours/{parcours_id}/collect")
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_request_lifecycle(self):
        self.find("GC1", "2025-07-12")
        self.find("GC2", "2025-07-12")
        self.find("GC9", "2025-08-01")                     # hors plage
        self.logs((10, "GC3", "2025-07-12", 3, ME))        # DNF
        collection = db.session.query(LogCollection).one()
        db.session.add(CacheRef(collection_id=collection.id, gc_code="GC1",
                                latitude=45.0, longitude=5.0, source_format="mygcflow-logs"))
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        state = self.collect(parcours["id"])
        self.assertEqual((state["total"], state["unread"], state["request"]), (3, 2, None))

        response = self.post(f"/api/parcours/{parcours['id']}/collect", {"mode": "unread"})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["request"]["count"], 2)
        asked = self.gc_logs.current_collect_request()
        self.assertEqual((asked["codes"], asked["label"], asked["parcours_id"]),
                         (["GC2", "GC3"], "Vacances", parcours["id"]))

        # Un autre parcours voit la demande en attente, sans pouvoir la retirer.
        other = self.create(name="Autre")
        self.assertEqual(self.collect(other["id"])["otherRequest"], "Vacances")
        self.delete(f"/api/parcours/{other['id']}/collect")
        self.assertIsNotNone(self.gc_logs.current_collect_request())

        response = self.post(f"/api/parcours/{parcours['id']}/collect", {"mode": "all"})
        self.assertEqual(response.get_json()["request"]["count"], 3)
        response = self.delete(f"/api/parcours/{parcours['id']}/collect")
        self.assertIsNone(response.get_json()["request"])
        self.assertIsNone(self.gc_logs.current_collect_request())

    def test_refusals(self):
        self.find("GC1", "2025-07-12")
        self.find("GC2", "2025-07-12")
        db.session.commit()
        parcours = self.create(date_end="2025-07-12")
        url = f"/api/parcours/{parcours['id']}/collect"
        self.assertEqual(self.post(url, {"mode": "rien"}).status_code, 400)
        with mock.patch.object(self.gc_logs, "MAX_COLLECT_CODES", 1):
            self.assertEqual(self.post(url, {"mode": "all"}).status_code, 400)
        empty = self.create(name="Vide", date_start="2024-01-01", date_end="2024-01-02")
        self.assertEqual(self.post(f"/api/parcours/{empty['id']}/collect", {}).status_code, 400)
        self.assertEqual(self.get("/api/parcours/999/collect").status_code, 404)
        self.assertIsNone(self.gc_logs.current_collect_request())


class AdjustmentTests(_Base):
    def patch(self, url, json):
        return self.client.patch(url, json=json, headers={"Origin": HOST}, base_url=HOST)

    def test_overrides_are_patched_cleared_and_served_with_the_inputs(self):
        pid = self.create()["id"]
        response = self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [
            {"key": "GC1", "rank": 2, "pinnedTime": "10:15", "visitMin": 45},
            {"key": "GC2", "excluded": True, "day": "2025-07-13", "legMode": "car"},
            {"key": "GC3", "position": {"lat": 45.1234567, "lon": 5.5}},
        ]})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["overrides"], [
            {"key": "GC1", "rank": 2, "pinnedTime": "10:15", "day": None, "excluded": False,
             "legMode": None, "visitMin": 45, "position": None},
            {"key": "GC2", "rank": None, "pinnedTime": None, "day": "2025-07-13", "excluded": True,
             "legMode": "car", "visitMin": None, "position": None},
            {"key": "GC3", "rank": None, "pinnedTime": None, "day": None, "excluded": False,
             "legMode": None, "visitMin": None, "position": {"lat": 45.123457, "lon": 5.5}},
        ])
        # Patch partiel ; une étape sans plus d'ajustement perd sa ligne.
        payload = self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [
            {"key": "GC1", "rank": None},
            {"key": "GC2", "excluded": False, "day": None, "legMode": None},
            {"key": "GC3", "position": None},
        ]}).get_json()
        self.assertEqual(payload["overrides"], [
            {"key": "GC1", "rank": None, "pinnedTime": "10:15", "day": None, "excluded": False,
             "legMode": None, "visitMin": 45, "position": None}])
        inputs = self.get(f"/api/parcours/{pid}/inputs").get_json()
        self.assertEqual([o["key"] for o in inputs["overrides"]], ["GC1"])
        self.assertEqual(inputs["places"], [])
        cleared = self.client.delete(f"/api/parcours/{pid}/overrides", headers={"Origin": HOST}, base_url=HOST)
        self.assertEqual(cleared.get_json()["overrides"], [])

    def test_adjustments_reread_stays_light_and_patch_answers_overrides_only(self):
        pid = self.create()["id"]
        self.post(f"/api/parcours/{pid}/places",
                  {"kind": "place", "name": "Vue", "lat": 45.9, "lon": 6.1, "date": "2025-07-12"})
        light = self.get(f"/api/parcours/{pid}/adjustments").get_json()
        # Relecture de geste : ni journées reconstruites, ni points de traces.
        self.assertTrue(light["success"])
        for field in ("overrides", "places", "photos", "cameras"):
            self.assertIn(field, light)
        for field in ("tracks", "days", "parcours", "parkings", "counts"):
            self.assertNotIn(field, light)
        self.assertEqual([p["name"] for p in light["places"]], ["Vue"])
        with_tracks = self.get(f"/api/parcours/{pid}/adjustments?tracks=1").get_json()
        self.assertIn("tracks", with_tracks)
        # La réponse d'une écriture ne porte que les ajustements.
        patched = self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [{"key": "GC1", "rank": 1}]}).get_json()
        self.assertEqual(sorted(patched.keys()), ["overrides", "success"])
        cleared = self.delete(f"/api/parcours/{pid}/overrides").get_json()
        self.assertEqual(sorted(cleared.keys()), ["overrides", "success"])

    def test_invalid_overrides_change_nothing(self):
        pid = self.create()["id"]
        self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [{"key": "GC1", "rank": 1}]})
        cases = [
            ([{"key": "GC1", "rank": 5}, {"key": "GC2", "pinnedTime": "25:00"}], "time-invalid"),
            ([{"key": "GC1", "day": "2025-07-20"}], "day-out-of-range"),
            ([{"key": "", "rank": 1}], "override-invalid"),
            ([{"key": "GC1", "rank": -1}], "override-invalid"),
            ([{"key": "GC1", "rank": True}], "override-invalid"),
            ([{"key": "GC1", "excluded": "oui"}], "override-invalid"),
            ([{"key": "GC1", "legMode": "avion"}], "override-invalid"),
            ([{"key": "GC1", "visitMin": -5}], "override-invalid"),
            ([{"key": "GC1", "visitMin": 721}], "override-invalid"),
            ([{"key": "GC1", "position": {"lat": 91, "lon": 5}}], "override-invalid"),
            ([{"key": "GC1", "position": {"lat": 45}}], "override-invalid"),
            ([{"key": "GC1", "position": [45, 5]}], "override-invalid"),
            ([{"key": "GC1", "position": {"lat": True, "lon": 5}}], "override-invalid"),
            ("pas une liste", "override-invalid"),
        ]
        for overrides, code in cases:
            response = self.patch(f"/api/parcours/{pid}/overrides", {"overrides": overrides})
            self.assertEqual(response.status_code, 400, overrides)
            self.assertEqual(response.get_json()["error"], code, overrides)
        # Tout ou rien : le rang 5 du premier cas n'a pas été écrit.
        inputs = self.get(f"/api/parcours/{pid}/inputs").get_json()
        self.assertEqual(inputs["overrides"][0]["rank"], 1)

    def test_places_and_bases(self):
        pid = self.create()["id"]
        base = self.post(f"/api/parcours/{pid}/places",
                         {"kind": "base", "name": "Hôtel", "lat": 45.9, "lon": 6.12})
        self.assertEqual(base.status_code, 201, base.get_json())
        self.assertEqual(base.get_json()["place"]["date"], None)   # toutes les journées
        place = self.post(f"/api/parcours/{pid}/places", {
            "kind": "place", "name": "Belvédère", "lat": 45.85, "lon": 6.2,
            "date": "2025-07-13", "time": "16:30"}).get_json()["place"]
        self.assertEqual((place["kind"], place["time"]), ("place", "16:30"))
        for body, code in [
            ({"kind": "place", "name": "Sans date", "lat": 45, "lon": 6}, "place-invalid"),
            ({"kind": "hotel", "lat": 45, "lon": 6}, "place-invalid"),
            ({"kind": "base", "lat": 95, "lon": 6}, "place-invalid"),
            ({"kind": "base", "lat": 45, "lon": 6, "date": "2025-08-01"}, "day-out-of-range"),
        ]:
            response = self.post(f"/api/parcours/{pid}/places", body)
            self.assertEqual(response.get_json()["error"], code, body)
        updated = self.patch(f"/api/parcours/{pid}/places/{place['id']}", {"time": None, "name": "Vue"}).get_json()
        self.assertEqual((updated["place"]["time"], updated["place"]["name"]), (None, "Vue"))
        # Rôle d'une base : départ seul, retour seul ; « both » par défaut,
        # valeur inconnue refusée, un lieu garde toujours « both ».
        self.assertEqual(base.get_json()["place"]["role"], "both")
        self.assertEqual(place["role"], "both")
        base_id = base.get_json()["place"]["id"]
        updated = self.patch(f"/api/parcours/{pid}/places/{base_id}", {"role": "start"}).get_json()
        self.assertEqual(updated["place"]["role"], "start")
        response = self.patch(f"/api/parcours/{pid}/places/{base_id}", {"role": "milieu"})
        self.assertEqual(response.get_json()["error"], "place-invalid")
        converted = self.patch(f"/api/parcours/{pid}/places/{base_id}",
                               {"kind": "place", "date": "2025-07-12"}).get_json()
        self.assertEqual(converted["place"]["role"], "both")
        # Catégorie d'affichage : jeu fermé, icône libre seulement pour
        # « custom », effacée en quittant cette catégorie.
        parking = self.post(f"/api/parcours/{pid}/places", {
            "kind": "place", "name": "Parking", "lat": 45.9, "lon": 6.1,
            "date": "2025-07-12", "category": "parking", "icon": "ti-flag"}).get_json()["place"]
        self.assertEqual((parking["category"], parking["icon"]), ("parking", None))
        custom = self.post(f"/api/parcours/{pid}/places", {
            "kind": "place", "name": "Arbre remarquable", "lat": 45.9, "lon": 6.11,
            "date": "2025-07-12", "category": "custom", "icon": "ti-tree"}).get_json()["place"]
        self.assertEqual((custom["category"], custom["icon"]), ("custom", "ti-tree"))
        for body in [
            {"kind": "place", "lat": 45, "lon": 6, "date": "2025-07-12", "category": "château"},
            {"kind": "place", "lat": 45, "lon": 6, "date": "2025-07-12", "category": "custom", "icon": "arbre"},
        ]:
            response = self.post(f"/api/parcours/{pid}/places", body)
            self.assertEqual(response.get_json()["error"], "place-invalid", body)
        demoted = self.patch(f"/api/parcours/{pid}/places/{custom['id']}", {"category": "viewpoint"}).get_json()
        self.assertEqual((demoted["place"]["category"], demoted["place"]["icon"]), ("viewpoint", None))
        self.assertEqual(len(self.get(f"/api/parcours/{pid}/inputs").get_json()["places"]), 4)
        self.assertEqual(self.delete(f"/api/parcours/{pid}/places/{place['id']}").status_code, 200)
        self.assertEqual(self.delete(f"/api/parcours/{pid}/places/{place['id']}").status_code, 404)
        # Le lieu d'un autre parcours n'est pas atteignable par celui-ci.
        other = self.create(name="Autre")["id"]
        self.assertEqual(self.delete(f"/api/parcours/{other}/places/{base.get_json()['place']['id']}").status_code, 404)

    def test_shrinking_the_range_reports_orphans_and_cleans_with_confirm(self):
        """Un rétrécissement qui laisserait des lieux ou des ajustements
        « journée » dehors est refusé sans `drop_orphans` ; avec, les lieux
        datés sont supprimés et la journée des ajustements effacée."""
        pid = self.create()["id"]
        self.post(f"/api/parcours/{pid}/places", {
            "kind": "place", "name": "Belvédère", "lat": 45.85, "lon": 6.2, "date": "2025-07-13"})
        self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [
            {"key": "GC1", "day": "2025-07-13"},
            {"key": "GC2", "day": "2025-07-13", "rank": 2}]})

        # Sans confirmation : refus détaillé, rien n'a bougé.
        refused = self.patch(f"/api/parcours/{pid}", {"date_end": "2025-07-12"})
        self.assertEqual(refused.status_code, 409)
        body = refused.get_json()
        self.assertEqual((body["error"], body["places"], body["days"]), ("out-of-range", 1, 2))
        parcours = self.get(f"/api/parcours/{pid}").get_json()["parcours"]
        self.assertEqual(parcours["date_end"], "2025-07-13")
        inputs = self.get(f"/api/parcours/{pid}/inputs").get_json()
        self.assertEqual(len(inputs["places"]), 1)
        self.assertEqual(len(inputs["overrides"]), 2)

        # Confirmé : lieu supprimé, journée effacée — GC2 garde son rang,
        # GC1 (qui n'avait que sa journée) perd sa ligne.
        ok = self.patch(f"/api/parcours/{pid}", {"date_end": "2025-07-12", "drop_orphans": True})
        self.assertEqual(ok.status_code, 200, ok.get_json())
        inputs = self.get(f"/api/parcours/{pid}/inputs").get_json()
        self.assertEqual(inputs["places"], [])
        self.assertEqual(len(inputs["overrides"]), 1)
        kept = inputs["overrides"][0]
        self.assertEqual((kept["key"], kept["day"], kept["rank"]), ("GC2", None, 2))

        # Un rétrécissement sans orphelin n'a pas besoin de la confirmation.
        pid = self.create(name="Sans lieu")["id"]
        ok = self.patch(f"/api/parcours/{pid}", {"date_end": "2025-07-12"})
        self.assertEqual(ok.status_code, 200, ok.get_json())

    def test_duplicate_export_import(self):
        pid = self.create()["id"]
        self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [
            {"key": "GC1", "rank": 1, "visitMin": 30},
            {"key": "GC2", "position": {"lat": 45.2, "lon": 5.2}}]})
        self.post(f"/api/parcours/{pid}/places",
                  {"kind": "base", "name": "Hôtel", "lat": 45.9, "lon": 6.12, "role": "end"})

        # Duplication : sélection, ajustements et lieux copiés.
        copy = self.post(f"/api/parcours/{pid}/duplicate", {})
        self.assertEqual(copy.status_code, 201, copy.get_json())
        copy = copy.get_json()["parcours"]
        self.assertTrue(copy["name"].endswith("(copie)"), copy["name"])
        inputs = self.get(f"/api/parcours/{copy['id']}/inputs").get_json()
        self.assertEqual(inputs["overrides"][0]["visitMin"], 30)
        self.assertEqual(inputs["overrides"][1]["position"], {"lat": 45.2, "lon": 5.2})
        self.assertEqual(inputs["places"][0]["role"], "end")

        # Export : le document porte tout le nécessaire.
        exported = self.get(f"/api/parcours/{pid}/export").get_json()
        self.assertEqual(exported["format"], "mygcflow-parcours")
        self.assertEqual(exported["version"], 1)
        self.assertEqual(len(exported["overrides"]), 2)
        self.assertEqual(len(exported["places"]), 1)

        # Import : le parcours recréé retrouve ajustements et lieux.
        exported["parcours"]["name"] = "Réimporté"
        imported = self.post("/api/parcours/import", exported)
        self.assertEqual(imported.status_code, 201, imported.get_json())
        nid = imported.get_json()["parcours"]["id"]
        inputs = self.get(f"/api/parcours/{nid}/inputs").get_json()
        self.assertEqual(inputs["overrides"][0]["key"], "GC1")
        self.assertEqual(inputs["overrides"][1]["position"], {"lat": 45.2, "lon": 5.2})
        self.assertEqual(inputs["places"][0]["name"], "Hôtel")

        # Document invalide ou ajustement hors plage : rien n'est importé.
        for body in [{"format": "autre"}, {"parcours": {"name": "X"}},
                     {**exported, "overrides": [{"key": "GC1", "day": "2026-01-01"}]}]:
            response = self.post("/api/parcours/import", body)
            self.assertEqual(response.status_code, 400, body)
        names = [p["name"] for p in self.get("/api/parcours").get_json()["parcours"]]
        self.assertEqual(names.count("Réimporté"), 1)

    def test_deleting_a_parcours_deletes_its_adjustments(self):
        pid = self.create()["id"]
        self.patch(f"/api/parcours/{pid}/overrides", {"overrides": [{"key": "GC1", "rank": 1}]})
        self.post(f"/api/parcours/{pid}/places", {"kind": "base", "lat": 45, "lon": 6})
        self.delete(f"/api/parcours/{pid}")
        from models import ParcoursOverride, ParcoursPlace
        self.assertEqual(ParcoursOverride.query.count(), 0)
        self.assertEqual(ParcoursPlace.query.count(), 0)


class MigrationTests(_Base):
    def test_tables_exist_at_latest_version(self):
        self.assertGreaterEqual(migrations.LATEST_VERSION, 11)
        with db.engine.connect() as conn:
            tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"parcours", "parcours_override", "parcours_place"} <= tables)


if __name__ == "__main__":
    unittest.main()
