"""Page « Mes poses » : caches posées tirées des logs (poses_dataset.py).

Fixture fictive tests/fixtures/gc_logs/logs-poses.json : une cache par règle
(publication, pose seule, bêta-test, cycles de désactivation, archivage →
désarchivage → archivage, event du poseur, cache sans position, cache sans
pays, cache d'un autre poseur).
"""

import csv
import io
import json
import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

import log_formats as lf
import log_store
import poses_dataset as pd
from app import create_app
from extensions import db
from models import Geocache

FIXTURE = Path(__file__).parent / "fixtures" / "gc_logs" / "logs-poses.json"
ME = 1234567


def _doc():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.app = create_app({"SQLALCHEMY_DATABASE_URI":
                               f"sqlite:///{os.path.join(self.tmpdir.name, 'g.db')}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()
        pd.clear_memo()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _commit(self, doc=None):
        log_store.commit_logs(db.session, lf.parse_logs_json(json.dumps(doc or _doc()).encode()))

    def _payload(self):
        return pd.build_payload(db.session)

    @staticmethod
    def _row(payload, code):
        return payload["code"].index(code)

    @staticmethod
    def _day(payload, iso):
        return date.fromisoformat(iso).toordinal() - date.fromisoformat(payload["origin"]).toordinal()

    def _events(self, payload, code):
        k = self._row(payload, code)
        kinds = payload["logKinds"]
        ev = payload["ev"]
        return [(ev["day"][i], kinds[ev["kind"][i]], ev["fav"][i], ev["folded"][i])
                for i in range(len(ev["cache"])) if ev["cache"][i] == k]

    def _states(self, payload, code):
        k = self._row(payload, code)
        st = payload["st"]
        return [(st["day"][i], st["state"][i], st["synthetic"][i])
                for i in range(len(st["cache"])) if st["cache"][i] == k]


class ClassifyTests(unittest.TestCase):
    def test_kinds_depend_on_type_and_author(self):
        cases = [
            ((24, 42, ME), pd.KIND_PUBLISH),
            ((2, 5, ME), pd.KIND_FIND), ((10, 5, ME), pd.KIND_FIND), ((11, 5, ME), pd.KIND_FIND),
            ((2, ME, ME), pd.KIND_OWNER_NOTE),   # trouvaille du poseur sur sa cache
            ((10, ME, ME), pd.KIND_OWNER_NOTE),  # présence à son propre event
            ((3, 5, ME), pd.KIND_DNF), ((3, ME, ME), pd.KIND_OWNER_NOTE),
            ((4, 5, ME), pd.KIND_NOTE), ((4, ME, ME), pd.KIND_OWNER_NOTE),
            ((45, 5, ME), pd.KIND_ALERT), ((7, 5, ME), pd.KIND_ALERT),
            ((46, ME, ME), pd.KIND_MAINTENANCE), ((47, ME, ME), pd.KIND_MAINTENANCE),
            ((22, ME, ME), pd.KIND_DISABLE), ((22, 42, ME), pd.KIND_DISABLE),
            ((23, ME, ME), pd.KIND_ENABLE), ((12, 42, ME), pd.KIND_UNARCHIVE),
            ((5, ME, ME), pd.KIND_ARCHIVE), ((5, 42, ME), pd.KIND_ARCHIVE), ((25, 42, ME), pd.KIND_ARCHIVE),
            ((18, 42, ME), pd.KIND_REVIEWER), ((76, 42, ME), pd.KIND_REVIEWER),
            ((9, 5, ME), pd.KIND_OTHER), ((999, 5, ME), pd.KIND_OTHER),
        ]
        for (type_id, author, owner), expected in cases:
            self.assertEqual(pd.classify_log(type_id, author, owner), expected, (type_id, author))

    def test_kind_table_is_stable(self):
        # Les codes partent au client : leur ordre est un contrat.
        self.assertEqual(pd.POSES_LOG_KINDS[:3], ("publish", "find", "dnf"))
        self.assertEqual(len(set(pd.POSES_LOG_KINDS)), len(pd.POSES_LOG_KINDS))


class PayloadTests(_Base):
    def test_empty_reasons(self):
        self.assertEqual(self._payload()["meta"]["reason"], "no-collection")
        doc = _doc()
        for cache in doc["caches"]:
            cache["owner"] = {"id": 7000001, "name": "Autre_Poseur"}
        self._commit(doc)
        payload = self._payload()
        self.assertEqual(payload["meta"]["reason"], "no-owned-caches")
        self.assertEqual(payload["count"], 0)

    def test_only_owned_caches_with_a_position_are_placed(self):
        self._commit()
        payload = self._payload()
        self.assertIsNone(payload["meta"]["reason"])
        self.assertNotIn("GCQ0001", payload["code"])          # autre poseur
        self.assertNotIn("GCP0007", payload["code"])          # sans position
        self.assertEqual(payload["meta"]["pending"], 1)
        self.assertEqual(payload["meta"]["ownedTotal"], 8)
        self.assertEqual(payload["count"], 7)
        for key in ("code", "name", "lon", "lat", "placed", "archived", "status", "type", "size",
                    "difficulty", "terrain", "country", "region", "geoBorrowed", "appearSource"):
            self.assertEqual(len(payload[key]), payload["count"], key)
        # Ordre des lignes : apparition croissante.
        self.assertEqual(payload["placed"], sorted(payload["placed"]))
        self.assertEqual(payload["placed"][0], 0)

    def test_no_placed_caches_when_every_owned_cache_is_pending(self):
        # Toutes les caches posées sans position : raison propre (distincte de
        # « aucune cache possédée »), les compteurs d'attente restent servis.
        doc = _doc()
        for cache in doc["caches"]:
            cache.pop("latitude", None)
            cache.pop("longitude", None)
        self._commit(doc)
        payload = self._payload()
        meta = payload["meta"]
        self.assertEqual(meta["reason"], "no-placed-caches")
        self.assertEqual(payload["count"], 0)
        self.assertEqual(meta["ownedTotal"], 8)
        self.assertEqual(meta["pending"], 8)
        self.assertEqual(meta["undatable"], 0)

    def test_appearance_is_the_publication(self):
        self._commit()
        p = self._payload()
        k = self._row(p, "GCP0001")
        self.assertEqual(p["placed"][k], self._day(p, "2018-03-05"))
        self.assertEqual(p["appearSource"][k], pd.APPEAR_PUBLISH)

    def test_without_publication_the_placed_date_is_used(self):
        self._commit()
        p = self._payload()
        k = self._row(p, "GCP0002")
        self.assertEqual(p["placed"][k], self._day(p, "2018-06-01"))
        self.assertEqual(p["appearSource"][k], pd.APPEAR_PLACED)

    def test_a_beta_find_advances_the_appearance_and_earlier_logs_are_folded(self):
        self._commit()
        p = self._payload()
        k = self._row(p, "GCP0003")
        appear = self._day(p, "2019-01-10")
        self.assertEqual(p["placed"][k], appear)
        self.assertEqual(p["appearSource"][k], pd.APPEAR_BETA_FIND)
        events = self._events(p, "GCP0003")
        # Note du poseur (2018-12-25) et note du relecteur (2019-01-05) :
        # ramenées au jour d'apparition, marquées « folded ».
        folded = [e for e in events if e[3]]
        self.assertEqual([(e[0], e[1]) for e in folded],
                         [(appear, pd.KIND_OWNER_NOTE), (appear, pd.KIND_REVIEWER)])
        self.assertTrue(all(e[0] >= appear for e in events))
        self.assertEqual(p["meta"]["foldedLogs"], 2)

    def test_disable_enable_cycles(self):
        self._commit()
        p = self._payload()
        D = lambda iso: self._day(p, iso)  # noqa: E731
        self.assertEqual(self._states(p, "GCP0004"), [
            (D("2019-07-01"), pd.STATE_DISABLED, 0),
            (D("2019-07-15"), pd.STATE_ACTIVE, 0),
            (D("2019-09-01"), pd.STATE_DISABLED, 0),
            # Maintenance puis réactivation le même jour : seul le dernier état compte.
            (D("2019-09-10"), pd.STATE_ACTIVE, 0),
        ])
        k = self._row(p, "GCP0004")
        self.assertEqual(p["status"][k], pd.STATUS_ACTIVE)
        self.assertEqual(p["archived"][k], -1)

    def test_archive_unarchive_archive(self):
        self._commit()
        p = self._payload()
        D = lambda iso: self._day(p, iso)  # noqa: E731
        self.assertEqual(self._states(p, "GCP0005"), [
            (D("2019-10-01"), pd.STATE_ARCHIVED, 0),
            (D("2019-10-20"), pd.STATE_ACTIVE, 0),
            (D("2020-03-01"), pd.STATE_ARCHIVED, 0),
        ])
        k = self._row(p, "GCP0005")
        # `archived` = début de l'archivage final ; le log postérieur reste compté.
        self.assertEqual(p["archived"][k], D("2020-03-01"))
        self.assertEqual(p["status"][k], pd.STATUS_ARCHIVED)
        self.assertIn((D("2020-03-15"), pd.KIND_FIND, 0, 0), self._events(p, "GCP0005"))

    def test_status_without_archive_log_adds_an_inferred_change(self):
        self._commit()
        p = self._payload()
        changes = self._states(p, "GCP0006")
        self.assertEqual(len(changes), 1)
        day, state, synthetic = changes[0]
        self.assertEqual((state, synthetic), (pd.STATE_ARCHIVED, 1))
        # Date de l'export qui atteste le statut.
        self.assertEqual(day, self._day(p, "2020-12-31"))
        self.assertEqual(p["meta"]["inferredStates"], 1)

    def test_owner_attending_own_event_is_not_a_find_received(self):
        self._commit()
        p = self._payload()
        kinds = [e[1] for e in self._events(p, "GCP0006")]
        self.assertEqual(kinds.count(pd.KIND_FIND), 2)
        self.assertEqual(kinds.count(pd.KIND_OWNER_NOTE), 1)

    def test_counters_and_favorites(self):
        self._commit()
        meta = self._payload()["meta"]
        # GCP0001 2, GCP0002 1, GCP0003 4, GCP0005 2, GCP0006 2, GCP0008 1
        # (GCP0007, sans position, n'est pas placée).
        self.assertEqual(meta["finds"], 12)
        self.assertEqual(meta["favorites"], 3)
        self.assertEqual(meta["dnf"], 1)
        self.assertEqual(meta["snapshotDate"], "2020-12-31")

    def test_events_are_sorted_by_day_then_cache(self):
        self._commit()
        ev = self._payload()["ev"]
        keys = list(zip(ev["day"], ev["cache"]))
        self.assertEqual(keys, sorted(keys))
        for key in ("kind", "fav", "folded", "author"):
            self.assertEqual(len(ev[key]), len(ev["day"]))

    def test_authors_table(self):
        self._commit()
        p = self._payload()
        names = {p["authors"][a] for a in p["ev"]["author"] if a >= 0}
        self.assertTrue({"Alice", "Bob", "Chloé", "Relecteur", "Joueur_Fictif"} <= names)

    def test_country_is_borrowed_from_a_nearby_find(self):
        db.session.add(Geocache(gc_code="GCNEAR1", latitude=49.301, longitude=6.401,
                                country="France", state="Lorraine", found=True,
                                date_find=datetime(2020, 1, 1)))
        db.session.commit()
        self._commit()
        p = self._payload()
        k = self._row(p, "GCP0008")
        self.assertEqual(p["countries"][p["country"][k]], "France")
        self.assertEqual(p["regions"][p["region"][k]], "Lorraine")
        self.assertEqual(p["geoBorrowed"][k], 1)
        self.assertEqual(p["geoBorrowed"][self._row(p, "GCP0001")], 0)

    def test_owner_matched_by_name_when_id_is_missing(self):
        doc = _doc()
        doc["caches"][0]["owner"] = {"id": None, "name": "joueur_fictif"}
        self._commit(doc)
        p = self._payload()
        self.assertIn("GCP0001", p["code"])
        self.assertEqual(p["meta"]["ownerMatchedByName"], 1)

    def test_memo_follows_the_revision(self):
        self._commit()
        key1, body1 = pd.load_payload(db.session)
        key2, body2 = pd.load_payload(db.session)
        self.assertIs(body1, body2)
        doc = _doc()
        doc["exported_at"] = "2021-01-01T00:00:00Z"
        doc["logs"].append({"log_id": 900000999, "gc_code": "GCP0002", "type_id": 2, "date": "2020-06-01",
                            "author": {"id": 2000009, "name": "Nouveau"}, "favorite": True})
        self._commit(doc)
        key3, body3 = pd.load_payload(db.session)
        self.assertNotEqual(key1, key3)
        self.assertEqual(json.loads(body3)["meta"]["favorites"], 4)


class DetailsTests(_Base):
    def test_details_of_an_owned_cache(self):
        self._commit()
        d = pd.cache_details(db.session, "gcp0005")
        self.assertEqual(d["gc_code"], "GCP0005")
        self.assertEqual(d["published_date"], "2019-02-01")
        self.assertEqual(d["appear_date"], "2019-02-01")
        self.assertTrue(d["archived_by_reviewer"])
        self.assertEqual(d["first_find"], {"date": "2019-02-02", "author": "Alice"})
        self.assertEqual(d["counts"][pd.KIND_ARCHIVE], 2)
        self.assertEqual(d["final_state"], pd.STATE_ARCHIVED)

    def test_details_of_someone_elses_cache_is_none(self):
        self._commit()
        self.assertIsNone(pd.cache_details(db.session, "GCQ0001"))
        self.assertIsNone(pd.cache_details(db.session, "GCZZZZZ"))


class ExportCsvTests(_Base):
    """Export CSV de toutes les caches posées (poses_dataset.export_csv)."""

    def _csv_text(self):
        return "".join(pd.export_csv(db.session))

    def _csv_rows(self):
        text = self._csv_text()
        return list(csv.reader(io.StringIO(text[1:]), delimiter=";"))

    def _row_of(self, code):
        return {r[0]: r for r in self._csv_rows()[1:]}[code]

    def test_bom_separator_and_header_only_without_collection(self):
        text = self._csv_text()
        self.assertTrue(text.startswith("\ufeff"))
        self.assertEqual(text.count("\r\n"), 1)
        rows = self._csv_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], [
            "Code GC", "Nom", "Type", "Taille", "D", "T",
            "Latitude", "Longitude", "Pays", "Région",
            "Apparition", "Source d'apparition", "Statut",
            "Trouvailles", "Favoris", "DNF", "Logs",
            "Première trouvaille", "Premier trouveur", "Dernier log",
        ])

    def test_one_row_per_owned_cache_in_code_order(self):
        self._commit()
        rows = self._csv_rows()
        self.assertEqual(len(rows), 9)          # en-tête + 8 caches posées
        codes = [r[0] for r in rows[1:]]
        self.assertEqual(codes, sorted(codes))
        self.assertNotIn("GCQ0001", codes)      # cache d'un autre poseur

    def test_row_values_and_log_counts(self):
        self._commit()
        c = self._row_of("GCP0001")
        self.assertEqual(c[1], "Publication et premier trouveur")
        self.assertEqual(c[2:4], ["Traditional Cache", "Micro"])
        self.assertEqual(c[4:6], ["1.5", "2"])
        self.assertAlmostEqual(float(c[6]), 49.10)
        self.assertAlmostEqual(float(c[7]), 6.10)
        self.assertEqual(c[8:10], ["France", "Grand-Est"])
        self.assertEqual(c[10], "2018-03-05")   # apparition = publication
        self.assertEqual(c[11], "Publication")
        self.assertEqual(c[12], "Active")
        self.assertEqual(c[13:17], ["2", "1", "1", "5"])  # trouv./fav/DNF/logs
        self.assertEqual(c[17], "2018-03-05")   # première trouvaille
        self.assertEqual(c[18], "Alice")        # premier trouveur
        self.assertEqual(c[19], "2018-03-20")   # dernier log

    def test_appearance_sources_and_statuses(self):
        self._commit()
        # Bêta-trouvaille : apparition avancée au premier « Found it ».
        c = self._row_of("GCP0003")
        self.assertEqual(c[10:12], ["2019-01-10", "Bêta-trouvaille"])
        self.assertEqual(c[17:19], ["2019-01-10", "Testeur"])
        self.assertEqual(c[13:17], ["4", "1", "0", "7"])
        # Pose seule, sans publication.
        self.assertEqual(self._row_of("GCP0002")[11], "Date de pose")
        # Archivage joué par les logs / déduit du statut à l'export.
        self.assertEqual(self._row_of("GCP0005")[12], "Archivée")
        self.assertEqual(self._row_of("GCP0006")[12], "Archivée")

    def test_never_found_cache_has_empty_first_find_cells(self):
        self._commit()
        c = self._row_of("GCP0004")
        self.assertEqual(c[13], "0")            # jamais trouvée
        self.assertEqual(c[17], "")
        self.assertEqual(c[18], "")
        self.assertEqual(c[19], "2019-09-10")   # dernier log quand même

    def test_pending_cache_is_exported_with_empty_cells(self):
        # Sans position : cellules lat/lon vides, ligne exportée quand même.
        self._commit()
        c = self._row_of("GCP0007")
        self.assertEqual(c[6:8], ["", ""])
        self.assertEqual(c[10:12], ["2019-06-05", "Publication"])
        # Sans pays : le pays emprunté au voisinage reste propre à la carte.
        self.assertEqual(self._row_of("GCP0008")[8:10], ["", ""])

    def test_undatable_cache_is_exported_with_empty_cells(self):
        doc = _doc()
        doc["caches"][1].pop("placed_date")     # GCP0002 : ni pose ni log
        doc["logs"] = [log for log in doc["logs"] if log["gc_code"] != "GCP0002"]
        self._commit(doc)
        c = self._row_of("GCP0002")
        self.assertEqual(c[10:12], ["", ""])    # apparition et source vides
        self.assertEqual(c[12], "Active")       # statut de la fiche à l'export
        self.assertEqual(c[16], "0")
        self.assertEqual(c[19], "")


