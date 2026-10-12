import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

import lab_formats as lf
import lab_store
from app import create_app
from extensions import db
from models import Geocache, LabDiscovery

FIXTURES = Path(__file__).parent / "fixtures" / "labs"
HISTORY = FIXTURES / "lab-finds-valid.json"
COORDS = FIXTURES / "lab2gpx-stages.gpx"


class LabStoreTests(unittest.TestCase):
    """Upserts, enrichissement et idempotence sur une vraie base SQLite."""

    def setUp(self):
        # ignore_cleanup_errors : Windows garde parfois le SQLite/WAL ouvert
        # une fraction de seconde après la libération du moteur.
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmpdir.cleanup)
        self.db_path = os.path.join(self.tmpdir.name, 'geocaching.db')
        self.app = create_app({'SQLALCHEMY_DATABASE_URI': f"sqlite:///{self.db_path}"})
        self.addCleanup(self._dispose)
        self.ctx = self.app.app_context()
        self.ctx.push()

    def _dispose(self):
        # Libérer la session et le moteur DANS le contexte (il faut current_app),
        # puis dépiler : Windows garde sinon le fichier SQLite ouvert.
        db.session.remove()
        db.engine.dispose()
        self.ctx.pop()

    def _history(self):
        return lf.parse_lab_finds(HISTORY.read_bytes())

    def _coords(self):
        return lf.parse_lab2gpx_gpx(COORDS.read_bytes())

    def _count(self, model):
        return db.session.query(model).count()

    def _discovery(self, stage_uuid):
        return db.session.query(LabDiscovery).filter_by(stage_uuid=stage_uuid).one_or_none()

    # --- import historique -------------------------------------------------

    def test_history_commit_creates_collection_and_rows(self):
        summary = lab_store.commit_history(db.session, self._history())
        self.assertTrue(summary["success"])
        self.assertEqual(summary["added"], 12)
        self.assertEqual(summary["rejected"], 0)
        self.assertEqual(summary["total"], 12)
        # aucune coordonnée dans l'historique → toutes en attente
        self.assertEqual(summary["ready"], 0)
        self.assertEqual(summary["unresolved"], 12)
        d = self._discovery("57a9e000-0000-4000-8000-000000000101")
        self.assertEqual(d.found_date, date(2024, 5, 14))
        self.assertEqual(d.coordinate_status, LabDiscovery.COORD_MISSING)
        self.assertEqual(d.local_uid, d.stage_uuid)

    def test_preview_writes_nothing(self):
        summary = lab_store.preview_history(db.session, self._history())
        self.assertEqual(summary["added"], 12)
        self.assertEqual(self._count(LabDiscovery), 0)
        self.assertIsNone(lab_store.get_collection(db.session))

    def test_reimport_is_idempotent(self):
        lab_store.commit_history(db.session, self._history())
        summary = lab_store.commit_history(db.session, self._history())
        self.assertEqual(summary["added"], 0)
        self.assertEqual(summary["unchanged"], 12)
        self.assertEqual(summary["updated"], 0)
        self.assertEqual(self._count(LabDiscovery), 12)

    # --- enrichissement coordonnées ----------------------------------------

    def test_coords_enrich_without_creating_finds(self):
        lab_store.commit_history(db.session, self._history())
        summary = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(summary["resolved"], 8)
        # 0202, 0205 (non trouvées), 0491/0492 (remaniées), 0601/0602 (hors histo)
        self.assertEqual(summary["ignored"], 6)
        self.assertEqual(self._count(LabDiscovery), 12)   # aucune créée
        self.assertEqual(summary["ready"], 8)
        self.assertEqual(summary["unresolved"], 4)
        d = self._discovery("57a9e000-0000-4000-8000-000000000101")
        self.assertAlmostEqual(d.latitude, 47.21510)
        self.assertEqual(d.coordinate_status, LabDiscovery.COORD_RESOLVED)
        self.assertEqual(d.coordinate_scope, "stage")
        self.assertEqual(d.adventure_url,
                         "https://labs.geocaching.com/goto/fa1e0000-0000-4000-8000-000000000001")
        # étape remaniée : UUID différent dans le GPX → reste sans coordonnées
        self.assertEqual(self._discovery("57a9e000-0000-4000-8000-000000000401")
                         .coordinate_status, LabDiscovery.COORD_MISSING)

    def test_coords_alone_create_no_discovery(self):
        summary = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(summary["ignored"], 14)
        self.assertEqual(self._count(LabDiscovery), 0)

    def test_reimport_coords_idempotent(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        summary = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(summary["resolved"], 0)
        self.assertEqual(summary["unchanged"], 8)
        self.assertEqual(summary["ignored"], 6)

    def test_user_correction_is_protected(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        row = self._discovery("57a9e000-0000-4000-8000-000000000101")
        row.latitude, row.longitude = 47.5, -1.2
        row.coordinate_source = lab_store.USER_CORRECTION
        db.session.commit()
        summary = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(summary["conflicts"], 1)
        row = self._discovery("57a9e000-0000-4000-8000-000000000101")
        self.assertAlmostEqual(row.latitude, 47.5)   # correction conservée

    # --- conflits et réimport ----------------------------------------------

    def test_date_conflict_is_reported_and_existing_kept(self):
        lab_store.commit_history(db.session, self._history())
        changed = self._history()
        for draft in changed.drafts:
            if draft.stage_uuid == "57a9e000-0000-4000-8000-000000000101":
                draft.found_date = date(2024, 5, 15)
        summary = lab_store.commit_history(db.session, changed)
        self.assertEqual(summary["conflicts"], 1)
        self.assertEqual(self._discovery("57a9e000-0000-4000-8000-000000000101")
                         .found_date, date(2024, 5, 14))

    def test_date_conflict_keeps_existing_date_metadata(self):
        lab_store.commit_history(db.session, self._history())
        uuid = "57a9e000-0000-4000-8000-000000000101"
        before = self._discovery(uuid)
        kept = (before.date_precision, before.date_basis, before.source_date_text,
                before.found_at_offset_minutes, before.found_at_utc)
        changed = self._history()
        for draft in changed.drafts:
            if draft.stage_uuid == uuid:
                draft.found_date = date(2024, 5, 15)
                draft.found_at_utc = None
                draft.found_at_offset_minutes = None
                draft.date_precision = "day"
                draft.date_basis = "source_date_only"
                draft.source_date_text = "2024-05-15"
        summary = lab_store.commit_history(db.session, changed)
        self.assertEqual(summary["conflicts"], 1)
        self.assertEqual(summary["updated"], 0)
        d = self._discovery(uuid)
        self.assertEqual((d.date_precision, d.date_basis, d.source_date_text,
                          d.found_at_offset_minutes, d.found_at_utc), kept)

    def test_user_date_correction_survives_reimport(self):
        lab_store.commit_history(db.session, self._history())
        uuid = "57a9e000-0000-4000-8000-000000000101"
        row = self._discovery(uuid)
        row.found_date = date(2024, 6, 1)
        row.date_precision = "day"
        row.date_basis = lab_store.USER_CORRECTION
        row.found_at_utc = None
        row.found_at_offset_minutes = None
        db.session.commit()
        for _ in range(2):   # stable d'un réimport à l'autre
            summary = lab_store.commit_history(db.session, self._history())
            self.assertEqual(summary["conflicts"], 1)
            self.assertEqual(summary["updated"], 0)
            self.assertEqual(summary["unchanged"], 12)
            self.assertEqual(summary["conflicts_detail"][0]["protected"],
                             lab_store.USER_CORRECTION)
            d = self._discovery(uuid)
            self.assertEqual(d.found_date, date(2024, 6, 1))
            self.assertEqual(d.date_basis, lab_store.USER_CORRECTION)
            self.assertEqual(d.date_precision, "day")
            self.assertIsNone(d.found_at_utc)

    def test_same_date_never_downgrades_instant(self):
        lab_store.commit_history(db.session, self._history())
        uuid = "57a9e000-0000-4000-8000-000000000101"
        self.assertEqual(self._discovery(uuid).date_precision, "instant")
        day_only = self._history()
        for draft in day_only.drafts:
            if draft.stage_uuid == uuid:
                draft.found_at_utc = None
                draft.found_at_offset_minutes = None
                draft.date_precision = "day"
                draft.date_basis = "source_date_only"
                draft.source_date_text = "2024-05-14"
        summary = lab_store.commit_history(db.session, day_only)
        self.assertEqual(summary["unchanged"], 12)
        d = self._discovery(uuid)
        self.assertEqual(d.date_precision, "instant")
        self.assertIsNotNone(d.found_at_utc)

    def test_empty_fields_never_erase_reliable_data(self):
        lab_store.commit_history(db.session, self._history())
        sparse = self._history()
        for draft in sparse.drafts:
            if draft.stage_uuid == "57a9e000-0000-4000-8000-000000000101":
                draft.stage_title = None
                draft.found_date = None
        summary = lab_store.commit_history(db.session, sparse)
        d = self._discovery("57a9e000-0000-4000-8000-000000000101")
        self.assertEqual(d.stage_title, "Le Moulin Rouge")
        self.assertEqual(d.found_date, date(2024, 5, 14))
        self.assertEqual(summary["unchanged"], 12)

    # --- isolation des sources ----------------------------------------------

    def test_geocache_table_untouched(self):
        db.session.add(Geocache(latitude=48.8, longitude=2.3, gc_code="GC0001"))
        db.session.commit()
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(self._count(Geocache), 1)

    def test_clear_labs_preserves_geocaches(self):
        db.session.add(Geocache(latitude=48.8, longitude=2.3, gc_code="GC0001"))
        db.session.commit()
        lab_store.commit_history(db.session, self._history())
        result = lab_store.clear_labs(db.session)
        self.assertEqual(result["deleted"], 12)
        self.assertEqual(self._count(LabDiscovery), 0)
        self.assertIsNone(lab_store.get_collection(db.session))
        self.assertEqual(self._count(Geocache), 1)

    # --- lectures -----------------------------------------------------------

    def test_status_and_unresolved(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        status = lab_store.collection_status(db.session)
        self.assertEqual(status["total"], 12)
        self.assertEqual(status["ready"], 8)
        self.assertEqual(status["collection"]["revision"], 2)
        unresolved = lab_store.unresolved_discoveries(db.session)
        self.assertEqual(len(unresolved), 4)
        self.assertTrue(all("missing_coordinates" in u["reasons"] for u in unresolved))


if __name__ == "__main__":
    unittest.main()
