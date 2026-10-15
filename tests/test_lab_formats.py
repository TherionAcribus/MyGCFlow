import json
import unittest
from datetime import date, datetime
from pathlib import Path

import lab_formats as lf

FIXTURES = Path(__file__).parent / "fixtures" / "labs"


class DetectFormatTests(unittest.TestCase):
    def test_history_json_detected(self):
        data = (FIXTURES / "lab-finds-valid.json").read_bytes()
        self.assertEqual(lf.detect_lab_file_format(data), lf.FORMAT_LAB_FINDS)

    def test_lab2gpx_detected(self):
        data = (FIXTURES / "lab2gpx-stages.gpx").read_bytes()
        self.assertEqual(lf.detect_lab_file_format(data), lf.FORMAT_LAB2GPX_GPX)

    def test_doctype_rejected_at_detection(self):
        data = (FIXTURES / "lab2gpx-doctype.gpx").read_bytes()
        self.assertIsNone(lf.detect_lab_file_format(data))

    def test_unknown_content(self):
        for blob in (b"<html><body>login</body></html>", b"not a file",
                     b'{"format": "other"}', b'{"format": "mygcflow-lab-finds", "x":'):
            self.assertIsNone(lf.detect_lab_file_format(blob), blob)


class DateParsingTests(unittest.TestCase):
    def test_instant_with_negative_offset(self):
        pd = lf.parse_lab_datetime("2024-05-14T09:12:33.451-07:00")
        self.assertEqual(pd.found_date, date(2024, 5, 14))          # date civile source
        self.assertEqual(pd.found_at_utc, datetime(2024, 5, 14, 16, 12, 33, 451000))
        self.assertEqual(pd.offset_minutes, -420)
        self.assertEqual(pd.precision, "instant")

    def test_instant_with_z_and_other_offset(self):
        pd = lf.parse_lab_datetime("2021-11-20T16:37:22.294-08:00")
        self.assertEqual(pd.found_at_utc, datetime(2021, 11, 21, 0, 37, 22, 294000))
        self.assertEqual(pd.found_date, date(2021, 11, 20))          # pas la date UTC
        pd_z = lf.parse_lab_datetime("2024-05-14T09:12:33Z")
        self.assertEqual(pd_z.offset_minutes, 0)
        self.assertEqual(pd_z.found_at_utc, datetime(2024, 5, 14, 9, 12, 33))

    def test_date_only(self):
        pd = lf.parse_lab_datetime("2024-06-09")
        self.assertEqual(pd.found_date, date(2024, 6, 9))
        self.assertIsNone(pd.found_at_utc)
        self.assertEqual(pd.precision, "day")

    def test_ambiguous_date_never_guessed(self):
        pd = lf.parse_lab_datetime("14/05/2024")
        self.assertIsNone(pd.found_date)
        self.assertTrue(pd.warnings)

    def test_naive_instant_keeps_civil_date_only(self):
        pd = lf.parse_lab_datetime("2024-05-14T09:12:33")
        self.assertEqual(pd.found_date, date(2024, 5, 14))
        self.assertIsNone(pd.found_at_utc)        # pas de fuseau inventé
        self.assertEqual(pd.precision, "day")
        self.assertTrue(pd.warnings)

    def test_missing_date(self):
        pd = lf.parse_lab_datetime(None, None)
        self.assertIsNone(pd.found_date)

    def test_declared_date_fallback_and_mismatch(self):
        pd = lf.parse_lab_datetime(None, "2024-05-14")
        self.assertEqual(pd.found_date, date(2024, 5, 14))
        self.assertEqual(pd.basis, "source_date_only")
        pd2 = lf.parse_lab_datetime("2024-05-14T09:12:33-07:00", "2024-05-15")
        self.assertEqual(pd2.found_date, date(2024, 5, 14))
        self.assertTrue(any("désaccord" in w for w in pd2.warnings))


class CoordinateValidationTests(unittest.TestCase):
    def test_ranges(self):
        self.assertTrue(lf.validate_coordinates(47.2, -1.55).ok)
        self.assertFalse(lf.validate_coordinates(95.0, 0).ok)
        self.assertFalse(lf.validate_coordinates(0, 181.0).ok)
        self.assertFalse(lf.validate_coordinates("abc", 0).ok)
        self.assertFalse(lf.validate_coordinates(float("nan"), 0).ok)
        self.assertFalse(lf.validate_coordinates(float("inf"), 0).ok)

    def test_zero_zero_warns_but_passes(self):
        cc = lf.validate_coordinates(0.0, 0.0)
        self.assertTrue(cc.ok)
        self.assertTrue(cc.warnings)


