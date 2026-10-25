import json
import unittest
from datetime import date, datetime
from pathlib import Path

import log_formats as lf

FIXTURES = Path(__file__).parent / "fixtures" / "gc_logs"
CONTRACT = FIXTURES / "logs-contract-valid.json"
MY_FINDS = FIXTURES / "my-finds-logs.gpx"


def _contract(**changes):
    doc = json.loads(CONTRACT.read_text(encoding="utf-8"))
    doc.update(changes)
    return json.dumps(doc).encode("utf-8")


class CodeTests(unittest.TestCase):

    def test_gc_codes_round_trip(self):
        # Codes réels relevés sur geocaching.com.
        self.assertEqual(lf.code_to_id("GC345J4", "GC"), 2483974)
        self.assertEqual(lf.code_to_id("GC2PR3N", "GC"), 2114502)
        self.assertEqual(lf.id_to_code(2483974, "GC"), "GC345J4")
        self.assertEqual(lf.code_to_id("GC1A", "GC"), 0x1A)
        self.assertEqual(lf.id_to_code(0x1A, "GC"), "GC1A")
        for value in (1, 0xFFFF, 0x10000, 228739556, 1374556328):
            self.assertEqual(lf.code_to_id(lf.id_to_code(value, "GL"), "GL"), value)
        self.assertEqual(lf.code_to_id("GL803Y79", "GL"), 228739556)

    def test_invalid_codes(self):
        self.assertIsNone(lf.code_to_id("GL803Y79", "GC"))
        self.assertIsNone(lf.code_to_id("GCIL0", "GC"))     # I, L hors alphabet
        self.assertIsNone(lf.code_to_id("GC", "GC"))
        self.assertIsNone(lf.code_to_id(None, "GC"))

    def test_normalize_gc_code(self):
        self.assertEqual(lf.normalize_gc_code(" gc 345j4 "), "GC345J4")
        self.assertIsNone(lf.normalize_gc_code("XY123"))
        self.assertIsNone(lf.normalize_gc_code(2483974))


class ValueTests(unittest.TestCase):

    def test_civil_date(self):
        self.assertEqual(lf.parse_civil_date("2012-01-08T20:00:00Z"), date(2012, 1, 8))
        self.assertEqual(lf.parse_civil_date("2012-01-08"), date(2012, 1, 8))
        self.assertIsNone(lf.parse_civil_date("20/08/2011"))    # ambiguë : jamais devinée
        self.assertIsNone(lf.parse_civil_date("2012-02-30"))
        self.assertIsNone(lf.parse_civil_date("1999-12-31"))
        self.assertIsNone(lf.parse_civil_date(None))

    def test_instant_is_naive_utc(self):
        self.assertEqual(lf.parse_instant("2026-10-24T09:12:00Z"), datetime(2026, 10, 24, 9, 12))
        self.assertEqual(lf.parse_instant("2026-10-24T11:12:00+02:00"), datetime(2026, 10, 24, 9, 12))
        self.assertIsNone(lf.parse_instant("hier"))

    def test_types_and_categories(self):
        self.assertEqual(lf.type_id_from_label("Didn’t find it"), 3)
        self.assertEqual(lf.type_id_from_label("  found   IT "), 2)
        self.assertEqual(lf.type_id_from_label("Needs Archive"), 7)
        self.assertIsNone(lf.type_id_from_label("Mystery Log Type"))
        self.assertEqual(lf.canonical_type_id(1003), 24)
        self.assertEqual(lf.log_category(3), lf.CATEGORY_DNF)
        self.assertEqual(lf.log_category(46), lf.CATEGORY_OWNER)
        self.assertEqual(lf.log_category(999), lf.CATEGORY_OTHER)

    def test_day_order_puts_dnf_before_find(self):
        day = date(2026, 7, 20)
        logs = [(day, 4, 1), (day, 2, 2), (day, 3, 3), (date(2026, 7, 19), 2, 9)]
        ordered = sorted(logs, key=lambda l: lf.day_order_key(*l))
        self.assertEqual([l[2] for l in ordered], [9, 3, 2, 1])