class ApiTests(_Base):
    def test_page_carries_its_mode_and_link(self):
        html = self.app.test_client().get("/poses").get_data(as_text=True)
        self.assertIn('data-mode="poses"', html)
        self.assertIn('id="linkPosesMode"', html)
        self.assertIn('id="selectPosesArchivedDisplay"', html)

    def test_data_route_and_etag(self):
        self._commit()
        client = self.app.test_client()
        first = client.get("/api/poses/data")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["count"], 7)
        etag = first.headers["ETag"]
        again = client.get("/api/poses/data", headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)

    def test_data_route_without_logs(self):
        body = self.app.test_client().get("/api/poses/data").get_json()
        self.assertEqual(body["meta"]["reason"], "no-collection")

    def test_cache_route(self):
        self._commit()
        client = self.app.test_client()
        self.assertEqual(client.get("/api/poses/caches/GCP0001").get_json()["cache"]["name"],
                         "Publication et premier trouveur")
        self.assertEqual(client.get("/api/poses/caches/GCQ0001").status_code, 404)

    def test_export_csv_route(self):
        self._commit()
        response = self.app.test_client().get("/api/poses/export.csv")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/csv")
        disposition = response.headers["Content-Disposition"]
        self.assertIn("attachment", disposition)
        self.assertIn("mes-poses-", disposition)
        body = response.get_data().decode("utf-8")
        self.assertTrue(body.startswith("\ufeff"))
        # En-tête + une ligne par cache posée (8), y compris la sans position.
        self.assertEqual(len(body.lstrip("\ufeff").splitlines()), 9)

    def test_export_csv_route_without_collection(self):
        response = self.app.test_client().get("/api/poses/export.csv")
        self.assertEqual(response.status_code, 200)
        body = response.get_data().decode("utf-8")
        self.assertTrue(body.startswith("\ufeff"))
        self.assertIn("Code GC", body)


if __name__ == "__main__":
    unittest.main()