class CoordinateTextTests(unittest.TestCase):
    """Saisie libre d'une position (modale « Étapes en attente »)."""

    def assertParsed(self, text, lat, lon):
        cc = lf.parse_coordinates_text(text)
        self.assertTrue(cc.ok, f"{text!r} : {cc.warnings}")
        self.assertAlmostEqual(cc.latitude, lat, places=5, msg=text)
        self.assertAlmostEqual(cc.longitude, lon, places=5, msg=text)

    def test_decimal(self):
        for text in ("48.8584, 2.2945", "48.8584 2.2945", "48.8584;2.2945",
                     "48,8584 2,2945", "48,8584; 2,2945"):
            self.assertParsed(text, 48.8584, 2.2945)
        self.assertParsed("-33.8568, 151.2153", -33.8568, 151.2153)

    def test_degrees_minutes_geocaching_format(self):
        for text in ("N 48° 51.504 E 002° 17.670", "N48 51.504 E2 17.670",
                     "n 48 51.504 e 2 17.670", "E 002° 17.670 N 48° 51.504",
                     "48 51.504 2 17.670"):
            self.assertParsed(text, 48.8584, 2.2945)
        self.assertParsed("S 33° 51.408 W 151° 12.918", -33.8568, -151.2153)
        self.assertParsed("N 48° 51.504 O 001° 17.670", 48.8584, -1.2945)

    def test_degrees_minutes_seconds(self):
        self.assertParsed("48°51'30.2\"N 2°17'40.2\"E", 48.8583889, 2.2945)
        self.assertParsed("48°51′30.2″N, 2°17′40.2″O", 48.8583889, -2.2945)
        self.assertParsed("48 51 30.2 2 17 40.2", 48.8583889, 2.2945)

    def test_ambiguous_or_malformed_rejected(self):
        for text in ("", "   ", None, "abc", "48.8584", "1 2 3",
                     "48,8584,2,2945",          # virgules : décimale ou séparateur ?
                     "N 48 75.0 E 2 17",        # minutes ≥ 60
                     "N 48.5 30 E 2 17",        # degrés décimaux suivis de minutes
                     "N 48 51 N 2 17",          # deux latitudes
                     "N -48 51 E 2 17",         # signe et lettre à la fois
                     "48.8 2.2 N"):             # une seule lettre
            self.assertFalse(lf.parse_coordinates_text(text).ok, repr(text))

    def test_out_of_range_rejected(self):
        cc = lf.parse_coordinates_text("95, 2")
        self.assertFalse(cc.ok)
        self.assertTrue(cc.warnings)


class HistoryParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = lf.parse_lab_finds((FIXTURES / "lab-finds-valid.json").read_bytes())

    def test_ok_and_meta(self):
        self.assertTrue(self.res.ok, self.res.errors)
        self.assertEqual(self.res.meta["coverage"], "complete")
        self.assertEqual(self.res.meta["declared_count"], 12)
        self.assertEqual(self.res.meta["exported_at"], datetime(2026, 1, 15, 10, 0, 0))

    def test_all_drafts_parsed(self):
        self.assertEqual(len(self.res.drafts), 12)
        self.assertEqual(self.res.rejected, [])
        by_stage = {d.stage_uuid: d for d in self.res.drafts}
        d = by_stage["57a9e000-0000-4000-8000-000000000101"]
        self.assertEqual(d.adventure_uuid, "fa1e0000-0000-4000-8000-000000000001")
        self.assertEqual(d.found_date, date(2024, 5, 14))
        self.assertEqual(d.found_at_utc, datetime(2024, 5, 14, 16, 12, 33, 451000))
        self.assertEqual(d.local_key, d.stage_uuid)
        self.assertEqual(d.source_record_key, "log:900001")
        self.assertIsNone(d.latitude)          # l'historique ne porte pas de coords
        archived = by_stage["57a9e000-0000-4000-8000-000000000301"]
        self.assertTrue(archived.is_archived)

    def test_not_json(self):
        res = lf.parse_lab_finds(b"<html></html>")
        self.assertFalse(res.ok)
        res2 = lf.parse_lab_finds(json.dumps({"format": "mygcflow-lab-finds",
                                              "schema_version": 99,
                                              "discoveries": []}))
        self.assertFalse(res2.ok)


