"""Page Parcours : parcours enregistrés et entrées de la reconstruction
(parcours_store.py, parcours_dataset.py, blueprints/parcours.py)."""

import os
import tempfile
import unittest
from datetime import date, datetime

import migrations
from app import create_app
from extensions import db
from models import Geocache, LabCollection, LabDiscovery, LogCollection, LogEvent

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

    def test_finds_extent_for_the_creation_form(self):
        self.assertEqual(self.get("/api/parcours").get_json()["finds"], {"first": None, "last": None})
        self.find("GC1", "2024-03-02")
        self.find("GC2", "2025-07-13")
        db.session.commit()
        self.assertEqual(self.get("/api/parcours").get_json()["finds"],
                         {"first": "2024-03-02", "last": "2025-07-13"})

    def test_unknown_parcours(self):
        self.assertEqual(self.get("/api/parcours/999/inputs").status_code, 404)


class MigrationTests(_Base):
    def test_table_exists_at_latest_version(self):
        self.assertGreaterEqual(migrations.LATEST_VERSION, 10)
        with db.engine.connect() as conn:
            tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("parcours", tables)


if __name__ == "__main__":
    unittest.main()
