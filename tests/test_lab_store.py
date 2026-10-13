import json
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

    def test_reimport_is_idempotent(self):
        lab_store.commit_history(db.session, self._history())
        summary = lab_store.commit_history(db.session, self._history())
        self.assertEqual(summary["added"], 0)
        self.assertEqual(summary["unchanged"], 12)
        self.assertEqual(summary["updated"], 0)
        self.assertEqual(self._count(LabDiscovery), 12)

    # --- fusion d'identité log:<id> → stage_uuid -----------------------------

    LOG_STAGE = "57a9e000-0000-4000-8000-000000000777"

    def _log_finds(self, stage_id):
        """Export `mygcflow-lab-finds` minimal : un seul log, dont l'étape
        n'a d'UUID que si `stage_id` est fourni."""
        return lf.parse_lab_finds(json.dumps({
            "format": lf.FORMAT_LAB_FINDS,
            "schema_version": lf.LAB_FINDS_SCHEMA_VERSION,
            "discoveries": [{
                "adventure_id": "fa1e0000-0000-4000-8000-000000000001",
                "stage_id": stage_id,
                "adventure_title": "Circuit des Moulins",
                "stage_title": "Le Moulin Rouge",
                "found_date": "2024-05-14",
                "log_id": 424242,
            }],
        }))

    def test_log_identity_merges_into_stage_uuid(self):
        """Le même log importé sans puis avec `stage_id` : la ligne créée
        sous `log:<id>` est retrouvée via `source_record_key` — jamais de
        doublon — et son identité locale migre vers l'UUID."""
        summary = lab_store.commit_history(db.session, self._log_finds(None))
        self.assertEqual(summary["added"], 1)
        row = db.session.query(LabDiscovery).one()
        self.assertEqual(row.local_uid, "log:424242")
        self.assertIsNone(row.stage_uuid)
        self.assertEqual(row.source_record_key, "log:424242")

        summary = lab_store.commit_history(
            db.session, self._log_finds(self.LOG_STAGE))
        self.assertEqual(summary["added"], 0)
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(self._count(LabDiscovery), 1)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).one()
        self.assertEqual(row.stage_uuid, self.LOG_STAGE)
        self.assertEqual(row.local_uid, self.LOG_STAGE)      # identité migrée
        self.assertEqual(row.source_record_key, "log:424242")

    def test_log_identity_still_found_after_uuid_migration(self):
        """Après la migration vers l'UUID, un réimport sans `stage_id`
        (clé `log:`) retrouve la ligne par `source_record_key` — sans
        redescendre l'identité locale vers `log:`."""
        lab_store.commit_history(db.session, self._log_finds(None))
        lab_store.commit_history(db.session, self._log_finds(self.LOG_STAGE))
        summary = lab_store.commit_history(db.session, self._log_finds(None))
        self.assertEqual(summary["added"], 0)
        self.assertEqual(self._count(LabDiscovery), 1)
        db.session.expire_all()
        row = db.session.query(LabDiscovery).one()
        self.assertEqual(row.local_uid, self.LOG_STAGE)
        self.assertEqual(row.stage_uuid, self.LOG_STAGE)

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

    # --- conflits tranchés (overrides) ---------------------------------------

    STAGE = "57a9e000-0000-4000-8000-000000000101"

    def _moved_coords(self, lat=47.3, lon=-1.6):
        moved = self._coords()
        for stage in moved.stages:
            if stage.stage_uuid == self.STAGE:
                stage.latitude, stage.longitude = lat, lon
        return moved

    def test_coordinates_within_tolerance_are_not_a_conflict(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        summary = lab_store.commit_coordinates(
            db.session, self._moved_coords(47.21510 + 4e-6, -1.55420 - 4e-6))
        self.assertEqual(summary["conflicts"], 0)
        self.assertEqual(summary["unchanged"], 8)

    def test_coordinate_conflict_describes_the_stage(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        summary = lab_store.commit_coordinates(db.session, self._moved_coords())
        self.assertEqual(summary["conflicts"], 1)
        detail = summary["conflicts_detail"][0]
        self.assertEqual(detail["local_uid"], self.STAGE)
        self.assertEqual(detail["stage_title"], "Le Moulin Rouge")
        self.assertEqual(detail["field"], "coordinates")
        self.assertEqual(detail["incoming"], [47.3, -1.6])
        self.assertAlmostEqual(self._discovery(self.STAGE).latitude, 47.21510)

    def test_override_replaces_conflicting_coordinates(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        overrides = {lab_store.override_key(self.STAGE, "coordinates", [47.3, -1.6])}
        summary = lab_store.commit_coordinates(
            db.session, self._moved_coords(), overrides=overrides)
        self.assertEqual(summary["conflicts"], 0)
        self.assertEqual(summary["updated"], 1)
        row = self._discovery(self.STAGE)
        self.assertAlmostEqual(row.latitude, 47.3)
        self.assertEqual(row.coordinate_source, "lab2gpx-gpx")

    def test_override_also_replaces_a_user_correction(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        row = self._discovery(self.STAGE)
        row.latitude, row.longitude = 47.5, -1.2
        row.coordinate_source = lab_store.USER_CORRECTION
        db.session.commit()
        overrides = {lab_store.override_key(self.STAGE, "coordinates", [47.3, -1.6])}
        summary = lab_store.commit_coordinates(
            db.session, self._moved_coords(), overrides=overrides)
        self.assertEqual(summary["conflicts"], 0)
        self.assertAlmostEqual(self._discovery(self.STAGE).latitude, 47.3)

    def test_override_only_applies_to_the_value_shown(self):
        """Le choix porte sur la valeur vue à l'aperçu : un autre fichier
        apportant une autre position reste un conflit."""
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        overrides = {lab_store.override_key(self.STAGE, "coordinates", [47.3, -1.6])}
        summary = lab_store.commit_coordinates(
            db.session, self._moved_coords(48.0, -2.0), overrides=overrides)
        self.assertEqual(summary["conflicts"], 1)
        self.assertAlmostEqual(self._discovery(self.STAGE).latitude, 47.21510)

    def test_override_replaces_conflicting_date(self):
        lab_store.commit_history(db.session, self._history())
        changed = self._history()
        for draft in changed.drafts:
            if draft.stage_uuid == self.STAGE:
                draft.found_date = date(2024, 5, 15)
                draft.found_at_utc = None
                draft.found_at_offset_minutes = None
                draft.date_precision = "day"
                draft.date_basis = "source_date_only"
                draft.source_date_text = "2024-05-15"
        overrides = {lab_store.override_key(self.STAGE, "found_date", "2024-05-15")}
        summary = lab_store.commit_history(db.session, changed, overrides=overrides)
        self.assertEqual(summary["conflicts"], 0)
        self.assertEqual(summary["updated"], 1)
        row = self._discovery(self.STAGE)
        self.assertEqual(row.found_date, date(2024, 5, 15))
        # La provenance suit la date retenue.
        self.assertEqual(row.date_basis, "source_date_only")
        self.assertIsNone(row.found_at_utc)

    # --- propositions et avertissements --------------------------------------

    REMOVED = "57a9e000-0000-4000-8000-000000000401"   # « La Porte Nord »

    def _coords_with_renamed_stage(self, *reworked_uuids):
        """GPX où des étapes remaniées (UUID inconnus de l'historique)
        portent le titre de l'étape trouvée."""
        coords = self._coords()
        for stage in coords.stages:
            if stage.stage_uuid in reworked_uuids:
                stage.stage_title = "  la porte NORD "
        return coords

    def test_unique_title_match_is_stored_as_suggestion_not_applied(self):
        lab_store.commit_history(db.session, self._history())
        summary = lab_store.commit_coordinates(
            db.session,
            self._coords_with_renamed_stage("57a9e000-0000-4000-8000-000000000491"))
        self.assertTrue(any(p["local_uid"] == self.REMOVED and p["unique"]
                            for p in summary["proposals"]))
        row = self._discovery(self.REMOVED)
        self.assertIsNone(row.latitude)                       # jamais appliquée
        self.assertEqual(row.coordinate_status, LabDiscovery.COORD_MISSING)
        self.assertAlmostEqual(row.suggested_latitude, 47.23010)
        self.assertAlmostEqual(row.suggested_longitude, -1.57020)
        item = next(u for u in lab_store.unresolved_discoveries(db.session)
                    if u["local_uid"] == self.REMOVED)
        self.assertAlmostEqual(item["suggestion"]["latitude"], 47.23010)

    def test_ambiguous_title_match_stores_nothing(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords_with_renamed_stage(
            "57a9e000-0000-4000-8000-000000000491",
            "57a9e000-0000-4000-8000-000000000492"))
        row = self._discovery(self.REMOVED)
        self.assertIsNone(row.suggested_latitude)
        item = next(u for u in lab_store.unresolved_discoveries(db.session)
                    if u["local_uid"] == self.REMOVED)
        self.assertIsNone(item["suggestion"])

    def test_row_warnings_are_grouped_by_reason(self):
        history = self._history()
        for draft in history.drafts[:3]:
            draft.warnings.append("found_at sans fuseau")
        history.drafts[3].warnings.append("autre")
        summary = lab_store.commit_history(db.session, history)
        grouped = {w["reason"]: w.get("count") for w in summary["warnings"]}
        self.assertEqual(grouped["found_at sans fuseau"], 3)
        self.assertEqual(grouped["autre"], 1)

    # --- propriétaire et publication ------------------------------------------

    def test_coords_bring_owner_and_publication(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        row = self._discovery(self.STAGE)
        self.assertEqual(row.owner, "Testeur_Fictif")
        self.assertEqual(row.published_date, date(2020, 3, 10))

    def test_already_resolved_stage_is_completed_on_reimport(self):
        """Étapes résolues avant que ces champs existent : un nouveau passage
        du GPX les complète, sans conflit ni changement de position."""
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        db.session.query(LabDiscovery).update(
            {LabDiscovery.owner: None, LabDiscovery.published_date: None})
        db.session.commit()
        summary = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(summary["updated"], 8)
        self.assertEqual(summary["unchanged"], 0)
        self.assertEqual(summary["conflicts"], 0)
        row = self._discovery(self.STAGE)
        self.assertEqual(row.owner, "Testeur_Fictif")
        self.assertAlmostEqual(row.latitude, 47.21510)
        # Stable ensuite.
        again = lab_store.commit_coordinates(db.session, self._coords())
        self.assertEqual(again["unchanged"], 8)

    def test_user_corrected_position_still_gets_owner_and_publication(self):
        lab_store.commit_history(db.session, self._history())
        row = self._discovery(self.STAGE)
        row.latitude, row.longitude = 47.5, -1.2
        row.coordinate_status = LabDiscovery.COORD_RESOLVED
        row.coordinate_source = lab_store.USER_CORRECTION
        db.session.commit()
        lab_store.commit_coordinates(db.session, self._coords())
        row = self._discovery(self.STAGE)
        self.assertAlmostEqual(row.latitude, 47.5)             # position conservée
        self.assertEqual(row.published_date, date(2020, 3, 10))

    # --- compteurs et pagination ----------------------------------------------

    def test_unresolved_listing_is_paginated(self):
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        everything = lab_store.unresolved_discoveries(db.session)
        self.assertEqual(len(everything), 4)
        pages = (lab_store.unresolved_discoveries(db.session, limit=3, offset=0)
                 + lab_store.unresolved_discoveries(db.session, limit=3, offset=3))
        self.assertEqual([p["local_uid"] for p in pages],
                         [e["local_uid"] for e in everything])
        self.assertEqual(lab_store.unresolved_discoveries(db.session, offset=4), [])

    def test_counts_and_listing_agree_on_every_state(self):
        """Compteurs, liste des étapes en attente et bornes de dates reposent
        sur la même définition, y compris pour les états limites."""
        lab_store.commit_history(db.session, self._history())
        lab_store.commit_coordinates(db.session, self._coords())
        ready = db.session.query(LabDiscovery).filter(
            LabDiscovery.ready_clause()).order_by(LabDiscovery.id).all()
        self.assertEqual(len(ready), 8)
        ready[0].coordinate_status = None            # statut jamais renseigné
        ready[1].found_date = None                   # date manquante
        ready[2].longitude = None                    # position incomplète
        ready[3].coordinate_status = LabDiscovery.COORD_AMBIGUOUS
        db.session.commit()

        status = lab_store.collection_status(db.session)
        self.assertEqual((status["total"], status["ready"], status["unresolved"]),
                         (12, 4, 8))
        listed = lab_store.unresolved_discoveries(db.session)
        self.assertEqual(len(listed), 8)
        self.assertTrue(all(item["reasons"] for item in listed))
        reasons = {item["local_uid"]: item["reasons"] for item in listed}
        self.assertEqual(reasons[ready[0].local_uid], ["coordinate_missing"])
        self.assertEqual(reasons[ready[1].local_uid], ["missing_date"])
        self.assertEqual(reasons[ready[2].local_uid], ["missing_coordinates"])
        self.assertEqual(reasons[ready[3].local_uid], ["coordinate_ambiguous"])

    def test_date_bounds_ignore_stages_without_position(self):
        lab_store.commit_history(db.session, self._history())
        # Aucune position : rien d'affichable, donc aucune borne.
        self.assertEqual(lab_store.lab_date_bounds(db.session), (None, None))
        lab_store.commit_coordinates(db.session, self._coords())
        low, high = lab_store.lab_date_bounds(db.session)
        self.assertIsNotNone(low)
        self.assertLessEqual(low, high)

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