class ContractTests(unittest.TestCase):

    def test_valid_file(self):
        res = lf.parse_logs_json(CONTRACT.read_bytes())
        self.assertTrue(res.ok, res.errors)
        self.assertEqual(res.meta["source"], lf.SOURCE_LOGS)
        self.assertEqual(res.meta["account_user_id"], 1234567)
        self.assertEqual(res.meta["exported_at"], datetime(2026, 10, 24, 9, 12))
        self.assertEqual(res.meta["generator"], "outil-fictif 1.0")
        by_id = {d.log_id: d for d in res.logs}
        self.assertEqual(sorted(by_id), [181176759, 207457894, 228739556,
                                         500000001, 500000002, 500000003, 500000004])
        gl = by_id[228739556]                       # identité donnée par le code GL
        self.assertEqual((gl.gc_code, gl.log_date), ("GC9ZZZZ", date(2021, 5, 2)))
        self.assertEqual(by_id[500000003].type_id, 24)    # variante 1003 ramenée
        self.assertIn("type de log inconnu — conservé", by_id[500000004].warnings)
        self.assertIs(by_id[207457894].favorite, True)
        self.assertIsNone(by_id[181176759].favorite)
        self.assertEqual(res.duplicates, 1)
        reasons = sorted(reason for section, _i, reason in res.rejected if section == "logs")
        self.assertEqual(reasons, sorted([
            "date absente ou illisible",
            "log d'objet voyageur, sans rapport avec les caches",
            "log sans identité (ni log_id, ni log_code)",
        ]))

    def test_coverage_keeps_only_complete_scopes(self):
        res = lf.parse_logs_json(CONTRACT.read_bytes())
        scopes = res.meta["coverage"]
        self.assertEqual([s.kind for s in scopes], ["author", "caches"])
        author, caches = scopes
        self.assertTrue(author.contains("GC1", 3, date(2020, 1, 1), 1234567))
        self.assertFalse(author.contains("GC1", 2, date(2020, 1, 1), 1234567))
        self.assertFalse(author.contains("GC1", 3, date(2020, 1, 1), 42))
        self.assertTrue(caches.contains("GC1ABCD", 2, date(2020, 1, 1), 42))
        self.assertFalse(caches.contains("GC2PR3N", 2, date(2020, 1, 1), 42))

    def test_malformed_coverage_is_dropped(self):
        res = lf.parse_logs_json(_contract(coverage=[
            {"kind": "author", "author_id": 1, "type_ids": "3", "complete": True},
            {"kind": "author", "author_id": 1, "since": "hier", "complete": True},
            {"kind": "caches", "gc_codes": ["GC1", "pas un code"], "complete": True},
            {"kind": "author", "complete": True},
            {"kind": "author", "author_id": 1, "since": "2026-01-01", "complete": True},
        ]))
        self.assertEqual(len(res.meta["coverage"]), 1)
        self.assertEqual(res.meta["coverage"][0].since, date(2026, 1, 1))
        self.assertEqual(sum(1 for s, _i, _r in res.rejected if s == "coverage"), 4)

    def test_caches(self):
        res = lf.parse_logs_json(CONTRACT.read_bytes())
        caches = {c.gc_code: c for c in res.caches}
        mine = caches["GC1ABCD"]
        self.assertEqual((mine.owner_id, mine.status, mine.placed_date),
                         (1234567, "archived", date(2015, 4, 1)))
        other = caches["GC9ZZZZ"]
        self.assertEqual((other.corrected_latitude, other.corrected_longitude), (48.01, 7.01))
        self.assertIsNone(other.owner_id)

    def test_cache_values_are_checked(self):
        res = lf.parse_logs_json(_contract(caches=[
            {"gc_code": "GC1", "difficulty": 6, "terrain": 2.3, "status": "perdue",
             "state": "None", "latitude": 95, "longitude": 2, "placed_date": "05/03/2011"},
            {"name": "sans code"},
        ]))
        cache = res.caches[0]
        self.assertIsNone(cache.difficulty)
        self.assertIsNone(cache.terrain)
        self.assertIsNone(cache.status)
        self.assertIsNone(cache.state)
        self.assertIsNone(cache.latitude)
        self.assertIsNone(cache.placed_date)
        self.assertEqual(len(cache.warnings), 6)
        self.assertEqual([r for s, _i, r in res.rejected if s == "caches"],
                         ["code GC absent ou invalide"])

    def test_log_identity_must_agree(self):
        res = lf.parse_logs_json(_contract(logs=[
            {"log_id": 1, "log_code": "GL803Y79", "gc_code": "GC1", "type_id": 2, "date": "2020-01-01"},
        ]))
        self.assertEqual(res.logs, [])
        self.assertEqual(res.rejected[0][2], "log_id et log_code ne concordent pas")

    def test_label_used_when_type_id_missing(self):
        res = lf.parse_logs_json(_contract(logs=[
            {"log_id": 1, "gc_code": "GC1", "type_label": "Owner Maintenance", "date": "2020-01-01"},
            {"log_id": 2, "gc_code": "GC1", "type_label": "Inconnu", "date": "2020-01-01"},
        ]))
        self.assertEqual([(d.log_id, d.type_id) for d in res.logs], [(1, 46)])

    def test_structural_errors(self):
        for doc in ({"format": "autre"}, {"format": "mygcflow-logs", "schema_version": 2},
                    {"format": "mygcflow-logs", "schema_version": 1, "logs": {}},
                    {"format": "mygcflow-logs", "schema_version": 1, "logs": [], "caches": {}}):
            res = lf.parse_logs_json(json.dumps(doc).encode())
            self.assertFalse(res.ok, doc)
            self.assertTrue(res.errors)
        self.assertFalse(lf.parse_logs_json(b"{pas du json").ok)


