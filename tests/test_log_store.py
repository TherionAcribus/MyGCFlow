import json
import os
import shutil
import tempfile
import unittest
from datetime import date

import bdd
import log_formats as lf
import log_store
from app import create_app
from extensions import db
from models import CacheRef, Geocache, LogCollection, LogEvent

from tests.test_log_formats import CONTRACT, MY_FINDS

ME = 1234567


def _doc():
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def _parse(doc):
    return lf.parse_logs_json(json.dumps(doc).encode("utf-8"))


class LogStoreTests(unittest.TestCase):
    """Fusion, couverture et compte sur une vraie base SQLite."""

    def setUp(self):
        # ignore_cleanup_errors : Windows garde parfois le SQLite/WAL ouvert
        # une fraction de seconde après la libération du moteur.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, "geocaching.db")
        self.app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{self.db_path}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()

    def _dispose(self):
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _commit(self, doc=None, **kwargs):
        return log_store.commit_logs(db.session, _parse(doc or _doc()), **kwargs)

    def _log(self, log_id):
        return db.session.query(LogEvent).filter_by(log_id=log_id).one_or_none()

    def _ids(self):
        return sorted(log_id for (log_id,) in db.session.query(LogEvent.log_id))

    # --- import ------------------------------------------------------------

    def test_first_import(self):
        summary = self._commit()
        self.assertTrue(summary["success"])
        self.assertEqual((summary["added"], summary["caches_added"]), (7, 2))
        self.assertEqual(summary["rejected"], 3)
        self.assertEqual(summary["unknown_types"], {"999": 1})
        self.assertEqual(summary["categories"]["mine"], {"dnf": 2, "find": 1, "other": 1})
        status = summary["status"]
        self.assertEqual(status["account"], {"user_id": ME, "username": "Joueur_Fictif"})
        self.assertEqual((status["logs"], status["mine"], status["caches"]), (7, 4, 2))
        # GC2PR3N : ni fiche, ni trouvaille My Finds → en attente de position.
        self.assertEqual(status["pending_coordinates"], 1)
        dnf = self._log(181176759)
        self.assertEqual((dnf.gc_code, dnf.type_id, dnf.log_date), ("GC2PR3N", 3, date(2011, 8, 20)))
        ref = db.session.query(CacheRef).filter_by(gc_code="GC9ZZZZ").one()
        self.assertEqual((ref.corrected_latitude, ref.coordinate_source), (48.01, lf.SOURCE_LOGS))

    def test_status_reports_last_import(self):
        # « Dernier import le … : +n logs, … — source » de la carte.
        self.assertIsNone(log_store.collection_status(db.session)["last_import"])
        self._commit()
        info = log_store.collection_status(db.session)["last_import"]
        self.assertEqual(info["added"], 7)
        self.assertEqual(info["source"], lf.SOURCE_LOGS)
        self.assertEqual(info["generator"], "outil-fictif 1.0")
        self.assertTrue(info["at"].startswith("20"))
        log_store.clear_logs(db.session)
        self.assertIsNone(log_store.collection_status(db.session)["last_import"])

    def test_pending_caches_and_resolve(self):
        # GC2PR3N : des logs, pas de fiche ni de position (modale de complétion).
        self._commit()
        page = log_store.pending_caches(db.session)
        self.assertEqual(page["total"], 1)
        item = page["items"][0]
        self.assertEqual((item["gc_code"], item["logs"], item["dnf"]), ("GC2PR3N", 2, 1))
        self.assertIsNone(item["name"])

        # La saisie manuelle crée la fiche et sort la cache de l'attente.
        self.assertTrue(log_store.resolve_cache_coordinates(
            db.session, "GC2PR3N", 48.8584, 2.2945))
        self.assertEqual(log_store.collection_status(db.session)["pending_coordinates"], 0)
        ref = db.session.query(CacheRef).filter_by(gc_code="GC2PR3N").one()
        self.assertEqual(ref.coordinate_source, lf.USER_CORRECTION)
        self.assertFalse(
            log_store.resolve_cache_coordinates(db.session, "GC00000", 1.0, 1.0))

        # Un import postérieur reprend les autres champs mais pas la position.
        doc = _doc()
        doc["caches"].append({"gc_code": "GC2PR3N", "name": "Renommée",
                              "latitude": 10.0, "longitude": 10.0})
        self._commit(doc)
        ref = db.session.query(CacheRef).filter_by(gc_code="GC2PR3N").one()
        self.assertAlmostEqual(ref.latitude, 48.8584)
        self.assertEqual(ref.name, "Renommée")

    def test_reimport_is_idempotent(self):
        self._commit()
        summary = self._commit()
        self.assertEqual((summary["added"], summary["updated"], summary["removed"]), (0, 0, 0))
        self.assertEqual(summary["unchanged"], 7)
        self.assertEqual(summary["caches_unchanged"], 2)
        self.assertEqual(db.session.query(LogEvent).count(), 7)
        self.assertEqual(db.session.query(LogCollection).one().revision, 2)

    def test_preview_writes_nothing(self):
        summary = log_store.preview_logs(db.session, _parse(_doc()))
        self.assertEqual((summary["added"], summary["collection_revision"]), (7, 0))
        self.assertEqual(db.session.query(LogEvent).count(), 0)
        self.assertIsNone(log_store.get_collection(db.session))

    def test_revision_guard(self):
        self._commit()
        with self.assertRaises(log_store.LogRevisionConflict):
            self._commit(expected_revision=0)
        self._commit(expected_revision=1)

    # --- fraîcheur ---------------------------------------------------------

    def test_newer_export_updates_older_is_stale(self):
        self._commit()
        newer = _doc()
        newer["exported_at"] = "2026-10-25T00:00:00Z"
        newer["logs"][0]["date"] = "2011-08-21"
        self.assertEqual(self._commit(newer)["updated"], 1)
        self.assertEqual(self._log(181176759).log_date, date(2011, 8, 21))

        older = _doc()
        older["exported_at"] = "2026-01-01T00:00:00Z"
        summary = self._commit(older)
        self.assertEqual(summary["stale"], 1)
        self.assertEqual(self._log(181176759).log_date, date(2011, 8, 21))

    def test_missing_field_never_erases(self):
        self._commit()
        doc = _doc()
        for rec in doc["logs"]:
            rec.pop("favorite", None)
            rec.pop("author", None)
        self._commit(doc)
        log = self._log(207457894)
        self.assertIs(log.favorite, True)
        self.assertEqual(log.author_id, ME)

    # --- couverture --------------------------------------------------------

    def test_complete_author_coverage_removes_deleted_dnf(self):
        self._commit()
        doc = _doc()
        doc["logs"] = [rec for rec in doc["logs"] if rec.get("log_code") != "GL803Y79"]
        summary = self._commit(doc)
        self.assertEqual(summary["removed"], 1)
        self.assertEqual(summary["removed_sample"][0]["log_id"], 228739556)
        self.assertEqual(summary["removed_sample"][0]["author"], "Joueur_Fictif")
        self.assertIsNone(self._log(228739556))

    def test_complete_cache_coverage_removes_only_that_cache(self):
        self._commit()
        doc = _doc()
        doc["logs"] = [rec for rec in doc["logs"] if rec.get("log_id") != 500000002]
        self.assertEqual(self._commit(doc)["removed"], 1)
        self.assertIsNone(self._log(500000002))
        self.assertIsNotNone(self._log(207457894))

    def test_without_coverage_nothing_is_removed(self):
        self._commit()
        doc = _doc()
        doc["coverage"] = []
        doc["logs"] = doc["logs"][:1]
        self.assertEqual(self._commit(doc)["removed"], 0)
        self.assertEqual(len(self._ids()), 7)

    def test_coverage_since_limits_removal(self):
        self._commit()
        doc = _doc()
        doc["coverage"] = [{"kind": "author", "author_id": ME, "since": "2016-01-01", "complete": True}]
        doc["logs"] = []
        summary = self._commit(doc)
        # Périmètre : logs de l'auteur depuis 2016 (2016-01-01 et 2021-05-02) ;
        # ses logs de 2011-2012 restent.
        self.assertEqual(summary["removed"], 2)
        self.assertEqual(self._ids(), [181176759, 207457894, 500000001, 500000002, 500000003])

    # --- compte, fiches ----------------------------------------------------

    def test_other_account_is_refused(self):
        self._commit()
        doc = _doc()
        doc["account"] = {"user_id": 999, "username": "Autre"}
        with self.assertRaises(log_store.LogAccountMismatch):
            self._commit(doc)
        self.assertEqual(log_store.get_collection(db.session).account_user_id, ME)
        self.assertEqual(log_store.get_collection(db.session).revision, 1)

    def test_username_follows_confirmed_account(self):
        self._commit()
        doc = _doc()
        doc["account"]["username"] = "Nouveau_Pseudo"
        self._commit(doc)
        self.assertEqual(log_store.get_collection(db.session).account_username, "Nouveau_Pseudo")
        doc["account"] = {"username": "Imposteur"}
        self._commit(doc)
        self.assertEqual(log_store.get_collection(db.session).account_username, "Nouveau_Pseudo")

    def test_user_correction_survives_import(self):
        self._commit()
        ref = db.session.query(CacheRef).filter_by(gc_code="GC1ABCD").one()
        ref.latitude, ref.longitude = 49.2, 6.2
        ref.coordinate_source = lf.USER_CORRECTION
        db.session.commit()
        doc = _doc()
        doc["exported_at"] = "2026-10-26T00:00:00Z"
        doc["caches"][0]["favorite_points"] = 5
        summary = self._commit(doc)
        self.assertEqual(summary["caches_updated"], 1)
        ref = db.session.query(CacheRef).filter_by(gc_code="GC1ABCD").one()
        self.assertEqual((ref.latitude, ref.longitude, ref.favorite_points), (49.2, 6.2, 5))

    def test_clear(self):
        self._commit()
        result = log_store.clear_logs(db.session)
        self.assertEqual((result["removed_logs"], result["removed_caches"]), (7, 2))
        self.assertFalse(log_store.collection_status(db.session)["exists"])
        doc = _doc()
        doc["account"] = {"user_id": 999}
        self._commit(doc)    # un autre compte est accepté après effacement

    # --- import My Finds ---------------------------------------------------

    def _upload_my_finds(self):
        path = os.path.join(self.tmpdir.name, "my-finds.gpx")
        shutil.copyfile(MY_FINDS, path)
        bdd.uploadBdd(path, Geocache, db)

    def test_my_finds_import_feeds_logs(self):
        self._upload_my_finds()
        self.assertEqual(db.session.query(Geocache).count(), 2)
        self.assertEqual(self._ids(), [181176759, 207457894, 228700001, 228739556])
        status = log_store.collection_status(db.session)
        self.assertEqual(status["account"], {"user_id": ME, "username": "Joueur_Fictif"})
        self.assertEqual(status["mine_by_category"], {"dnf": 1, "find": 2, "note": 1})
        # Positions données par les trouvailles My Finds.
        self.assertEqual(status["pending_coordinates"], 0)
        self.assertEqual(self._log(181176759).source_format, lf.SOURCE_GPX_MYFINDS)

        self._upload_my_finds()     # réimport : rien ne bouge, rien n'est retiré
        self.assertEqual(len(self._ids()), 4)
        # Le fichier du contrat, plus récent, complète l'historique du même
        # compte : point favori apporté au Found it, log 228739556 déplacé
        # (le contrat le date et le place autrement), DNF identique.
        summary = self._commit()
        self.assertEqual((summary["updated"], summary["unchanged"]), (2, 1))
        self.assertIs(self._log(207457894).favorite, True)
        self.assertEqual(self._log(228739556).gc_code, "GC9ZZZZ")
        self.assertEqual(summary["status"]["pending_coordinates"], 0)

    def test_my_finds_without_usable_logs_creates_nothing(self):
        # Logs sans attribut id (cas des fixtures e2e) : rejetés, et aucune
        # collection vide ni révision créée.
        result = log_store.merge_myfinds_logs(
            db.session, lf.myfinds_parse_result([], ["log sans identité (ni log_id, ni log_code)"]))
        self.assertEqual(result, {"success": False, "skipped": "no_logs", "rejected": 1})
        self.assertIsNone(log_store.get_collection(db.session))

    def test_my_finds_of_another_account_keeps_finds(self):
        doc = _doc()
        doc["account"] = {"user_id": 999}
        doc["coverage"] = []
        self._commit(doc)
        self._upload_my_finds()
        self.assertEqual(db.session.query(Geocache).count(), 2)
        self.assertEqual(len(self._ids()), 7)     # logs du compte 999 intacts


if __name__ == "__main__":
    unittest.main()