class HistoryInvalidFileTests(unittest.TestCase):
    """Le fichier structurellement valide dont les lignes posent problème."""

    @classmethod
    def setUpClass(cls):
        cls.res = lf.parse_lab_finds((FIXTURES / "lab-finds-invalid.json").read_bytes())

    def test_records_kept_with_diagnostics(self):
        self.assertTrue(self.res.ok, self.res.errors)
        # 7 enregistrements - 1 doublon log_id = 6 brouillons, 0 rejeté
        # (chaque ligne conserve une identité exploitable)
        self.assertEqual(len(self.res.drafts), 6)
        self.assertEqual(self.res.duplicates, 1)
        self.assertEqual(self.res.rejected, [])

    def test_bad_values_stay_unresolved(self):
        by_log = {d.source_record_key: d for d in self.res.drafts}
        self.assertIsNone(by_log["log:910001"].found_date)      # date ambiguë rejetée
        self.assertIsNone(by_log["log:910002"].stage_uuid)      # absent → clé log:
        self.assertEqual(by_log["log:910002"].local_key, "log:910002")
        self.assertIsNone(by_log["log:910003"].stage_uuid)      # non UUID → absent
        self.assertIsNone(by_log["log:910004"].found_date)      # aucune date
        # found_date absente mais found_at ISO → date dérivée
        self.assertEqual(by_log["log:910005"].found_date, date(2024, 6, 2))


class GpxParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = lf.parse_lab2gpx_gpx((FIXTURES / "lab2gpx-stages.gpx").read_bytes())

    def test_all_stages_parsed(self):
        self.assertTrue(self.res.ok, self.res.errors)
        self.assertEqual(len(self.res.stages), 14)
        self.assertEqual(self.res.rejected, [])

    def test_fields(self):
        by_guid = {s.stage_uuid: s for s in self.res.stages}
        s = by_guid["57a9e000-0000-4000-8000-000000000101"]
        self.assertEqual(s.adventure_uuid, "fa1e0000-0000-4000-8000-000000000001")
        self.assertAlmostEqual(s.latitude, 47.21510)
        self.assertAlmostEqual(s.longitude, -1.55420)
        self.assertTrue(s.found_flag)
        self.assertEqual(s.stages_total, 5)
        unfound = by_guid["57a9e000-0000-4000-8000-000000000202"]
        self.assertFalse(unfound.found_flag)
        self.assertEqual(unfound.stage_title, "Le Calvaire")

    def test_time_never_used_as_find_date(self):
        # <time> = publication de l'Adventure : le parseur ne l'expose pas.
        self.assertFalse(hasattr(self.res.stages[0], "found_date"))


class GpxEdgeCasesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = lf.parse_lab2gpx_gpx((FIXTURES / "lab2gpx-edgecases.gpx").read_bytes())

    def test_counts(self):
        self.assertTrue(self.res.ok, self.res.errors)
        # 4 wpt : sans gsak:Guid -> rejeté ; lat=95 -> rejeté ;
        # (0,0) -> gardé avec avertissement ; sans bloc adventureLab -> gardé
        self.assertEqual(len(self.res.stages), 2)
        self.assertEqual(len(self.res.rejected), 2)

    def test_null_island_warned(self):
        null_stage = next(s for s in self.res.stages
                          if s.stage_uuid == "57a9e000-0000-4000-8000-000000000902")
        self.assertEqual(null_stage.latitude, 0.0)
        self.assertTrue(any("(0,0)" in w for w in null_stage.warnings))


class GpxSecurityTests(unittest.TestCase):
    def test_owner_and_publication_are_read(self):
        res = lf.parse_lab2gpx_gpx((FIXTURES / "lab2gpx-stages.gpx").read_bytes())
        stage = next(s for s in res.stages
                     if s.stage_uuid == "57a9e000-0000-4000-8000-000000000101")
        self.assertEqual(stage.owner, "Testeur_Fictif")
        self.assertEqual(stage.published_date, date(2020, 3, 10))

    def test_unreadable_publication_time_is_ignored(self):
        raw = (FIXTURES / "lab2gpx-stages.gpx").read_bytes().replace(
            b"<time>2020-03-10T08:00:00.000</time>", b"<time>bientot</time>")
        res = lf.parse_lab2gpx_gpx(raw)
        self.assertTrue(res.ok)
        stage = next(s for s in res.stages
                     if s.stage_uuid == "57a9e000-0000-4000-8000-000000000101")
        self.assertIsNone(stage.published_date)

    def test_doctype_rejected(self):
        res = lf.parse_lab2gpx_gpx((FIXTURES / "lab2gpx-doctype.gpx").read_bytes())
        self.assertFalse(res.ok)
        self.assertTrue(any("DOCTYPE" in e["reason"] for e in res.errors))

    def test_broken_xml_rejected(self):
        res = lf.parse_lab2gpx_gpx(b"<gpx><wpt")
        self.assertFalse(res.ok)


if __name__ == "__main__":
    unittest.main()