class GpxTests(unittest.TestCase):

    def test_my_finds_logs(self):
        res = lf.parse_gpx_logs(MY_FINDS.read_bytes())
        self.assertTrue(res.ok, res.errors)
        self.assertEqual(res.meta["source"], lf.SOURCE_GPX_MYFINDS)
        self.assertEqual((res.meta["account_user_id"], res.meta["account_username"]),
                         (1234567, "Joueur_Fictif"))
        self.assertEqual(res.meta["exported_at"], datetime(2026, 10, 20, 8, 0))
        by_id = {d.log_id: d for d in res.logs}
        self.assertEqual(sorted(by_id), [181176759, 207457894, 228700001, 228739556])
        dnf = by_id[181176759]
        self.assertEqual((dnf.gc_code, dnf.type_id, dnf.log_date), ("GC2PR3N", 3, date(2011, 8, 20)))
        self.assertEqual(res.rejected_counts(), [{"reason": "type de log absent ou inconnu", "count": 1}])
        self.assertFalse(any(hasattr(d, "text") for d in res.logs))

    def test_gpx_caches(self):
        res = lf.parse_gpx_logs(MY_FINDS.read_bytes())
        caches = {c.gc_code: c for c in res.caches}
        archived = caches["GC2PR3N"]
        self.assertEqual((archived.status, archived.placed_date, archived.owner_id, archived.terrain),
                         ("archived", date(2011, 3, 5), 7000001, 3.0))
        self.assertEqual((archived.latitude, archived.longitude), (48.85, 2.35))
        active = caches["GC345J4"]
        self.assertEqual(active.status, "active")
        self.assertIsNone(active.state)            # « None » de geocaching.com

    def test_dtd_is_refused(self):
        data = b'<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x "y">]><gpx></gpx>'
        res = lf.parse_gpx_logs(data)
        self.assertFalse(res.ok)
        self.assertIsNone(lf.detect_logs_file_format(data))

    def test_detection(self):
        self.assertEqual(lf.detect_logs_file_format(CONTRACT.read_bytes()), lf.FORMAT_LOGS)
        self.assertEqual(lf.detect_logs_file_format(MY_FINDS.read_bytes()), lf.FORMAT_GPX)
        self.assertIsNone(lf.detect_logs_file_format(b'{"format": "mygcflow-lab-finds"}'))
        self.assertIsNone(lf.detect_logs_file_format(b"bonjour"))
        self.assertFalse(lf.parse_logs_file(b"bonjour").ok)

    def test_myfinds_account_needs_a_single_finder(self):
        logs = [lf.LogDraft(1, "GC1", 2, date(2020, 1, 1), author_id=1, author_name="A"),
                lf.LogDraft(2, "GC1", 2, date(2020, 1, 1), author_id=2, author_name="B"),
                lf.LogDraft(1, "GC1", 2, date(2020, 1, 1), author_id=1, author_name="A")]
        res = lf.myfinds_parse_result(logs, ["raison"])
        self.assertIsNone(res.meta["account_user_id"])
        self.assertEqual(res.duplicates, 1)
        self.assertEqual(res.rejected, [("logs", None, "raison")])


if __name__ == "__main__":
    unittest.main()
